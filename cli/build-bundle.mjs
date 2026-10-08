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
import { appendFileSync, readFileSync, copyFileSync, rmSync, writeFileSync } from 'fs'
import { readDshRegistry } from './scripts/lib/dshRegistry.mjs'
import { readBuiltinBundle, readHarnessMonitorBundle, readModelManagerBundle } from './scripts/lib/modelManagerBundle.mjs'
import { readProcessImageBundle } from './scripts/lib/processImageBundle.mjs'
import { leanBlock } from './scripts/lib/leanBlock.mjs'
import { asciiOnly } from './scripts/lib/asciiOnly.mjs'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
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

// `BUNDLE_OUT_DIR`: somewhere other than dist/ (the end-to-end update test builds real releases).
const outDir = process.env.BUNDLE_OUT_DIR || 'dist'

// Start clean so no stale per-file `dist/*.js` / sourcemaps leak into the release artifact.
rmSync(outDir, { recursive: true, force: true })

const options = {
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
    js: `/*! harness v${version} - Copyright (c) 2026 Autonomous, Inc. - MIT (https://github.com/autonomous-ai/openharness) */\n`
      + 'import{createRequire as ___cr}from"module";const require=___cr(import.meta.url);',
  },
  sourcemap: false,
  minify: true,
  keepNames: true,
  legalComments: 'eof',
  logLevel: 'info',
}

// Both lean builds refer to one asset file. Moving Store setup out of the core must not duplicate the
// release-owned harnesses in the services' build and the core's legacy inline-service fallback.
const builtinAssetsName = 'harness-builtin-assets.mjs'
const builtinAssets = await esbuild.build({
  ...options, entryPoints: ['src/dsh/bundledFiles.ts'], write: false, logLevel: 'warning',
})
const sharedBuiltinAssets = {
  name: 'shared-builtin-assets',
  setup(build) {
    build.onResolve({ filter: /^\.\/bundledFiles\.js$/ }, () => ({ path: `./${builtinAssetsName}`, external: true }))
  },
}

// harnessd's master and its services, bundled on their own (src/leanEntry.ts): Node parses all of the
// file a process starts on, and the whole CLI's cost each of them about 45 MiB at idle. Split, so that a
// process parses only the files its own code is in: the master never the services', search never the
// viewers'. Carried inside cli.js, at its end, as a comment Node only skims (scripts/lib/leanBlock.mjs).
const lean = await esbuild.build({
  ...options,
  plugins: [sharedBuiltinAssets],
  entryPoints: { harnessd: 'src/leanEntry.ts' },
  outdir: 'lean',
  splitting: true,
  chunkNames: '[name]-[hash]',
  outExtension: { '.js': '.mjs' },
  write: false,
  logLevel: 'warning',
})
// The core, bundled apart from them (src/leanCoreEntry.ts): built as one more entry of the same build, it
// shared their files, and each file a build splits out holds what any entry that loads it uses, so the
// master and every service loaded what only the core uses. Its files are named `core-*`, so the two never
// meet in the folder they are written to.
const leanCore = await esbuild.build({
  ...options,
  plugins: [sharedBuiltinAssets],
  entryPoints: { 'harnessd-core': 'src/leanCoreEntry.ts' },
  outdir: 'lean',
  splitting: true,
  chunkNames: 'core-[name]-[hash]',
  outExtension: { '.js': '.mjs' },
  write: false,
  logLevel: 'warning',
})
const leanFiles = Object.fromEntries(lean.outputFiles.map((file) => [basename(file.path), asciiOnly(file.text)]))
leanFiles[builtinAssetsName] = asciiOnly(builtinAssets.outputFiles[0].text)
for (const file of leanCore.outputFiles) {
  const name = basename(file.path)
  if (name in leanFiles) throw new Error(`the core's lean file ${name} has the name of one of the master's and the services'`)
  leanFiles[name] = asciiOnly(file.text)
}

await esbuild.build({
  ...options,
  // Still one file, which the self-updater downloads, verifies and swaps whole. Its entry decides what a
  // process loads (src/entry.ts), and the master starts itself, the core and the services from the lean
  // bundle.
  entryPoints: ['src/entry.ts'],
  outfile: `${outDir}/cli.js`,
})
writeFileSync(`${outDir}/cli.js`, asciiOnly(readFileSync(`${outDir}/cli.js`, 'utf8')))
appendFileSync(`${outDir}/cli.js`, leanBlock(leanFiles))

copyFileSync('hook/notify.mjs', `${outDir}/notify.mjs`)

console.log(`✓ Bundled ${outDir}/cli.js (v${version}) + ${outDir}/notify.mjs`)
