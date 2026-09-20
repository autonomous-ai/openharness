// The Drone Pilot harness scripts, run the way Harness runs them.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'harness.json'), 'utf8'))
const scratch = []
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

function tempDir() { const d = mkdtempSync(join(tmpdir(), 'pilot-')); scratch.push(d); return d }
function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  for (const [k, v] of Object.entries(env)) v === null ? delete merged[k] : (merged[k] = v)
  const r = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
const seedScript = join(here, 'skills/pilot/scripts/seed-verdict.sh')

test('every script the manifest names is in the folder and executable', () => {
  for (const s of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor]) {
    assert.doesNotThrow(() => accessSync(join(here, s), constants.X_OK), s)
  }
})

test('setup uses pinned local dependencies and resolves Node without asking for a system install', () => {
  const packages=JSON.parse(readFileSync(join(here,'toolchain/package.json'),'utf8'));
  assert.deepEqual(packages.dependencies,{'clipper-lib':'6.4.2','esbuild':'0.27.2','playwright-core':'1.63.0'});
  assert.match(readFileSync(join(here,'toolchain/install.sh'),'utf8'),/harness_node 20/);
})

test('doctor verifies the actual Node, build tools and local browser', () => {
  assert.equal(run(manifest.toolchain.doctor).code, 0)
})

test('init lays out a workspace and seeds a not-ready verdict', () => {
  const ws = tempDir()
  assert.equal(run(manifest.workspace.init, { cwd: ws, env: { HARNESS_DSH: manifest.id } }).code, 0)
  assert.equal(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).ready, false)
  assert.equal(readFileSync(join(ws, '.harness-initialized'), 'utf8'), `initialized by ${manifest.id}\n`)
})

test('the manifest names its source-saving viewer and an HTML artifact', () => {
  assert.equal(manifest.viewer.command, 'toolchain/viewer.sh')
  assert.deepEqual(manifest.viewer.artifactExtensions, ['.html'])
})

test('seed-verdict reflects whether a flight exists', () => {
  const ws = tempDir()
  run(manifest.workspace.init, { cwd: ws })
  assert.equal(spawnSync(seedScript, [ws], { cwd: ws, encoding: 'utf8' }).status, 0)
  assert.equal(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).ready, false)
  mkdirSync(join(ws, 'flight'), { recursive: true })
  writeFileSync(join(ws, 'flight/index.html'), '<!doctype html>')
  assert.equal(spawnSync(seedScript, [ws], { cwd: ws, encoding: 'utf8' }).status, 0)
  assert.equal(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).ready, false)
})


test('the manifest opens the field studio and provides its installed tools to the agent', () => {
  assert.equal(manifest.viewer.url, 'http://127.0.0.1:${port}/')
  assert.deepEqual(manifest.agent.env,{DRONE_DSH_DIR:'${dsh}'})
  assert.ok(manifest.workspace.marker.endsWith('/index.html'))
})
