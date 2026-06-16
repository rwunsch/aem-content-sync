'use strict'

/*
 * App-level authorization on top of `require-adobe-auth`.
 *
 * `require-adobe-auth` only proves the caller has a valid IMS token for THIS org.
 * To restrict the app to specific Admin Console profiles (e.g. Cloud Manager
 * Deployment / Program Managers), we check the caller's IMS group memberships:
 * IMS `/ims/organizations/v6` returns the user's orgs, each with a `groups` list
 * whose `groupName` values are the product-profile / role identifiers
 * (e.g. `CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE`). If the caller is in none of the
 * allowed profiles, the action returns 403.
 *
 * The allowed profiles are stored in config (`accessProfiles`) and editable in
 * the UI (Settings → Access control) — no redeploy. A value of ['*'] means
 * "any signed-in user in the org" (authentication only, no profile restriction).
 *
 * Well-known profile catalog (standard across orgs):
 *   CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE  Cloud Manager Deployment Manager
 *   CM_CS_PROGRAM_MANAGER_ROLE_PROFILE     Cloud Manager Program Manager (Business Owner)
 *   CM_CS_DEVELOPER_ROLE_PROFILE           Cloud Manager Developer
 *   AEM Administrators                     AEM Administrator (org-level / per-env prefix)
 */

const IMS_HOST = process.env.IMS_HOST || 'https://ims-na1.adobelogin.com'

// Per-container cache of the caller's profile groups, keyed by token, to avoid
// an IMS round-trip on every poll. Short TTL; cold starts re-check.
const cache = new Map()
const TTL_MS = 10 * 60 * 1000

function bearer (params) {
  const h = (params && params.__ow_headers) || {}
  const a = h.authorization || h.Authorization || ''
  return a.replace(/^Bearer\s+/i, '').trim()
}

function targetOrg (params) {
  const h = (params && params.__ow_headers) || {}
  return h['x-gw-ims-org-id'] || h['X-Gw-Ims-Org-Id'] || (params && params.IMS_ORG_ID)
}

function orgIdOf (o) {
  const ref = o.orgRef || {}
  return ref.ident && ref.authSrc ? `${ref.ident}@${ref.authSrc}` : (o.orgName || '')
}

// Fetch the caller's profile/role group names for this org (cached per token).
async function callerProfiles (params) {
  const token = bearer(params)
  if (!token) { const e = new Error('Authentication required'); e.statusCode = 401; throw e }

  const cached = cache.get(token)
  if (cached && cached.exp > Date.now()) return cached.groups

  let orgs
  try {
    const r = await fetch(`${IMS_HOST}/ims/organizations/v6`, { headers: { Authorization: 'Bearer ' + token } })
    if (!r.ok) { const e = new Error('Authorization check failed'); e.statusCode = 502; throw e }
    orgs = await r.json()
  } catch (err) {
    if (err.statusCode) throw err
    const e = new Error('Authorization check failed'); e.statusCode = 502; throw e
  }

  const list = Array.isArray(orgs) ? orgs : (orgs.organizations || [])
  const want = targetOrg(params)
  const org = list.find(o => orgIdOf(o) === want) || list[0] || {}
  // IMS puts the technical profile code (e.g. CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE)
  // in `groupDisplayName` and the friendly name (e.g. "Deployment Manager - Cloud
  // Service") in `groupName` — so collect BOTH and match against either.
  const groups = (org.groups || []).flatMap(g => [g.groupName, g.groupDisplayName]).filter(Boolean)

  cache.set(token, { groups, exp: Date.now() + TTL_MS })
  return groups
}

// True if the caller is in at least one allowed profile (or allowed = ['*']).
// A profile entry matches a group by exact name OR as a prefix (so
// "AEM Administrators" matches "AEM Administrators - author - Program …").
function matches (groups, allowed) {
  if (!Array.isArray(allowed) || !allowed.length) return false
  if (allowed.includes('*')) return true
  return allowed.some(p => groups.some(g => g === p || g.startsWith(p)))
}

/**
 * Throw 401/403/502 if the caller is not in one of `allowed` Admin Console
 * profiles. `allowed` comes from config.accessProfiles.
 */
async function assertAuthorized (params, allowed) {
  if (Array.isArray(allowed) && allowed.includes('*')) return '*'
  const groups = await callerProfiles(params)
  if (!matches(groups, allowed)) {
    const list = (Array.isArray(allowed) && allowed.length ? allowed : []).join(', ')
    const e = new Error(
      'Not authorized: this application is restricted to the following Admin Console profile(s): ' +
      list + '. Ask an administrator to add you to one of them.')
    e.statusCode = 403
    throw e
  }
  return 'ok'
}

module.exports = { assertAuthorized, callerProfiles, matches }
