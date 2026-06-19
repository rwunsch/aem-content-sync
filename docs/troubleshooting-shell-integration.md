# Troubleshooting: running a secured App Builder SPA in the Experience Cloud Shell

This document records the problems hit while getting this App Builder application
to run inside the Adobe Experience Cloud Shell (`experience.adobe.com`) with IMS
authentication, while keeping the backend actions private/gated. Each entry has
the **symptom**, the **root cause**, and the **fix**, so the next person doesn't
have to rediscover them.

The app is a React Spectrum SPA served from App Builder static hosting, talking
to Adobe I/O Runtime web actions. The UI must obtain the user's IMS token from
the shell and send it to `require-adobe-auth`-gated actions.

---

## 1. App was a standalone application, not an `dx/excshell/1` extension

**Symptom:** loading the app via the shell's `?devMode=true#/custom-apps/?localDevUrl=…`
URL eventually timed out with **`Error 408-001: Failed to load local application`**;
the shell never injected a token.

**Root cause:** `app.config.yaml` declared the app under `application:` (the
"standalone / headless" shape). The shell only performs the IMS token handshake
for apps declared as `dx/excshell/1` extensions.

**Fix:** convert to an extension. `app.config.yaml`:

```yaml
extensions:
  dx/excshell/1:
    $include: ext.config.yaml
```

with the actions/web/runtimeManifest moved into `ext.config.yaml` under
`operations.view → impl: index.html`. Keep the package name stable so deployed
action paths don't change.

---

## 2. `@adobe/exc-app` `init()` used incorrectly

**Symptom:** console warning *"Experience Cloud shell not available, rendering
standalone — Cannot read properties of undefined (reading 'on')"*; the app
rendered with **no token**, so every backend call returned **401 "missing
authorization header"**.

**Root cause:** the code did `const runtime = init({})` then `runtime.on(...)`.
In `@adobe/exc-app@1.x`, `init(bootstrap)` **returns void** and invokes
`bootstrap(runtime)` once the runtime is ready — the runtime is the callback
argument, not a return value.

**Fix:**

```js
init((runtime) => {
  runtime.on('ready', ({ imsOrg, imsToken, imsProfile, locale }) => {
    runtime.done()
    // …use imsToken…
  })
})
```

---

## 3. Missing Experience Cloud Module Runtime loader (`src/exc-runtime.js`)

**Symptom:** even after #1 and #2, the shell still showed **408** and the
`init` bootstrap callback never fired. The shell *did* load the app at
`…/?_mr=<runtime-url>` (HTTP 200), but the handshake never completed.

**Root cause:** `@adobe/exc-app`'s `init()` only registers `window.EXC_MR_READY`
and **waits** — it does **not** load the Module Runtime itself. The shell passes
the runtime URL in the `_mr` query parameter; the app must ship the canonical
loader (`exc-runtime.js`) that reads `_mr`, injects that script, and on load
calls `EXC_MR_READY()`. This file was missing entirely, so the runtime never
loaded and the callback never fired.

**Fix:** add `web-src/src/exc-runtime.js` (the canonical loader from
`@adobe/generator-add-web-assets-exc-react/templates/src/exc-runtime.js`) and
`require('./exc-runtime')` **before** `init()`, inside a try/catch (it throws
when not inside the shell iframe → fall back to a token-less standalone render).

---

## 4. Duplicated CORS header `Access-Control-Allow-Origin: *,*`

**Symptom:** after the handshake finally worked and a token was obtained, the
UI showed **"Failed to fetch"**. `curl` of the same endpoint with the token
returned **200 with the data** — so it was a browser-only failure.

**Root cause:** the `require-adobe-auth` web sequence injects CORS headers on
every response. The action's own response helper **also** set
`Access-Control-Allow-Origin: *`. On the authenticated response the two combined
into `Access-Control-Allow-Origin: *,*`, which browsers reject as malformed →
the fetch fails before the body is read.

**Fix:** the action must **not** set any `Access-Control-*` headers — let the
platform own CORS. Response helper returns only `Content-Type: application/json`.

---

## 5. WSL2 + Windows browser: localhost dev cert hostname mismatch

**Symptom:** the shell iframe couldn't load `https://localhost:9080` (**408**),
even though opening that URL directly in a tab worked after clicking through the
cert warning. You cannot click-through a cert warning for a cross-origin iframe.

**Root cause:** the aio dev certificate's SAN is `DeveloperSelfSigned.cert`, not
`localhost`, so the browser never *trusts* it for `localhost` — it only let you
manually proceed in a top-level tab, which doesn't apply to iframes.

**Fix:** regenerate `dist/dev-keys/cert-pub.crt` with a proper SAN
(`subjectAltName=DNS:localhost,IP:127.0.0.1`) and add it to the OS trust store
(on Windows: `certutil -addstore -user -f Root <cert>`). aio reuses an existing
cert in `dist/dev-keys/` on restart.

---

## 6. Deploying when the CLI login is stale

**Symptom:** `aio app deploy` failed with `IMSOAuthSDK:TIMEOUT` /
`IMSSDK:CANNOT_GENERATE_TOKEN`; `aio console …` hung. Re-running `aio login`
fixes it (the cached token had expired; a VPN reconnect does not refresh it).

**Useful fallback:** **action** code can be updated without an interactive login
using the static Runtime namespace key (`AIO_runtime_auth` / `AIO_runtime_namespace`
from `.env`) — either `aio rt` commands or a raw OpenWhisk REST
`PUT /api/v1/namespaces/{ns}/actions/{pkg}/{action}?overwrite=true` with Basic
auth. Round-trip the action JSON and change only `exec.code` to preserve
parameters and annotations. **Web-asset (CDN) deploys and App Registry publish
still require a real `aio login`.**

---

## 7. Global vs project-local `aio` / Parcel version mismatch

**Symptom:** the dev server returned **HTTP 500** with
*"@parcel/resolver-default is not compatible with the current version of Parcel.
Requires ^2.16.4 but the current version is 2.12.0."*

**Root cause:** the globally-installed `aio` (older) resolved an incompatible
Parcel. The project-local `aio` (`./node_modules/.bin/aio`) has a matching
Parcel set.

**Fix:** always run builds/deploys with the **project-local** `aio`.

---

## 8. Fresh workspace: `require-adobe-auth` wrapper sequence not created → "backend unreachable"

**Symptom:** after publishing the app to a **new** workspace (e.g. promoting to a
**Production** workspace for the first time) the SPA loads in the shell but every
backend call fails with **"Failed to fetch" / "backend unreachable."** A direct
`curl` of the action's web URL returns **HTTP 404** (not 401):

```
POST https://<ns>.adobeioruntime.net/api/v1/web/<pkg>/ui-api   → 404
```

**Root cause:** `require-adobe-auth: true` works by deploying the action renamed
`__secured_<name>` **and** creating a web **sequence** `<name>` =
`[/adobeio/shared-validators-v1/app-registry, <pkg>/__secured_<name>]`. On a fresh
namespace `aio app deploy` sometimes creates only the inner `__secured_ui-api` and
**skips the `ui-api` wrapper sequence** (the app-registry validator wiring depends
on the just-published app being fully propagated). With no `ui-api` route, the
SPA's POST hits nothing → 404 → the UI reports the backend as unreachable. Confirm
with `aio rt action list`: you'll see `__secured_ui-api` but **no** `ui-api`.

**Fix:** create the wrapper sequence manually to match a known-good workspace:

```bash
aio rt action update <pkg>/ui-api \
  --sequence /adobeio/shared-validators-v1/app-registry,<pkg>/__secured_ui-api \
  --web true -a final true -a raw-http false -a require-adobe-auth false
```

**Verify:** an anonymous **POST** to the web URL should now return **401** (the
validator rejecting the missing token) instead of 404 — the same response a
working workspace gives. A real IMS token from the shell then passes through.
Note a **full** `aio app deploy` may drop the sequence again; re-run the command
if "backend unreachable" returns after a redeploy. (A `GET` returns 404 even when
healthy — the SPA uses POST, so test with POST.)

---

## 9. `aio app use` doesn't populate the app's `CM_*` / `IMS_ORG_ID` action inputs

**Symptom:** after switching workspaces with `aio app use` (e.g. Stage → Production),
the deployed actions can't reach Cloud Manager — `getCMToken` throws *"Cloud Manager
OAuth credentials are not configured"* or IMS returns `invalid_client`. `.env` has the
`AIO_ims_contexts_<context>_*` lines but `IMS_ORG_ID` / `CM_CLIENT_ID` / `CM_CLIENT_SECRET`
are empty.

**Root cause:** `aio app use` writes the **IMS S2S context** (`AIO_ims_contexts_…_client__id`,
`…_client__secrets`, `…_ims__org__id`, …) but **not** the app-specific convenience vars the
manifest passes as action inputs (`IMS_ORG_ID`, `CM_CLIENT_ID`, `CM_CLIENT_SECRET`). Those were
added manually in the original workspace and don't carry across. Also, the secret is stored as a
**bracketed array** (`client__secrets=[p8e-…]`) — the brackets must be stripped.

**Fix:** derive the convenience vars from the context lines, then **redeploy**:

```
IMS_ORG_ID       = AIO_ims_contexts_<ctx>_ims__org__id
CM_CLIENT_ID     = AIO_ims_contexts_<ctx>_client__id
CM_CLIENT_SECRET = AIO_ims_contexts_<ctx>_client__secrets   # strip surrounding [ ]
```

Verify before redeploy with a `client_credentials` call to
`https://ims-na1.adobelogin.com/ims/token/v3` — a 200 with an `access_token` means the
credential is good; `invalid_client` usually means the brackets weren't stripped.

---

## 10. Content Copy 403 — CM credential lacks Deployment Manager on the **target program**

**Symptom:** listing programs/environments/content-sets works, but starting a run fails:

```
FATAL: [CloudManagerSDK:ERROR_CREATE_CONTENTFLOW] … (403 Forbidden) — User unauthorized.
User does not have the necessary permissions for this operation.
```

**Root cause:** the Cloud Manager **Deployment Manager – Cloud Service** product profile on the
credential is **necessary but not sufficient** for Content Copy. The copy is a privileged,
*environment-scoped* operation, and the API credential **also** needs the AEM environment's
**`AEM Administrators – author – Program <id> – Environment <id>`** product profile (assigned in
the **Admin Console**, under that product profile's **API credentials** tab). Read calls (list
programs/environments/content-sets) succeed with the Cloud Manager profile alone; only the actual
`createContentFlow` checks the AEM-environment profile — which is why **listing works but the copy
403s**. A new workspace's S2S credential has the Cloud Manager profile but is **not** automatically
added to the per-environment AEM Administrators profile, so it must be added explicitly.

> Verified empirically: at the Cloud Manager API level the Stage and Production credentials had
> *identical* profiles (Deployment Manager + Developer – Cloud Service); the only difference was
> that Stage's credential was a member of `AEM Administrators – author – Program 127553 –
> Environment 1512873` and Production's was not. Adding the Production credential there fixed it.

**Fix:** in the **Admin Console → Products →** the `AEM Administrators – author – Program <id> –
Environment <id>` product profile **→ API credentials → Add API credentials**, add the
credential (named `<…> - <Workspace>`, e.g. `Robert Wunsch - aem content sync - Production`).
Do this for **every environment the job touches** — both the **source** (read) and **destination**
(write) environments. Allow ~10–30 min to propagate, then re-run. Listing working while the copy
403s is the tell-tale that the AEM-environment profile is the missing piece, not the credential.

---

## 11. After a permission change, redeploy to pick up a fresh token

**Symptom:** you granted (or removed) an Admin Console role / product profile for the API
credential, waited for propagation, but the deployed action's behaviour doesn't change — e.g.
Content Copy still returns 403 even though the AEM Administrators profile is now assigned.

**Root cause:** the action obtains a Cloud Manager token via `client_credentials` and **caches it
in module memory** (`auth.js`), valid for the token lifetime (~24 h, refreshed ~10 min before
expiry). IMS bakes the credential's entitlements into the token **at mint time**. A warm action
container therefore keeps using a token minted *before* the permission change — with the old
entitlements — until that token expires or the container is recycled.

**Fix:** run `aio app deploy`. Deploying a new action version means the next invocation runs in a
**fresh container** that mints a **new token**, which reflects the updated entitlements
immediately. (Equivalently, wait for the cached token to expire, but redeploy is deterministic.)

**Rule of thumb:** any Admin Console role/profile change that affects the credential ⇒ wait for
propagation, then `aio app deploy`, then retry.

---

## 12. Published app: `aio app deploy` silently skips Production

**Symptom:** you run `aio app deploy` on the Production workspace, it reports *"Successful
deployment"*, but the live code never changes — a feature you just added doesn't appear, and the
deployed action still behaves like the old version.

**Root cause:** once the app is **published** to the org catalog, `aio app deploy` deliberately
**skips** deploying to the Production workspace to protect the live, approved app. The skip is
easy to miss — the log line is buried:

```
ℹ This application is published and the current workspace is Production, deployment will be
  skipped. You must first retract this application in Adobe Exchange to deploy updates.
```

**Fix:** deploy updates with the force flag — this pushes the new code to the namespace without
disturbing the approved catalog listing (no re-approval needed):

```
aio app deploy --force-deploy
```

(Or retract the app in Adobe Exchange first, deploy normally, then re-submit — slower.)

> Verifying what's actually deployed: the action is a **binary (zip) action** (`exec.binary:
> true`), so `GET …/actions/<pkg>/<action>?code=true` returns **base64**, not readable JS —
> grepping it for a source string always fails. To truly check, base64-decode the `exec.code`,
> unzip it, and grep the bundled `index.js`. (Or just exercise the feature and confirm behaviour.)

---

## Security posture (kept throughout)

- `ui-api` is a web action with `require-adobe-auth: true` → anonymous calls get
  **401**; only a valid IMS token from the same org is accepted.
- `orchestrator` is a **non-web** (private) action — no public URL; invoked only
  inside the namespace (scheduler rule, `ui-api` trigger, self-chain).
- The static SPA bundle contains **no secrets**; all credentials live in action
  inputs server-side.
