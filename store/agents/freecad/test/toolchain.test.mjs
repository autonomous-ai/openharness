// The FreeCAD harness's scripts, run the way Harness runs them: by path, in the directory Harness
// gives them, with the environment Harness sets. Uses a FAKE freecadcmd so no real app is needed.
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

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'freecad-'))
  scratch.push(dir)
  return dir
}

function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  delete merged.FREECAD_BIN
  delete merged.FREECAD_TOOLCHAIN
  const isolatedPackage = tempDir()
  mkdirSync(join(isolatedPackage, 'toolchain'))
  merged.HARNESS_DSH_DIR = isolatedPackage
  for (const [key, value] of Object.entries(env)) if (value === null) delete merged[key]; else merged[key] = value
  const result = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A fake `freecadcmd`: writes `part.step` into the output-dir argument (last arg), as the real
 *  FreeCADCmd writes the file named by the plan's Part.export. */
function fakeFreecadCmd() {
  const dir = tempDir()
  const bin = join(dir, 'freecadcmd')
  writeFileSync(bin, '#!/bin/sh\n[ -n "$HARNESS_BUILD_DIR" ] || exit 0\nprintf \'ISO-10303-21;\\nEND-ISO-10303-21;\\n\' > "$HARNESS_BUILD_DIR/part.step"\nprintf \'{"valid":true,"closed":true,"solids":1,"volumeMM3":1}\' > "$HARNESS_BUILD_DIR/geometry.json"\n')
  chmodSync(bin, 0o755)
  return { dir, bin }
}

test('every script the manifest names is in the folder and executable', () => {
  for (const script of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor, 'skills/freecad/scripts/build-part.sh']) {
    assert.doesNotThrow(() => accessSync(join(here, script), constants.X_OK), script)
  }
})

test('setup finds a freecadcmd CLI on PATH and says ok', () => {
  const { dir, bin } = fakeFreecadCmd()
  const { code, stdout } = run(manifest.toolchain.setup, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0)
  assert.match(stdout, /ok   freecad/)
})

test('doctor says ok when freecadcmd is on PATH', () => {
  const { dir } = fakeFreecadCmd()
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0)
  assert.match(stdout, /ok   freecadcmd/)
})

test('doctor says miss and fails when freecad is not present', () => {
  if (existsSync('/Applications/FreeCAD.app')) return // can't force this case on a machine with the cask installed
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: tempDir() } })
  assert.equal(code, 1)
  assert.match(stdout, /miss freecadcmd/)
})

test('init seeds the first verdict and the initialized marker', () => {
  const workspace = tempDir()
  const { code } = run(manifest.workspace.init, { cwd: workspace, env: { HARNESS_DSH: manifest.id } })
  assert.equal(code, 0)
  const verdict = JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))
  assert.equal(verdict.ready, false)
  assert.match(readFileSync(join(workspace, '.harness-initialized'), 'utf8'), new RegExp(manifest.id.replace('/', '/')))
})

test('build-part.sh supports legacy geometry without claiming the design is checked', () => {
  const skill = readFileSync(join(here, 'skills/freecad/SKILL.md'), 'utf8')
  const command = 'sh "$FREECAD_SKILLS/freecad/scripts/build-part.sh"'
  assert.ok(skill.includes(command), 'SKILL.md should document the one-stop build command')
  assert.equal(manifest.agent.env.FREECAD_SKILLS, '${dsh}/skills')

  const { dir, bin } = fakeFreecadCmd()
  const workspace = tempDir()
  mkdirSync(join(workspace, 'parts'), { recursive: true })
  writeFileSync(join(workspace, 'part.FCMacro'), 'import FreeCAD as App\nimport Part\n')
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: workspace,
    env: { ...process.env, FREECAD_BIN: bin, FREECAD_SKILLS: join(here, 'skills'), PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, HARNESS_WORKSPACE: workspace },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(workspace, 'part.step')), true)
  const verdict = JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))
  assert.equal(verdict.ready, false)
  assert.match(verdict.summary, /design.json/)
  assert.equal(verdict.artifact, 'part.step')
})
