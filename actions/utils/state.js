'use strict'

const stateLib = require('@adobe/aio-lib-state')

// NOTE: aio-lib-state v5 keys must match ^[a-zA-Z0-9-_.]+$ — colons are NOT allowed.
const KEYS = {
  PHASE: 'sync_phase',
  COPY_INDEX: 'sync_copyIndex',
  FLOW_ID: 'sync_currentFlowId',
  PUBLISH_INDEX: 'sync_publishIndex',
  RUN_ID: 'sync_runId',
  STARTED_AT: 'sync_startedAt',
  LOG: 'sync_log',
  LOCK: 'sync_lock', // best-effort processing lock (ms timestamp) to serialise concurrent orchestrator invocations
  // Jobs model:
  ACTIVE_JOB_ID: 'sync_activeJobId', // job currently running
  QUEUE: 'sync_queue', // pending job ids
  RUN_SETS: 'sync_runSets', // content-set snapshot for the active run
  RUN_PATHS: 'sync_runPaths', // publish-path snapshot for the active run
  RUN_PUBLISH: 'sync_runPublish', // publish-config snapshot (mode/targets/filters) for the active run
  RUN_ENV: 'sync_runEnv', // env snapshot { programId, sourceEnvId, destEnvId } for the active job's run
  RUN_ONLY_ACTIVATED: 'sync_runOnlyActivated', // legacy, retained for compatibility
  RUN_PUBLISHED: 'sync_runPublished', // publish step counters (prod-mirror / tree activation)
  RUN_ERRORS: 'sync_runErrors',
  PROD_MIRROR_PROGRESS: 'sync_prodMirrorProgress', // incremental prod-mirror cursor (survives self-chain)
  JOB_STATUS: 'sync_jobStatus', // map: jobId -> { lastRunAt, lastStatus, lastRunId, lastError }
  LAST_TICK: 'sync_lastTick' // last scheduler evaluation time (ms)
}

const PHASES = {
  IDLE: 'IDLE',
  CHECK_STUCK: 'CHECK_STUCK',
  COPYING: 'COPYING',
  PUBLISHING: 'PUBLISHING',
  NOTIFYING_SUCCESS: 'NOTIFYING_SUCCESS',
  NOTIFYING_FAILURE: 'NOTIFYING_FAILURE'
}

// TTL: 48 hours for run-scoped keys — auto-expires stale state if a run gets stuck.
const STATE_TTL = 48 * 60 * 60
// Long TTL for cross-run keys (job status, queue, last tick).
const LONG_TTL = 364 * 24 * 60 * 60

async function getStore () {
  return stateLib.init()
}

function safeJson (raw, fallback) {
  if (raw == null || raw === '') return fallback
  try { return JSON.parse(raw) } catch (_) { return fallback }
}

async function getState () {
  const store = await stateLib.init()
  const phase = (await store.get(KEYS.PHASE))?.value || PHASES.IDLE
  const copyIndex = parseInt((await store.get(KEYS.COPY_INDEX))?.value || '0', 10)
  const flowId = (await store.get(KEYS.FLOW_ID))?.value || null
  const publishIndex = parseInt((await store.get(KEYS.PUBLISH_INDEX))?.value || '0', 10)
  const runId = (await store.get(KEYS.RUN_ID))?.value || null
  const startedAt = (await store.get(KEYS.STARTED_AT))?.value || null
  const log = safeJson((await store.get(KEYS.LOG))?.value, [])
  const activeJobId = (await store.get(KEYS.ACTIVE_JOB_ID))?.value || null
  const queue = safeJson((await store.get(KEYS.QUEUE))?.value, [])
  const runSets = safeJson((await store.get(KEYS.RUN_SETS))?.value, [])
  const runPaths = safeJson((await store.get(KEYS.RUN_PATHS))?.value, [])
  const runPublish = safeJson((await store.get(KEYS.RUN_PUBLISH))?.value, null)
  const runEnv = safeJson((await store.get(KEYS.RUN_ENV))?.value, null)
  const runOnlyActivated = ((await store.get(KEYS.RUN_ONLY_ACTIVATED))?.value || 'true') === 'true'
  const runPublishedRaw = (await store.get(KEYS.RUN_PUBLISHED))?.value
  const runPublished = runPublishedRaw != null && runPublishedRaw !== '' ? parseInt(runPublishedRaw, 10) : null
  const runErrorsRaw = (await store.get(KEYS.RUN_ERRORS))?.value
  const runErrors = runErrorsRaw != null && runErrorsRaw !== '' ? parseInt(runErrorsRaw, 10) : null
  const prodMirrorProgress = safeJson((await store.get(KEYS.PROD_MIRROR_PROGRESS))?.value, null)
  const lockAt = parseInt((await store.get(KEYS.LOCK))?.value || '0', 10)
  return {
    store, phase, copyIndex, flowId, publishIndex, runId, startedAt, log,
    activeJobId, queue, runSets, runPaths, runPublish, runEnv, runOnlyActivated,
    runPublished, runErrors, prodMirrorProgress, lockAt
  }
}

async function setState (store, updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      await store.delete(key)
    } else {
      await store.put(key, typeof value === 'object' ? JSON.stringify(value) : String(value), { ttl: STATE_TTL })
    }
  }
}

async function appendLog (store, existingLog, message) {
  const entry = `[${new Date().toISOString()}] ${message}`
  const updated = [...existingLog, entry].slice(-50)
  await setState(store, { [KEYS.LOG]: updated })
  console.log(entry)
  return updated
}

// ── cross-run helpers (long TTL) ────────────────────────────────────────────

async function getJobStatusMap (store) {
  return JSON.parse((await store.get(KEYS.JOB_STATUS))?.value || '{}')
}

async function setJobStatus (store, jobId, status) {
  const map = await getJobStatusMap(store)
  map[jobId] = { ...(map[jobId] || {}), ...status }
  await store.put(KEYS.JOB_STATUS, JSON.stringify(map), { ttl: LONG_TTL })
  return map
}

// Clear the stored status for one job (or all jobs if jobId is omitted).
// Only touches the per-job status display map — leaves run state / queue /
// config untouched.
async function clearJobStatus (store, jobId) {
  const map = await getJobStatusMap(store)
  if (jobId) { delete map[jobId] } else { for (const k of Object.keys(map)) delete map[k] }
  await store.put(KEYS.JOB_STATUS, JSON.stringify(map), { ttl: LONG_TTL })
  return map
}

async function getQueue (store) {
  return JSON.parse((await store.get(KEYS.QUEUE))?.value || '[]')
}

async function setQueue (store, queue) {
  await store.put(KEYS.QUEUE, JSON.stringify(queue), { ttl: LONG_TTL })
}

async function getLastTick (store) {
  return parseInt((await store.get(KEYS.LAST_TICK))?.value || '0')
}

async function setLastTick (store, ms) {
  await store.put(KEYS.LAST_TICK, String(ms), { ttl: LONG_TTL })
}

// Reset only the run-scoped keys (keep queue, job status, last tick).
async function resetRun (store) {
  for (const k of [KEYS.PHASE, KEYS.COPY_INDEX, KEYS.FLOW_ID, KEYS.PUBLISH_INDEX,
    KEYS.RUN_ID, KEYS.STARTED_AT, KEYS.LOG, KEYS.ACTIVE_JOB_ID,
    KEYS.RUN_SETS, KEYS.RUN_PATHS, KEYS.RUN_PUBLISH, KEYS.RUN_ENV, KEYS.RUN_ONLY_ACTIVATED,
    KEYS.RUN_PUBLISHED, KEYS.RUN_ERRORS, KEYS.PROD_MIRROR_PROGRESS, KEYS.LOCK]) {
    await store.delete(k)
  }
}

// Full reset (everything, including queue/job status) — used by UI "cancel/reset all".
async function resetState (store) {
  for (const key of Object.values(KEYS)) {
    await store.delete(key)
  }
}

module.exports = {
  KEYS, PHASES, getStore, getState, setState, appendLog,
  getJobStatusMap, setJobStatus, clearJobStatus, getQueue, setQueue, getLastTick, setLastTick,
  resetRun, resetState
}
