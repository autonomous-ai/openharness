// The Starter's scripts, run the way Harness runs them: by path, in the directory Harness gives them,
// with the environment Harness sets. Copy this folder with the rest of the starter and keep it
// passing as your harness grows.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'harness.json'), 'utf8'))
const scratch = []
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'starter-'))
  scratch.push(dir)
  return dir
}

/** Run a script by its path, as Harness does: env adds to (or, with `null`, removes from) this process's. */
function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  const result = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('every script the manifest names is in the folder and executable', () => {
  for (const script of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor, 'skills/hello/scripts/hello.sh']) {
    assert.doesNotThrow(() => accessSync(join(here, script), constants.X_OK), script)
  }
})

test('setup installs nothing and succeeds quietly', () => {
  assert.deepEqual(run(manifest.toolchain.setup), { code: 0, stdout: '', stderr: '' })
})

test('doctor says ok when sh is on PATH', () => {
  const { code, stdout } = run(manifest.toolchain.doctor)
  assert.equal(code, 0)
  assert.equal(stdout, 'ok   sh\n')
})

test('doctor says miss and fails when sh is not on PATH', () => {
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: tempDir() } })
  assert.equal(code, 1)
  assert.equal(stdout, 'miss sh\n')
})

test('init records the harness that laid out the workspace, in the workspace', () => {
  const workspace = tempDir()
  const { code } = run(manifest.workspace.init, { cwd: workspace, env: { HARNESS_DSH: manifest.id } })
  assert.equal(code, 0)
  assert.equal(readFileSync(join(workspace, '.harness-initialized'), 'utf8'), 'initialized by autonomous/starter\n')
})

test('init without HARNESS_DSH still runs, and says it does not know who', () => {
  const workspace = tempDir()
  assert.equal(run(manifest.workspace.init, { cwd: workspace, env: { HARNESS_DSH: null } }).code, 0)
  assert.equal(readFileSync(join(workspace, '.harness-initialized'), 'utf8'), 'initialized by ?\n')
})

test('the hello skill\'s command, exactly as SKILL.md writes it, greets from the workspace', () => {
  const skill = readFileSync(join(here, 'skills/hello/SKILL.md'), 'utf8')
  const command = /```bash\n(.+)\n```/.exec(skill)[1]
  assert.equal(command, 'sh "$STARTER_DSH_DIR/skills/hello/scripts/hello.sh"')
  const workspace = tempDir()
  // agent.env gives the agent STARTER_DSH_DIR=${dsh}; the install dir is this folder.
  assert.equal(manifest.agent.env.STARTER_DSH_DIR, '${dsh}')
  const result = spawnSync('/bin/sh', ['-c', command], { cwd: workspace, env: { ...process.env, STARTER_DSH_DIR: here }, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `hello from the Starter harness in ${realpathSync(workspace)}\n`)
})
