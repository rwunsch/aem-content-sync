#!/usr/bin/env node
'use strict'

/*
 * Self-healing post-deploy hook.
 *
 * `require-adobe-auth: true` is meant to deploy the action twice: the real
 * private action `__secured_ui-api`, and a public web SEQUENCE `ui-api` that
 * chains Adobe's token validator in front of it:
 *
 *   ui-api = [ /adobeio/shared-validators-v1/app-registry , <pkg>/__secured_ui-api ]
 *
 * On a freshly-created namespace (e.g. the first publish to a new Production
 * workspace) `aio app deploy` sometimes creates only `__secured_ui-api` and
 * SKIPS the `ui-api` wrapper sequence — so the SPA's POST hits a missing route,
 * returns 404, and the UI reports the backend as "unreachable". A full redeploy
 * can also drop the sequence again.
 *
 * This hook runs after every `aio app deploy`, detects the missing/incorrect
 * `ui-api` sequence, and (re)creates it to match a healthy workspace. It is
 * idempotent: if the sequence already exists and is correct, it does nothing.
 *
 * It talks to the OpenWhisk REST API directly with the namespace key from the
 * environment (AIO_runtime_namespace / AIO_runtime_auth), so it needs no
 * interactive `aio login`. See docs/troubleshooting-shell-integration.md §8.
 */

const fs = require('fs')
const path = require('path')

const VALIDATOR = '/adobeio/shared-validators-v1/app-registry'
const SECURED = '__secured_ui-api'
const SEQ_NAME = 'ui-api'

// Load AIO_runtime_* from process.env, falling back to a .env file next to the app.
function loadCreds () {
  const env = { ...process.env }
  if (!env.AIO_runtime_namespace || !env.AIO_runtime_auth) {
    const envPath = path.join(process.cwd(), '.env')
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
        if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim()
      }
    }
  }
  return {
    ns: env.AIO_runtime_namespace,
    auth: env.AIO_runtime_auth,
    apihost: (env.AIO_runtime_apihost || 'https://adobeioruntime.net').replace(/\/$/, '')
  }
}

function api (apihost, ns, auth, suffix, opts = {}) {
  const url = `${apihost}/api/v1/namespaces/${encodeURIComponent(ns)}/${suffix}`
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: 'Basic ' + Buffer.from(auth).toString('base64'),
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  })
}

async function main () {
  const { ns, auth, apihost } = loadCreds()
  if (!ns || !auth) {
    console.warn('[ensure-auth-sequence] no AIO_runtime_namespace/auth in env or .env — skipping')
    return
  }

  // Find which package holds __secured_ui-api (robust to package renames).
  const listRes = await api(apihost, ns, auth, 'actions?limit=50')
  if (!listRes.ok) {
    console.warn(`[ensure-auth-sequence] could not list actions (HTTP ${listRes.status}) — skipping`)
    return
  }
  const actions = await listRes.json()
  const secured = actions.find(a => a.name === SECURED)
  if (!secured) {
    console.log(`[ensure-auth-sequence] no ${SECURED} action found — nothing to wire (skipping)`)
    return
  }
  const pkg = String(secured.namespace || '').split('/')[1]
  if (!pkg) {
    console.warn('[ensure-auth-sequence] could not derive package name — skipping')
    return
  }

  // Is the ui-api sequence already present and correct?
  const getRes = await api(apihost, ns, auth, `actions/${pkg}/${SEQ_NAME}`)
  if (getRes.ok) {
    const cur = await getRes.json()
    const comps = (cur.exec && cur.exec.components) || []
    const webExport = (cur.annotations || []).some(a => a.key === 'web-export' && a.value === true)
    const ok = cur.exec && cur.exec.kind === 'sequence' &&
      comps.some(c => c.includes('shared-validators')) &&
      comps.some(c => c.endsWith(`/${SECURED}`)) && webExport
    if (ok) {
      console.log(`[ensure-auth-sequence] ${pkg}/${SEQ_NAME} sequence already healthy — nothing to do`)
      return
    }
    console.log(`[ensure-auth-sequence] ${pkg}/${SEQ_NAME} present but not a healthy auth sequence — recreating`)
  } else if (getRes.status === 404) {
    console.log(`[ensure-auth-sequence] ${pkg}/${SEQ_NAME} missing — creating require-adobe-auth wrapper sequence`)
  } else {
    console.warn(`[ensure-auth-sequence] unexpected status ${getRes.status} reading ${pkg}/${SEQ_NAME} — skipping`)
    return
  }

  const body = {
    name: SEQ_NAME,
    exec: { kind: 'sequence', components: [VALIDATOR, `/${ns}/${pkg}/${SECURED}`] },
    annotations: [
      { key: 'web-export', value: true },
      { key: 'raw-http', value: false },
      { key: 'final', value: true },
      { key: 'require-adobe-auth', value: false },
      { key: 'exec', value: 'sequence' }
    ]
  }
  const putRes = await api(apihost, ns, auth, `actions/${pkg}/${SEQ_NAME}?overwrite=true`, {
    method: 'PUT',
    body: JSON.stringify(body)
  })
  if (putRes.ok) {
    console.log(`[ensure-auth-sequence] ✓ ${pkg}/${SEQ_NAME} auth sequence ensured (validator → ${SECURED})`)
  } else {
    const txt = await putRes.text().catch(() => '')
    console.warn(`[ensure-auth-sequence] ⚠ failed to create ${pkg}/${SEQ_NAME} (HTTP ${putRes.status}): ${txt.slice(0, 200)}`)
  }
}

// Never fail the deploy on a hook hiccup — log and exit 0.
main().catch(e => { console.warn('[ensure-auth-sequence] error (non-fatal):', e.message) })
