import React, { useEffect, useState, useCallback } from 'react'
import {
  Flex, View, Heading, Text, Divider, Link, StatusLight, Button, Picker, Item,
  TableView, TableHeader, TableBody, Column, Row, Cell
} from '@adobe/react-spectrum'
import { aemAuthorUrl } from './links'
import { tierRank } from '../tiers'

// Mask a long identifier for display — keep the head and tail, hide the middle.
function mask (s) {
  if (!s) return '—'
  const str = String(s)
  if (str.length <= 12) return str
  return `${str.slice(0, 6)}…${str.slice(-4)}`
}

// "Preview gap" helper — ported from the Jobs validate tool. Compares the
// publish-activated and preview-activated counts for a path.
function gapNote (v) {
  const p = Number(String(v.publishActivated).replace(/\D/g, ''))
  const pv = Number(String(v.previewActivated).replace(/\D/g, ''))
  if (!Number.isFinite(p) || !Number.isFinite(pv)) return '—'
  if (pv >= p && p > 0) return 'preview ≈ publish ✓'
  return `${Math.max(p - pv, 0)} fewer on preview`
}

// A Cloud Manager environment status string usually reads "ready" once an env
// is up and running. Treat ready/running as green, anything else as amber.
function statusIsReady (s) {
  return /ready|running|active/i.test(String(s || ''))
}

export default function Help ({ api }) {
  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState(null)
  const [jobs, setJobs] = useState(null)

  // Connection-readiness state (Connection status panel) — all dynamic.
  const [cm, setCm] = useState({ state: 'pending' }) // pending | ok | error
  const [creds, setCreds] = useState(null) // aemServiceCredsSet (boolean) map from status.config
  const [primaryProgramId, setPrimaryProgramId] = useState(null)
  const [environments, setEnvironments] = useState({ state: 'pending' }) // pending | ok | error

  // Diagnostics (validate) state — moved here from the Jobs tab.
  const [selectedJobId, setSelectedJobId] = useState(null)
  const [validation, setValidation] = useState(null)
  const [validating, setValidating] = useState(false)
  const [validateError, setValidateError] = useState(null)

  // Pull the connected-integration identity and the configured jobs on mount,
  // plus run the connection-readiness checks in parallel.
  useEffect(() => {
    // Identity (always informational / neutral).
    api.integration()
      .then((r) => setInfo(r.integration))
      .catch((e) => setInfoError(e.message))

    // Cloud Manager reachability.
    api.programs()
      .then((r) => {
        const programs = (r && r.programs) || []
        if (programs.length > 0) setCm({ state: 'ok', count: programs.length })
        else setCm({ state: 'error' })
      })
      .catch(() => setCm({ state: 'error' }))

    // Jobs + configured AEM credentials + the per-environment listing.
    api.status()
      .then((s) => {
        const list = (s.config && s.config.jobs) || []
        setJobs(list)
        setSelectedJobId((cur) => cur || (list[0] && list[0].id) || null)
        setCreds((s.config && s.config.aemServiceCredsSet) || {})

        // Collect the distinct programIds across the jobs; use the first as the
        // primary program and list ALL of its environments.
        const programIds = [...new Set(list.map((j) => j.programId).filter(Boolean))]
        const primary = programIds[0] || null
        setPrimaryProgramId(primary)
        if (!primary) {
          setEnvironments({ state: 'ok', list: [] })
          return
        }
        api.environments(primary)
          .then((er) => setEnvironments({ state: 'ok', list: (er && er.environments) || [] }))
          .catch((e) => setEnvironments({ state: 'error', message: e.message }))
      })
      .catch(() => {
        setJobs([])
        setCreds({})
        setEnvironments({ state: 'error', message: 'status unavailable' })
      })
  }, [api])

  // Environments ordered prod → stage → dev (highest tier first).
  const orderedEnvs = (environments.list || [])
    .slice()
    .sort((a, b) => tierRank(b.type) - tierRank(a.type))

  const doValidate = useCallback(async (id) => {
    if (!id) return
    setValidating(true); setValidation(null); setValidateError(null)
    try {
      const r = await api.validate(id)
      setValidation(r.validation || [])
    } catch (e) {
      setValidateError(e.message)
    } finally {
      setValidating(false)
    }
  }, [api])

  return (
    <Flex direction="column" gap="size-350" UNSAFE_style={{ maxWidth: 640 }}>
      <Heading level={2} marginBottom={0}>Help</Heading>
      <Text>How this app copies and publishes content between AEM author environments, how to set an environment up, and how to diagnose what a run will do.</Text>

      {/* 0 — Connection status (fully dynamic readiness panel) */}
      <View>
        <Heading level={3}>Connection status</Heading>
        <Flex direction="column" gap="size-200">

          {/* Cloud Manager access */}
          <View>
            {cm.state === 'pending' && <StatusLight variant="neutral">Checking… Cloud Manager access</StatusLight>}
            {cm.state === 'ok' && (
              <StatusLight variant="positive">Connected — Cloud Manager reachable ({cm.count} program{cm.count === 1 ? '' : 's'})</StatusLight>
            )}
            {cm.state === 'error' && (
              <Flex direction="column" gap="size-50">
                <StatusLight variant="negative">Not connected — the integration can&rsquo;t reach Cloud Manager</StatusLight>
                <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>
                  Grant the technical account the Cloud Manager <b>Deployment Manager</b> role
                  (Admin Console &rarr; Cloud Manager product profile) and wait for IMS propagation.
                </Text>
              </Flex>
            )}
          </View>

          {/* Identity — informational / neutral */}
          <View>
            {infoError && <StatusLight variant="negative">{infoError}</StatusLight>}
            {!info && !infoError && <StatusLight variant="neutral">Checking… identity</StatusLight>}
            {info && (
              <Flex direction="column" gap="size-50">
                <StatusLight variant="neutral">Identity</StatusLight>
                <View elementType="ul" UNSAFE_style={{ margin: 0, paddingLeft: '1.2rem' }}>
                  <li><Text><b>Technical account:</b> <code>{info.technicalAccountId || '—'}</code></Text></li>
                  <li><Text><b>IMS org:</b> <code>{mask(info.imsOrgId)}</code></Text></li>
                  <li><Text><b>Client ID:</b> <code>{mask(info.clientId)}</code></Text></li>
                </View>
              </Flex>
            )}
          </View>

          {/* Environments & authors — all environments for the primary program */}
          <View>
            <Text><b>Environments &amp; authors</b></Text>
            {environments.state === 'pending' && <Text>Checking…</Text>}
            {environments.state === 'error' && (
              <StatusLight variant="negative">Couldn&rsquo;t list environments{environments.message ? `: ${environments.message}` : ''}</StatusLight>
            )}
            {environments.state === 'ok' && orderedEnvs.length === 0 && (
              <Text>No environments found for the configured program.</Text>
            )}
            {environments.state === 'ok' && orderedEnvs.length > 0 && (
              <Flex direction="column" gap="size-200" marginTop="size-100">
                {orderedEnvs.map((env) => {
                  const author = aemAuthorUrl(primaryProgramId, env.id)
                  const hasCreds = !!(creds && creds[env.id])
                  // The AEM author auth method the app will actually use for THIS env,
                  // resolved in the same order the backend uses: per-env Service
                  // Credentials (JWT) → bearer token → basic auth → (Cloud Manager
                  // token, which classic AEM endpoints reject).
                  const basicAvailable = !!(info && info.basicAvailable)
                  const hasAemToken = !!(info && info.hasAemToken)
                  return (
                    <View key={env.id} UNSAFE_style={{ paddingLeft: '0.2rem' }}>
                      <Flex direction="column" gap="size-50">
                        <Text><b>{env.name}</b> ({env.type}, {env.id})</Text>
                        {/* Line 1 — Environment run state (is the env awake), NOT auth. */}
                        <StatusLight variant={statusIsReady(env.status) ? 'positive' : 'notice'}>
                          Environment state: {statusIsReady(env.status) ? 'awake' : (env.status || 'unknown status')}
                        </StatusLight>
                        {author
                          ? <Text>author: <Link><a href={author} target="_blank" rel="noopener noreferrer">{author} ↗</a></Link></Text>
                          : <Text>author: —</Text>}
                        {/* Line 2 — Publish auth (Credential B): the AEM Service Credentials for THIS env. */}
                        {hasCreds
                          ? <StatusLight variant="positive">Publish credential (B): Service Credentials set — use “Check credentials” in Settings to confirm</StatusLight>
                          : hasAemToken
                            ? <StatusLight variant="positive">Publish credential (B): bearer token</StatusLight>
                            : basicAvailable
                              ? <StatusLight variant="notice">Publish credential (B): basic auth (works on dev/sandbox only — paste Service Credentials for production authors)</StatusLight>
                              : (
                                <Flex direction="column" gap="size-50">
                                  <StatusLight variant="negative">Publish credential (B): none — paste this environment&rsquo;s Service Credentials JSON in the Settings tab. (The App Builder integration&rsquo;s own token cannot publish — replicate/querybuilder return 403.)</StatusLight>
                                </Flex>
                              )}
                      </Flex>
                    </View>
                  )
                })}
              </Flex>
            )}
          </View>
        </Flex>
      </View>

      <Divider size="S" />

      {/* 0b — The two credentials (mental model) */}
      <View>
        <Heading level={3}>Two credentials</Heading>
        <Text>
          This app uses <b>two separate credentials</b> for two separate jobs.
          Keeping them straight is the key to setting the app up correctly.
        </Text>

        <Flex direction="column" gap="size-250" marginTop="size-150">

          {/* Credential A */}
          <View borderRadius="regular" borderWidth="thin" borderColor="gray-300" paddingX="size-200" paddingY="size-150">
            <Flex direction="column" gap="size-100">
              <Heading level={4} margin={0}>Credential A — the App Builder integration</Heading>
              <View elementType="ul" UNSAFE_style={{ margin: 0, paddingLeft: '1.2rem' }}>
                <li><Text><b>What it is:</b> this project&rsquo;s own OAuth Server-to-Server credential (the integration&rsquo;s technical account).</Text></li>
                <li><Text><b>Where to find it:</b> Adobe Developer Console &rarr; this project &rarr; the OAuth Server-to-Server credential.</Text></li>
                <li><Text><b>Where to grant it:</b> Admin Console &mdash; the <b>Deployment Manager</b> role in Cloud Manager, plus <b>AEM Administrator</b> on the source and destination environments.</Text></li>
                <li><Text><b>Used for:</b> the <b>content copy</b> (Cloud Manager&rsquo;s content-flow engine moves content downstream).</Text></li>
                <li><Text><b>How readiness is determined:</b> <b>Cloud Manager reachable</b> (the programs check below) <i>plus</i> a successful copy &mdash; copy ability is <b>proven by copy</b>, not by a direct AEM probe.</Text></li>
              </View>
              <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>
                Note: this token cannot call an AEM author directly &mdash; every AEM
                author endpoint returns <b>403</b> even when the account IS AEM
                Administrator, because Cloud Manager&rsquo;s copy engine consumes that
                grant on the backend. So there is no direct AEM test for Credential A.
              </Text>
            </Flex>
          </View>

          {/* Credential B */}
          <View borderRadius="regular" borderWidth="thin" borderColor="gray-300" paddingX="size-200" paddingY="size-150">
            <Flex direction="column" gap="size-100">
              <Heading level={4} margin={0}>Credential B — the AEM Service Credentials (per environment)</Heading>
              <View elementType="ul" UNSAFE_style={{ margin: 0, paddingLeft: '1.2rem' }}>
                <li><Text><b>What it is:</b> the Service Credentials (JWT) JSON downloaded for <i>each</i> environment &mdash; one per environment.</Text></li>
                <li><Text><b>Where to find it:</b> Cloud Manager &rarr; the environment &rarr; Developer Console &rarr; Integrations &rarr; Service Credentials &rarr; download.</Text></li>
                <li><Text><b>Where to grant it:</b> on that environment&rsquo;s author &mdash; the credential&rsquo;s technical-account user needs <b>replicate (activate) rights</b>.</Text></li>
                <li><Text><b>Used for:</b> the <b>publish</b> step (replication / activation) on that environment.</Text></li>
                <li><Text><b>How readiness is determined:</b> directly testable &mdash; the <b>Check credentials</b> button in Settings authenticates and provisions the technical-account user.</Text></li>
              </View>
            </Flex>
          </View>

        </Flex>
      </View>

      <Divider size="S" />

      {/* 1 — What a run is */}
      <View>
        <Heading level={3}>What a run is</Heading>
        <Text>
          A run takes one job and copies that job&rsquo;s content sets from its
          copy-from environment (the higher tier) to the destination (the lower
          tier), then publishes those content sets on the destination. Copying
          happens first; publishing happens after the copy lands.
        </Text>
      </View>

      <Divider size="S" />

      {/* 2 — How copy & publish work */}
      <View>
        <Heading level={3}>How copy &amp; publish work</Heading>
        <Flex direction="column" gap="size-150">
          <Text>
            The copy step uses Cloud Manager content flows. Each content set is
            copied by its own flow, and a flow only ever moves content
            downstream (from a higher tier to a lower one). An environment can
            run only one content flow at a time, so when a job has several
            content sets they are copied one after another, in order, rather
            than in parallel.
          </Text>
          <Text>
            Content copy intentionally strips the replication (publish) status
            from each node as it lands on the destination &mdash; that status
            describes the source environment&rsquo;s publish state and is
            meaningless on a different environment. The practical effect: right
            after a copy, nothing on the destination looks &ldquo;published.&rdquo;
            That is exactly why the run publishes afterwards &mdash; the publish
            step re-applies the publish status the copy removed.
          </Text>
          <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>
            Example: a job copies one content set from the higher-tier
            environment, the flow finishes, the destination now holds the
            content but with no publish status; the publish step then activates
            the configured paths so the destination serves them.
          </Text>
          <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>
            <b>References are not followed automatically.</b> The publish step
            activates exactly the paths in the job&rsquo;s content sets (for
            mirror mode, the ones already published on the source) &mdash; it does
            not collect a page&rsquo;s references the way the author UI&rsquo;s
            &ldquo;Publish Page (with references)&rdquo; does. So a page&rsquo;s
            images, experience fragments and content fragments are published only
            if their paths are also in the content sets. Add the relevant roots
            (e.g. <code>/content/dam/&lt;site&gt;</code> and
            <code> /content/experience-fragments/&lt;site&gt;</code>) as content
            sets so references are published too.
          </Text>
        </Flex>
      </View>

      <Divider size="S" />

      {/* 3 — Publish modes */}
      <View>
        <Heading level={3}>Publish modes</Heading>
        <Flex direction="column" gap="size-150">
          <Text>
            <b>Mirror what&rsquo;s published on the copy-from environment
            (recommended).</b> Reads what is currently published on the
            copy-from environment for each tier (publish and preview) and
            reproduces exactly that set on the destination. If the copy-from
            environment has no preview tier, the preview pass is skipped
            automatically. This keeps the destination tracking the source&rsquo;s
            current published set every run &mdash; new publishes are picked up,
            removed ones are dropped, and never-published drafts are excluded.
          </Text>
          <Text>
            <b>Publish everything in the set.</b> Activates every path in the
            content set in full, regardless of what was previously published.
          </Text>
          <Text>
            <b>Only changed content.</b> Re-publishes only content that was
            already published before and has changed since &mdash; so a run
            pushes just the differences.
          </Text>
          <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>
            An advanced option lets a job publish via the environment&rsquo;s own
            installed publish tool instead of the built-in modes &mdash; use it
            only on environments where that tool is present.
          </Text>
        </Flex>
      </View>

      <Divider size="S" />

      {/* 4 — How to configure an environment */}
      <View>
        <Heading level={3}>How to configure an environment</Heading>
        <Flex direction="column" gap="size-150">
          <Text>
            Each environment that takes part in a copy needs two things: the two
            access grants below on the technical account, and a Service
            Credentials file so the app can publish on that environment&rsquo;s
            author.
          </Text>
          <Text><b>Grant both of these on the technical account:</b></Text>
          <View elementType="ol" UNSAFE_style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li>
              <Text>
                <b>Deployment Manager</b> in Cloud Manager &mdash; lets the
                account execute the content-flow (copy) operation. Grant it in
                Admin Console &rarr; AEM as a Cloud Service &rarr; Cloud Manager
                &rarr; the Deployment Manager profile &rarr; API credentials.
              </Text>
            </li>
            <li>
              <Text>
                <b>AEM Administrator on both the source and the destination
                environments</b> &mdash; lets the account read from the source
                and write to the destination. Add the technical account to each
                environment&rsquo;s AEM Administrators profile (API credentials).
                This is the step most often missed.
              </Text>
            </li>
          </View>
          <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>
            Role changes take roughly 10&ndash;30 minutes (up to about an hour)
            to propagate.
          </Text>
          <Text><b>Add Service Credentials per environment (for publishing):</b></Text>
          <Text><b>Where to get them:</b></Text>
          <View elementType="ol" UNSAFE_style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li><Text>Open Cloud Manager and select the environment.</Text></li>
            <li><Text>Open that environment&rsquo;s <b>Developer Console</b>.</Text></li>
            <li><Text>Go to <b>Integrations</b> &rarr; <b>Service Credentials</b> and generate / download the <b>Service Credentials</b> JSON. Each environment that publishes needs its own Service Credentials.</Text></li>
          </View>
          <Text><b>Where to paste them:</b></Text>
          <View elementType="ol" UNSAFE_style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li><Text>Go to the <b>Settings</b> tab.</Text></li>
            <li><Text>Find the environment and open its per-environment <b>Service Credentials (JWT)</b> box.</Text></li>
            <li><Text>Paste the JSON into that box and click <b>Save</b>.</Text></li>
          </View>
          <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>
            The publish endpoints (replicate / querybuilder) do not accept the
            Cloud Manager access token, so the Service Credentials are required
            even when the technical account is already an AEM Administrator.
            Basic auth (user / password) only works on dev / sandbox authors.
          </Text>
        </Flex>
      </View>

      <Divider size="S" />

      {/* 5 — Diagnostics: Validate eligibility */}
      <View>
        <Heading level={3}>Diagnostics &mdash; Validate eligibility</Heading>
        <Flex direction="column" gap="size-200">
          <Text>
            A read-only diagnostic: it counts how many nodes are currently
            activated for publish and for preview under each of a job&rsquo;s
            publish paths. It changes nothing &mdash; it only reports what is
            already activated per tier, so you can see whether the destination
            holds the publish status a run would rely on.
          </Text>
          <Flex direction="row" gap="size-150" alignItems="end" wrap>
            <Picker
              label="Job"
              selectedKey={selectedJobId}
              items={jobs || []}
              isDisabled={!jobs || jobs.length === 0}
              onSelectionChange={(k) => { setSelectedJobId(String(k)); setValidation(null) }}
              width="size-3000">
              {(j) => <Item key={j.id}>{j.name || j.id}</Item>}
            </Picker>
            <Button
              variant="secondary"
              style="fill"
              isDisabled={!selectedJobId}
              isPending={validating}
              onPress={() => doValidate(selectedJobId)}>
              Validate eligibility (read-only)
            </Button>
          </Flex>
          {validateError && <StatusLight variant="negative">{validateError}</StatusLight>}
          {validation && (
            <TableView aria-label="Validation results" density="compact" overflowMode="wrap">
              <TableHeader>
                <Column key="root">Path</Column>
                <Column key="pub" width={150}>Publish-activated</Column>
                <Column key="pubAgent" width={170}>…_publish prop</Column>
                <Column key="prev" width={150}>Preview-activated</Column>
                <Column key="note">Preview gap</Column>
              </TableHeader>
              <TableBody>
                {validation.map((v, i) => (
                  <Row key={i}>
                    <Cell>{v.root}</Cell>
                    <Cell>{v.error ? '—' : String(v.publishActivated)}</Cell>
                    <Cell>{v.error ? '—' : String(v.publishAgentActivated)}</Cell>
                    <Cell>{v.error ? '—' : String(v.previewActivated)}</Cell>
                    <Cell>{v.error ? `error: ${v.error}` : gapNote(v)}</Cell>
                  </Row>
                ))}
              </TableBody>
            </TableView>
          )}
        </Flex>
      </View>

      <Divider size="S" />

      {/* 6 — Deploying & access control */}
      <View>
        <Heading level={3}>Deploying &amp; access control</Heading>
        <Flex direction="column" gap="size-150">
          <Text>
            How the app is published to the org and how access is restricted to
            the people allowed to run syncs.
          </Text>
          <View elementType="ol" UNSAFE_style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li>
              <Text>
                <b>Publish.</b> Publish the app to the org from the Adobe
                Developer Console (this app type has no CLI publish step).
                Publishing surfaces it in the Experience Cloud shell, which
                supplies the signed-in user&rsquo;s token. The raw adobeio URL
                and the devMode URL are not the production entry points.
              </Text>
            </li>
            <li>
              <Text>
                <b>Login gate.</b> Enable <code>require-adobe-auth</code> so the
                API can&rsquo;t be called anonymously, then deploy with a full
                <code> aio app deploy</code>. An anonymous call then returns
                <b> 401</b>.
              </Text>
            </li>
            <li>
              <Text>
                <b>Access control (built in).</b> Beyond the login gate, the app
                enforces <b>Admin Console profiles</b> in the backend: every API
                call checks the caller&rsquo;s IMS group membership and returns
                <b> 403</b> unless they hold one of the allowed profiles. Choose
                which profiles are allowed in <b>Settings &rarr; Access control</b>
                &mdash; the default is <b>Cloud Manager Deployment &amp; Program
                Managers</b>. You can add others (e.g. Developer, AEM
                Administrators), enter a custom IMS group, or open it to any
                signed-in org user. (Changes save instantly, no redeploy. The
                server refuses a selection that would lock you out.)
              </Text>
            </li>
            <li>
              <Text>
                <b>Credentials.</b> Paste each environment&rsquo;s Service
                Credentials (JWT) in Settings. They are stored encrypted
                server-side and are never returned to the browser.
              </Text>
            </li>
          </View>
          <Text><b>Why it&rsquo;s safe</b> &mdash; defense-in-depth layers:</Text>
          <View elementType="ul" UNSAFE_style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li><Text><b>Login gate</b> &mdash; no anonymous calls (require-adobe-auth, same org).</Text></li>
            <li><Text><b>Profile gate</b> &mdash; in-action Admin Console profile check (Settings &rarr; Access control) controls <i>who</i> can use it.</Text></li>
            <li><Text><b>Private orchestrator</b> &mdash; the engine action has no public URL.</Text></li>
            <li><Text><b>AEM service-account permissions</b> &mdash; control what it can touch.</Text></li>
            <li><Text><b>Downstream-only rule</b> &mdash; the app can never write up into prod.</Text></li>
          </View>
          <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>
            More detail: docs/troubleshooting-shell-integration.md
          </Text>
        </Flex>
      </View>
    </Flex>
  )
}
