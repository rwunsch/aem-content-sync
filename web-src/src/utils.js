/*
 * actionWebInvoke — calls a web action by its generated endpoint URL.
 * Endpoints come from `./config.json`, which `aio app build` generates from
 * app.config.yaml (action name → URL).
 */

/* eslint-disable no-empty */
export async function actionWebInvoke (actionUrl, headers = {}, params = {}, options = { method: 'POST' }) {
  const fetchConfig = {
    method: options.method,
    headers: { 'Content-Type': 'application/json', ...headers }
  }

  if (fetchConfig.method.toUpperCase() === 'GET') {
    const qs = new URLSearchParams(params).toString()
    actionUrl = qs ? `${actionUrl}?${qs}` : actionUrl
  } else {
    fetchConfig.body = JSON.stringify(params)
  }

  const response = await fetch(actionUrl, fetchConfig)
  let content
  try {
    content = await response.json()
  } catch (e) {
    content = await response.text().catch(() => '')
  }

  if (!response.ok) {
    const msg = (content && content.error) || (typeof content === 'string' ? content : 'request failed')
    throw new Error(`${response.status} — ${msg}`)
  }
  return content
}

/**
 * Thin client around the ui-api action: one call per op.
 */
export function createApi (uiApiUrl, imsToken, imsOrg) {
  const headers = {}
  if (imsToken) headers.Authorization = `Bearer ${imsToken}`
  if (imsOrg) headers['x-gw-ims-org-id'] = imsOrg

  const call = (op, params = {}) =>
    actionWebInvoke(uiApiUrl, headers, { op, ...params }, { method: 'POST' })

  // Cache for the slow, effectively-static Cloud Manager lookups (programs /
  // environments / content sets / integration identity). These rarely change
  // within a session, yet each is a slow CM round-trip on a cold-startable
  // serverless action — so refetching them every time a tab is opened is what
  // makes tab switches feel slow. Live run-status (status / flows) is NEVER
  // cached. Pass { refresh: true } to bypass and refresh a cached entry.
  // We cache the in-flight promise, so concurrent callers share one request
  // and a rejection clears the entry (so the next call retries).
  const cache = new Map()
  const cached = (key, fn, refresh) => {
    if (!refresh && cache.has(key)) return cache.get(key)
    const p = Promise.resolve().then(fn).catch((e) => { cache.delete(key); throw e })
    cache.set(key, p)
    return p
  }

  return {
    status: () => call('status'),
    getConfig: () => call('config'),
    saveConfig: (config) => call('saveConfig', { config }),
    setAuto: (enabled) => call('setAuto', { enabled }),
    runJob: (jobId) => call('trigger', { jobId }),
    runAll: () => call('trigger', { runAll: true }),
    cancel: () => call('cancel'),
    clearStatus: (jobId) => call('clearStatus', jobId ? { jobId } : {}),
    reset: () => call('reset'),
    flows: () => call('flows'),
    credInfo: () => call('credInfo'),
    accessInfo: () => call('accessInfo'),
    validateCreds: (envId, programId) => call('validateCreds', { envId, programId }),
    validate: (jobId) => call('validate', { jobId }),
    programs: ({ refresh } = {}) => cached('programs', () => call('programs'), refresh),
    environments: (programId, { refresh } = {}) => cached(`env:${programId}`, () => call('environments', { programId }), refresh),
    contentSets: (programId, { refresh } = {}) => cached(`sets:${programId}`, () => call('contentSets', { programId }), refresh),
    integration: ({ refresh } = {}) => cached('integration', () => call('integration'), refresh)
  }
}
