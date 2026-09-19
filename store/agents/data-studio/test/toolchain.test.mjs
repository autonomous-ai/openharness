// The Data Studio harness's scripts, run the way Harness runs them: by path, in the directory
// Harness gives them, with the environment Harness sets.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'harness.json'), 'utf8'))
const scratch = []
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'data-studio-'))
  scratch.push(dir)
  return dir
}

function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  for (const [key, value] of Object.entries(env)) if (value === null) delete merged[key]; else merged[key] = value
  const result = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A fake `node` (this harness's only local runtime gate) that reports a version. */
function fakeNode() {
  const dir = tempDir()
  const bin = join(dir, 'node')
  writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do [ "$a" = "--version" ] && echo "v20.19.0"; done; exit 0\n')
  chmodSync(bin, 0o755)
  return dir
}

test('every script the manifest names is in the folder and executable', () => {
  for (const script of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor, 'skills/data/scripts/update-verdict.sh']) {
    assert.doesNotThrow(() => accessSync(join(here, script), constants.X_OK), script)
  }
})

test('setup finds node on PATH and says ok', () => {
  const dir = fakeNode()
  const { code, stdout } = run(manifest.toolchain.setup, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0)
  assert.match(stdout, /ok   node/)
})

test('doctor says ok when node is on PATH', () => {
  const dir = fakeNode()
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0)
  assert.match(stdout, /ok   node/)
})

test('doctor says miss and fails when node is absent', () => {
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: tempDir() } })
  assert.equal(code, 1)
  assert.match(stdout, /miss node/)
})

test('init seeds the first verdict and the initialized marker', () => {
  const workspace = tempDir()
  const { code } = run(manifest.workspace.init, { cwd: workspace, env: { HARNESS_DSH: manifest.id } })
  assert.equal(code, 0)
  const verdict = JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))
  assert.equal(verdict.ready, false)
  assert.match(readFileSync(join(workspace, '.harness-initialized'), 'utf8'), new RegExp(manifest.id.replace('/', '/')))
})

test('file existence cannot turn an unavailable browser proof into a ready verdict', () => {
  const skill = readFileSync(join(here, 'skills/data/SKILL.md'), 'utf8')
  const command = 'sh "$DATA_SKILLS/data/scripts/update-verdict.sh"'
  assert.ok(skill.includes(command), 'SKILL.md should document the one-stop update command')
  assert.equal(manifest.agent.env.DATA_SKILLS, '${dsh}/skills')

  const workspace = tempDir()
  writeFileSync(join(workspace, 'index.html'), '<!doctype html><h1>dash</h1>\n')
  writeFileSync(join(workspace, 'data.csv'), 'quarter,region,revenue\n2025-Q1,North,12\n')
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: workspace,
    env: { ...process.env, DATA_SKILLS: join(here, 'skills'), HARNESS_WORKSPACE: workspace, PLAYWRIGHT_MODULE: join(workspace, 'missing-playwright.mjs') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1, result.stderr)
  const verdict = JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))
  assert.equal(verdict.ready, false)
  assert.match(verdict.findings[0].message, /Playwright is missing/)
  assert.equal(verdict.artifact, 'index.html')
})

test('update-verdict.sh reports missing index.html and fails', () => {
  const workspace = tempDir()
  writeFileSync(join(workspace, 'data.csv'), 'q,r,v\n1,2,3\n')
  const result = spawnSync('/bin/sh', ['-c', 'sh "$DATA_SKILLS/data/scripts/update-verdict.sh"'], {
    cwd: workspace,
    env: { ...process.env, DATA_SKILLS: join(here, 'skills'), HARNESS_WORKSPACE: workspace },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'), /index\.html missing/)
})
