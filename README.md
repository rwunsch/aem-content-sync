# aem-content-sync

Automated AEMaaCS content copy (Prod → Stage) with Tree Activation, built on Adobe App Builder / I/O Runtime.

**Solves:** Cloud Manager's Content Copy tool has no native scheduling or auto-publish. This tool wraps it in a scheduled, observable, event-driven pipeline.

---

## Architecture

A cron alarm (every 15 min) triggers the `orchestrator` action, which evaluates each job's own
schedule. The orchestrator is a state machine backed by I/O State Store — it does one unit of work
per tick and exits, so it handles multi-hour content copies without hitting the 60-second action timeout.

```
[Cron alarm: every 15 min → evaluate each job's schedule]
        │
        ▼
[CHECK_STUCK] — cancel stale flows; abort if one is already running on the env pair
        │
        ▼
[COPYING] — start content flow → poll → advance to next set on COMPLETED
        │  (sequential; concurrent flows are blocked by Cloud Manager)
        ▼
[PUBLISHING] — prod-mirror: publish on the destination what is published on the source
        │
        ▼
[NOTIFYING] — Slack message: success or failure  →  [IDLE]
```

### ⚠️ Why publishing is "prod-mirror" (important)

**Cloud Manager Content Copy intentionally STRIPS replication status** (`cq:lastReplicationAction`,
`…_publish`, `…_preview`) from the copied content on the destination — this is documented, by-design
behaviour, because those properties describe the *source's* publish tier and are meaningless on a
different environment. Consequence: after a copy, **nothing on the destination looks "activated"**, so
a Tree-Activation `onlyActivated` (or the vendor's bulk-publish, which gates on the same property) would
publish **nothing**.

The correct approach — implemented here as **`publish.mode = "prodMirror"`** — is to drive publishing
from the **source**: after the copy, query the **source (prod) author** for what is actually activated
(per agent: publish / preview), and replicate exactly that set on the **destination (stage) author**.
This mirrors prod's *current* published set every run (tracks new publishes and removals), correctly
excludes drafts and preview-only content, and reproduces the publish-vs-preview distinction that the
copy itself cannot carry. (`treeActivation` and `bulkPublish` modes remain available but only make
sense where the destination already carries activation state.)

---

## Installation & deployment (any customer environment)

This is a complete, end-to-end walkthrough for standing the app up in **any** Adobe
org / AEM as a Cloud Service program — from zero to a scheduled, secured,
shell-hosted UI. It is intentionally verbose; skip the parts you already have.

### What you are setting up (the moving parts)

```
Adobe Developer Console project
  └─ Workspace (Stage, and later Production)
       ├─ APIs:  Cloud Manager · I/O Management · State · (Files)
       ├─ Credential: OAuth Server-to-Server  ──────────────► content COPY (Cloud Manager API)
       └─ Runtime namespace (App Builder)  ────────────────► where actions + UI deploy

AEM as a Cloud Service program
  ├─ Source author env (copy FROM)   ┐ Cloud Manager "Content Copy"
  └─ Dest   author env (copy TO)     ┘ moves content between these
       └─ per-env Developer Console "Service Credentials" (JWT) ─► publish/replicate step

Experience Cloud Shell (experience.adobe.com)
  └─ loads the SPA, injects the signed-in user's IMS token ─────► calls the gated ui-api
```

Two distinct credentials are required, by design (see *AEM authentication* below):
**(A)** one **OAuth Server-to-Server** credential on the workspace, for the Cloud
Manager content-copy API; **(B)** one **AEM Service Credentials (JWT)** set **per
author environment**, for the publish/replication step (classic AEM `/bin/*`
endpoints reject the OAuth S2S token).

### Step 0 — Prerequisites

- **Node.js ≥ 18** and **npm**.
- **Adobe I/O CLI**, current version: `npm install -g @adobe/aio-cli` then `aio --version`.
  Always run project commands with the **project-local** CLI (`./node_modules/.bin/aio`)
  to avoid global/local Parcel version drift.
- Access to the target **Adobe org** with rights to create a Developer Console project,
  and an org **System/Cloud Manager admin** who can grant the product profiles below.
- The AEM as a Cloud Service **program ID** and the **source** + **destination** author
  **environment IDs** (Cloud Manager → the program → Environments).

### Step 1 — Adobe Developer Console: project, workspace, APIs, credential

1. Go to <https://developer.adobe.com/console> → **Create new project** (or *Project from
   template → App Builder*). Give it a name.
2. The project has a **Stage** workspace by default; you'll add **Production** later
   (Step 9). Work in **Stage** first.
3. In the **Stage** workspace → **Add API** and add:
   - **Cloud Manager** (required — content copy)
   - **I/O Management API** (required — App Builder deploy/registration)
   - **State** (and **Files** if you extend storage) — used by the orchestrator's state machine
   When prompted for credential type, choose **OAuth Server-to-Server**. This creates the
   single S2S credential the app uses for Cloud Manager. Note its **Client ID**,
   **Client Secret**, **Technical Account ID**, and the **Org ID**.
4. The workspace now has an **App Builder runtime namespace** (visible under *Runtime*),
   e.g. `1234567-myproject-stage`. The app deploys here.

> CLI alternative (scriptable): `aio console project create`, `aio console workspace create`,
> `aio console workspace api add --service-code CloudManagerSDK,AdobeIOManagementAPISDK,StateSDK`.

### Step 2 — Grant permissions (the wiring that trips everyone up)

Content **copy** and content **publish** each need their own grant. Allow ~10–30 min
for product-profile changes to propagate.

**2a. Cloud Manager — Deployment Manager** (to *execute* the content flow)
- Admin Console → **Adobe Experience Manager** (Cloud Manager product) → the
  **Deployment Manager** product profile → **API credentials** tab → add the workspace's
  **technical account** (from Step 1). Without this, `createContentFlow` → **403**.

**2b. AEM Administrator on BOTH source and destination environments** (to read prod + write stage)
- Admin Console → AEM → for **each** environment, the
  `AEM Administrators – … – Program <p> – Environment <e>` product profile → **API
  credentials** tab → add the same technical account. Content copy verifies this on both
  ends; without it the copy can't touch the instances.

**2c. Per-environment AEM Service Credentials (JWT)** (for the prod-mirror publish step)
- Cloud Manager → the program → **Environments** → on **each** author env (source *and*
  destination): `…` → **Developer Console** → **Integrations → Service Credentials** →
  **Download** the JSON (`clientId`, `clientSecret`, `privateKey`, `org`, `technicalAccount`).
- Add **that** technical account's email to the env's **AEM Administrators** product
  profile (Admin Console), and ensure it has **replication/activate** rights on the
  destination author. You paste this JSON into the app's **Settings** tab (Step 7); the
  app provisions the technical-account user on first authenticated call.

### Step 3 — Content Sets in Cloud Manager

Cloud Manager → the program → **Content Sets** → create one or more sets describing the
JCR paths to move (author tier). Note each **Content Set ID** — you'll select it in the
app's **Configure** tab. (You can also create them via the Cloud Manager API.)

### Step 4 — Clone and install

```bash
git clone <this-repo-url> aem-content-sync
cd aem-content-sync
npm install            # runs scripts/postinstall.js (defuses the events-plugin deploy crash)
```

### Step 5 — Link the workspace and fill in `.env`

```bash
# Download the workspace's config from Console (Stage workspace → Download)
aio app use <path-to-downloaded-config.json>     # or: aio app use   (after aio console workspace select)
cp .env.example .env
```

Edit `.env` (never commit it — it's gitignored):

| Variable | Where it comes from |
|---|---|
| `IMS_ORG_ID` | Developer Console (Org ID, `…@AdobeOrg`) |
| `CM_CLIENT_ID` / `CM_CLIENT_SECRET` / `CM_TECHNICAL_ACCOUNT_ID` | the OAuth S2S credential (Step 1) |
| `AEM_AUTHOR_URL` | optional legacy single-env author URL; prod-mirror derives author URLs from each job's `programId`+env IDs |
| `AEM_TOKEN` | optional; the publish step normally uses the per-env Service Credentials set in Settings |
| `SLACK_WEBHOOK_URL` | optional — incoming webhook for run notifications |
| `AIO_runtime_namespace` / `AIO_runtime_auth` | the App Builder runtime namespace + key (from `aio app use`) |

### Step 6 — Deploy

```bash
aio app deploy
```

This builds the SPA and the actions and deploys them. What you get, and the **security model**:

- **`ui-api`** — a **web** action annotated `require-adobe-auth: true`. The platform wraps
  it in a sequence that validates an Adobe **IMS bearer token + `x-gw-ims-org-id`** from the
  **same org** before your code runs. Anonymous calls get **401**. This is the only
  externally reachable endpoint, and it is gated.
- **`orchestrator`** — a **non-web** (private) action with **no public URL**. It is invoked
  only from inside the namespace (the scheduler rule, the `ui-api` trigger op, and its own
  self-chain) via the authenticated namespace API.
- **Static SPA** — served from the App Builder CDN. It contains **no secrets**; every data
  call goes through the gated `ui-api`. So even though the page URL is public, an
  unauthenticated visitor sees an empty shell that can do nothing.

> Deploy uses the workspace IMS login. If `aio app deploy` fails with
> `IMSOAuthSDK:TIMEOUT` / `CANNOT_GENERATE_TOKEN`, your CLI login expired — run `aio login`
> and retry. (Action-only code updates can also be pushed with the namespace key without a
> login; web/CDN deploy and publishing always need `aio login`.)

### Step 7 — Open the app in the Experience Cloud Shell

The app is an `dx/excshell/1` extension and runs **inside the Experience Cloud Shell**,
which hands it the signed-in user's IMS token. To open a deployed build for testing,
`aio app deploy` prints a URL of this form:

```
https://experience.adobe.com/?devMode=true#/custom-apps/?localDevUrl=https://<namespace>.adobeio-static.net/index.html
```

For **local development**, run `aio app run` (or `npm start`) and open the printed
`…localDevUrl=https://localhost:9080` shell URL — the shell injects your token into the
local app, so the gated backend works without deploying. On Windows/WSL you must trust the
dev cert; see `docs/troubleshooting-shell-integration.md`.

> Do **not** open the raw `…adobeio-static.net/index.html` URL directly — outside the shell
> there is no token, so every call returns 401. Always go through the shell URL.

### Step 8 — Configure jobs and per-environment publish credentials in the UI

In the running app:
- **Settings** → for each environment, paste its **Service Credentials (JWT)** JSON
  (Step 2c) and click **Check credentials** (validates + provisions the technical user).
  The setup-status indicators turn green as each prerequisite is met.
- **Configure** → create a job: pick the **program**, **copy-from** and **copy-to** author
  environments, the **content set(s)**, the **publishing mode** (default **prod-mirror**),
  and the **schedule** (cron). Changes autosave to I/O State — no redeploy needed.

You can also pre-seed defaults by editing `config/content-sync.json` before deploy
(replace the `YOUR_*` placeholders), but the UI is the recommended path.

### Step 9 — Run, verify, and schedule

- **Operate** tab → **Run a job** to trigger immediately; watch the live phase, queue, and
  run log. The scheduler also evaluates each job's cron automatically.
- A run = copy the job's content sets from the source author, then publish them on the
  destination per the chosen mode.

### Step 10 — Promote to Production and publish (for other users)

A `devMode`/`localDevUrl` URL is a one-shot dev side-load — the shell strips the params on
reload, so it isn't a durable entry point. For colleagues/operators to open the app from the
Experience Cloud catalog with a **stable, reloadable URL**, promote it to the **Production**
workspace and publish it. This is a deliberate, partly-manual step:

1. **Production workspace must be set up first.** In Developer Console, the Production
   workspace needs its **own** OAuth Server-to-Server credential and the same APIs as Stage
   (Cloud Manager, I/O Management, State). It has a **separate runtime namespace** from Stage.
2. **Switch local context to Production:**
   ```bash
   aio app use   # select the Production workspace  (or: aio console workspace select Production && aio app use)
   ```
   ⚠️ This **overwrites your local `.aio`/`.env`** to point at the Production namespace +
   credentials. Your deployed *Stage* app keeps running; only the local config flips. Run
   `aio app use` again to switch back to Stage afterward.
3. **Deploy to Production:** `aio app deploy`.
4. **The Production app starts unconfigured** — it has its own namespace/state, so set up jobs
   (Configure) and per-environment Service Credentials (Settings) **again** there, independent
   of Stage. Access-control profiles also default fresh (Deployment + Program Managers).
5. **Submit for publishing:** Developer Console → **Production workspace → Submit for approval**
   → fill the submission form → **Submit**.
6. **Org admin approves:** an organization **administrator** approves it in **Adobe Exchange →
   App Builder applications → Private distribution** (this is a manual approval, not a CLI step).
7. **Result:** the app appears under **App Builder Apps** at
   `https://experience.adobe.com/#/@<org>/custom-apps` with a stable URL that survives browser
   reloads. End users must also be **entitled to the product profiles** the app's APIs require
   (and, per the access-control gate, hold one of the configured Admin Console profiles).

> Tip: keep Stage and Production as separate workspaces and switch between them with
> `aio app use`. Don't share namespaces or credentials across the two.

---

## Restricting WHO can access the app (authorization)

`require-adobe-auth` handles **authentication** (a valid IMS token) and **same-org**
gating automatically — a stranger from another org, or with no token, gets **401**. But
"anyone in the org with a token" is usually too broad. There are three layers you can add,
from coarsest to finest. Use one or combine them.

### Layer 1 — Service/product entitlement (platform-enforced, no code)

When the app is **published** (Step 10), the Experience Cloud Shell enforces that the user
is **entitled to all services attached to the App Builder project**. Because this project
integrates the **Cloud Manager** API, only users whose org assigns them the corresponding
product profile can load and use it.

To restrict to a dedicated group: in the **Admin Console**, create/choose a product profile
for the relevant product (e.g. **Adobe Experience Manager → Cloud Manager**) and **assign
only the intended people** to it. Remove everyone else. Membership changes take ~10–30 min
to propagate. This is the simplest "only these people" control and requires no code.

### Layer 2 — Admin Console profile check (BUILT IN, configurable in the UI)

The app **enforces specific Admin Console profiles in the backend** out of the box. On
every `ui-api` call, `actions/utils/authz.js` reads the caller's IMS group memberships
(`GET https://ims-na1.adobelogin.com/ims/organizations/v6`) and returns **403** unless the
caller holds one of the **allowed profiles**. This runs *on top of* `require-adobe-auth`
(same-org authentication).

**Default:** `CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE` and `CM_CS_PROGRAM_MANAGER_ROLE_PROFILE`
— i.e. **Cloud Manager Deployment Managers and Program Managers**. These `CM_CS_*` group
names are standard across orgs, so the default is portable.

**Where to change it (no code, no redeploy): `Settings → Access control`.** A checklist lets
you choose any combination of:

| Profile (IMS group) | Who it is |
|---|---|
| `CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE` | Cloud Manager Deployment Manager |
| `CM_CS_PROGRAM_MANAGER_ROLE_PROFILE` | Cloud Manager Program Manager (Business Owner) |
| `CM_CS_DEVELOPER_ROLE_PROFILE` | Cloud Manager Developer |
| `AEM Administrators` | AEM Administrator (matches any `AEM Administrators…` group, incl. per-env) |
| *(custom)* | any IMS group name you type in |
| `*` | "Any signed-in user in the org" — authentication only, no profile restriction |

The card also shows **your own** profiles and **refuses a selection that would lock you
out** (the server returns 409 and the UI warns). The selection is stored in config
(`accessProfiles`) in I/O State.

**How it's enforced (for reviewers):**
- `actions/utils/authz.js` — `assertAuthorized(params, allowedProfiles)` fetches the caller's
  org groups and matches them (exact, or prefix for `AEM Administrators…`).
- `actions/ui-api/index.js` — calls `assertAuthorized(params, config.accessProfiles)` at the
  top of `main()` before any op; 403 (with the list of allowed profiles) otherwise.
- The decision is cached per token (~10 min) to avoid an IMS round-trip on every poll.

**To find the exact group name for a custom profile**, an admin can read a known user's
groups from `GET /ims/organizations/v6` (the `groups[].groupName` values), or copy the
product-profile name from Admin Console, then add it in the Access control card.

### Layer 3 — Network fronting (only if you must hide even the page)

App Builder static hosting is a public CDN, so the (secret-free) page bytes are reachable
by URL. If your policy requires that even the empty shell not be served to outsiders, put a
**reverse proxy / CDN with SSO** in front of it, or surface the app **only** through the
published Experience Cloud catalog and never share the raw `adobeio-static.net` URL. The
actions remain gated regardless (Layers 1–2), so this only affects the static page.

**Recommended baseline:** Layer 1 (dedicated product profile) for *who can open it*, plus
Layer 2 (in-action role check) if you need to pin a specific role like Deployment Manager.

---

## Manual trigger (testing)

Invoke the orchestrator directly to test without waiting for the Friday cron:

```bash
# Start a run from IDLE (full flow)
aio rt action invoke aem-content-sync/orchestrator --result

# Skip stuck-flow check and jump straight to COPYING (useful during testing)
aio rt action invoke aem-content-sync/orchestrator --param skipToCopying true --result

# Check current state
aio rt activation poll
```

---

## Configuration reference

`config/content-sync.json` (jobs-based):

| Field | Description |
|---|---|
| `stuckFlowThresholdHours` | Flows older than this are treated as stuck and cancelled (default: 8) |
| `jobs[].programId` | Cloud Manager program ID (numeric, without "p" prefix) — **per job** |
| `jobs[].sourceEnvId` / `destEnvId` | Source (prod) / destination (stage) environment IDs — **per job** |
| `jobs[].schedule` | Cron (5-field, UTC) for this job |
| `jobs[].contentSets[].id` | Content set ID from Cloud Manager (Content Sets) |
| `jobs[].contentSets[].path` | JCR root of the set; also the publish path |
| `jobs[].contentSets[].wipeDestination` | Wipe the destination path before copy (deletes it first) |
| `jobs[].contentSets[].publish` | Publish this path after the copy (default `true`) |
| `jobs[].publish.mode` | `prodMirror` (recommended) \| `treeActivation` \| `bulkPublish` |
| `jobs[].publish.targets` | Replication agents to mirror/publish: `["publish"]`, `["preview"]`, or both |

---

## Environment variables

| Variable | Description |
|---|---|
| `IMS_ORG_ID` | Adobe IMS Org ID |
| `CM_CLIENT_ID` | OAuth client ID (from Developer Console technical account) |
| `CM_CLIENT_SECRET` | OAuth client secret |
| `CM_TECHNICAL_ACCOUNT_ID` | Technical account ID |
| `AEM_AUTHOR_URL` | (legacy single-env) Stage Author URL. prod-mirror derives both author URLs from the job's `programId`+env IDs instead. |
| `AEM_TOKEN` | Bearer token for AEM Author API. ⚠️ This is **NOT** the Cloud Manager S2S token (that returns 403 on the author). See "AEM authentication". |
| `SLACK_WEBHOOK_URL` | Incoming webhook URL for notifications |

---

## AEM authentication (prod-mirror publish step)

The publish step calls classic AEM author endpoints (`/bin/querybuilder.json`, `/bin/replicate.json`)
on both the source and destination authors. **These endpoints do not accept the Cloud Manager OAuth
S2S token** — that credential is scoped for Cloud Manager APIs only and returns **403** on the author
(confirmed). For programmatic, non-interactive AEM author access the supported pattern is **AEM
Developer Console Service Credentials (JWT), one set per environment**:

1. Cloud Manager → the program → **Environments** → on each author env: `…` → **Developer Console**.
2. **Integrations → Technical Accounts → Create** → download the **Service Credentials** JSON
   (`clientId`, `clientSecret`, `privateKey`, `org`, `technicalAccount`).
3. Add that technical account's email to the env's **AEM Administrators** product profile (Admin Console).
4. In the app, exchange the JWT for an IMS access token (e.g. `@adobe/aemcs-api-client-lib`) and send it
   as `Authorization: Bearer <token>` to the author.

So you need service credentials for **both** the prod (source) and stage (destination) authors.
Basic auth is officially unsupported on AEMaaCS author (it happens to work on dev/sandbox envs via the
"Sling (Development)" realm, but do not rely on it for production). Local Development Access Tokens work
but are dev-only / short-lived.

### Why not the Cloud Manager OAuth token? (the auth distinction)

The one OAuth S2S credential serves **Cloud Manager** (content copy) and any **OpenAPI-based AEM APIs**
(`/adobe/…` — sites, assets, content fragments). But the prod-mirror publish step uses **classic**
endpoints — `/bin/replicate.json` (publish) and `/bin/querybuilder.json` (what's published) — which are
**not** exposed via OpenAPI and **do not accept the OAuth S2S token** (you get 403, regardless of the
account being an AEM Administrator — it's the token type the endpoint accepts, not permissions). Classic
endpoints require **AEM Developer Console service credentials (JWT)** — which is the *current, supported*
method, **not** the deprecated ADC JWT. So the architecture is intentionally **hybrid**: OAuth S2S for
Cloud Manager, JWT service credentials for the AEM publish step. **Future:** if Adobe ships an OpenAPI
replication/publication API, the publish step can move to the single OAuth S2S credential and the JWT
dependency removed — the app's AEM auth is pluggable for exactly this. Full detail + validation sources:
`docs/14-aem-api-auth-distinction.md`.

---

## Known constraints

- **Content Copy direction**: Prod → Stage → Dev only. Reverse direction is not supported by Cloud Manager.
- **Concurrent flows**: Cloud Manager rejects concurrent content flows for the same program. The orchestrator checks for running flows before starting.
- **Hibernated environments**: Cloud Manager will wake a hibernated environment when a content copy is triggered, but this adds delay. Wake environments manually before scheduled runs if latency matters.
- **Tree Activation + onlyActivated**: Requires the `publish-content-tree` workflow model to be available on Stage Author. It ships with AEMaaCS by default.
- **References are NOT auto-followed**: the publish step activates exactly the configured content-set paths (for `prodMirror`, the source author's already-activated set *under those roots*). A page's references — DAM assets, experience fragments, content fragments, tags — are published **only if their own paths are within the job's content sets**. This is unlike the AEM author UI's *Publish Page (with references)*, which collects references automatically; the programmatic `/bin/replicate.json` activation does not. **To publish a page's references, add their roots as content sets**, e.g. alongside `/content/<site>` also add `/content/dam/<site>`, `/content/experience-fragments/<site>`, and `/content/dam/<site>/<cf-models>`. (Automatic reference resolution before replicate is a possible future enhancement.)

---

## Configuring your environments

This app is environment-agnostic — point it at your own AEM as a Cloud Service
program and environments. You provide the program ID, a source and destination
author environment ID, and one or more content set IDs:

- in the app's **Configure** tab (recommended), or
- by editing the `YOUR_*` placeholders in `config/content-sync.json`.

Author URLs follow the form `https://author-p<programId>-e<envId>.adobeaemcloud.com`.
Credentials are supplied via `.env` (never committed) and the Settings tab.
