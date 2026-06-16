#!/usr/bin/env node
'use strict'

/*
 * Workaround for @adobe/aio-cli 11.x: the bundled @adobe/aio-cli-plugin-events
 * registers deploy hooks that oclif's TS path resolver crashes on
 * ("orig.startsWith is not a function") during `aio app deploy`, aborting the
 * web-assets deploy. This app registers NO Adobe I/O Events, so those hooks are
 * dead weight — we blank them out so `aio app deploy` works.
 *
 * Runs on postinstall so the fix survives `npm install`. Idempotent and safe:
 * if the plugin isn't present, it does nothing.
 */

const fs = require('fs')
const path = require('path')

const pkgPath = path.resolve(__dirname, '..', 'node_modules', '@adobe', 'aio-cli-plugin-events', 'package.json')

try {
  if (!fs.existsSync(pkgPath)) {
    process.exit(0)
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (pkg.oclif && pkg.oclif.hooks && Object.keys(pkg.oclif.hooks).length > 0) {
    pkg.oclif.hooks = {}
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    console.log('[postinstall] Neutralized aio-cli-plugin-events deploy hooks (events not used; avoids aio app deploy crash).')
  }
} catch (e) {
  // Non-fatal: never block install over this workaround.
  console.warn('[postinstall] events-plugin workaround skipped:', e.message)
}
