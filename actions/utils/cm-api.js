'use strict'

const cloudManager = require('@adobe/aio-lib-cloudmanager')
const { getCMToken } = require('./auth')

async function getClient (params) {
  const token = await getCMToken(params)
  return cloudManager.init(params.IMS_ORG_ID, params.CM_CLIENT_ID, token)
}

// `env` carries the per-job environment pair { programId, sourceEnvId, destEnvId }.
// Content Copy is author-to-author only, so tier is always 'author'.
async function startContentFlow (params, env, contentSet) {
  const client = await getClient(params)
  const result = await client.createContentFlow(
    env.programId,
    env.sourceEnvId,
    {
      contentSetId: contentSet.id,
      destEnvironmentId: env.destEnvId,
      includeACL: false,
      tier: 'author',
      // Wipe the destination content-set paths before import when the set is
      // flagged for it. Native Content Backflow option: the gateway builds it
      // into the export CR and AEM deletes the target paths
      // (/adobe/contentbackflow/wipe) before installing — scoped to exactly the
      // content set's root paths.
      wipeDestination: !!contentSet.wipeDestination
    }
  )
  // The CM API returns `contentFlowId` (not `id`); fall back to id just in case.
  return result.contentFlowId || result.id
}

// Content-flow status from the API is 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' |
// 'CANCELLED' (NOT 'RUNNING'/'SUCCEEDED'). The lib methods take (programId,
// contentFlowId) — the flow id alone identifies it, no env arg.
async function getContentFlowStatus (params, env, flowId) {
  if (!flowId) throw new Error('Content flow id is required')
  const client = await getClient(params)
  const flow = await client.getContentFlow(env.programId, flowId)
  return flow && flow.status ? flow.status : 'UNKNOWN'
}

async function listRunningFlows (params, env) {
  const client = await getClient(params)
  const flows = await client.listContentFlows(env.programId)
  // Normalise the id (the CM API field is `contentFlowId`, not `id`) and only
  // count flows that are genuinely active:
  //  - must have an id (a malformed/idless entry caused spurious "Active flow
  //    undefined" aborts);
  //  - status IN_PROGRESS/RUNNING;
  //  - NOT a zombie — CM can leave a rejected flow (e.g. errorCode CONCURRENT-100)
  //    at status IN_PROGRESS even though its export/import phase already FAILED;
  //    such a flow never progresses and must not block new runs.
  const dead = (f) => {
    const r = f.resultDetails || {}
    return (r.exportResult && r.exportResult.phase === 'FAILED') ||
           (r.importResult && r.importResult.phase === 'FAILED')
  }
  return (flows || [])
    .filter(f => f && (f.status === 'IN_PROGRESS' || f.status === 'RUNNING'))
    .map(f => ({ ...f, id: f.id || f.contentFlowId }))
    .filter(f => f.id && !dead(f))
}

async function cancelContentFlow (params, env, flowId) {
  const client = await getClient(params)
  await client.cancelContentFlow(env.programId, flowId)
}

async function listPrograms (params) {
  const client = await getClient(params)
  const programs = await client.listPrograms()
  return (programs || []).map(p => ({ id: String(p.id), name: p.name || `Program ${p.id}` }))
}

async function listEnvironments (params, programId) {
  const client = await getClient(params)
  const envs = await client.listEnvironments(programId)
  return (envs || []).map(e => ({ id: String(e.id), name: e.name || `env ${e.id}`, type: e.type, status: e.status }))
}

// Content Sets are program-scoped. Returns the existing Cloud Manager content
// sets so the UI can offer them as a selectable list (instead of typing an id).
async function listContentSets (params, programId) {
  const client = await getClient(params)
  const sets = await client.listContentSets(programId)
  return (sets || []).map(s => {
    const paths = Array.isArray(s.paths)
      ? s.paths.map(p => (typeof p === 'string' ? p : (p.path || p.rootPath || ''))).filter(Boolean)
      : []
    return { id: String(s.id), name: s.name || `Content set ${s.id}`, paths }
  })
}

module.exports = { startContentFlow, getContentFlowStatus, listRunningFlows, cancelContentFlow, listPrograms, listEnvironments, listContentSets }
