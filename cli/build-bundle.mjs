/**
 * Release build: bundle the whole CLI into ONE self-contained `dist/cli.js`
 * that runs on every OS under the user's Node, plus the standalone hook script.
 * The optional macOS image probe is embedded as pinned bytes in that same JS.
 *
 * Version is baked in via esbuild `define(__ADAPTER_VERSION__)`, sourced from `ADAPTER_VERSION`
 * (set by scripts/upload-cli.sh) else package.json — so the running binary's version EXACTLY
 * equals the published manifest version (the self-updater compares them).
 *
 * `bufferutil`/`utf-8-validate` are ws's OPTIONAL native deps — mark external and provide a real
 * `require` via the banner so ws's try/catch fallback works without them.
 */
import * as esbuild from 'esbuild'
import { readFileSync, copyFileSync, rmSync } from 'fs'
import { readDshRegistry } from './scripts/lib/dshRegistry.mjs'
import { readBuiltinBundle, readHarnessMonitorBundle, readModelManagerBundle } from './scripts/lib/modelManagerBundle.mjs'
import { readProcessImageBundle } from './scripts/lib/processImageBundle.mjs'
import { fileURLToPath } from 'node:url'
const modelManagerBundle = JSON.stringify(readModelManagerBundle(fileURLToPath(new URL('../store/agents/autonomous-grid', import.meta.url))))
const devicesBundle = JSON.stringify(readBuiltinBundle(fileURLToPath(new URL('../store/agents/devices', import.meta.url)), ['harness.json', 'AGENTS.md', 'LICENSE', 'template']))
const harnessMonitorBundle = JSON.stringify(readHarnessMonitorBundle(fileURLToPath(new URL('../store/agents/harness-monitor', import.meta.url))))

const version =
  process.env.ADAPTER_VERSION ||
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// The bundled registry (the store/ folders and store/registry at the repo root) — see src/dsh/registry.ts.
const dshRegistry = JSON.stringify(readDshRegistry(new URL('../store', import.meta.url)))
const processImages = readProcessImageBundle({
  path: process.env.HARNESS_PROCESS_IMAGES_ARTIFACT,
  required: process.env.HARNESS_REQUIRE_PROCESS_IMAGES === '1',
})

// Start clean so no stale per-file `dist/*.js` / sourcemaps leak into the release artifact.
rmSync('dist', { recursive: true, force: true })

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    __ADAPTER_VERSION__: JSON.stringify(version),
    __DSH_REGISTRY__: JSON.stringify(dshRegistry),
    __MODEL_MANAGER_BUNDLE__: JSON.stringify(modelManagerBundle),
    __DEVICES_BUNDLE__: JSON.stringify(devicesBundle),
    __HARNESS_MONITOR_BUNDLE__: JSON.stringify(harnessMonitorBundle),
    __DARWIN_PROCESS_IMAGES__: processImages ? JSON.stringify(processImages) : 'undefined',
  },
  // The copyright line is MIT's one condition — it has to travel with the copy the user actually
  // receives, and the published bundle IS that copy (upload-cli.sh ships `cli.js` and `notify.mjs`,
  // nothing else). `legalComments: 'eof'` below appends the dependencies' own notices; this is ours.
  banner: {
    js: `/*! harness v${version} — Copyright (c) 2026 Autonomous, Inc. — MIT (https://github.com/autonomous-ai/openharness) */\n`
      + 'import{createRequire as ___cr}from"module";const require=___cr(import.meta.url);',
  },
  sourcemap: false,
  minify: true,
  keepNames: true,
  legalComments: 'eof',
  logLevel: 'info',
})

copyFileSync('hook/notify.mjs', 'dist/notify.mjs')

console.log(`✓ Bundled dist/cli.js (v${version}) + dist/notify.mjs`)
