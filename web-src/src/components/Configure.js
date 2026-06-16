import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  Flex, View, Heading, Text, TextField, Picker, Item, Switch,
  Button, ActionButton, StatusLight, ListView,
  Checkbox, CheckboxGroup, RadioGroup, Radio, DialogTrigger, AlertDialog,
  ContextualHelp, Content
} from '@adobe/react-spectrum'
import Add from '@spectrum-icons/workflow/Add'
import Delete from '@spectrum-icons/workflow/Delete'
import Refresh from '@spectrum-icons/workflow/Refresh'
import ArrowRight from '@spectrum-icons/workflow/ArrowRight'
import { describeCron } from './ui'
import { allowedDestinations, tierRank } from '../tiers'
import { collides } from '../scheduleCollision'
import Card from './Card'

const CRON_PRESETS = [
  { id: '0 20 * * 5', label: 'Friday 20:00 UTC' },
  { id: '0 2 * * *', label: 'Daily 02:00 UTC' },
  { id: '0 19 * * 1-5', label: 'Weekdays 19:00 UTC' },
  { id: '0 22 * * 0', label: 'Sunday 22:00 UTC' },
  { id: '0 */6 * * *', label: 'Every 6 hours' }
]

// body may be a string (one paragraph) or an array of strings (rendered as
// short, separate labelled lines — used to keep the "i" popovers tightly
// structured rather than one long run-on sentence).
function Help (title, body) {
  return (
    <ContextualHelp variant="info">
      <Heading>{title}</Heading>
      <Content>
        {Array.isArray(body)
          ? body.map((line, i) => <Text key={i} UNSAFE_style={{ display: 'block', marginBottom: i < body.length - 1 ? '0.4rem' : 0 }}>{line}</Text>)
          : <Text>{body}</Text>}
      </Content>
    </ContextualHelp>
  )
}

const DIM = { color: 'var(--spectrum-global-color-gray-700)' }

// Order environments highest tier first: prod → stage → dev/others. Stable within a tier.
const byTierDesc = (a, b) => tierRank(b.type) - tierRank(a.type)

let _uid = 0
const newId = () => `job-${Date.now()}-${_uid++}`
const blankJob = () => ({
  id: newId(), name: 'New job', enabled: true, schedule: '0 20 * * 5',
  programId: '', sourceEnvId: '', destEnvId: '',
  contentSets: [],
  publish: { mode: 'prodMirror', targets: ['publish'], onlyModified: false, includeChildren: true, enableVersion: false, dryRun: false, chunkSize: null, maxQueueSize: null, maxTreeSize: null, model: '', country: '' }
})

export default function Configure ({ api, onHealth }) {
  const [jobs, setJobs] = useState(null)
  const [statusMap, setStatusMap] = useState({})
  const [activeJobId, setActiveJobId] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [baseConfig, setBaseConfig] = useState({})
  const [error, setError] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [programs, setPrograms] = useState([])
  const [environments, setEnvironments] = useState([])
  const [availableSets, setAvailableSets] = useState([])
  const [loadingLists, setLoadingLists] = useState(false)

  const saveTimer = useRef(null)

  const load = useCallback(async () => {
    try {
      const s = await api.status()
      setBaseConfig(s.config); setJobs(s.config.jobs); setActiveJobId(s.activeJobId)
      const m = {}; (s.jobs || []).forEach((j) => { m[j.id] = j.status }); setStatusMap(m)
      setSelectedId((cur) => cur || (s.config.jobs[0] && s.config.jobs[0].id) || null)
      onHealth && onHealth(true)
    } catch (e) { setError(e.message); onHealth && onHealth(false) }
  }, [api, onHealth])

  useEffect(() => { load() }, [load])

  // Clear any pending autosave timer on unmount.
  useEffect(() => () => clearTimeout(saveTimer.current), [])

  const selected = jobs && jobs.find((j) => j.id === selectedId)
  const pub = selected && (selected.publish || {})

  // Per-job environment lists: load programs once and environments for the
  // selected job's program (the env pair lives on the job now, not globally).
  const loadEnvLists = useCallback(async (programId, refresh = false) => {
    setLoadingLists(true)
    const tasks = [
      api.programs({ refresh }).then((r) => setPrograms(r.programs || [])).catch(() => setPrograms([]))
    ]
    if (programId) {
      tasks.push(api.environments(programId, { refresh }).then((r) => setEnvironments(r.environments || [])).catch(() => setEnvironments([])))
      tasks.push(api.contentSets(programId, { refresh }).then((r) => setAvailableSets(r.contentSets || [])).catch(() => setAvailableSets([])))
    } else { setEnvironments([]); setAvailableSets([]) }
    try { await Promise.all(tasks) } finally { setLoadingLists(false) }
  }, [api])

  useEffect(() => { if (selected && selected.programId) loadEnvLists(selected.programId) }, [selectedId, selected && selected.programId]) // eslint-disable-line

  // Debounced autosave: every patch computes the next jobs array and schedules
  // a save 800ms later. No explicit Save button.
  const queueSave = useCallback((nextJobs) => {
    setDirty(true)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try { const r = await api.saveConfig({ ...baseConfig, jobs: nextJobs }); setJobs(r.config.jobs); setDirty(false); setSavedAt(Date.now()) } catch (e) { setError(e.message) }
    }, 800)
  }, [api, baseConfig])

  const patchJob = (id, patch) => {
    const next = jobs.map((j) => j.id === id ? { ...j, ...patch } : j)
    setJobs(next); setError(null); queueSave(next)
  }
  const patchPublish = (id, patch) => {
    const next = jobs.map((j) => j.id === id ? { ...j, publish: { ...(j.publish || {}), ...patch } } : j)
    setJobs(next); setError(null); queueSave(next)
  }
  const patchSet = (jobId, i, patch) => {
    const next = jobs.map((j) => j.id === jobId ? { ...j, contentSets: j.contentSets.map((s, idx) => idx === i ? { ...s, ...patch } : s) } : j)
    setJobs(next); queueSave(next)
  }
  const addSet = (jobId) => {
    const next = jobs.map((j) => j.id === jobId ? { ...j, contentSets: [...j.contentSets, { id: '', paths: [], wipeDestination: false, publish: true }] } : j)
    setJobs(next); queueSave(next)
  }
  const removeSet = (jobId, i) => {
    const next = jobs.map((j) => j.id === jobId ? { ...j, contentSets: j.contentSets.filter((_, idx) => idx !== i) } : j)
    setJobs(next); queueSave(next)
  }

  const addJob = () => { const j = blankJob(); const next = [...jobs, j]; setJobs(next); setSelectedId(j.id); queueSave(next) }
  const deleteJob = (id) => { const next = jobs.filter((j) => j.id !== id); setJobs(next); setSelectedId((cur) => cur === id ? (next[0] && next[0].id) || null : cur); queueSave(next) }

  const runNow = useCallback(async (id) => { setBusy(true); try { await api.runJob(id); await load() } catch (e) { setError(e.message) } finally { setBusy(false) } }, [api, load])

  // When the source changes, clear a destination that is no longer downstream.
  const onSourceChange = (sourceEnvId) => {
    const allowed = allowedDestinations(environments, sourceEnvId)
    const keepDest = allowed.some((e) => String(e.id) === String(selected.destEnvId))
    patchJob(selected.id, { sourceEnvId, ...(keepDest ? {} : { destEnvId: '' }) })
  }

  const onProgramChange = (programId) => { patchJob(selected.id, { programId, sourceEnvId: '', destEnvId: '' }); loadEnvLists(programId) }
  const envLabel = (e) => `${e.name} — ${e.type}${e.status ? ` [${e.status}]` : ''} (${e.id})`

  if (!jobs && !error) return <Text>Loading jobs…</Text>
  if (!jobs) return <StatusLight variant="negative">{error}</StatusLight>

  const sortedEnvs = [...environments].sort(byTierDesc)
  const dests = selected ? [...allowedDestinations(environments, selected.sourceEnvId)].sort(byTierDesc) : []
  const sourceEnv = selected && environments.find((e) => String(e.id) === String(selected.sourceEnvId))
  const fromEnvName = sourceEnv ? (sourceEnv.name || sourceEnv.type) : ''
  const clash = selected && jobs.find((o) => o.id !== selected.id && o.enabled && selected.enabled && collides(selected.schedule, o.schedule, 6 * 3600e3))
  const savedRecently = savedAt > 0 && (Date.now() - savedAt < 4000)

  return (
    <Flex direction="row" gap="size-400" alignItems="start">
      {/* Job list */}
      <Flex direction="column" gap="size-100" width="size-3600">
        <Flex direction="row" alignItems="center">
          <Heading level={4} margin={0}>Jobs</Heading>
          <View flex />
          <ActionButton onPress={addJob}><Add /><Text>Add</Text></ActionButton>
        </Flex>
        <ListView aria-label="Jobs" selectionMode="single" selectionStyle="highlight"
          selectedKeys={selectedId ? [selectedId] : []}
          onSelectionChange={(keys) => { const k = keys === 'all' ? null : [...keys][0]; if (k) setSelectedId(k) }}
          height="size-5000" items={jobs}>
          {(j) => (
            <Item key={j.id} textValue={j.name}>
              <Text>{j.name}{j.id === activeJobId ? '  • running' : ''}</Text>
              <Text slot="description">{describeCron(j.schedule)} — {(statusMap[j.id] && statusMap[j.id].lastStatus) || 'never run'}{!j.enabled ? ' • disabled' : ''}</Text>
            </Item>
          )}
        </ListView>
      </Flex>

      {/* Editor */}
      <Flex direction="column" gap="size-300" flex>
        {error && <StatusLight variant="negative">{error}</StatusLight>}

        {!selected ? <Text>Select a job, or add one.</Text> : (
          <>
            {/* Top action bar — always visible */}
            <Flex direction="row" gap="size-200" alignItems="center" wrap>
              <Button variant="primary" style="outline" onPress={() => runNow(selected.id)} isDisabled={busy}>Run this job</Button>
              <Switch isSelected={selected.enabled} onChange={(v) => patchJob(selected.id, { enabled: v })}>Enabled</Switch>
              <View flex />
              {savedRecently && <StatusLight variant="positive">Saved automatically ✓</StatusLight>}
              {dirty && !savedRecently && <StatusLight variant="notice">Saving…</StatusLight>}
              <DialogTrigger>
                <Button variant="negative" isDisabled={busy}>Delete</Button>
                {(close) => (
                  <AlertDialog title="Delete job?" variant="destructive" primaryActionLabel="Delete" cancelLabel="Cancel"
                    onPrimaryAction={() => { close(); deleteJob(selected.id) }}>
                    "{selected.name}" will be removed.
                  </AlertDialog>
                )}
              </DialogTrigger>
            </Flex>

            <Card>
              <TextField label="Job name" value={selected.name} onChange={(v) => patchJob(selected.id, { name: v })} width="100%" />
              {clash && (
                <StatusLight variant="notice" marginTop="size-200">May overlap with “{clash.name}” ({describeCron(clash.schedule)}) — jobs run one at a time, so this one could queue and start late.</StatusLight>
              )}
              <Flex direction="row" gap="size-200" alignItems="end" wrap marginTop="size-200">
                <Picker label="Presets" placeholder="Presets" selectedKey={CRON_PRESETS.find((p) => p.id === selected.schedule) ? selected.schedule : null} items={CRON_PRESETS}
                  onSelectionChange={(k) => patchJob(selected.id, { schedule: String(k) })}
                  contextualHelp={Help('Schedule', ['When this job runs automatically, in UTC.', 'Pick a preset or type a 5-field cron expression.', 'The scheduler wakes every 15 minutes and starts any job whose cron became due.', 'Requires the master Auto-sync switch (Operate) to be on.'])}>
                  {(p) => <Item key={p.id}>{p.label}</Item>}
                </Picker>
                <TextField label="Cron expression (UTC)" value={selected.schedule} onChange={(v) => patchJob(selected.id, { schedule: v })} width="size-2000"
                  contextualHelp={Help('Cron (5 fields, UTC)', [
                    '5 space-separated fields, all UTC:',
                    'minute (0-59) · hour (0-23) · day-of-month (1-31) · month (1-12) · day-of-week (0-6, 0=Sun)',
                    'Use * for “any”, */n for “every n”, a-b for ranges.',
                    '“0 20 * * 5” = Fri 20:00',
                    '“0 2 * * *” = daily 02:00',
                    '“*/15 * * * *” = every 15 min',
                    '“0 19 * * 1-5” = weekdays 19:00'
                  ])} />
                <Text marginBottom="size-100">{describeCron(selected.schedule)}</Text>
              </Flex>
            </Card>

            <Card title="Connected environments (copy FROM → TO)">
              <Flex direction="row" alignItems="center" gap="size-100" marginBottom="size-200">
                <Heading level={5} margin={0}>Program &amp; environments</Heading>
                {Help('Connected environments', ['Content Copy only flows downstream: Prod → Stage → Dev.', 'Pick the Cloud Manager program, then the source (copy FROM) and destination (copy TO).', 'Service Credentials for each environment are managed in the Settings tab.'])}
                <View flex />
                <ActionButton aria-label="Reload program & environment lists" isQuiet onPress={() => loadEnvLists(selected.programId, true)}><Refresh /></ActionButton>
                {loadingLists && <Text>loading…</Text>}
              </Flex>
              <View marginBottom="size-300">
                {programs.length ? (
                  <Picker label="Program" width="100%" selectedKey={selected.programId} items={programs} onSelectionChange={(k) => onProgramChange(String(k))}
                    contextualHelp={Help('Program', 'The Cloud Manager program that owns this job’s environments. Loaded from the credential’s org; for a different-org target the list may be empty and you can type the id manually.')}>
                    {(p) => <Item key={p.id} textValue={`${p.name} (${p.id})`}><Text UNSAFE_style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name} ({p.id})</Text></Item>}
                  </Picker>
                ) : (
                  <TextField label="Program ID" width="100%" value={selected.programId || ''} onChange={(v) => onProgramChange(v)}
                    contextualHelp={Help('Program ID', 'Cloud Manager program id for this job (the program list could not be loaded for this credential’s org, so enter it manually).')} />
                )}
              </View>
              <Flex direction="row" gap="size-200" alignItems="start">
                <View flex>
                  {environments.length ? (
                    <Picker label="Copy FROM (source)" width="100%" selectedKey={selected.sourceEnvId} items={sortedEnvs} onSelectionChange={(k) => onSourceChange(String(k))}
                      contextualHelp={Help('Source environment', 'Where content is copied FROM — normally Production. Content Copy only flows downstream, so the source must be a higher tier than the destination.')}>
                      {(e) => <Item key={e.id}>{envLabel(e)}</Item>}
                    </Picker>
                  ) : (
                    <TextField label="Source env ID" width="100%" value={selected.sourceEnvId || ''} onChange={(v) => patchJob(selected.id, { sourceEnvId: v })}
                      contextualHelp={Help('Source environment', 'Environment id to copy FROM (Production).')} />
                  )}
                </View>
                <View paddingTop="size-450"><ArrowRight size="S" aria-label="to" /></View>
                <View flex>
                  {environments.length ? (
                    <Picker label="Copy TO (destination)" width="100%" selectedKey={selected.destEnvId} items={dests} onSelectionChange={(k) => patchJob(selected.id, { destEnvId: String(k) })}
                      contextualHelp={Help('Destination environment', ['Where content is copied TO — normally Stage.', 'Only environments strictly lower in tier than the source are offered (downstream only).'])}>
                      {(e) => <Item key={e.id}>{envLabel(e)}</Item>}
                    </Picker>
                  ) : (
                    <TextField label="Dest env ID" width="100%" value={selected.destEnvId || ''} onChange={(v) => patchJob(selected.id, { destEnvId: v })}
                      contextualHelp={Help('Destination environment', 'Environment id to copy TO (Stage).')} />
                  )}
                </View>
              </Flex>
            </Card>

            <Card title="Content sets (copied in order)">
              <Flex direction="row" justifyContent="end" marginBottom="size-100">
                <ActionButton onPress={() => addSet(selected.id)}><Add /><Text>Add content set</Text></ActionButton>
              </Flex>
              {selected.contentSets.length === 0 && <Text>No content sets — add one.</Text>}
              {selected.contentSets.map((s, i) => (
                <View key={i} borderRadius="medium" UNSAFE_style={{ borderTop: i === 0 ? 'none' : '1px solid var(--spectrum-global-color-gray-200)' }} paddingTop={i === 0 ? 0 : 'size-200'} marginBottom="size-200">
                  <Flex direction="row" gap="size-200" alignItems="end" wrap>
                    {availableSets.length ? (
                      <Picker aria-label="Content set" label={i === 0 ? 'Content set' : null} selectedKey={s.id || null} items={availableSets} flex minWidth="size-3600"
                        onSelectionChange={(k) => { const cs = availableSets.find((x) => String(x.id) === String(k)); patchSet(selected.id, i, { id: String(k), paths: (cs && cs.paths) || [], wipeDestination: !!s.wipeDestination, publish: s.publish !== false }) }}
                        contextualHelp={i === 0 ? Help('Content sets', 'Pick an existing Cloud Manager Content Set (loaded for this job’s program). Its root paths are shown read-only beneath and are what gets copied (and published, if Publish is on). Wipe = clear the destination paths before copying; Publish = also publish these paths after the copy. Sets copy one at a time, in order.') : undefined}>
                        {(cs) => <Item key={cs.id} textValue={`${cs.name} (${cs.id})`}><Text UNSAFE_style={{ whiteSpace: 'nowrap' }}>{cs.name} ({cs.id})</Text></Item>}
                      </Picker>
                    ) : (
                      <TextField aria-label="Content set ID" label={i === 0 ? 'Content set ID' : null} value={s.id || ''} onChange={(v) => patchSet(selected.id, i, { id: v })} flex
                        contextualHelp={i === 0 ? Help('Content sets', 'The Cloud Manager Content Set id (the program’s content-set list could not be loaded, so enter it manually). Wipe = clear destination before copy; Publish = also publish after copy. Sets copy one at a time, in order.') : undefined} />
                    )}
                    <Switch aria-label="Publish after copy" isSelected={s.publish !== false} onChange={(v) => patchSet(selected.id, i, { publish: v })}>Publish after copy</Switch>
                    <Switch aria-label="Wipe" isSelected={!!s.wipeDestination} onChange={(v) => patchSet(selected.id, i, { wipeDestination: v })}>Wipe</Switch>
                    {Help('Wipe', 'Wipe = delete everything under the destination path before copying, so the destination exactly matches the source (removes items deleted on the source). Off = merge/overwrite without removing extras.')}
                    <ActionButton aria-label="Remove set" onPress={() => removeSet(selected.id, i)}><Delete /></ActionButton>
                  </Flex>
                  {(s.paths && s.paths.length > 0) ? (
                    <Flex direction="row" gap="size-100" wrap marginTop="size-150">
                      {s.paths.map((p, pi) => (
                        <View key={pi} backgroundColor="gray-100" borderWidth="thin" borderColor="gray-300" borderRadius="regular" paddingX="size-100" paddingY="size-25">
                          <Text UNSAFE_style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{p}</Text>
                        </View>
                      ))}
                    </Flex>
                  ) : (s.id && <Text UNSAFE_style={{ ...DIM, display: 'block', marginTop: 'var(--spectrum-global-dimension-size-100)' }}>No paths defined for this content set.</Text>)}
                </View>
              ))}
            </Card>

            <Card title="Publishing">
              <RadioGroup label="What to publish after each copy" value={pub.mode || 'prodMirror'} onChange={(v) => patchPublish(selected.id, { mode: v })}>
                <Radio value="prodMirror">Mirror what’s published on {fromEnvName || 'the copy-from environment'} <Text UNSAFE_style={DIM}>(recommended)</Text></Radio>
                <Radio value="publishAll">Publish everything in the set</Radio>
                <Radio value="onlyChanged">Only changed content</Radio>
                <Radio value="bulkPublish">Use the environment’s installed publish tool (advanced)</Radio>
              </RadioGroup>

              {pub.mode === 'bulkPublish' && (
                <View marginTop="size-200">
                  <TextField label="Country (blank = all)" value={pub.country || ''} onChange={(v) => patchPublish(selected.id, { country: v })} width="size-2400"
                    contextualHelp={Help('Country', 'Restrict the installed bulk-publish tool to one country code (e.g. gb). Leave blank to publish all countries.')} />
                </View>
              )}

              <details style={{ marginTop: 'var(--spectrum-global-dimension-size-250)' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--spectrum-global-color-gray-800)' }}>Advanced</summary>
                <View marginTop="size-200">
                  <CheckboxGroup label="Targets (replication agents)" orientation="horizontal"
                    value={pub.targets || ['publish']} onChange={(v) => patchPublish(selected.id, { targets: v.length ? v : ['publish'] })}
                    contextualHelp={Help('Targets', 'Which AEM tier(s) to replicate to. Publish = the live publish tier; Preview = the preview tier. Only applies to “Publish everything” and “Only changed”; Mirror auto-detects each path’s targets from the source.')}>
                    <Checkbox value="publish">Publish</Checkbox>
                    <Checkbox value="preview">Preview</Checkbox>
                  </CheckboxGroup>

                  <Flex direction="row" gap="size-400" wrap marginTop="size-250" alignItems="center">
                    <Switch isSelected={!!pub.enableVersion} onChange={(v) => patchPublish(selected.id, { enableVersion: v })}>Create version</Switch>
                    <Switch isSelected={!!pub.dryRun} onChange={(v) => patchPublish(selected.id, { dryRun: v })}>Dry run</Switch>
                  </Flex>
                  {pub.dryRun && <StatusLight variant="notice" marginTop="size-100">Dry run: the workflow logs the paths it would activate but does not replicate.</StatusLight>}

                  <Flex direction="row" gap="size-300" wrap marginTop="size-250" alignItems="end">
                    <TextField label="Chunk size" value={pub.chunkSize == null ? '' : String(pub.chunkSize)} onChange={(v) => patchPublish(selected.id, { chunkSize: v === '' ? null : Number(v) })} width="size-1600"
                      contextualHelp={Help('Chunk size', 'Number of paths bundled into a single replication batch. AEM default: 50.')} />
                    <TextField label="Max queue size" value={pub.maxQueueSize == null ? '' : String(pub.maxQueueSize)} onChange={(v) => patchPublish(selected.id, { maxQueueSize: v === '' ? null : Number(v) })} width="size-1600"
                      contextualHelp={Help('Max queue size', 'The step pauses when the replication queue exceeds this many items, then resumes once it drains. AEM default: 10.')} />
                    <TextField label="Max tree size" value={pub.maxTreeSize == null ? '' : String(pub.maxTreeSize)} onChange={(v) => patchPublish(selected.id, { maxTreeSize: v === '' ? null : Number(v) })} width="size-1600"
                      contextualHelp={Help('Max tree size', 'Maximum number of nodes for a tree to be treated as “small”. AEM default: 500000.')} />
                    <TextField label="Workflow model (optional override)" value={pub.model || ''} onChange={(v) => patchPublish(selected.id, { model: v })} flex
                      contextualHelp={Help('Workflow model override', 'Advanced: path to a workflow model that uses the Tree Activation step. Leave blank to use the default.')} />
                  </Flex>
                </View>
              </details>
            </Card>
          </>
        )}
      </Flex>
    </Flex>
  )
}
