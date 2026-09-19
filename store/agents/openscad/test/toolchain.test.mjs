// The OpenSCAD harness's scripts, run the way Harness runs them: by path, in the directory Harness
// gives them, with the environment Harness sets.
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
  const dir = mkdtempSync(join(tmpdir(), 'openscad-'))
  scratch.push(dir)
  return dir
}

function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  for (const [key, value] of Object.entries(env)) if (value === null) delete merged[key]; else merged[key] = value
  const result = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A transport fixture, not evidence of a real OpenSCAD render. */
function fakeOpenscad() {
  const dir = tempDir()
  const bin = join(dir, 'openscad')
  const faces = [[[0,0,0],[0,1,0],[1,0,0]],[[0,0,0],[1,0,0],[0,0,1]],[[0,0,0],[0,0,1],[0,1,0]],[[1,0,0],[0,1,0],[0,0,1]]]
  const mesh = 'solid tetra\n' + faces.map(face => 'facet normal 0 0 0\nouter loop\n' + face.map(v => 'vertex '+v.join(' ')).join('\n') + '\nendloop\nendfacet').join('\n') + '\nendsolid tetra\n'
  writeFileSync(join(dir,'fixture.stl'), mesh)
  writeFileSync(bin, '#!/bin/sh\n[ "$1" = "-o" ] || exit 0\ncp "'+join(dir,'fixture.stl')+'" "$2"\n')
  chmodSync(bin, 0o755)
  return { dir, bin }
}

test('every script the manifest names is in the folder and executable', () => {
  for (const script of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor, 'skills/openscad/scripts/render-part.sh']) {
    assert.doesNotThrow(() => accessSync(join(here, script), constants.X_OK), script)
  }
})

test('setup finds an openscad CLI on PATH and says ok', () => {
  const { dir, bin } = fakeOpenscad()
  const { code, stdout } = run(manifest.toolchain.setup, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0)
  assert.match(stdout, /ok   openscad/)
})

test('doctor says ok when openscad is on PATH', () => {
  const { dir } = fakeOpenscad()
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: `${dir}:/usr/bin:/bin` } })
  assert.equal(code, 0)
  assert.match(stdout, /ok   openscad/)
})

test('doctor says miss and fails when openscad is not present', () => {
  if (existsSync('/Applications/OpenSCAD.app')) return // can't force this case on a machine with the cask installed
  const { code, stdout } = run(manifest.toolchain.doctor, { env: { PATH: tempDir() } })
  assert.equal(code, 1)
  assert.match(stdout, /miss openscad/)
})

test('init seeds the first verdict and the initialized marker', () => {
  const workspace = tempDir()
  const { code } = run(manifest.workspace.init, { cwd: workspace, env: { HARNESS_DSH: manifest.id } })
  assert.equal(code, 0)
  const verdict = JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))
  assert.equal(verdict.ready, false)
  assert.match(readFileSync(join(workspace, '.harness-initialized'), 'utf8'), new RegExp(manifest.id.replace('/', '/')))
})

test('render-part.sh renders an artifact and flips the verdict, exactly as SKILL.md writes it', () => {
  const skill = readFileSync(join(here, 'skills/openscad/SKILL.md'), 'utf8')
  const command = 'sh "$OPENSCAD_SKILLS/openscad/scripts/render-part.sh"'
  assert.ok(skill.includes(command), 'SKILL.md should document the one-stop render command')
  assert.equal(manifest.agent.env.OPENSCAD_SKILLS, '${dsh}/skills')

  const { dir, bin } = fakeOpenscad()
  const workspace = tempDir()
  mkdirSync(join(workspace, 'parts'), { recursive: true })
  writeFileSync(join(workspace, 'model.scad'), 'cube(10);\n')
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: workspace,
    env: { ...process.env, OPENSCAD_SKILLS: join(here, 'skills'), PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, HARNESS_WORKSPACE: workspace },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(workspace, 'part.stl')), true)
  const verdict = JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))
  assert.equal(verdict.ready, true)
  assert.equal(verdict.artifact, 'part.stl')
})
