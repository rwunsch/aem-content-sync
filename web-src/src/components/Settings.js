import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  Flex, View, Heading, Text, TextArea, Button, StatusLight,
  ActionButton, DialogTrigger, AlertDialog, Checkbox, CheckboxGroup, TextField
} from '@adobe/react-spectrum'
import Refresh from '@spectrum-icons/workflow/Refresh'
import { tierRank } from '../tiers'
import Card from './Card'

const DIM = { color: 'var(--spectrum-global-color-gray-700)' }

// Order environments highest tier first: prod → stage → dev/others.
const byTierDesc = (a, b) => tierRank(b.type) - tierRank(a.type)

function statusIsReady (s) {
  return /ready|running|active/i.test(String(s || ''))
}

export default function Settings ({ api, onHealth, active }) {
  const [credsSet, setCredsSet] = useState({}) // aemServiceCredsSet map from status.config
  const [credInfo, setCredInfo] = useState({}) // envId → { email, id, clientId, org } (non-secret)
  const [programs, setPrograms] = useState([]) // [{ programId, environments: [] }]
  const [jobsStatus, setJobsStatus] = useState([]) // status-bearing jobs: [{ programId, status: { lastStatus, lastRunAt } }]
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [credDraft, setCredDraft] = useState({}) // per-env textarea drafts (envId → JSON string)
  const [credBusy, setCredBusy] = useState(null) // envId currently saving/clearing
  const [resetBusy, setResetBusy] = useState(false)
  const [validation, setValidation] = useState({}) // envId → { ok, message } from validateCreds
  const [validateBusy, setValidateBusy] = useState(null) // envId currently being validated
  const [access, setAccess] = useState({ accessProfiles: [], mine: [], catalog: [] }) // access-control info
  const [accessSel, setAccessSel] = useState([]) // selected allowed profiles (draft)
  const [accessBusy, setAccessBusy] = useState(false)
  const [accessMsg, setAccessMsg] = useState(null) // { ok, text }
  const [customProfile, setCustomProfile] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const s = await api.status()
      const cfg = (s && s.config) || {}
      setCredsSet(cfg.aemServiceCredsSet || {})
      setJobsStatus((s && s.jobs) || [])
      const jobs = cfg.jobs || []
      const programIds = [...new Set(jobs.map((j) => j.programId).filter(Boolean))]
      const out = await Promise.all(programIds.map(async (programId) => {
        try {
          const er = await api.environments(programId)
          return { programId, environments: (er && er.environments) || [] }
        } catch (_) {
          return { programId, environments: [] }
        }
      }))
      setPrograms(out)
      try {
        const ci = await api.credInfo()
        setCredInfo((ci && ci.credInfo) || {})
      } catch (_) { /* non-fatal: technical-account display is best-effort */ }
      try {
        const ai = await api.accessInfo()
        if (ai) { setAccess(ai); setAccessSel(ai.accessProfiles || []) }
      } catch (_) { /* non-fatal: access-control card is best-effort */ }
      onHealth && onHealth(true)
    } catch (e) {
      setError(e.message); onHealth && onHealth(false)
    } finally {
      setLoading(false)
    }
  }, [api, onHealth])

  useEffect(() => { load() }, [load])

  // Re-fetch whenever the user navigates INTO the Settings tab (tabs stay mounted,
  // so a tab switch doesn't remount). This picks up programs/environments added on
  // jobs in Configure without a manual refresh.
  const wasActive = useRef(false)
  useEffect(() => {
    if (active && !wasActive.current) load()
    wasActive.current = active
  }, [active, load])

  // Validate (and provision the AEM user for) ONE environment's stored credential.
  // One authenticated call to AEM both proves the credential works and provisions
  // the technical-account user in the instance. Stores the result per env.
  const validateCreds = useCallback(async (envId, programId) => {
    setValidateBusy(envId)
    try {
      const r = await api.validateCreds(envId, programId)
      setValidation((v) => ({ ...v, [envId]: (r && r.validate) || { ok: false, message: 'No response' } }))
    } catch (e) {
      setValidation((v) => ({ ...v, [envId]: { ok: false, message: e.message } }))
    } finally { setValidateBusy(null) }
  }, [api])

  // Save ONE environment's Service Credentials JSON; backend merges into the map.
  const saveCreds = useCallback(async (envId, textValue, programId) => {
    setCredBusy(envId); setError(null)
    try {
      await api.saveConfig({ aemServiceCreds: { [envId]: textValue } })
      setCredDraft((d) => { const n = { ...d }; delete n[envId]; return n })
      await load()
      // Validate + provision the technical-account user right after saving.
      await validateCreds(envId, programId)
    } catch (e) { setError(e.message) } finally { setCredBusy(null) }
  }, [api, load, validateCreds])

  // Clear ONE environment's credential ('' → backend treats as delete).
  const clearCreds = useCallback(async (envId) => {
    setCredBusy(envId); setError(null)
    try {
      await api.saveConfig({ aemServiceCreds: { [envId]: '' } })
      setCredDraft((d) => { const n = { ...d }; delete n[envId]; return n })
      await load()
    } catch (e) { setError(e.message) } finally { setCredBusy(null) }
  }, [api, load])

  const doReset = useCallback(async () => {
    setResetBusy(true); setError(null)
    try { await api.reset(); await load() } catch (e) { setError(e.message) } finally { setResetBusy(false) }
  }, [api, load])

  // Persist the allowed access profiles. '*' (any org user) overrides the rest.
  const saveAccess = useCallback(async () => {
    setAccessBusy(true); setAccessMsg(null)
    try {
      const profiles = accessSel.includes('*') ? ['*'] : accessSel
      await api.saveConfig({ accessProfiles: profiles })
      setAccessMsg({ ok: true, text: 'Access profiles updated.' })
      await load()
    } catch (e) { setAccessMsg({ ok: false, text: e.message }) } finally { setAccessBusy(false) }
  }, [api, accessSel, load])

  // Does the current selection still include a profile the caller holds?
  const inSel = (g) => accessSel.some((p) => g === p || g.startsWith(p))
  const wouldLockOut = !accessSel.includes('*') && (access.mine || []).length > 0 && !(access.mine || []).some(inSel)
  // Custom profiles already chosen that aren't in the catalog (show as extra checkboxes).
  const catalogIds = (access.catalog || []).map((c) => c.id)
  const customSelected = accessSel.filter((p) => !catalogIds.includes(p))

  return (
    <Flex direction="column" gap="size-350" UNSAFE_style={{ maxWidth: 1100 }}>
      <Flex direction="row" alignItems="center" gap="size-200">
        <Heading level={2} margin={0}>Settings</Heading>
        <View flex />
        <ActionButton aria-label="Reload environments" isQuiet onPress={load}><Refresh /></ActionButton>
      </Flex>
      <Text UNSAFE_style={DIM}>
        Three things must be set up per program: the Cloud Manager integration (copy), its
        Deployment Manager + AEM Administrator grants (verified by a run), and each
        environment&rsquo;s Service Credentials (publish).
      </Text>
      <Text UNSAFE_style={DIM}>
        Manage each environment&rsquo;s author Service Credentials (JWT) so the app can publish on
        its author. Get the JSON from Cloud Manager &rarr; the environment &rarr; Developer Console
        &rarr; Integrations &rarr; Service Credentials &rarr; download.
      </Text>

      {error && <StatusLight variant="negative">{error}</StatusLight>}
      {loading && programs.length === 0 && <Text>Loading environments…</Text>}
      {!loading && programs.length === 0 && !error && (
        <Text>No environments yet — set a program and environments on a job in Configure.</Text>
      )}

      {programs.length > 0 && (
        <Card title="Setup status">
          {programs.map(({ programId, environments }) => {
            const cmReachable = environments.length > 0
            const lastOk = jobsStatus
              .filter((j) => j.programId === programId && j.status && j.status.lastStatus === 'SUCCEEDED')
              .map((j) => j.status.lastRunAt)
              .sort()
              .pop()
            const allCreds = environments.length > 0 && environments.every((e) => !!credsSet[e.id])
            return (
              <Flex key={programId} direction="column" gap="size-75" marginBottom="size-200">
                <Text UNSAFE_style={{ fontWeight: 700 }}>Program {programId}</Text>
                {cmReachable
                  ? <StatusLight margin={0} variant="positive">Cloud Manager integration: Connected — reaching Cloud Manager</StatusLight>
                  : <StatusLight margin={0} variant="notice">Cloud Manager integration: Can&rsquo;t reach Cloud Manager — check the App Builder integration credential and its Deployment Manager role.</StatusLight>}
                {lastOk
                  ? <StatusLight margin={0} variant="positive">Content-copy access (Developer Console technical account): verified by a successful run ({new Date(lastOk).toLocaleString()})</StatusLight>
                  : <StatusLight margin={0} variant="notice">Content-copy access (Developer Console technical account): Not yet verified — grant the integration&rsquo;s technical account the Deployment Manager role (Cloud Manager) and AEM Administrator (Admin Console) on each environment. This turns green automatically after the first successful run.</StatusLight>}
                {allCreds
                  ? <StatusLight margin={0} variant="positive">Publish credentials: All environments have Service Credentials</StatusLight>
                  : <StatusLight margin={0} variant="notice">Publish credentials: Some environments need Service Credentials (set them below).</StatusLight>}
              </Flex>
            )
          })}
        </Card>
      )}

      {programs.map(({ programId, environments }) => {
        const sortedEnvs = [...environments].sort(byTierDesc)
        return (
          <Card key={programId} title={`Program ${programId}`}>
            {sortedEnvs.length === 0 && <Text UNSAFE_style={DIM}>No environments found for this program.</Text>}
            <Flex direction="column" gap="size-150">
              {sortedEnvs.map((e) => {
                const hasCreds = !!credsSet[e.id]
                const info = credInfo[e.id]
                const techAcct = info && (info.email || info.id)
                const draft = credDraft[e.id]
                const value = draft != null ? draft : ''
                const busy = credBusy === e.id
                const validating = validateBusy === e.id
                const vr = validation[e.id]
                return (
                  <View key={e.id} borderRadius="regular" borderWidth="thin" borderColor="gray-300" paddingX="size-150" paddingY="size-150">
                    <Flex direction="row" gap="size-150" alignItems="start" wrap>
                      <Text>{e.name} ({e.type}, {e.id})</Text>
                      <View flex />
                      <Flex direction="column" gap="size-50">
                        <StatusLight margin={0} variant={statusIsReady(e.status) ? 'positive' : 'notice'}>
                          Environment state: {statusIsReady(e.status) ? 'awake' : (e.status || 'unknown status')}
                        </StatusLight>
                        {hasCreds
                          ? <StatusLight margin={0} variant="positive">Service Credentials set</StatusLight>
                          : <StatusLight margin={0} variant="notice">No Service Credentials</StatusLight>}
                      </Flex>
                      <Button
                        variant="secondary"
                        style="outline"
                        isDisabled={validating}
                        isPending={validating}
                        onPress={() => validateCreds(e.id, programId)}>
                        {validating ? 'Checking…' : 'Check credentials'}
                      </Button>
                    </Flex>
                    {vr && (
                      <Flex direction="column" marginTop="size-100">
                        <StatusLight margin={0} variant={vr.ok ? 'positive' : 'negative'}>{vr.message}</StatusLight>
                      </Flex>
                    )}
                    {hasCreds && techAcct && (
                      <Flex direction="column" marginTop="size-100">
                        <Text UNSAFE_style={DIM}>Technical account: {techAcct}</Text>
                        <Text UNSAFE_style={DIM}>Grant this account replication (activate) rights on this environment to allow publishing.</Text>
                      </Flex>
                    )}
                    <Flex direction="column" marginTop="size-100">
                      <Text UNSAFE_style={DIM}>Publishing uses this environment&rsquo;s Service Credentials (below). Content copy uses the App Builder integration (see Help).</Text>
                    </Flex>
                    <details style={{ marginTop: 'var(--spectrum-global-dimension-size-100)' }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--spectrum-global-color-gray-800)' }}>Service Credentials (JWT)</summary>
                      <View marginTop="size-150">
                        <TextArea
                          label="Paste Service Credentials JSON"
                          aria-label={`Service Credentials JSON for ${e.id}`}
                          value={value}
                          width="100%"
                          description="Paste the environment's Service Credentials JSON"
                          onChange={(v) => setCredDraft((d) => ({ ...d, [e.id]: v }))} />
                        <Flex direction="row" gap="size-150" marginTop="size-150" alignItems="center" wrap>
                          <Button variant="primary" isDisabled={busy || !value.trim()} isPending={busy} onPress={() => saveCreds(e.id, value)}>Save</Button>
                          {hasCreds && <Button variant="secondary" style="outline" isDisabled={busy} onPress={() => clearCreds(e.id)}>Clear</Button>}
                        </Flex>
                      </View>
                    </details>
                  </View>
                )
              })}
            </Flex>
          </Card>
        )
      })}

      <Card title="Access control — who can use this app">
        <Flex direction="column" gap="size-150">
          <Text UNSAFE_style={DIM}>
            On top of Adobe sign-in (same org), the app only accepts callers who hold one of
            the Admin Console profiles selected below. Everyone else gets a 403. Default:
            Cloud Manager Deployment &amp; Program Managers.
          </Text>
          {[...new Set(access.mine || [])].length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', color: 'var(--spectrum-global-color-gray-700)' }}>
                Your profiles ({[...new Set(access.mine || [])].length})
              </summary>
              <View elementType="ul" UNSAFE_style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
                {[...new Set(access.mine || [])].sort().map((p) => (
                  <li key={p}><Text UNSAFE_style={{ fontFamily: 'monospace', fontSize: '12px' }}>{p}</Text></li>
                ))}
              </View>
            </details>
          )}
          <CheckboxGroup
            aria-label="Allowed Admin Console profiles"
            value={accessSel}
            onChange={setAccessSel}>
            {(access.catalog || []).map((c) => (
              <Checkbox key={c.id} value={c.id}>{c.label}{c.id !== '*' ? ` (${c.id})` : ''}</Checkbox>
            ))}
            {customSelected.map((p) => (
              <Checkbox key={p} value={p}>{p} (custom)</Checkbox>
            ))}
          </CheckboxGroup>
          <Flex direction="row" gap="size-150" alignItems="end" wrap>
            <TextField label="Add a custom profile (IMS group name)" value={customProfile} onChange={setCustomProfile} width="size-3600" />
            <Button variant="secondary" style="outline"
              isDisabled={!customProfile.trim() || accessSel.includes(customProfile.trim())}
              onPress={() => { setAccessSel([...accessSel, customProfile.trim()]); setCustomProfile('') }}>Add</Button>
          </Flex>
          {accessSel.includes('*') && (
            <StatusLight margin={0} variant="notice">“Any signed-in user” is selected — profile restrictions are ignored (authentication only).</StatusLight>
          )}
          {wouldLockOut && (
            <StatusLight margin={0} variant="negative">This selection excludes all of your profiles — saving would lock you out (the server will reject it).</StatusLight>
          )}
          {accessMsg && <StatusLight margin={0} variant={accessMsg.ok ? 'positive' : 'negative'}>{accessMsg.text}</StatusLight>}
          <Flex direction="row" gap="size-150">
            <Button variant="primary" isDisabled={accessBusy || accessSel.length === 0 || wouldLockOut} isPending={accessBusy} onPress={saveAccess}>Save access profiles</Button>
            <Button variant="secondary" style="outline" isDisabled={accessBusy} onPress={() => setAccessSel(access.accessProfiles || [])}>Reset</Button>
          </Flex>
        </Flex>
      </Card>

      <Card title="Maintenance">
        <Flex direction="row" gap="size-200" alignItems="center" wrap>
          <DialogTrigger>
            <Button variant="negative" style="outline" isDisabled={resetBusy} isPending={resetBusy}>Reset state</Button>
            {(close) => (
              <AlertDialog title="Reset state?" variant="destructive" primaryActionLabel="Reset" cancelLabel="Cancel"
                onPrimaryAction={() => { close(); doReset() }}>
                This clears run state, the queue, per-job status and the config override, reverting to the bundled default. Stored Service Credentials are also cleared.
              </AlertDialog>
            )}
          </DialogTrigger>
          <Text UNSAFE_style={DIM}>Clears run state, queue, per-job status and the config override.</Text>
        </Flex>
      </Card>
    </Flex>
  )
}
