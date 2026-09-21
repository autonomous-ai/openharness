// Web Studio's scripts, run the way Harness runs them.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'harness.json'), 'utf8'))
const scratch = []
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })
function tempDir() { const d = mkdtempSync(join(tmpdir(), 'web-studio-')); scratch.push(d); return d }
function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  for (const [k, v] of Object.entries(env)) if (v === null) delete merged[k]; else merged[k] = v
  const r = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('every script the manifest names is executable', () => {
  for (const s of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor, 'skills/web/scripts/screenshot.mjs'])
    assert.doesNotThrow(() => accessSync(join(here, s), constants.X_OK), s)
})

test('doctor always ok (no native toolchain needed)', () => {
  const { code, stdout } = run(manifest.toolchain.doctor)
  assert.equal(code, 0); assert.match(stdout, /ok   isolated-web-viewer/)
})

test('setup is a quiet no-op', () => {
  const { code, stdout, stderr } = run(manifest.toolchain.setup)
  assert.deepEqual([code, stdout, stderr], [0, '', ''])
})

test('init seeds the first verdict', () => {
  const ws = tempDir()
  assert.equal(run(manifest.workspace.init, { cwd: ws, env: { HARNESS_DSH: manifest.id } }).code, 0)
  assert.equal(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).ready, false)
})

test('template is a real, loadable html page with an interaction', () => {
  const html = readFileSync(join(here, 'template/index.html'), 'utf8')
  assert.match(html, /<canvas/); assert.match(html, /pointermove/); assert.match(html, /requestAnimationFrame/)
  assert.match(html, /<title>/)
})

test('the golden-loop command in SKILL.md matches the shipped proof script', () => {
  const skill = readFileSync(join(here, 'skills/web/SKILL.md'), 'utf8')
  assert.ok(skill.includes('node "$WEB_SKILLS/web/scripts/screenshot.mjs"'))
  assert.equal(manifest.agent.env.WEB_SKILLS, '${dsh}/skills')
})
