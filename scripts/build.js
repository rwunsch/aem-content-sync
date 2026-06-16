#!/usr/bin/env node
'use strict'

/**
 * Build script: bundles each action with esbuild (minified) and zips the result.
 * Output: dist/<action-name>.zip — ready for `aio rt deploy -m manifest.yml`
 *
 * Single .js file limit on I/O Runtime is 1MB.
 * Zip limit is 48MB. We bundle + minify + zip to stay inside limits.
 * The zip must contain index.js at its root — that is the runtime entry point.
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const archiver = require('archiver')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

const ACTIONS = [
  { name: 'orchestrator', entry: 'actions/orchestrator/index.js' },
  { name: 'ui-api',       entry: 'actions/ui-api/index.js' }
]

/**
 * Create a zip containing srcFile as index.js at the root.
 * Uses the `archiver` package — cross-platform (Windows, WSL, Linux, macOS).
 */
function zipFile (srcFile, destZip) {
  if (fs.existsSync(destZip)) fs.unlinkSync(destZip)

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZip)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', resolve)
    archive.on('error', reject)

    archive.pipe(output)
    // The zip must contain index.js at its root — that is the runtime entry point
    archive.file(srcFile, { name: 'index.js' })
    archive.finalize()
  })
}

async function build () {
  fs.mkdirSync(DIST, { recursive: true })

  for (const action of ACTIONS) {
    const bundlePath = path.join(DIST, `${action.name}.js`)
    const zipPath    = path.join(DIST, `${action.name}.zip`)
    const entry      = path.join(ROOT, action.entry)

    console.log(`\nBundling ${action.name}...`)
    execSync(
      `npx esbuild "${entry}" --bundle --platform=node --target=node18 --minify --outfile="${bundlePath}"`,
      { stdio: 'inherit', cwd: ROOT }
    )

    const sizeMB = (fs.statSync(bundlePath).size / 1024 / 1024).toFixed(2)
    console.log(`  bundle: ${sizeMB} MB → zipping...`)

    await zipFile(bundlePath, zipPath)

    const zipMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)
    console.log(`  zip:    ${zipMB} MB  →  ${zipPath}`)
  }

  // Verify zip contents (central directory listing via unzip if available)
  console.log('\nVerifying zip contents...')
  for (const action of ACTIONS) {
    const zipPath = path.join(DIST, `${action.name}.zip`)
    try {
      const entries = execSync(`unzip -Z1 "${zipPath}"`).toString().trim()
      console.log(`  ${action.name}.zip contains: ${entries}`)
    } catch {
      console.log(`  ${action.name}.zip written (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB) — unzip not available for listing`)
    }
  }

  console.log('\nBuild complete.')
}

build().catch(err => { console.error(err); process.exit(1) })
