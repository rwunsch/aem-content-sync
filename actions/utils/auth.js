'use strict'

/*
 * Cloud Manager / AEM IMS token via OAuth Server-to-Server (client_credentials),
 * obtained with a direct call to the IMS token endpoint.
 *
 * We deliberately do NOT use @adobe/aio-lib-ims here: it eagerly pulls in the
 * interactive CLI login path (aio-lib-ims-oauth → cli-ux → @oclif/command), whose
 * load-time Node-version check crashes once esbuild bundles everything into one
 * file (its `__dirname/../package.json` lookup resolves wrong on I/O Runtime).
 * A plain fetch has zero dependencies and bundles cleanly.
 */

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'

const DEFAULT_SCOPES = [
  'openid',
  'AdobeID',
  'read_organizations',
  'additional_info.projectedProductContext',
  'read_pc.dma_aem_ams'
]

let _cachedToken = null
let _tokenExpiry = 0

function resolveScopes (params) {
  const raw = params.CM_SCOPES
  if (!raw) return DEFAULT_SCOPES.join(',')
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) return arr.join(',')
  } catch (_) { /* not JSON */ }
  return String(raw).replace(/\s+/g, '')
}

async function getCMToken (params) {
  if (!params.CM_CLIENT_ID || !params.CM_CLIENT_SECRET) {
    throw new Error('Cloud Manager OAuth credentials are not configured')
  }
  const now = Date.now()
  if (_cachedToken && now < _tokenExpiry) return _cachedToken

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: params.CM_CLIENT_ID,
    client_secret: params.CM_CLIENT_SECRET,
    scope: resolveScopes(params)
  })

  const res = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`IMS token error ${res.status}: ${json.error || json.error_description || 'unknown'}`)
  }

  _cachedToken = json.access_token
  // Refresh 10 minutes before expiry (IMS tokens are ~24h for S2S, but be safe).
  const lifetimeMs = (json.expires_in ? json.expires_in * 1000 : 60 * 60 * 1000)
  _tokenExpiry = now + Math.max(lifetimeMs - 10 * 60 * 1000, 60 * 1000)
  return _cachedToken
}

// ── AEM author token via AEM Developer Console Service Credentials (JWT) ─────────
// Classic AEM author endpoints (/bin/replicate.json, /bin/querybuilder.json) do NOT
// accept the Cloud Manager OAuth S2S token (403). They require AEM Developer Console
// *Service Credentials* (JWT) — exchange the signed JWT for an IMS access token.
// `serviceCreds` is the JSON downloaded per environment (has integration.{org,id,
// privateKey,metascopes,imsEndpoint,technicalAccount.{clientId,clientSecret}}).
let jwt
const _aemTokenCache = {} // keyed by clientId → { token, exp }

async function getAemToken (serviceCreds) {
  if (!serviceCreds) throw new Error('AEM service credentials are required')
  if (!jwt) jwt = require('jsonwebtoken')
  const i = serviceCreds.integration || serviceCreds
  if (!i || !i.technicalAccount || !i.technicalAccount.clientId || !i.privateKey) {
    throw new Error('AEM service credentials are missing required fields')
  }
  const clientId = i.technicalAccount.clientId
  const now = Date.now()
  const cached = _aemTokenCache[clientId]
  if (cached && now < cached.exp) return cached.token

  const ims = i.imsEndpoint || 'ims-na1.adobelogin.com'
  const metascopes = String(i.metascopes || 'ent_aem_cloud_api').split(',').filter(Boolean)
  const payload = {
    exp: Math.floor(now / 1000) + 300,
    iss: i.org,
    sub: i.id,
    aud: `https://${ims}/c/${clientId}`
  }
  for (const m of metascopes) payload[`https://${ims}/s/${m}`] = true
  const signed = jwt.sign(payload, i.privateKey, { algorithm: 'RS256' })

  const res = await fetch(`https://${ims}/ims/exchange/jwt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: i.technicalAccount.clientSecret, jwt_token: signed })
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`AEM JWT exchange ${res.status}: ${json.error || json.error_description || 'unknown'}`)
  const lifetimeMs = (json.expires_in ? Number(json.expires_in) : 23 * 3600 * 1000)
  _aemTokenCache[clientId] = { token: json.access_token, exp: now + Math.max(lifetimeMs - 10 * 60 * 1000, 60 * 1000) }
  return json.access_token
}

module.exports = { getCMToken, getAemToken }
