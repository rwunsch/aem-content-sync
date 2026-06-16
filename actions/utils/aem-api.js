'use strict'

// Node 18 has fetch built-in — no node-fetch needed.

const DEFAULT_TREE_MODEL = '/var/workflow/models/publish-content-tree'

// Accepts either a Bearer token (string) or basic-auth creds ({ user, password }).
// AEMaaCS author needs Bearer (JWT service-credentials) in production; basic auth
// works on dev/sandbox envs ("Sling (Development)" realm).
function authHeaders (auth) {
  if (auth && typeof auth === 'object' && auth.user) {
    return { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.password || ''}`).toString('base64') }
  }
  return { Authorization: `Bearer ${auth}` }
}

/**
 * Start a Tree Activation (a.k.a. Publish Content Tree) workflow on the AEM author.
 *
 * Exposes the full permutation set. We send each option both as the legacy
 * Publish-Content-Tree `param.*` form AND as the newer Tree Activation `filters`
 * form, so it works whether the configured model uses the deprecated process or a
 * copied model using the Tree Activation step. Unknown params are ignored by AEM.
 *
 * opts:
 *   payload (required)   JCR path to activate
 *   agentId              'publish' | 'preview'        (the "Target")
 *   onlyActivated        bool — only re-publish already-activated nodes
 *   onlyModified         bool — only already-activated AND modified-since-activation
 *   includeChildren      bool — walk the whole subtree (default true)
 *   enableVersion        bool — create a version on activate (default false)
 *   dryRun               bool — log selections, do not replicate
 *   chunkSize            int  — paths per batch (Tree Activation step)
 *   maxQueueSize         int  — pause when queue exceeds this (Tree Activation step)
 *   model                workflow model path (default OOTB publish-content-tree)
 *
 * Returns the workflow instance path (Location header) for polling.
 */
async function startTreeActivation (authorUrl, token, opts) {
  const {
    payload,
    agentId = 'publish',
    onlyActivated = true,
    onlyModified = false,
    includeChildren = true,
    enableVersion = false,
    dryRun = false,
    chunkSize,
    maxQueueSize,
    maxTreeSize,
    model = DEFAULT_TREE_MODEL
  } = opts

  if (!payload) throw new Error('startTreeActivation: payload path is required')

  // Build the `filters` string for the Tree Activation step.
  const filterParts = []
  if (onlyActivated) filterParts.push('onlyActivated')
  if (onlyModified) filterParts.push('onlyModified')
  const filters = filterParts.join('|')

  const form = {
    model,
    payload,
    payloadType: 'JCR_PATH',
    'param.agentId': agentId,
    'param.includeChildren': String(includeChildren),
    'param.enableVersion': String(enableVersion),
    'param.dryRun': String(dryRun)
  }
  // Legacy Publish-Content-Tree boolean params:
  if (onlyActivated) form['param.onlyActivated'] = 'true'
  if (onlyModified) form['param.onlyModified'] = 'true'
  // Newer Tree Activation step args:
  if (filters) form['param.filters'] = filters
  if (chunkSize != null) form['param.chunkSize'] = String(chunkSize)
  if (maxQueueSize != null) form['param.maxQueueSize'] = String(maxQueueSize)
  if (maxTreeSize != null) form['param.maxTreeSize'] = String(maxTreeSize)

  const res = await fetch(`${authorUrl}/libs/cq/workflow/instances`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Tree Activation failed for ${payload} (agent=${agentId}): HTTP ${res.status} — ${text.slice(0, 300)}`)
  }
  return res.headers.get('location') || null
}

async function getWorkflowStatus (authorUrl, token, instancePath) {
  const res = await fetch(`${authorUrl}${instancePath}.json`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`Workflow status check failed: HTTP ${res.status}`)
  const json = await res.json()
  return json.status // 'RUNNING' | 'COMPLETED' | 'ABORTED' | 'SUSPENDED'
}

// ── the vendor's custom bulk-publish tool (preview+publish in one pass) ──────────────

async function startBulkPublish (authorUrl, token, country) {
  const form = {}
  if (country) form.country = country
  const res = await fetch(`${authorUrl}/bin/raye/bulk-publish/start`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Bulk publish start failed: HTTP ${res.status} — ${json.error || ''}`)
  return json // { success, jobId, state, startedAt }
}

async function getBulkPublishStatus (authorUrl, token) {
  const res = await fetch(`${authorUrl}/bin/raye/bulk-publish/status`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`Bulk publish status failed: HTTP ${res.status}`)
  return res.json()
}

// ── Validation harness: QueryBuilder eligibility counts (read-only) ──────────────

async function queryCount (authorUrl, token, path, property) {
  const qs = new URLSearchParams({
    path,
    property,
    'property.value': 'Activate',
    'p.limit': '0',
    'p.guessTotal': 'true',
    type: 'nt:base'
  })
  const res = await fetch(`${authorUrl}/bin/querybuilder.json?${qs.toString()}`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`QueryBuilder failed for ${property} under ${path}: HTTP ${res.status}`)
  const json = await res.json()
  // guessTotal returns `total` (may be a count or estimate string like "1000+")
  return json.total != null ? json.total : (json.results || 0)
}

/**
 * For one root, report how many nodes each eligibility interpretation selects:
 *   publishActivated  → cq:lastReplicationAction == Activate     (native onlyActivated @publish ≈ the vendor tool publish gate)
 *   publishAgentActivated → cq:lastReplicationAction_publish == Activate (the vendor tool also ORs this)
 *   previewActivated  → cq:lastReplicationAction_preview == Activate  (native onlyActivated @preview)
 *
 * the vendor tool pushes to BOTH preview and publish for the publish-activated set, whereas
 * native onlyActivated @preview gates on the preview set. The preview gap =
 * publish-activated minus preview-activated.
 */
async function validateEligibility (authorUrl, token, root) {
  const [publishActivated, publishAgentActivated, previewActivated] = await Promise.all([
    queryCount(authorUrl, token, root, 'cq:lastReplicationAction'),
    queryCount(authorUrl, token, root, 'cq:lastReplicationAction_publish'),
    queryCount(authorUrl, token, root, 'cq:lastReplicationAction_preview')
  ])
  return { root, publishActivated, publishAgentActivated, previewActivated }
}

// ── Prod-mirror publish: read the SOURCE author's activated set, replicate it on DEST ──
// Content Copy strips replication status, so "publish what was published on prod" must be
// driven from the SOURCE author's per-agent activation state, not the destination's.

const AEMAACS_AUTHOR = (programId, envId) => `https://author-p${programId}-e${envId}.adobeaemcloud.com`

const AGENT_PROP = { publish: 'cq:lastReplicationAction_publish', preview: 'cq:lastReplicationAction_preview' }

// All paths under `root` that are activated to the given agent (publish|preview) on `authorUrl`.
async function getActivatedPaths (authorUrl, token, root, agentId = 'publish') {
  const prop = AGENT_PROP[agentId] || AGENT_PROP.publish
  const qs = new URLSearchParams({
    path: root, property: prop, 'property.value': 'Activate',
    'p.limit': '-1', 'p.hits': 'selective', 'p.properties': 'jcr:path', type: 'nt:base'
  })
  const res = await fetch(`${authorUrl}/bin/querybuilder.json?${qs.toString()}`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`getActivatedPaths ${root} (${agentId}) on ${authorUrl}: HTTP ${res.status}`)
  const json = await res.json()
  const paths = (json.hits || []).map((h) => String(h['jcr:path']).replace(/\/jcr:content$/, ''))
  return [...new Set(paths)].filter(Boolean)
}

async function getCsrfToken (authorUrl, token) {
  const res = await fetch(`${authorUrl}/libs/granite/csrf/token.json`, { headers: authHeaders(token) })
  const j = await res.json().catch(() => ({}))
  return j.token || ''
}

// Replicate (activate) a single path to a given agent on `authorUrl`.
async function replicatePath (authorUrl, token, path, agentId, csrf) {
  const headers = { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' }
  if (csrf) headers['CSRF-Token'] = csrf
  const res = await fetch(`${authorUrl}/bin/replicate.json`, {
    method: 'POST', headers,
    body: new URLSearchParams({ cmd: 'Activate', path, agentId: agentId || 'publish' }).toString()
  })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`replicate ${path} (${agentId}) on ${authorUrl}: HTTP ${res.status} — ${t.slice(0, 150)}`) }
  return true
}

// Replicate MANY paths to an agent in ONE request — /bin/replicate.json accepts repeated
// `path` params and queues them all. This is what makes prod-mirror scale (one round-trip
// per chunk instead of per path; AEM's replication agents process the queue asynchronously).
async function replicatePaths (authorUrl, token, paths, agentId, csrf) {
  if (!paths || !paths.length) return true
  const headers = { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' }
  if (csrf) headers['CSRF-Token'] = csrf
  const body = new URLSearchParams()
  body.append('cmd', 'Activate')
  body.append('agentId', agentId || 'publish')
  for (const p of paths) body.append('path', p)
  const res = await fetch(`${authorUrl}/bin/replicate.json`, { method: 'POST', headers, body: body.toString() })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`replicate ${paths.length} paths (${agentId}) on ${authorUrl}: HTTP ${res.status} — ${t.slice(0, 150)}`) }
  return true
}

module.exports = {
  startTreeActivation,
  getWorkflowStatus,
  startBulkPublish,
  getBulkPublishStatus,
  validateEligibility,
  AEMAACS_AUTHOR,
  getActivatedPaths,
  getCsrfToken,
  replicatePath,
  replicatePaths,
  // back-compat alias (old name used elsewhere)
  triggerTreeActivation: (authorUrl, token, path) => startTreeActivation(authorUrl, token, { payload: path })
}
