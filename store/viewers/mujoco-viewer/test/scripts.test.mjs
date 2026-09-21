// setup.sh, doctor.sh and viewer.sh, each run from a copy of the package in a scratch folder with a
// PATH that holds only what the case gives it: bash, dirname, cat, and a real, old or missing node and
// npm. The scripts find Node through runtimes.sh, so a case can also lay down Harness's own Node under
// HOME (~/.harness/runtime/current-node) — the Node a fresh Mac, with none on PATH, gets — with an npm
// beside it. Every line they can print, and the exit code that goes with it.
//
//   npm test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { after, test } from 'node:test'
import { PACKAGE, removeTree, write } from './helpers.mjs'

const root = mkdtempSync(join(tmpdir(), 'mujoco-viewer-scripts-'))
after(() => removeTree(root))

// A bash line tracer's hooks (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT), passed through when set.
const TRACER = Object.fromEntries(['BASH_ENV', 'SHCOV_OUT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
const OLD_NODE = '#!/bin/sh\n[ "$1" = "-e" ] && exit 1\necho v16.20.2\n'
const which = (tool) => ['/bin', '/usr/bin'].map((dir) => join(dir, tool)).find((path) => existsSync(path))
const INSTALLED = {
  'node_modules/@mujoco/mujoco/mujoco.wasm': 'wasm',
  'node_modules/@mujoco/mujoco/package.json': JSON.stringify({ version: '3.13.0' }),
  'node_modules/three/build/three.module.js': 'export {}',
  'node_modules/three/package.json': JSON.stringify({ version: '0.186.0' }),
}
const PANE = { 'public/main.js': '', 'public/index.html': '' }

let cases = 0

/** An executable script at dir/name; whatever was there goes first, so nothing is written through a link. */
function stub(dir, name, body) {
  const full = join(dir, name)
  mkdirSync(dir, { recursive: true })
  rmSync(full, { force: true })
  writeFileSync(full, body)
  chmodSync(full, 0o755)
  return full
}

/**
 * A package copy and its PATH. node: 'real' | 'old' | null. npm: null, or the exit codes of `npm ci`
 * and `npm run smoke`; the stub logs what it was asked to npm.log in the package. harness: Harness's own
 * Node under HOME, 'real' | 'old' | null, with that npm stub beside it when there is one. The scripts and
 * runtimes.sh are linked, not copied, so a line tracer maps back to them.
 */
function sandbox({ node = 'real', npm = null, harness = null, files = {} } = {}) {
  const dir = join(root, `case-${++cases}`)
  const pkg = join(dir, 'pkg')
  const bin = join(dir, 'bin')
  const home = join(dir, 'home')
  mkdirSync(pkg, { recursive: true })
  mkdirSync(bin)
  mkdirSync(home)
  for (const script of ['setup.sh', 'doctor.sh', 'viewer.sh', 'runtimes.sh']) symlinkSync(join(PACKAGE, script), join(pkg, script))
  for (const tool of ['bash', 'dirname', 'cat']) symlinkSync(which(tool), join(bin, tool))
  const npmStub = (where) => stub(where, 'npm', `#!/bin/sh\necho "$*" >> npm.log\ncase "$1" in\n  ci) exit ${npm.ci} ;;\n  run) exit ${npm.smoke} ;;\nesac\nexit 99\n`)
  if (node === 'real') symlinkSync(process.execPath, join(bin, 'node'))
  if (node === 'old') stub(bin, 'node', OLD_NODE)
  if (harness) {
    const harnessBin = join(dir, 'harness-node', 'bin')
    mkdirSync(harnessBin, { recursive: true })
    if (harness === 'real') symlinkSync(process.execPath, join(harnessBin, 'node'))
    else stub(harnessBin, 'node', OLD_NODE)
    if (npm) npmStub(harnessBin)
    write(join(home, '.harness', 'runtime', 'current-node'), join(harnessBin, 'node'))
  } else if (npm) {
    npmStub(bin)
  }
  for (const [rel, body] of Object.entries(files)) write(join(pkg, rel), body)
  const run = (script, env = {}, cwd = pkg) => {
    const r = spawnSync(script, [], { cwd, env: { PATH: bin, HOME: home, ...TRACER, ...env }, encoding: 'utf8' })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, npm: existsSync(join(pkg, 'npm.log')) ? readFileSync(join(pkg, 'npm.log'), 'utf8') : null }
  }
  return { dir, pkg, bin, home, run }
}

const noHarnessNode = (box) => `miss node >= 18, and Harness's own Node is not in ${box.home}/.harness/runtime — run \`harness start\` once to lay it down\n`
const harnessTooOld = "miss node >= 18 — this machine's newest is v16.20.2, Harness's own; update Harness\n"

test('setup.sh needs node 18 or newer — this machine\'s or Harness\'s own — and npm beside it, before it installs anything', () => {
  for (const node of [null, 'old']) {
    const box = sandbox({ node, npm: { ci: 0, smoke: 0 } })
    const r = box.run('./setup.sh')
    assert.deepEqual([r.code, r.stdout, r.npm], [1, noHarnessNode(box), null], `node: ${node}`)
  }
  let r = sandbox({ node: 'old', harness: 'old', npm: { ci: 0, smoke: 0 } }).run('./setup.sh')
  assert.deepEqual([r.code, r.stdout, r.npm], [1, harnessTooOld, null])
  r = sandbox({ npm: null }).run('./setup.sh')
  assert.deepEqual([r.code, r.stdout], [1, `miss npm beside node ${process.version}\n`])
})

test('setup.sh on a machine with no node on PATH installs with Harness\'s own Node and the npm beside it', () => {
  const r = sandbox({ node: null, harness: 'real', npm: { ci: 0, smoke: 0 }, files: INSTALLED }).run('./setup.sh')
  assert.deepEqual([r.code, r.stdout, r.npm], [0, 'ok   mujoco 3.13.0 (wasm) · three 0.186.0\n', 'ci --silent --no-audit --no-fund\nrun smoke --silent\n'])
})

test('setup.sh stops when npm ci fails, and says which dependency npm ci did not deliver', () => {
  let r = sandbox({ npm: { ci: 3, smoke: 0 } }).run('./setup.sh')
  assert.deepEqual([r.code, r.stdout, r.npm], [3, '', 'ci --silent --no-audit --no-fund\n'])
  r = sandbox({ npm: { ci: 0, smoke: 0 } }).run('./setup.sh')
  assert.deepEqual([r.code, r.stdout], [1, 'miss mujoco.wasm after npm ci\n'])
  r = sandbox({ npm: { ci: 0, smoke: 0 }, files: { 'node_modules/@mujoco/mujoco/mujoco.wasm': 'wasm' } }).run('./setup.sh')
  assert.deepEqual([r.code, r.stdout], [1, 'miss three after npm ci\n'])
})

test('setup.sh runs the install-time smoke checks, not the whole suite, and reports the versions', () => {
  let r = sandbox({ npm: { ci: 0, smoke: 4 }, files: INSTALLED }).run('./setup.sh')
  assert.deepEqual([r.code, r.stdout, r.npm], [4, '', 'ci --silent --no-audit --no-fund\nrun smoke --silent\n'])
  r = sandbox({ npm: { ci: 0, smoke: 0 }, files: INSTALLED }).run('./setup.sh')
  assert.deepEqual([r.code, r.stdout, r.npm], [0, 'ok   mujoco 3.13.0 (wasm) · three 0.186.0\n', 'ci --silent --no-audit --no-fund\nrun smoke --silent\n'])
  const pkg = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.smoke, 'node test/smoke.mjs && node test/server.mjs', 'what setup runs: the WASM API and the server')
  assert.match(pkg.scripts.test, /npm run smoke/)
})

test('doctor.sh: one line per check, exit 0 only when everything is there', () => {
  let r = sandbox({ files: { ...INSTALLED, ...PANE } }).run('./doctor.sh')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, `ok   node ${process.version}\nok   mujoco 3.13.0 (wasm)\nok   three 0.186.0\nok   pane (public/)\n`)

  r = sandbox().run('./doctor.sh')
  assert.equal(r.code, 1)
  assert.equal(r.stdout, `ok   node ${process.version}\nmiss node_modules/@mujoco/mujoco — run ./setup.sh\nmiss node_modules/three — run ./setup.sh\nmiss public/ — this package is incomplete\n`)

  r = sandbox({ files: { ...INSTALLED, 'public/main.js': '' } }).run('./doctor.sh')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\nmiss public\/ — this package is incomplete\n$/)

  // Before the fix the doctor never asked for node, and said ready on a machine the viewer cannot run on.
  for (const node of [null, 'old']) {
    const box = sandbox({ node, files: { ...INSTALLED, ...PANE } })
    r = box.run('./doctor.sh')
    assert.equal(r.code, 1, `node: ${node}`)
    assert.ok(r.stdout.startsWith(noHarnessNode(box)), `node: ${node}`)
  }
  r = sandbox({ node: 'old', harness: 'old', files: { ...INSTALLED, ...PANE } }).run('./doctor.sh')
  assert.equal(r.code, 1)
  assert.ok(r.stdout.startsWith(harnessTooOld))

  // A fresh Mac: no node on PATH, Harness's own laid down — the Node setup.sh installed with.
  r = sandbox({ node: null, harness: 'real', files: { ...INSTALLED, ...PANE } }).run('./doctor.sh')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, `ok   node ${process.version}\nok   mujoco 3.13.0 (wasm)\nok   three 0.186.0\nok   pane (public/)\n`)
})

test('viewer.sh insists on the port and the workspace, then execs node on the viewer beside it', () => {
  const box = sandbox()
  let r = box.run('./viewer.sh', { HARNESS_WORKSPACE: '/tmp' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /HARNESS_VIEWER_PORT: parameter null or not set/)
  r = box.run('./viewer.sh', { HARNESS_VIEWER_PORT: '18997' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /HARNESS_WORKSPACE: parameter null or not set/)

  writeFileSync(join(box.pkg, 'viewer.mjs'), 'console.log(JSON.stringify({ script: process.argv[1], port: process.env.HARNESS_VIEWER_PORT, workspace: process.env.HARNESS_WORKSPACE }))\n')
  r = box.run('pkg/viewer.sh', { HARNESS_VIEWER_PORT: '18997', HARNESS_WORKSPACE: '/tmp/ws' }, box.dir)
  assert.equal(r.code, 0, r.stderr)
  const seen = JSON.parse(r.stdout)
  assert.ok(isAbsolute(seen.script), 'the viewer is named by its absolute path, whatever the caller\'s directory')
  assert.equal(realpathSync(seen.script), realpathSync(join(box.pkg, 'viewer.mjs')))
  assert.deepEqual([seen.port, seen.workspace], ['18997', '/tmp/ws'])
})

test('viewer.sh from a login shell with no node on PATH runs Harness\'s own; with none at all, a miss and no server', () => {
  const env = { HARNESS_VIEWER_PORT: '18997', HARNESS_WORKSPACE: '/tmp/ws' }
  const box = sandbox({ node: null, harness: 'real' })
  writeFileSync(join(box.pkg, 'viewer.mjs'), 'console.log(process.execPath)\n')
  let r = box.run('./viewer.sh', env)
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, `${process.execPath}\n`, ''])
  const bare = sandbox({ node: null })
  writeFileSync(join(bare.pkg, 'viewer.mjs'), 'console.log(process.execPath)\n')
  r = bare.run('./viewer.sh', env)
  assert.deepEqual([r.code, r.stdout], [1, noHarnessNode(bare)])
})
