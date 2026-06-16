'use strict'

/**
 * Effective configuration layer (jobs-based).
 *
 * Config shape:
 * {
 *   stuckFlowThresholdHours,
 *   jobs: [
 *     {
 *       id, name, enabled, schedule (cron),
 *       programId, sourceEnvId, destEnvId,      // env pair is per-job (copy FROM → TO)
 *       contentSets: [ { id, path, wipeDestination, publish } ],  // author-tier only
 *       publish: {...}                            // one publishing policy per job
 *     }
 *   ],
 *   notifications: {...}
 * }
 *
 * Each content set carries a `publish` flag (default true): every content-set
 * path is published by default after the copy, and can be opted out per set.
 * There is no separate publishPaths list — publish paths are DERIVED from the
 * content sets via jobPublishPaths(). Content Copy is author-to-author only, so
 * there is no tier choice (always author).
 *
 * The bundled config/content-sync.json is the deploy-time default. The UI can
 * override it at runtime by writing a config blob into I/O State (`sync_config`),
 * so edits take effect on the next run WITHOUT a redeploy.
 *
 * Legacy configs (top-level env fields, single-config, publishPaths, content-set
 * tier) are migrated on read so older deployments keep working.
 */

const bundled = require('../../config/content-sync.json')

const CONFIG_KEY = 'sync_config'
const AUTO_KEY = 'sync_autoEnabled'
const LONG_TTL = 364 * 24 * 60 * 60

// Admin Console profiles (IMS group names) allowed to use the app. The ui-api
// action enforces these on every call (see actions/utils/authz.js). Default:
// Cloud Manager Deployment + Program Managers. Editable in Settings → Access
// control (no redeploy). A list of ['*'] means "any signed-in user in the org".
const DEFAULT_ACCESS_PROFILES = [
  'CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE',
  'CM_CS_PROGRAM_MANAGER_ROLE_PROFILE'
]

function normaliseAccessProfiles (v) {
  if (!Array.isArray(v)) return [...DEFAULT_ACCESS_PROFILES]
  const cleaned = v.map((s) => String(s || '').trim()).filter(Boolean)
  if (!cleaned.length) return [...DEFAULT_ACCESS_PROFILES]
  if (cleaned.includes('*')) return ['*']
  return cleaned
}

// User-facing publish policy collapses to one of three modes; advanced fields
// stay for the publishAll/onlyChanged tiers + batching. bulkPublish (the env's
// installed publish tool) is kept but only surfaced under Advanced.
function normalisePublish (p, legacyOnlyActivated) {
  p = p || {}
  const targets = Array.isArray(p.targets) && p.targets.length ? p.targets : ['publish']
  let mode = p.mode
  if (mode === 'treeActivation') {
    mode = p.onlyModified ? 'onlyChanged' : 'publishAll'
  }
  const MODES = ['prodMirror', 'publishAll', 'onlyChanged', 'bulkPublish']
  return {
    mode: MODES.includes(mode) ? mode : 'prodMirror',
    targets: targets.filter((t) => t === 'publish' || t === 'preview'),
    onlyModified: !!p.onlyModified,
    includeChildren: p.includeChildren != null ? !!p.includeChildren : true,
    enableVersion: !!p.enableVersion,
    dryRun: !!p.dryRun,
    chunkSize: p.chunkSize != null && p.chunkSize !== '' ? Number(p.chunkSize) : 50,
    maxQueueSize: p.maxQueueSize != null && p.maxQueueSize !== '' ? Number(p.maxQueueSize) : 10,
    maxTreeSize: p.maxTreeSize != null && p.maxTreeSize !== '' ? Number(p.maxTreeSize) : 500000,
    model: p.model || '',
    country: p.country || ''
  }
}

// A content set is an id + the JCR paths it covers (paths come from the Cloud
// Manager content set itself — there is no single hand-typed path) + wipe +
// publish flag. Legacy `path` (single) migrates into `paths`.
function normaliseContentSet (s) {
  s = s || {}
  let paths = Array.isArray(s.paths) ? s.paths.filter(Boolean) : []
  if (!paths.length && (s.path || s.label)) paths = [s.path || s.label]
  return {
    id: s.id || '',
    paths,
    wipeDestination: !!s.wipeDestination,
    publish: s.publish !== false
  }
}

// Publish paths = every path of every content set flagged for publishing.
function jobPublishPaths (job) {
  return (job.contentSets || [])
    .filter((s) => s.publish !== false)
    .flatMap((s) => (Array.isArray(s.paths) ? s.paths : []))
    .filter(Boolean)
}

function migrate (cfg) {
  const out = { ...cfg }
  // Legacy top-level env fields become the seed for any job missing its own.
  const legacyEnv = {
    programId: out.programId || '',
    sourceEnvId: out.sourceEnvId || '',
    destEnvId: out.destEnvId || ''
  }
  if (!Array.isArray(out.jobs)) {
    // Legacy single-config → one job named "Default".
    out.jobs = [{
      id: 'default',
      name: 'Default sync',
      enabled: true,
      schedule: out.schedule || '0 20 * * 5',
      ...legacyEnv,
      contentSets: out.contentSets || [],
      onlyActivated: out.onlyActivated !== false
    }]
  }
  // Normalise each job: per-job env pair, normalised content sets (with publish
  // flag), one publishing policy. Drop the legacy publishPaths/tier.
  out.jobs = out.jobs.map((j, i) => {
    const sets = (Array.isArray(j.contentSets) ? j.contentSets : []).map(normaliseContentSet)
    // Back-compat: if an old job had explicit publishPaths, honour them by only
    // publishing the content sets whose path was in that list.
    if (Array.isArray(j.publishPaths) && j.publishPaths.length) {
      const allow = new Set(j.publishPaths)
      sets.forEach((s) => { s.publish = (s.paths || []).some((p) => allow.has(p)) })
    }
    return {
      id: j.id || `job-${i + 1}`,
      name: j.name || `Job ${i + 1}`,
      enabled: j.enabled !== false,
      schedule: j.schedule || '0 20 * * 5',
      programId: j.programId || legacyEnv.programId,
      sourceEnvId: j.sourceEnvId || legacyEnv.sourceEnvId,
      destEnvId: j.destEnvId || legacyEnv.destEnvId,
      contentSets: sets,
      publish: normalisePublish(j.publish, j.onlyActivated)
    }
  })
  // AEM author Service Credentials (JWT) per environment id — { "<envId>": <creds JSON|string> }.
  // Used by the prod-mirror publish step to authenticate to each author. Pasted via the UI.
  out.aemServiceCreds = (out.aemServiceCreds && typeof out.aemServiceCreds === 'object') ? out.aemServiceCreds : {}
  // Admin Console profiles allowed to use the app (enforced by ui-api authz).
  out.accessProfiles = normaliseAccessProfiles(out.accessProfiles)
  // Drop legacy top-level fields (env + run config now live inside jobs).
  delete out.contentSets
  delete out.publishPaths
  delete out.schedule
  delete out.programId
  delete out.sourceEnvId
  delete out.destEnvId
  return out
}

async function getConfigOverride (store) {
  const raw = (await store.get(CONFIG_KEY))?.value
  return raw ? JSON.parse(raw) : null
}

async function getEffectiveConfig (store) {
  const override = await getConfigOverride(store)
  return migrate(override || bundled)
}

async function saveConfigOverride (store, cfg) {
  const normalised = migrate(cfg)
  await store.put(CONFIG_KEY, JSON.stringify(normalised), { ttl: LONG_TTL })
  return normalised
}

function findJob (cfg, jobId) {
  return (cfg.jobs || []).find((j) => j.id === jobId) || null
}

async function getAutoEnabled (store) {
  const raw = (await store.get(AUTO_KEY))?.value
  return raw === undefined || raw === null ? true : raw === 'true'
}

async function setAutoEnabled (store, enabled) {
  await store.put(AUTO_KEY, String(!!enabled), { ttl: LONG_TTL })
  return !!enabled
}

module.exports = {
  BUNDLED: bundled,
  DEFAULT_ACCESS_PROFILES,
  normaliseAccessProfiles,
  migrate,
  jobPublishPaths,
  normaliseContentSet,
  findJob,
  getConfigOverride,
  getEffectiveConfig,
  saveConfigOverride,
  getAutoEnabled,
  setAutoEnabled
}
