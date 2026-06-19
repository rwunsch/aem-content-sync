'use strict'

/*
 * ui-api — single web action backing the App Builder UI.
 *
 * Ops:
 *   status      → run state + jobs (with per-job last-run status) + queue + config
 *   config      → effective config only
 *   saveConfig  → persist a config override (jobs editor)   { config }
 *   setAuto     → master pause/resume of scheduled syncs    { enabled }
 *   trigger     → run a job now { jobId } or all enabled jobs { runAll:true }
 *   cancel      → cancel current run, clear queue, reset to idle
 *   flows       → live Cloud Manager RUNNING flows
 */

const stateLib = require('@adobe/aio-lib-state')

const { PHASES, getState, getJobStatusMap, getRunHistory, setQueue, setJobStatus, clearJobStatus, resetRun, resetState } = require('../utils/state')
const { getEffectiveConfig, saveConfigOverride, getAutoEnabled, setAutoEnabled, jobPublishPaths, normaliseAccessProfiles } = require('../utils/config')
const { assertAuthorized, callerProfiles, matches } = require('../utils/authz')
const { listRunningFlows, cancelContentFlow, listPrograms, listEnvironments, listContentSets } = require('../utils/cm-api')
const { validateEligibility, AEMAACS_AUTHOR, getActivatedPaths, getCsrfToken, replicatePaths } = require('../utils/aem-api')
const { getCMToken, getAemToken } = require('../utils/auth')

// AEM author auth: per-env JWT service creds (from config map by envId, or params) → AEM_TOKEN → basic → CM token.
async function aemAuth (params, role, envObj, credsMap) {
  const envId = role === 'source' ? (envObj && envObj.sourceEnvId) : (envObj && envObj.destEnvId)
  const fromCfg = credsMap && envId && credsMap[envId]
  if (fromCfg) { try { return await getAemToken(typeof fromCfg === 'string' ? JSON.parse(fromCfg) : fromCfg) } catch (_) {} }
  const raw = role === 'source' ? params.AEM_SOURCE_SERVICE_CREDS : params.AEM_DEST_SERVICE_CREDS
  if (raw) { try { return await getAemToken(typeof raw === 'string' ? JSON.parse(raw) : raw) } catch (_) {} }
  if (params.AEM_TOKEN) return params.AEM_TOKEN
  if (params.AEM_USER) return { user: params.AEM_USER, password: params.AEM_PASSWORD }
  return await getCMToken(params)
}

// Never let credential VALUES leave the action. Replace aemServiceCreds with a
// boolean presence map (aemServiceCredsSet: { <envId>: true }) the client can use
// to show "credentials set" without ever receiving the secret JSON.
const maskConfig = (cfg) => {
  const creds = (cfg && cfg.aemServiceCreds) || {}
  const out = { ...cfg }
  delete out.aemServiceCreds
  out.aemServiceCredsSet = Object.keys(creds).reduce((m, k) => { m[k] = !!creds[k]; return m }, {})
  return out
}

// NOTE: do NOT set Access-Control-* headers here. The require-adobe-auth web
// sequence already injects CORS headers on every response; setting them again
// in the action produced a duplicated `Access-Control-Allow-Origin: *,*`, which
// browsers reject as malformed — surfacing in the SPA as "Failed to fetch" even
// though the action returned 200. Let the platform own CORS.
function res (body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json'
    },
    body
  }
}

async function main (params) {
  const method = (params.__ow_method || 'post').toLowerCase()
  if (method === 'options') return res({}, 204)

  const op = params.op || 'status'

  try {
    const store = await stateLib.init()

    // App-level authorization: the caller must hold one of the configured Admin
    // Console profiles (config.accessProfiles; default Cloud Manager Deployment +
    // Program Managers; ['*'] = any signed-in org user). 403 otherwise. This is
    // ON TOP OF the platform's require-adobe-auth (same-org IMS token).
    const gateCfg = await getEffectiveConfig(store)
    try {
      await assertAuthorized(params, gateCfg.accessProfiles)
    } catch (e) {
      return res({ error: e.message }, e.statusCode || 403)
    }

    switch (op) {
      case 'status': {
        const st = await getState()
        const config = await getEffectiveConfig(store)
        const autoEnabled = await getAutoEnabled(store)
        const jobStatus = await getJobStatusMap(store)
        const runHistory = await getRunHistory(store)
        // Attach per-job last-run status to each configured job.
        const jobs = config.jobs.map(j => ({ ...j, status: jobStatus[j.id] || null }))
        return res({
          phase: st.phase,
          runId: st.runId,
          startedAt: st.startedAt,
          activeJobId: st.activeJobId,
          copyIndex: st.copyIndex,
          publishIndex: st.publishIndex,
          flowId: st.flowId,
          runSets: st.runSets,
          runPaths: st.runPaths,
          queue: st.queue,
          log: st.log,
          autoEnabled,
          running: st.phase !== PHASES.IDLE,
          config: maskConfig(config),
          jobs,
          runHistory
        })
      }

      case 'config':
        return res({ config: maskConfig(await getEffectiveConfig(store)) })

      case 'saveConfig': {
        if (!params.config || typeof params.config !== 'object') {
          return res({ error: 'Missing or invalid `config` object' }, 400)
        }
        // The client config is masked (no credential values) EXCEPT when it is
        // explicitly setting/clearing a credential. Merge incoming creds onto the
        // stored ones so a routine job autosave never wipes stored credentials,
        // and treat '' / null as a delete of that env's credential.
        const existing = await getEffectiveConfig(store)
        const incoming = params.config || {}
        const mergedCreds = { ...(existing.aemServiceCreds || {}), ...(incoming.aemServiceCreds || {}) }
        delete incoming.aemServiceCredsSet
        for (const k of Object.keys(mergedCreds)) { if (mergedCreds[k] === '' || mergedCreds[k] == null) delete mergedCreds[k] }
        // Merge the incoming (possibly PARTIAL — Settings sends only aemServiceCreds)
        // onto the existing full config so a credential-only save never drops jobs.
        const toSave = { ...existing, ...incoming, aemServiceCreds: mergedCreds }

        // Self-lockout guard: if access profiles are being changed, refuse a set
        // that would lock the current caller out (unless it's the open '*' set).
        if (incoming.accessProfiles !== undefined) {
          const next = normaliseAccessProfiles(incoming.accessProfiles)
          if (!next.includes('*')) {
            const mine = await callerProfiles(params)
            if (!matches(mine, next)) {
              return res({ error: 'That access-profile selection would lock you out (you are not in any of the chosen profiles). Pick at least one profile you hold.' }, 409)
            }
          }
        }

        const saved = await saveConfigOverride(store, toSave)
        return res({ saved: true, config: maskConfig(saved) })
      }

      // Access-control info for the Settings UI: the configured profiles, the
      // caller's own profiles (so the UI can warn about self-lockout), and the
      // well-known catalog of selectable profiles.
      case 'accessInfo': {
        const cfg = await getEffectiveConfig(store)
        let mine = []
        try { mine = await callerProfiles(params) } catch (_) { mine = [] }
        const catalog = [
          { id: 'CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE', label: 'Cloud Manager — Deployment Manager' },
          { id: 'CM_CS_PROGRAM_MANAGER_ROLE_PROFILE', label: 'Cloud Manager — Program Manager (Business Owner)' },
          { id: 'CM_CS_DEVELOPER_ROLE_PROFILE', label: 'Cloud Manager — Developer' },
          { id: 'AEM Administrators', label: 'AEM Administrators (any environment)' },
          { id: '*', label: 'Any signed-in user in the org (no profile restriction)' }
        ]
        // Which of the caller's profiles look like role/profile groups (for display).
        // Dedupe (groupName + groupDisplayName can repeat) and sort for a clean list.
        const mineProfiles = [...new Set(mine.filter((g) => /^CM_CS_|^AEM Administrators/.test(g)))].sort()
        return res({ accessProfiles: cfg.accessProfiles, mine: mineProfiles, catalog })
      }

      case 'setAuto': {
        const enabled = await setAutoEnabled(store, params.enabled === true || params.enabled === 'true')
        return res({ autoEnabled: enabled })
      }

      case 'trigger': {
        // Always enqueue (no 409): the orchestrator queues and runs sequentially.
        const orchParams = {}
        if (params.runAll) orchParams.runAll = true
        else if (params.jobId) orchParams.jobId = params.jobId
        else return res({ error: 'Provide `jobId` or `runAll:true`' }, 400)
        orchParams.manual = true
        orchParams.source = 'ui'

        // Invoke the orchestrator via the AUTHENTICATED namespace API (Basic auth
        // with this namespace's OW API key) — NOT the public web URL. This lets the
        // orchestrator be a non-web action with no externally reachable endpoint;
        // it can only be invoked from inside the namespace (here, the self-chain,
        // and the scheduler rule). Non-blocking: the orchestrator runs one phase
        // and self-chains, so we return as soon as it's enqueued.
        const apiHost = (process.env.__OW_API_HOST || 'https://adobeioruntime.net').replace(/\/$/, '')
        const ns = process.env.__OW_NAMESPACE
        const apikey = process.env.__OW_API_KEY
        if (!apikey || !ns) return res({ error: 'Runtime credentials unavailable' }, 500)
        const orchUrl = `${apiHost}/api/v1/namespaces/${ns}/actions/aem-content-sync/orchestrator?blocking=false`
        const r = await fetch(orchUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(apikey).toString('base64')
          },
          body: JSON.stringify(orchParams)
        })
        if (!r.ok) {
          console.error(`[ui-api] orchestrator invoke failed: HTTP ${r.status}`)
          return res({ error: 'Failed to start orchestrator' }, 502)
        }
        const result = await r.json().catch(() => ({}))
        return res({ triggered: true, result })
      }

      case 'cancel': {
        const st = await getState()
        // flowId is reused for in-flight CM content flows (COPYING) and AEM workflow
        // instance paths (PUBLISHING) — only the former is cancellable via CM API.
        if (st.flowId && st.phase === PHASES.COPYING) {
          const env = st.runEnv || {}
          if (env.programId) {
            try {
              await cancelContentFlow(params, env, st.flowId)
            } catch (e) {
              console.warn(`[ui-api] cancelContentFlow failed: ${e.message}`)
            }
          }
        }
        if (st.activeJobId) {
          await setJobStatus(store, st.activeJobId, { lastStatus: 'CANCELLED', lastRunAt: new Date().toISOString() })
        }
        await setQueue(store, [])
        await resetRun(st.store)
        return res({ cancelled: true })
      }

      case 'flows': {
        // Env pair is per-job now: use the requested job, else the first job.
        const config = await getEffectiveConfig(store)
        const j = (params.jobId && (config.jobs || []).find((x) => x.id === params.jobId)) || (config.jobs || [])[0]
        if (!j || !j.programId || !j.sourceEnvId) return res({ flows: [] })
        const flows = await listRunningFlows(params, { programId: j.programId, sourceEnvId: j.sourceEnvId, destEnvId: j.destEnvId })
        return res({ flows })
      }

      case 'programs':
        return res({ programs: await listPrograms(params) })

      case 'environments': {
        const cfg = await getEffectiveConfig(store)
        const programId = params.programId || ((cfg.jobs || [])[0] && (cfg.jobs || [])[0].programId)
        return res({ environments: await listEnvironments(params, programId) })
      }

      case 'contentSets': {
        // Existing Cloud Manager content sets for a program, so the UI can offer
        // them as a selectable list instead of a hand-typed id.
        const cfg = await getEffectiveConfig(store)
        const programId = params.programId || ((cfg.jobs || [])[0] && (cfg.jobs || [])[0].programId)
        if (!programId) return res({ contentSets: [] })
        return res({ contentSets: await listContentSets(params, programId) })
      }

      case 'mirrorTest': {
        // Fast, isolated end-to-end check of the prod-mirror step (auth + query + replicate)
        // through a deployed action — without running a full content copy first.
        const cfg = await getEffectiveConfig(store)
        const j = (cfg.jobs || []).find((x) => x.id === params.jobId) || (cfg.jobs || [])[0]
        if (!j || !j.programId) return res({ error: 'no job/env' })
        const credsMap = cfg.aemServiceCreds || {}
        const srcAuth = await aemAuth(params, 'source', j, credsMap)
        const dstAuth = await aemAuth(params, 'dest', j, credsMap)
        const src = AEMAACS_AUTHOR(j.programId, j.sourceEnvId)
        const dst = AEMAACS_AUTHOR(j.programId, j.destEnvId)
        const roots = params.root ? [params.root] : jobPublishPaths(j)
        const targets = (j.publish && j.publish.targets && j.publish.targets.length) ? j.publish.targets : ['publish']
        let csrf = ''
        try { csrf = await getCsrfToken(dst, dstAuth) } catch (e) { return res({ error: 'csrf: ' + e.message }) }
        const out = {}; let published = 0; let errors = 0
        for (const agent of targets) {
          // Gather what the SOURCE has activated to this agent across all roots.
          const allPaths = []
          for (const root of roots) {
            let paths = []
            try { paths = await getActivatedPaths(src, srcAuth, root, agent) } catch (e) { return res({ error: `query ${agent} ${root}: ${e.message}` }) }
            for (const p of paths) allPaths.push(p)
          }
          // Auto-skip an agent (e.g. preview) when the source has nothing activated for it.
          if (allPaths.length === 0) {
            out[agent] = { found: 0, published: 0, errors: 0, skipped: true, sample: [] }
            continue
          }
          let agentPublished = 0; let agentErrors = 0; let lastError
          for (let k = 0; k < allPaths.length; k += 200) {
            const chunk = allPaths.slice(k, k + 200)
            try { await replicatePaths(dst, dstAuth, chunk, agent, csrf); agentPublished += chunk.length } catch (e) { agentErrors++; lastError = e.message }
          }
          out[agent] = { found: allPaths.length, published: agentPublished, errors: agentErrors, skipped: false, sample: allPaths.slice(0, 5) }
          if (lastError) out[agent].lastError = lastError
          published += agentPublished
          errors += agentErrors
        }
        const srcMode = (credsMap && credsMap[j.sourceEnvId]) ? 'jwt(config)' : (params.AEM_SOURCE_SERVICE_CREDS ? 'jwt(param)' : (params.AEM_TOKEN ? 'bearer' : (params.AEM_USER ? 'basic' : 'cmToken')))
        return res({ mirrorTest: out, source: src, dest: dst, published, errors, authMode: srcMode })
      }

      case 'integration': {
        // Non-secret identity info for the in-app Setup/Help panel: which
        // technical account, org, and AEM target this deployment is wired to.
        // Never returns the client secret or AEM token.
        const maskId = (s) => (s && s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : (s || ''))
        return res({
          integration: {
            imsOrgId: params.IMS_ORG_ID || '',
            technicalAccountId: params.CM_TECHNICAL_ACCOUNT_ID || '',
            clientId: maskId(params.CM_CLIENT_ID || ''),
            aemAuthorUrl: params.AEM_AUTHOR_URL || '',
            hasAemToken: !!params.AEM_TOKEN,
            basicAvailable: !!params.AEM_USER,
            hasSlack: !!params.SLACK_WEBHOOK_URL
          }
        })
      }

      case 'validate': {
        // Read-only eligibility comparison via QueryBuilder: for each publish path,
        // count nodes activated for publish vs preview, so we can prove whether
        // native onlyActivated matches the vendor's tool (esp. the preview tier).
        const cfg = await getEffectiveConfig(store)
        let paths = Array.isArray(params.paths) ? params.paths : null
        let job = null
        if (!paths && params.jobId) {
          job = (cfg.jobs || []).find((x) => x.id === params.jobId)
          paths = job ? jobPublishPaths(job) : []
        }
        paths = paths || []
        const credsMap = cfg.aemServiceCreds || {}
        const env = job || (cfg.jobs || [])[0] || {}
        const auth = await aemAuth(params, 'source', env, credsMap)
        const authorUrl = (env.programId && env.sourceEnvId)
          ? AEMAACS_AUTHOR(env.programId, env.sourceEnvId)
          : (params.AEM_AUTHOR_URL || '')
        if (!authorUrl) return res({ error: 'No source author URL available for validation' }, 400)
        const validation = []
        for (const root of paths) {
          try {
            validation.push(await validateEligibility(authorUrl, auth, root))
          } catch (e) {
            validation.push({ root, error: 'Validation failed' })
          }
        }
        return res({ validation })
      }

      case 'clearStatus': {
        // Clear just the stored status for one job (params.jobId) or all jobs.
        // Leaves config / run state / queue intact. Refuses a job that's the
        // currently-running one (its status would be rewritten on completion).
        const st = await getState()
        if (params.jobId && st.phase !== PHASES.IDLE && st.activeJobId === params.jobId) {
          return res({ error: 'That job is currently running — cancel it first.' }, 409)
        }
        await clearJobStatus(store, params.jobId)
        return res({ cleared: true, jobId: params.jobId || null })
      }

      case 'reset': {
        // Full wipe: run state, queue, per-job status, scheduler tick, and the
        // config override (reverts to the bundled default). Keeps no secrets.
        await resetState(store)
        return res({ reset: true })
      }

      case 'validateCreds': {
        // One-time authenticated call to AEM author: both VALIDATES the stored
        // Service Credential AND provisions the technical-account user in the
        // instance (JWT SSO provisions the user on first authenticated login).
        // NEVER returns the token or key.
        const cfg = await getEffectiveConfig(store)
        const raw = (cfg.aemServiceCreds || {})[params.envId]
        if (!raw) return res({ validate: { ok: false, message: 'No credentials stored for this environment.' } })
        let token
        try { token = await getAemToken(typeof raw === 'string' ? JSON.parse(raw) : raw) } catch (e) { return res({ validate: { ok: false, stage: 'jwt', message: 'JWT exchange failed: ' + e.message } }) }
        const author = AEMAACS_AUTHOR(params.programId, params.envId)
        try {
          const r = await fetch(author + '/libs/granite/csrf/token.json', { headers: { Authorization: 'Bearer ' + token } })
          if (r.ok) {
            return res({ validate: { ok: true, status: r.status, author, message: 'Credentials valid — authenticated to AEM. The technical-account user is now provisioned in this instance; grant it replication rights.' } })
          }
          return res({ validate: { ok: false, status: r.status, author, message: 'Authenticated call returned HTTP ' + r.status + ' — the credential reached AEM but was rejected; check the technical account.' } })
        } catch (e) {
          return res({ validate: { ok: false, stage: 'aem', author, message: e.message } })
        }
      }

      case 'credInfo': {
        // Non-secret identifiers parsed from each stored Service Credential, so the
        // operator can find the technical account in Admin Console without digging
        // through the JSON. NEVER returns privateKey / clientSecret.
        const cfg = await getEffectiveConfig(store)
        const creds = cfg.aemServiceCreds || {}
        const out = {}
        for (const [envId, raw] of Object.entries(creds)) {
          let j = {}
          try { j = typeof raw === 'string' ? JSON.parse(raw) : raw } catch (_) {}
          const ig = (j && j.integration) || j || {}
          const ta = ig.technicalAccount || {}
          out[envId] = {
            email: ig.email || ig.technicalAccountEmail || ta.email || '',
            id: ig.id || ig.technicalAccountId || '',
            clientId: ta.clientId || ig.client_id || '',
            org: ig.org || ig.imsOrgId || ''
          }
        }
        return res({ credInfo: out })
      }

      default:
        return res({ error: `Unknown op: ${op}` }, 400)
    }
  } catch (err) {
    console.error(`[ui-api] op=${op} failed:`, err)
    return res({ error: 'Request failed' }, 500)
  }
}

module.exports = { main }
