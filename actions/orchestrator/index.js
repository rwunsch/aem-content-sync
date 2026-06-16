'use strict'

/*
 * Orchestrator — scheduler + per-job state machine.
 *
 * Invoked every ~15 min by the cron alarm (source=cron), and on demand by the UI
 * (params.jobId to run one job now, or params.runAll). On each invocation:
 *   1. Enqueue work: cron → due jobs (per each job's own schedule); manual → the
 *      requested job(s). Dedup against the queue + the active run.
 *   2. If a run is active (phase != IDLE), advance it one step using the snapshot
 *      captured at run start (so config edits mid-run don't corrupt it).
 *   3. If idle, pop the next queued job and start it.
 *
 * Only ONE job runs at a time — Cloud Manager allows a single content flow per
 * source env, so overlapping jobs queue and run sequentially.
 */

const {
  KEYS, PHASES, getState, setState, appendLog,
  getQueue, setQueue, getLastTick, setLastTick, setJobStatus, resetRun
} = require('../utils/state')
const { startContentFlow, getContentFlowStatus, listRunningFlows, cancelContentFlow } = require('../utils/cm-api')
const { startTreeActivation, getWorkflowStatus, startBulkPublish, getBulkPublishStatus, AEMAACS_AUTHOR, getActivatedPaths, getCsrfToken, replicatePaths } = require('../utils/aem-api')

// prod-mirror replicates many paths per /bin/replicate.json request to scale.
const REPLICATE_CHUNK = 200
const { getCMToken, getAemToken } = require('../utils/auth')

// AEM author auth, resolved per role (source / dest). Preference order:
//   1. per-env AEM Dev Console Service Credentials (JWT)  — production
//   2. AEM_TOKEN (static Bearer)
//   3. AEM_USER/AEM_PASSWORD (basic — dev/sandbox only)
//   4. Cloud Manager S2S token (will 403 on the author; last-resort only)
async function aemAuthFor (params, role, envObj, credsMap) {
  const envId = role === 'source' ? (envObj && envObj.sourceEnvId) : (envObj && envObj.destEnvId)
  const fromCfg = credsMap && envId && credsMap[envId]
  if (fromCfg) { try { return await getAemToken(typeof fromCfg === 'string' ? JSON.parse(fromCfg) : fromCfg) } catch (e) { console.error(`AEM JWT for env ${envId} failed, falling back: ${e.message}`) } }
  const raw = role === 'source' ? params.AEM_SOURCE_SERVICE_CREDS : params.AEM_DEST_SERVICE_CREDS
  if (raw) { try { return await getAemToken(typeof raw === 'string' ? JSON.parse(raw) : raw) } catch (e) { console.error(`AEM JWT (${role}) failed, falling back: ${e.message}`) } }
  if (params.AEM_TOKEN) return params.AEM_TOKEN
  if (params.AEM_USER) return { user: params.AEM_USER, password: params.AEM_PASSWORD }
  return await getCMToken(params)
}

// Destination author URL + auth for publish steps (tree activation, bulk publish, prod-mirror).
async function destAuthorContext (params, store, st) {
  const env = st.runEnv || {}
  if (!env.programId || !env.destEnvId) throw new Error('Missing destination environment for AEM author')
  const credsMap = (await getEffectiveConfig(store)).aemServiceCreds || {}
  return {
    url: AEMAACS_AUTHOR(env.programId, env.destEnvId),
    auth: await aemAuthFor(params, 'dest', env, credsMap)
  }
}
const { sendSlack, buildSuccessMessage, buildFailureMessage } = require('../utils/notify')
const { getEffectiveConfig, getAutoEnabled, findJob, jobPublishPaths } = require('../utils/config')
const { isDue } = require('../utils/cron')

async function main (params) {
  const logger = console
  logger.log(`[orchestrator] invoked — source: ${params.source || 'unknown'}`)

  const st = await getState()
  const { store, phase } = st
  const config = await getEffectiveConfig(store)

  try {
    // ── 1. Enqueue work ───────────────────────────────────────────────────────
    if (params.jobId) {
      await enqueue(store, [params.jobId], st)
    } else if (params.manual && params.runAll) {
      await enqueue(store, config.jobs.filter(j => j.enabled).map(j => j.id), st)
    } else if (params.source === 'cron') {
      const autoEnabled = await getAutoEnabled(store)
      if (autoEnabled) {
        const due = await evaluateSchedule(store, config)
        if (due.length) {
          logger.log(`[orchestrator] scheduler: due jobs = ${due.join(', ')}`)
          await enqueue(store, due, st)
        }
      } else {
        logger.log('[orchestrator] auto-sync paused — scheduler skipped')
      }
    }

    // ── 2/3. Advance or start — serialised by a best-effort lock. Re-read state
    // after enqueue so phase/lock reflect any concurrent invocation.
    const stNow = await getState()
    if (stNow.lockAt && (Date.now() - stNow.lockAt) < 50000) {
      return { statusCode: 200, body: { busy: true } }
    }
    await setState(stNow.store, { [KEYS.LOCK]: String(Date.now()) })
    let result
    try {
      // Advance an active run, else start the next queued job.
      result = (stNow.phase !== PHASES.IDLE)
        ? await advance(params, stNow.store, config, stNow)
        : await startNext(stNow.store, config)
    } finally {
      await setState(stNow.store, { [KEYS.LOCK]: '0' })
    }

    // ── 4. Self-chain — if the run is still active, fire EXACTLY ONE successor
    // invocation (non-blocking). One step → one successor = a single linear chain
    // (no concurrency, so no duplicate flows), and it advances the run promptly
    // without depending on the coarse scheduler alarm. The chain ends when the run
    // reaches IDLE (no successor fired). An overlapping alarm tick is absorbed by
    // the lock above.
    try {
      const after = await getState()
      const apihost = process.env.__OW_API_HOST
      const apikey = process.env.__OW_API_KEY
      const ns = process.env.__OW_NAMESPACE
      if (after.phase !== PHASES.IDLE && apihost && apikey && ns) {
        const url = `${apihost.replace(/\/$/, '')}/api/v1/namespaces/${ns}/actions/aem-content-sync/orchestrator?blocking=false`
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(apikey).toString('base64') },
          body: JSON.stringify({ source: 'self-chain' })
        }).catch(() => {})
      }
    } catch (_) { /* self-chain is best-effort; the alarm backstops */ }

    return result
  } catch (err) {
    logger.error(`[orchestrator] Unhandled error in phase ${phase}:`, err)
    const errSt = await getState()
    await setState(errSt.store, {
      [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE,
      [KEYS.LOG]: [...errSt.log, `[${new Date().toISOString()}] FATAL: ${err.message}`]
    })
    return { statusCode: 200, body: { error: 'Run failed' } }
  }
}

// ── Scheduling helpers ────────────────────────────────────────────────────────

async function evaluateSchedule (store, config) {
  const now = Date.now()
  const lastTick = await getLastTick(store)
  await setLastTick(store, now)
  // First-ever tick: just establish a baseline, don't fire retroactively.
  if (!lastTick) return []
  const due = []
  for (const job of config.jobs) {
    if (job.enabled && isDue(job.schedule, lastTick, now)) due.push(job.id)
  }
  return due
}

async function enqueue (store, jobIds, st) {
  const queue = await getQueue(store)
  const active = st.activeJobId
  for (const id of jobIds) {
    if (id !== active && !queue.includes(id)) queue.push(id)
  }
  await setQueue(store, queue)
  return queue
}

async function startNext (store, config) {
  let queue = await getQueue(store)
  while (queue.length) {
    const jobId = queue.shift()
    const job = findJob(config, jobId)
    if (!job) {
      console.warn(`[orchestrator] queued job ${jobId} no longer exists — skipping`)
      continue
    }
    await setQueue(store, queue)
    const runId = new Date().toISOString()
    const publishPaths = jobPublishPaths(job)
    await setState(store, {
      [KEYS.PHASE]: PHASES.CHECK_STUCK,
      [KEYS.ACTIVE_JOB_ID]: job.id,
      [KEYS.RUN_ID]: runId,
      [KEYS.STARTED_AT]: runId,
      [KEYS.COPY_INDEX]: '0',
      [KEYS.PUBLISH_INDEX]: '0',
      [KEYS.FLOW_ID]: null,
      [KEYS.LOG]: [`[${runId}] Starting job "${job.name}" (${job.contentSets.length} content set(s), ${publishPaths.length} publish path(s))`],
      [KEYS.RUN_SETS]: job.contentSets,
      [KEYS.RUN_PATHS]: publishPaths,
      [KEYS.RUN_PUBLISH]: job.publish,
      [KEYS.RUN_ENV]: { programId: job.programId, sourceEnvId: job.sourceEnvId, destEnvId: job.destEnvId }
    })
    await setJobStatus(store, job.id, { lastStatus: 'RUNNING', lastRunId: runId, lastRunAt: runId, lastError: null })
    console.log(`[orchestrator] started job ${job.id} run ${runId}`)
    return { statusCode: 200, body: { started: true, jobId: job.id, runId } }
  }
  await setQueue(store, queue)
  return { statusCode: 200, body: { idle: true } }
}

// ── Run advancement (per active job, using the run snapshot) ────────────────────

async function advance (params, store, config, st) {
  const { phase } = st
  switch (phase) {
    case PHASES.CHECK_STUCK: return handleCheckStuck(params, store, config, st)
    case PHASES.COPYING: return handleCopying(params, store, config, st)
    case PHASES.PUBLISHING: return handlePublishing(params, store, config, st)
    case PHASES.NOTIFYING_SUCCESS: return handleNotify(params, store, config, st, true)
    case PHASES.NOTIFYING_FAILURE: return handleNotify(params, store, config, st, false)
    default:
      console.error(`[orchestrator] Unknown phase: ${phase}`)
      return { statusCode: 200, body: { phase, skipped: true } }
  }
}

async function handleCheckStuck (params, store, config, st) {
  const updatedLog = await appendLog(store, st.log, 'Checking for stuck content flows...')
  const runningFlows = await listRunningFlows(params, st.runEnv)
  if (runningFlows.length > 0) {
    for (const flow of runningFlows) {
      const createdMs = flow.createdAt ? new Date(flow.createdAt).getTime() : NaN
      const ageHours = Number.isFinite(createdMs) ? (Date.now() - createdMs) / 3600000 : NaN
      if (!Number.isFinite(ageHours)) {
        await appendLog(store, updatedLog, `Active flow ${flow.id} has no valid createdAt — aborting this run`)
        await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
        return { statusCode: 200, body: { aborted: true, reason: 'invalid_flow_timestamp', flowId: flow.id } }
      }
      if (ageHours > config.stuckFlowThresholdHours) {
        await appendLog(store, updatedLog, `Cancelling stuck flow ${flow.id} (age: ${ageHours.toFixed(1)}h)`)
        await cancelContentFlow(params, st.runEnv, flow.id)
      } else {
        await appendLog(store, updatedLog, `Active flow ${flow.id} found (age: ${ageHours.toFixed(1)}h) — aborting this run`)
        await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
        return { statusCode: 200, body: { aborted: true, reason: 'concurrent_flow', flowId: flow.id } }
      }
    }
  }
  await appendLog(store, updatedLog, 'No stuck flows. Proceeding to content copy.')
  await setState(store, { [KEYS.PHASE]: PHASES.COPYING })
  return { statusCode: 200, body: { phase: PHASES.COPYING } }
}

async function handleCopying (params, store, config, st) {
  const { copyIndex, flowId, runSets, log } = st
  const contentSet = runSets[copyIndex]

  if (!contentSet) {
    await appendLog(store, log, `All ${runSets.length} content sets copied. Moving to PUBLISHING.`)
    await setState(store, { [KEYS.PHASE]: PHASES.PUBLISHING, [KEYS.PUBLISH_INDEX]: '0' })
    return { statusCode: 200, body: { phase: PHASES.PUBLISHING } }
  }

  const csLabel = contentSet.id || (Array.isArray(contentSet.paths) ? contentSet.paths.join(', ') : '')

  if (!contentSet.id) {
    await appendLog(store, log, `Content set [${copyIndex}] missing id — cannot start copy`)
    await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
    return { statusCode: 200, body: { failed: true, reason: 'missing_content_set_id' } }
  }

  const env = st.runEnv || {}

  if (flowId) {
    const status = await getContentFlowStatus(params, st.runEnv, flowId)
    let curLog = await appendLog(store, log, `Content set [${copyIndex}] "${csLabel}" — flow ${flowId} status: ${status}`)
    if (status === 'COMPLETED' || status === 'SUCCEEDED') {
      await appendLog(store, curLog, `Copy of set "${csLabel}" completed (flow ${flowId}).`)
      await setState(store, { [KEYS.COPY_INDEX]: String(copyIndex + 1), [KEYS.FLOW_ID]: null })
      return { statusCode: 200, body: { flowId, status, nextIndex: copyIndex + 1 } }
    }
    if (status === 'FAILED' || status === 'CANCELLED') {
      await appendLog(store, curLog, `FAILED on content set [${copyIndex}] "${csLabel}"`)
      await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
      return { statusCode: 200, body: { failed: true, flowId, status } }
    }
    if (status === 'UNKNOWN') {
      await appendLog(store, curLog, `Content flow ${flowId} returned unknown status — aborting`)
      await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
      return { statusCode: 200, body: { failed: true, flowId, status } }
    }
    // Still running. Throttle the self-chain poll cadence to ~12s so it doesn't
    // hammer Cloud Manager or flood the run log (the `status:` line above already
    // narrates one concise progress line per poll). Sleeping here is well within the
    // action timeout and keeps the lock held so an alarm tick stays a no-op.
    await new Promise((resolve) => setTimeout(resolve, 12000))
    return { statusCode: 200, body: { polling: true, flowId, status } }
  }

  let curLog = await appendLog(store, log, `Copying content set "${csLabel}" from env ${env.sourceEnvId} → ${env.destEnvId} (this can take several minutes)`)
  curLog = await appendLog(store, curLog, `Starting content copy [${copyIndex}/${runSets.length}]: "${csLabel}"`)
  const newFlowId = await startContentFlow(params, st.runEnv, contentSet)
  await appendLog(store, curLog, `Content flow started: ${newFlowId}`)
  await setState(store, { [KEYS.FLOW_ID]: newFlowId })
  return { statusCode: 200, body: { started: true, flowId: newFlowId, contentSet: csLabel } }
}

async function handlePublishing (params, store, config, st) {
  const { publishIndex, flowId, runPaths, runPublish, log } = st
  const publish = runPublish || { mode: 'prodMirror', targets: ['publish'], onlyModified: false, includeChildren: true }
  const mode = publish.mode || 'prodMirror'

  if (mode === 'bulkPublish') {
    return handleBulkPublish(params, store, st, publish)
  }

  if (mode === 'prodMirror') {
    return handleProdMirror(params, store, st, publish)
  }

  // publishAll / onlyChanged → Tree Activation. Filters are derived from the mode:
  //   publishAll  → onlyActivated=false, onlyModified=false (publish everything under the roots)
  //   onlyChanged → onlyActivated=true,  onlyModified=true  (only already-activated + modified)
  const onlyActivated = (mode === 'onlyChanged')
  const onlyModified = (mode === 'onlyChanged')

  // Tree Activation: flat list of (path × target-agent) steps, run sequentially.
  const targets = publish.targets && publish.targets.length ? publish.targets : ['publish']
  const steps = []
  for (const p of runPaths) for (const agent of targets) steps.push({ path: p, agent })

  const step = steps[publishIndex]
  if (!step) {
    await appendLog(store, log, `All ${steps.length} publish step(s) complete. Moving to NOTIFYING_SUCCESS.`)
    await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_SUCCESS })
    return { statusCode: 200, body: { phase: PHASES.NOTIFYING_SUCCESS } }
  }

  // Poll an in-flight workflow instance (flowId reused to hold the instance path).
  if (flowId) {
    const { url, auth } = await destAuthorContext(params, store, st)
    const status = await getWorkflowStatus(url, auth, flowId)
    await appendLog(store, log, `Publish [${publishIndex + 1}/${steps.length}] target=${step.agent} ${step.path} — workflow ${status}`)
    if (status === 'COMPLETED') {
      await setState(store, { [KEYS.PUBLISH_INDEX]: String(publishIndex + 1), [KEYS.FLOW_ID]: null })
      return { statusCode: 200, body: { completed: step } }
    }
    if (status === 'ABORTED') {
      await appendLog(store, log, `Publish FAILED (aborted) on target=${step.agent} ${step.path}`)
      await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
      return { statusCode: 200, body: { failed: true, step } }
    }
    return { statusCode: 200, body: { polling: true, step, status } }
  }

  // Start Tree Activation for this (path, agent) with the mode-derived filters.
  const { url, auth } = await destAuthorContext(params, store, st)
  const filtersLabel = [onlyActivated && 'onlyActivated', onlyModified && 'onlyModified'].filter(Boolean).join('|') || 'none'
  await appendLog(store, log, `Starting Tree Activation [${publishIndex + 1}/${steps.length}] mode=${mode} target=${step.agent} filters=${filtersLabel}${publish.dryRun ? ' DRY-RUN' : ''}: ${step.path}`)
  const instance = await startTreeActivation(url, auth, {
    payload: step.path,
    agentId: step.agent,
    onlyActivated,
    onlyModified,
    includeChildren: publish.includeChildren,
    enableVersion: publish.enableVersion,
    dryRun: publish.dryRun,
    chunkSize: publish.chunkSize,
    maxQueueSize: publish.maxQueueSize,
    maxTreeSize: publish.maxTreeSize,
    model: publish.model || undefined
  })
  if (!instance) {
    // No instance path (some configs complete synchronously) — advance.
    await appendLog(store, log, 'Tree Activation returned no instance path — advancing.')
    await setState(store, { [KEYS.PUBLISH_INDEX]: String(publishIndex + 1) })
    return { statusCode: 200, body: { started: true, step, advanced: true } }
  }
  await appendLog(store, log, `Tree Activation workflow: ${instance}`)
  await setState(store, { [KEYS.FLOW_ID]: instance })
  return { statusCode: 200, body: { started: true, step, instance } }
}

async function handleBulkPublish (params, store, st, publish) {
  const { flowId, log } = st
  const { url, auth } = await destAuthorContext(params, store, st)
  if (!flowId) {
    await appendLog(store, log, `Starting the vendor's bulk-publish${publish.country ? ` (country=${publish.country})` : ' (full)'}…`)
    const res = await startBulkPublish(url, auth, publish.country)
    await appendLog(store, log, `Bulk-publish started: job ${res.jobId || ''}`)
    await setState(store, { [KEYS.FLOW_ID]: res.jobId || 'bulk' })
    return { statusCode: 200, body: { started: true, bulk: res } }
  }
  const status = await getBulkPublishStatus(url, auth)
  await appendLog(store, log, `Bulk-publish: state=${status.state} preview=${status.publishedPreviewSuccess} publish=${status.publishedPublishSuccess} errors=${(status.errors || []).length}`)
  if (status.done) {
    if (status.state === 'ERROR') {
      await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
      return { statusCode: 200, body: { failed: true } }
    }
    await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_SUCCESS, [KEYS.FLOW_ID]: null })
    return { statusCode: 200, body: { complete: true } }
  }
  return { statusCode: 200, body: { polling: true, state: status.state } }
}

// Prod-mirror: read the SOURCE author's per-agent activated set and replicate it on the DEST.
// Work is spread across self-chain invocations (one query root or one replicate chunk per step)
// so large path sets don't hit the action timeout.
async function handleProdMirror (params, store, st, publish) {
  const { runPaths, runEnv, log, prodMirrorProgress } = st
  const env = runEnv || {}
  if (!env.programId || !env.sourceEnvId || !env.destEnvId) {
    await appendLog(store, log, 'prod-mirror: missing programId/source/dest env — cannot publish')
    await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
    return { statusCode: 200, body: { failed: true, reason: 'missing_env' } }
  }

  const credsMap = (await getEffectiveConfig(store)).aemServiceCreds || {}
  const srcAuth = await aemAuthFor(params, 'source', env, credsMap)
  const dstAuth = await aemAuthFor(params, 'dest', env, credsMap)
  const src = AEMAACS_AUTHOR(env.programId, env.sourceEnvId)
  const dst = AEMAACS_AUTHOR(env.programId, env.destEnvId)
  const targets = (publish.targets && publish.targets.length) ? publish.targets : ['publish']
  const roots = runPaths || []

  let progress = prodMirrorProgress
  if (!progress) {
    let curLog = await appendLog(store, log, `Publishing (prod-mirror): reading what is published on ${env.sourceEnvId} and mirroring onto ${env.destEnvId}.`)
    curLog = await appendLog(store, curLog, `prod-mirror: source=${src} → dest=${dst}, agents=[${targets.join(',')}]`)
    let csrf = ''
    try { csrf = await getCsrfToken(dst, dstAuth) } catch (e) {
      await appendLog(store, curLog, `prod-mirror: CSRF token failed — ${e.message}`)
      await setState(store, { [KEYS.PHASE]: PHASES.NOTIFYING_FAILURE })
      return { statusCode: 200, body: { failed: true, reason: 'csrf' } }
    }
    progress = {
      targets,
      agentIdx: 0,
      rootIdx: 0,
      pathIdx: 0,
      phase: 'query',
      pathsByAgent: {},
      agentStats: {},
      csrf,
      published: 0,
      errors: 0
    }
  }

  const agent = progress.targets[progress.agentIdx]
  if (!agent) {
    await appendLog(store, log, `prod-mirror complete: ${publish.dryRun ? 'DRY-RUN ' : ''}published ${progress.published}, errors ${progress.errors}`)
    const failed = progress.errors > 0 && progress.published === 0
    await setState(store, {
      [KEYS.PHASE]: failed ? PHASES.NOTIFYING_FAILURE : PHASES.NOTIFYING_SUCCESS,
      [KEYS.RUN_PUBLISHED]: String(progress.published),
      [KEYS.RUN_ERRORS]: String(progress.errors),
      [KEYS.PROD_MIRROR_PROGRESS]: null
    })
    return { statusCode: 200, body: { prodMirror: true, published: progress.published, errors: progress.errors, agents: progress.agentStats, dryRun: !!publish.dryRun, complete: true } }
  }

  if (progress.phase === 'query') {
    const root = roots[progress.rootIdx]
    if (!root) {
      const paths = progress.pathsByAgent[agent] || []
      const totalFound = paths.length
      if (totalFound === 0) {
        await appendLog(store, log, `prod-mirror: no ${agent}-activated content on source — skipping ${agent}`)
        progress.agentStats[agent] = { found: 0, published: 0, errors: progress.queryErrors || 0, skipped: true }
        progress.agentIdx++
        progress.rootIdx = 0
        progress.pathIdx = 0
        progress.phase = 'query'
        progress.queryErrors = 0
      } else {
        await appendLog(store, log, `prod-mirror: ${totalFound} ${agent}-activated path(s) on source — replicating on dest`)
        progress.phase = 'replicate'
        progress.pathIdx = 0
      }
      await setState(store, { [KEYS.PROD_MIRROR_PROGRESS]: progress })
      return { statusCode: 200, body: { prodMirror: true, polling: true, phase: 'query', agent } }
    }
    try {
      const paths = await getActivatedPaths(src, srcAuth, root, agent)
      await appendLog(store, log, `prod-mirror: ${paths.length} ${agent}-activated under ${root}`)
      progress.pathsByAgent[agent] = [...(progress.pathsByAgent[agent] || []), ...paths]
    } catch (e) {
      progress.errors++
      progress.queryErrors = (progress.queryErrors || 0) + 1
      if (progress.queryErrors <= 5) await appendLog(store, log, `query FAILED ${agent} ${root}: ${e.message}`)
    }
    progress.rootIdx++
    await setState(store, { [KEYS.PROD_MIRROR_PROGRESS]: progress, [KEYS.RUN_ERRORS]: String(progress.errors) })
    return { statusCode: 200, body: { prodMirror: true, polling: true, phase: 'query', agent, root } }
  }

  const paths = progress.pathsByAgent[agent] || []
  if (progress.pathIdx >= paths.length) {
    progress.agentStats[agent] = {
      found: paths.length,
      published: progress.agentPublished || 0,
      errors: (progress.queryErrors || 0) + (progress.agentErrors || 0),
      skipped: false
    }
    await appendLog(store, log, `prod-mirror: replicated ${progress.agentPublished || 0} ${agent} path(s) on dest`)
    progress.agentIdx++
    progress.rootIdx = 0
    progress.pathIdx = 0
    progress.phase = 'query'
    progress.agentPublished = 0
    progress.agentErrors = 0
    progress.queryErrors = 0
    await setState(store, {
      [KEYS.PROD_MIRROR_PROGRESS]: progress,
      [KEYS.RUN_PUBLISHED]: String(progress.published),
      [KEYS.RUN_ERRORS]: String(progress.errors)
    })
    return { statusCode: 200, body: { prodMirror: true, polling: true, phase: 'replicate', agent, doneAgent: true } }
  }

  const chunk = paths.slice(progress.pathIdx, progress.pathIdx + REPLICATE_CHUNK)
  let agentPublished = progress.agentPublished || 0
  let agentErrors = progress.agentErrors || 0
  if (publish.dryRun) {
    agentPublished += chunk.length
    progress.published += chunk.length
  } else {
    try {
      await replicatePaths(dst, dstAuth, chunk, agent, progress.csrf)
      agentPublished += chunk.length
      progress.published += chunk.length
    } catch (e) {
      agentErrors++
      progress.errors++
      if (agentErrors <= 5) await appendLog(store, log, `  publish FAILED ${agent} (${chunk.length} paths): ${e.message}`)
    }
  }
  progress.pathIdx += chunk.length
  progress.agentPublished = agentPublished
  progress.agentErrors = agentErrors
  await setState(store, {
    [KEYS.PROD_MIRROR_PROGRESS]: progress,
    [KEYS.RUN_PUBLISHED]: String(progress.published),
    [KEYS.RUN_ERRORS]: String(progress.errors)
  })
  return { statusCode: 200, body: { prodMirror: true, polling: true, phase: 'replicate', agent, pathIdx: progress.pathIdx, total: paths.length } }
}

async function handleNotify (params, store, config, st, success) {
  const { runId, startedAt, log, activeJobId } = st
  const found = findJob(config, activeJobId)
  // Build the notify view from the run SNAPSHOT (env + derived paths), so the
  // message is correct even if the job definition was edited mid-run.
  const job = {
    name: (found && found.name) || activeJobId,
    contentSets: st.runSets || [],
    publishPaths: st.runPaths || [],
    programId: (st.runEnv && st.runEnv.programId) || (found && found.programId) || '',
    sourceEnvId: (st.runEnv && st.runEnv.sourceEnvId) || (found && found.sourceEnvId) || '',
    destEnvId: (st.runEnv && st.runEnv.destEnvId) || (found && found.destEnvId) || ''
  }

  try {
    if (success) {
      await sendSlack(params.SLACK_WEBHOOK_URL, buildSuccessMessage(config, job, runId, startedAt, log))
      let curLog = await appendLog(store, log, 'Success notification sent.')
      const pub = (st.runPublished != null) ? st.runPublished : (job.publishPaths || []).length
      const errs = (st.runErrors != null) ? st.runErrors : 0
      await appendLog(store, curLog, `Run complete — published ${pub}, errors ${errs}.`)
      await setJobStatus(store, activeJobId, { lastStatus: 'SUCCEEDED', lastRunAt: new Date().toISOString(), lastError: null })
    } else {
      const lastEntry = log[log.length - 1] || 'Unknown error'
      await sendSlack(params.SLACK_WEBHOOK_URL, buildFailureMessage(config, job, runId, lastEntry, log))
      await appendLog(store, log, 'Failure notification sent.')
      await setJobStatus(store, activeJobId, { lastStatus: 'FAILED', lastRunAt: new Date().toISOString(), lastError: lastEntry })
    }
  } catch (e) {
    console.error('[orchestrator] Notification failed:', e)
    await appendLog(store, log, `Notification failed: ${e.message}`)
  }

  await resetRun(store)
  // Chain straight into the next queued job (keeps "run all" responsive).
  const next = await startNext(store, config)
  return { statusCode: 200, body: { finished: true, success, runId, next: next.body } }
}

module.exports = { main }
