/*
 * Entry point. Boots the Experience Cloud Shell runtime when present (loading
 * the Module Runtime via ./exc-runtime, then receiving the IMS token through
 * @adobe/exc-app), and mounts the React app. Falls back to a token-less
 * standalone render when not inside the shell.
 */
import 'regenerator-runtime/runtime'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { init } from '@adobe/exc-app'
import App from './App'

const root = createRoot(document.getElementById('root'))
const render = (ims) => root.render(<App ims={ims} />)
const log = (...a) => {
  console.log('[content-sync]', ...a)
  try { (window.__csLog = window.__csLog || []).push(a.map(String).join(' ')) } catch (_) {}
}

let lastToken = null
const applyContext = (source, ctx) => {
  ctx = ctx || {}
  log(`context from ${source}: hasToken=${!!ctx.imsToken} org=${ctx.imsOrg || '(none)'}`)
  if (ctx.imsToken && ctx.imsToken !== lastToken) {
    lastToken = ctx.imsToken
    render({ org: ctx.imsOrg, token: ctx.imsToken, profile: ctx.imsProfile, locale: ctx.locale })
  }
}

try {
  // Load the Experience Cloud Module Runtime. This reads the shell's `_mr` param
  // and injects the runtime script; it THROWS synchronously if we're not inside
  // the shell iframe. Must run BEFORE init() so EXC_MR_READY is wired up.
  require('./exc-runtime')

  init((runtime) => {
    log('exc-app bootstrap fired (running in Experience Cloud Shell)')
    // 'ready' carries the initial IMS context; 'configuration' carries refreshes
    // (so a long-open session keeps a valid token).
    runtime.on('ready', (cfg) => {
      runtime.done() // dismiss the shell's loading spinner
      applyContext('ready', cfg)
    })
    runtime.on('configuration', (cfg) => applyContext('configuration', cfg))
  })
} catch (e) {
  // Not in the Experience Cloud Shell (e.g. the raw static/localhost URL opened
  // directly). Render standalone with no token; gated backend calls will 401.
  log('not running in Experience Cloud Shell — standalone render:', e && e.message)
  render({ org: null, token: null, profile: null })
}
