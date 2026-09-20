// Firmware Studio's scripts, run the way Harness runs them.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'harness.json'), 'utf8'))
const scratch = []
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })
function tempDir() { const d = mkdtempSync(join(tmpdir(), 'firmware-')); scratch.push(d); return d }
function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  for (const [k, v] of Object.entries(env)) if (v === null) delete merged[k]; else merged[k] = v
  const r = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
function fakePio() {
  const dir = tempDir(); const bin = join(dir, 'pio')
  writeFileSync(bin, '#!/bin/sh\nmkdir -p .pio/build/esp32dev\nprintf "fixture" > .pio/build/esp32dev/firmware.bin\necho "RAM: [= ] 10% (used 10 bytes from 100 bytes)"\nexit 0\n'); chmodSync(bin, 0o755)
  return { dir, bin }
}

test('every script the manifest names is executable', () => {
  for (const s of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor, 'skills/firmware/scripts/build-firmware.sh'])
    assert.doesNotThrow(() => accessSync(join(here, s), constants.X_OK), s)
})

test('setup finds pio on PATH and says ok', () => {
  const { dir } = fakePio()
  const { code, stdout } = run(manifest.toolchain.setup, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0); assert.match(stdout, /ok   pio/)
})

test('doctor ok when pio on PATH', () => {
  const { dir } = fakePio()
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0); assert.match(stdout, /ok   pio/)
})

test('doctor miss and fails when pio is absent', () => {
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: tempDir() } })
  assert.equal(code, 1); assert.match(stdout, /miss pio/)
})

test('init seeds the first verdict and a placeholder build-status pane', () => {
  const ws = tempDir()
  assert.equal(run(manifest.workspace.init, { cwd: ws, env: { HARNESS_DSH: manifest.id } }).code, 0)
  assert.equal(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).ready, false)
  assert.ok(existsSync(join(ws, 'build-status.html')))
})

test('build-firmware.sh builds, writes the pane, and flips the verdict, as SKILL.md documents', () => {
  const skill = readFileSync(join(here, 'skills/firmware/SKILL.md'), 'utf8')
  const command = 'sh "$FIRMWARE_SKILLS/firmware/scripts/build-firmware.sh"'
  assert.ok(skill.includes(command))
  assert.equal(manifest.agent.env.FIRMWARE_SKILLS, '${dsh}/skills')
  const { dir } = fakePio()
  const ws = tempDir()
  mkdirSync(join(ws, 'src'), { recursive: true })
  writeFileSync(join(ws, 'platformio.ini'), '[env:esp32dev]\n')
  writeFileSync(join(ws, 'src/main.cpp'), 'void setup(){}\nvoid loop(){}\n')
  const r = spawnSync('/bin/sh', ['-c', command], { cwd: ws, env: { ...process.env, FIRMWARE_SKILLS: join(here, 'skills'), FIRMWARE_TOOLCHAIN: join(here, 'toolchain'), PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, HARNESS_WORKSPACE: ws }, encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stderr || ''} ${r.stdout || ''}`)
  assert.equal(existsSync(join(ws, 'build-status.html')), true)
  assert.equal(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).ready, true)
})
