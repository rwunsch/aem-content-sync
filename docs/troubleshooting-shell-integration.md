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

## Security posture (kept throughout)

- `ui-api` is a web action with `require-adobe-auth: true` → anonymous calls get
  **401**; only a valid IMS token from the same org is accepted.
- `orchestrator` is a **non-web** (private) action — no public URL; invoked only
  inside the namespace (scheduler rule, `ui-api` trigger, self-chain).
- The static SPA bundle contains **no secrets**; all credentials live in action
  inputs server-side.
