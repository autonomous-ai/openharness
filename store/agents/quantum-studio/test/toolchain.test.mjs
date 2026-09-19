// Quantum Studio's scripts, run the way Harness runs them: by path, in the directory Harness gives
// them, with the environment Harness sets.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'harness.json'), 'utf8'))
const scratch = []
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

function tempDir() { const d = mkdtempSync(join(tmpdir(), 'quantum-')); scratch.push(d); return d }
function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  for (const [k, v] of Object.entries(env)) if (v === null) delete merged[k]; else merged[k] = v
  const r = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** A fake `node` that a successful headless proof prints: SIM OK qubits=N gates=M. */
function fakeNode() {
  const dir = tempDir(); const bin = join(dir, 'node')
  writeFileSync(bin, '#!/bin/sh\necho "SIM OK qubits=2 gates=3"\nexit 0\n'); chmodSync(bin, 0o755)
  return { dir, bin }
}

test('every script the manifest names is in the folder and executable', () => {
  for (const s of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor,
    'skills/quantum/scripts/build-quantum.sh', 'skills/quantum/scripts/proof.mjs'])
    assert.doesNotThrow(() => accessSync(join(here, s), constants.X_OK), s)
})

test('setup finds node on PATH and says ok', () => {
  const { dir } = fakeNode()
  const { code, stdout } = run(manifest.toolchain.setup, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0); assert.match(stdout, /ok   node/)
})

test('doctor says ok when node is on PATH', () => {
  const { dir } = fakeNode()
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0); assert.match(stdout, /ok   node/)
})

test('doctor says miss and fails when node is absent', () => {
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: tempDir() } })
  assert.equal(code, 1); assert.match(stdout, /miss node/)
})

test('init seeds the first verdict and the initialized marker', () => {
  const ws = tempDir()
  assert.equal(run(manifest.workspace.init, { cwd: ws, env: { HARNESS_DSH: manifest.id } }).code, 0)
  assert.equal(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).ready, false)
  assert.ok(existsSync(join(ws, '.harness-initialized')))
})

test('build-quantum.sh proves, rebuilds index.html and flips the verdict, as SKILL.md documents', () => {
  const skill = readFileSync(join(here, 'skills/quantum/SKILL.md'), 'utf8')
  const command = 'sh "$QUANTUM_SKILLS/quantum/scripts/build-quantum.sh"'
  assert.ok(skill.includes(command))
  assert.equal(manifest.agent.env.QUANTUM_SKILLS, '${dsh}/skills')

  const ws = tempDir()
  mkdirSync(join(ws, '.harness'), { recursive: true })
  writeFileSync(join(ws, 'circuit.json'),
    JSON.stringify({ name: 't', qubits: ['q0', 'q1'], gates: [{ gate: 'H', target: 0 }] }, null, 2))
  const r = spawnSync('/bin/sh', ['-c', command], {
    cwd: ws,
    env: { ...process.env, QUANTUM_SKILLS: join(here, 'skills'), HARNESS_WORKSPACE: ws },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `${r.stderr || ''} ${r.stdout || ''}`)
  assert.ok(existsSync(join(ws, 'index.html')))
  const verdict = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
  assert.equal(verdict.ready, true)
  assert.equal(verdict.artifact, 'index.html')
  assert.match(verdict.summary, /2 qubits, 1 gates/)
})
