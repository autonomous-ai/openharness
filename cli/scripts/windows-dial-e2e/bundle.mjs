/**
 * The desk as plain JavaScript, for a Windows machine whose Smart App Control runs only signed programs (README.md):
 * there neither esbuild nor tsx can run, so the desk and the CLI its daemon runs are built here, on a machine with this
 * checkout's node_modules, and run there under the installed release's signed node.exe.
 *
 *   node scripts/windows-dial-e2e/bundle.mjs <out>
 *
 * writes, into an empty <out>, the monorepo's shape, so the files the desk's harness reads by their place beside its
 * own (e2e/harness/daemon.ts CLI_ROOT, e2e/harness/fakeDial.ts) are where it looks:
 *   cli/scripts/windows-dial-e2e/desk.mjs              the desk and every module it imports
 *   cli/scripts/windows-dial-e2e/cli.js, notify.mjs    the CLI, as e2e/harness/bundle.ts builds it; the desk names it
 *   cli/scripts/windows-dial-e2e/console.ps1
 *   cli/src/cable/__fixtures__/fakeHarnessSerial.mjs   the serial stand-in of the stand-in desk
 *   devices/harness-device/firmware/version.txt        the firmware version the stand-in dial greets with
 */
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(here, '../..')
const [given] = process.argv.slice(2)
if (!given) {
  console.error('usage: node scripts/windows-dial-e2e/bundle.mjs <out>')
  process.exit(2)
}
const out = resolve(given)
if (existsSync(out) && readdirSync(out).length) {
  console.error(`${out} is not empty`)
  process.exit(2)
}
const repoRoot = resolve(cliRoot, '..')
const deskDir = join(out, 'cli', 'scripts', 'windows-dial-e2e')

// First: build-bundle.mjs empties the folder it writes.
execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: cliRoot, env: { ...process.env, BUNDLE_OUT_DIR: deskDir }, stdio: 'inherit' })

// The e2e harness's artifacts.ts imports vitest but uses it only once its vitest setup file calls keepArtifacts, which
// the desk never does, and placeNode.ts injects a global setup's value only under vitest: the desk, which runs outside
// vitest, gets a vitest that does nothing.
const noVitest = {
  name: 'no-vitest',
  setup(build) {
    build.onResolve({ filter: /^vitest$/ }, () => ({ path: 'vitest', namespace: 'no-vitest' }))
    build.onLoad({ filter: /.*/, namespace: 'no-vitest' }, () => ({
      contents: 'export const afterAll = () => {}, beforeEach = () => {}, expect = { getState: () => ({}) }, inject = () => undefined',
      loader: 'js',
    }))
  },
}

await esbuild.build({
  entryPoints: [join(here, 'desk.mts')],
  outfile: join(deskDir, 'desk.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ws's optional native helpers, as build-bundle.mjs leaves them out: ws falls back when `require` cannot find them.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: 'import{createRequire as ___cr}from"node:module";import{fileURLToPath as ___fp}from"node:url";const require=___cr(import.meta.url);'
      // The daemon the desk starts runs the CLI built beside it.
      + 'process.env.E2E_BUNDLE_PATH=___fp(new URL("./cli.js",import.meta.url));',
  },
  plugins: [noVitest],
  logLevel: 'warning',
})

copyFileSync(join(here, 'console.ps1'), join(deskDir, 'console.ps1'))
for (const file of [join('cli', 'src', 'cable', '__fixtures__', 'fakeHarnessSerial.mjs'), join('devices', 'harness-device', 'firmware', 'version.txt')]) {
  mkdirSync(dirname(join(out, file)), { recursive: true })
  copyFileSync(join(repoRoot, file), join(out, file))
}
console.log(`✓ the desk in ${deskDir}`)
