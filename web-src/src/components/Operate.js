import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  Flex, View, Heading, Text, ProgressBar, StatusLight,
  Switch, Well, ActionButton, Badge, Item, Picker,
  MenuTrigger, Menu, Button, DialogTrigger, AlertDialog,
  TableView, TableHeader, TableBody, Column, Row, Cell
} from '@adobe/react-spectrum'
import Refresh from '@spectrum-icons/workflow/Refresh'
import { statusVariant } from './ui'
import Card from './Card'

const PHASE_ORDER = ['IDLE', 'CHECK_STUCK', 'COPYING', 'PUBLISHING', 'NOTIFYING_SUCCESS', 'NOTIFYING_FAILURE']
const PHASE_LABEL = {
  IDLE: 'Idle', CHECK_STUCK: 'Checking for stuck flows', COPYING: 'Copying content',
  PUBLISHING: 'Publishing', NOTIFYING_SUCCESS: 'Done — success', NOTIFYING_FAILURE: 'Done — failure'
}
const phaseProgress = (p) => { const i = PHASE_ORDER.indexOf(p); return i < 0 ? 0 : Math.round((i / (PHASE_ORDER.length - 1)) * 100) }

const DIM = { color: 'var(--spectrum-global-color-gray-600)' }

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—')
const fmtDur = (a, b) => {
  if (!a || !b) return ''
  const ms = new Date(b) - new Date(a)
  if (!(ms >= 0)) return ''
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// One expandable run record (native <details> — reliable inside the SPA, no
// extra component lib). Collapsed: status + timings + sets. Expanded: the error
// (if failed) then the captured run log.
function RunRecord ({ r }) {
  const ok = r.status === 'SUCCEEDED'
  return (
    <details style={{ borderTop: '1px solid var(--spectrum-global-color-gray-200)', padding: '6px 0' }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>
        <span style={{ fontWeight: 700, color: ok ? 'var(--spectrum-global-color-green-700)' : 'var(--spectrum-global-color-red-700)' }}>
          {ok ? '✓ Succeeded' : '✗ Failed'}
        </span>
        {' · '}{fmtTime(r.startedAt)}{r.endedAt ? ` → ${fmtTime(r.endedAt)}` : ''}
        {fmtDur(r.startedAt, r.endedAt) ? ` (${fmtDur(r.startedAt, r.endedAt)})` : ''}
        {Array.isArray(r.sets) && r.sets.length ? ` · sets: ${r.sets.join(', ')}` : ''}
        {r.published != null ? ` · published ${r.published}` : ''}{r.errors ? `, errors ${r.errors}` : ''}
      </summary>
      <div style={{ marginTop: 6 }}>
        {!ok && r.error && (
          <div style={{ background: 'var(--spectrum-global-color-red-100)', color: 'var(--spectrum-global-color-red-700)', padding: '6px 8px', borderRadius: 4, marginBottom: 6, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {r.error}
          </div>
        )}
        <div style={{ maxHeight: 240, overflowY: 'auto', background: 'var(--spectrum-global-color-gray-75)', padding: '6px 8px', borderRadius: 4 }}>
          {(r.log && r.log.length)
            ? r.log.slice().reverse().map((line, i) => (
              <div key={i} style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{line}</div>))
            : <Text>No log captured for this run.</Text>}
        </div>
      </div>
    </details>
  )
}

export default function Operate ({ api, onHealth }) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [logJobId, setLogJobId] = useState(null)
  const logTouched = useRef(false)
  const timer = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const s = await api.status()
      setStatus(s); setError(null); onHealth && onHealth(true)
    } catch (e) { setError(e.message); onHealth && onHealth(false) }
  }, [api, onHealth])

  useEffect(() => { refresh(); timer.current = setInterval(refresh, 5000); return () => clearInterval(timer.current) }, [refresh])

  const runJob = useCallback(async (id) => { setBusy(true); try { await api.runJob(id); await refresh() } catch (e) { setError(e.message) } finally { setBusy(false) } }, [api, refresh])
  const runAll = useCallback(async () => { setBusy(true); try { await api.runAll(); await refresh() } catch (e) { setError(e.message) } finally { setBusy(false) } }, [api, refresh])
  const toggleAuto = useCallback(async (enabled) => { setStatus((s) => ({ ...s, autoEnabled: enabled })); try { await api.setAuto(enabled) } catch (e) { setError(e.message); refresh() } }, [api, refresh])
  const doClearStatus = useCallback(async (id) => { setBusy(true); try { await api.clearStatus(id); await refresh() } catch (e) { setError(e.message) } finally { setBusy(false) } }, [api, refresh])
  const doCancel = useCallback(async () => { setBusy(true); try { await api.cancel(); await refresh() } catch (e) { setError(e.message) } finally { setBusy(false) } }, [api, refresh])

  // Guard on null status for BOTH loading and error (a failed/blocked status
  // call leaves status null) — never fall through to status.* below or the
  // whole tab white-screens.
  if (!status) {
    return (
      <Flex direction="column" gap="size-350">
        {error
          ? <StatusLight variant="negative">{error}</StatusLight>
          : <Text>Loading status…</Text>}
      </Flex>
    )
  }

  const running = status && status.running
  const phase = (status && status.phase) || 'IDLE'
  const jobs = (status && status.jobs) || []
  const enabledJobs = jobs.filter((j) => j.enabled)
  const queueNames = (status.queue || []).map((id) => { const j = jobs.find((x) => x.id === id); return j ? j.name : id })
  const phaseVariant = phase === 'NOTIFYING_FAILURE' ? 'negative' : phase === 'NOTIFYING_SUCCESS' ? 'positive' : running ? 'info' : 'neutral'

  // Default the log selector to the most-recently-run job, else the first job.
  const mostRecentJob = jobs
    .filter((j) => j.status && j.status.lastRunAt)
    .sort((a, b) => new Date(b.status.lastRunAt) - new Date(a.status.lastRunAt))[0]
  const defaultLogJobId = (mostRecentJob && mostRecentJob.id) || (jobs[0] && jobs[0].id) || null
  const selectedLogJobId = (logTouched.current && logJobId) ? logJobId : defaultLogJobId

  return (
    <Flex direction="column" gap="size-350">
      {error && <StatusLight variant="negative">{error}</StatusLight>}

      {/* Current run */}
      <Card>
        <Flex direction="row" justifyContent="space-between" alignItems="center" gap="size-200" wrap>
          <Flex direction="column" gap="size-100" minWidth="size-3000" flex>
            <Flex direction="row" gap="size-150" alignItems="center" wrap>
              <Heading level={4} margin={0}>Current run</Heading>
              <StatusLight margin={0} variant={phaseVariant}>{PHASE_LABEL[phase] || phase}</StatusLight>
            </Flex>
            <Text UNSAFE_style={DIM}>A “run” copies one job’s content sets from its copy-from environment, then publishes them on the destination.</Text>
            <ProgressBar aria-label="Run progress" width="100%" value={phaseProgress(phase)} showValueLabel={false} />
            {running && (
              <Flex direction="row" gap="size-400" wrap marginTop="size-100">
                {status.flowId && <Text>CM flow: {status.flowId}</Text>}
              </Flex>
            )}
            {queueNames.length > 0 && (
              <Flex direction="row" gap="size-100" alignItems="center" wrap marginTop="size-100">
                <Text>Queued behind:</Text>
                {queueNames.map((n, i) => <Badge key={i} variant="neutral">{n}</Badge>)}
              </Flex>
            )}
          </Flex>
          <ActionButton aria-label="Refresh" onPress={refresh}><Refresh /></ActionButton>
        </Flex>

        <Flex direction="row" gap="size-200" alignItems="center" marginTop="size-300" wrap>
          <MenuTrigger>
            <Button variant="accent" isDisabled={busy}>Run a job</Button>
            <Menu onAction={(key) => { if (key === '__all__') runAll(); else runJob(key) }}>
              {[
                ...enabledJobs.map((j) => <Item key={j.id}>{j.name}</Item>),
                <Item key="__all__">All enabled jobs</Item>
              ]}
            </Menu>
          </MenuTrigger>
          {(running || phase !== 'IDLE') && (
            <DialogTrigger>
              <Button variant="negative" style="outline" isDisabled={busy}>Cancel run</Button>
              {(close) => (
                <AlertDialog title="Cancel the current run?" variant="destructive" primaryActionLabel="Cancel run" cancelLabel="Keep running"
                  onPrimaryAction={() => { close(); doCancel() }}>
                  Cancel the current run? This stops the in-progress Cloud Manager flow, clears the queue, and resets to idle.
                </AlertDialog>
              )}
            </DialogTrigger>
          )}
          <View flex />
          <Switch isSelected={!!(status && status.autoEnabled)} isDisabled={busy} onChange={toggleAuto}>Pause schedule</Switch>
        </Flex>
      </Card>

      {/* Last run, per job */}
      <Card title="Last run, per job">
        <TableView aria-label="Last run, per job" density="spacious" overflowMode="wrap">
          <TableHeader>
            <Column key="name">Job</Column>
            <Column key="result" width={150}>Result</Column>
            <Column key="when">When</Column>
            <Column key="actions" width={90} align="end">{''}</Column>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <Row key={j.id}>
                <Cell>{j.name}{j.id === status.activeJobId ? ' (running)' : ''}{!j.enabled ? ' (disabled)' : ''}</Cell>
                <Cell>
                  <StatusLight margin={0} variant={statusVariant(j.status && j.status.lastStatus)}>{(j.status && j.status.lastStatus) || '—'}</StatusLight>
                  {j.status && j.status.lastStatus === 'FAILED' && j.status.lastError &&
                    <Text UNSAFE_style={{ display: 'block', fontSize: '11px', color: 'var(--spectrum-global-color-red-600)', whiteSpace: 'normal' }}>{j.status.lastError}</Text>}
                </Cell>
                <Cell>{(j.status && j.status.lastRunAt) ? new Date(j.status.lastRunAt).toLocaleString() : '—'}</Cell>
                <Cell>{(j.status && j.status.lastStatus && j.id !== status.activeJobId)
                  ? <ActionButton isQuiet onPress={() => doClearStatus(j.id)} isDisabled={busy} aria-label={`Clear status for ${j.name}`}>Clear</ActionButton>
                  : ''}</Cell>
              </Row>
            ))}
          </TableBody>
        </TableView>
        <Text UNSAFE_style={{ ...DIM, display: 'block', marginTop: 'var(--spectrum-global-dimension-size-150)' }}>A quick last-run overview. Full per-run history with logs is below.</Text>
      </Card>

      {/* Run history, per job — expandable, with logs + failure reason */}
      <Card title="Run history">
        <Text UNSAFE_style={{ ...DIM, display: 'block', marginBottom: 'var(--spectrum-global-dimension-size-150)' }}>
          The last 10 runs of each job. Expand a run to see its content sets, the captured log, and any error message.
        </Text>
        {jobs.map((j) => {
          const hist = (status.runHistory && status.runHistory[j.id]) || []
          return (
            <View key={j.id} marginBottom="size-250">
              <Heading level={5} margin={0}>{j.name}</Heading>
              {hist.length === 0
                ? <Text UNSAFE_style={DIM}>No completed runs recorded yet.</Text>
                : hist.map((r, i) => <RunRecord key={i} r={r} />)}
            </View>
          )
        })}
      </Card>

      {/* Run log */}
      <Card title="Run log">
        <Flex direction="row" gap="size-200" alignItems="end" marginBottom="size-200" wrap>
          <Picker
            label="Run log for:"
            selectedKey={selectedLogJobId}
            onSelectionChange={(k) => { logTouched.current = true; setLogJobId(k) }}>
            {jobs.map((j) => <Item key={j.id}>{j.name}</Item>)}
          </Picker>
          <Text UNSAFE_style={DIM}>Shows the most recent run.</Text>
        </Flex>
        <Well UNSAFE_style={{ maxHeight: 320, overflowY: 'auto' }}>
          {(status && status.log && status.log.length)
            ? status.log.slice().reverse().map((line, i) => (
              <Text key={i} UNSAFE_style={{ display: 'block', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{line}</Text>))
            : <Text>No log entries for the current/last run.</Text>}
        </Well>
      </Card>
    </Flex>
  )
}
