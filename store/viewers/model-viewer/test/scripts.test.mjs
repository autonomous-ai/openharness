// setup.sh, doctor.sh and viewer.sh, run for real against a scratch copy of the package with only the
// tools each case allows on PATH: Node (the real one, one that is too old, or none), and an npm stub
// that installs as much as the case says and logs what it was asked. The scripts find Node through
// runtimes.sh, so a case can also lay down Harness's own Node under HOME (~/.harness/runtime/current-node)
// — the Node a fresh Mac, with none on PATH, gets — with npm beside it or not.
//
//   npm test
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { freePort, packageDir, sleep } from './helpers.mjs'

const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
// A bash line tracer's hooks (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT), passed through when set.
const TRACER = Object.fromEntries(['BASH_ENV', 'SHCOV_OUT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))

function systemTool(name) {
  const found = ['/bin', '/usr/bin'].map((dir) => join(dir, name)).find((path) => existsSync(path))
  assert.ok(found, `${name} is on this machine`)
  return found
}

/** An executable script at dir/name; whatever was there goes first, so nothing is written through a link. */
function stub(dir, name, body) {
  const full = join(dir, name)
  mkdirSync(dir, { recursive: true })
  rmSync(full, { force: true })
  writeFileSync(full, body)
  chmodSync(full, 0o755)
  return full
}

const NPM = `#!/bin/sh
echo "$*" >> "$NPM_LOG"
case "$1" in
  ci)
    [ "$NPM_CI" = fail ] && { echo "npm ERR! ci failed" >&2; exit 1; }
    [ "$NPM_CI" = nothing ] && exit 0
    /bin/mkdir -p node_modules/three/build node_modules/three/examples/jsm/loaders
    echo '{ "version": "0.186.0" }' > node_modules/three/package.json
    : > node_modules/three/build/three.module.js
    [ "$NPM_CI" = no-loader ] && exit 0
    : > node_modules/three/examples/jsm/loaders/GLTFLoader.js ;;
  run)
    [ "$NPM_SMOKE" = fail ] && { echo "smoke failed" >&2; exit 1; }
    echo "smoke ok" ;;
esac
exit 0
`
const OLD_NODE = '#!/bin/sh\n[ "$1" = "-e" ] && exit 1\necho v16.20.2\n'

/**
 * `script` and runtimes.sh linked into an empty package folder (linked, so a line tracer maps back to
 * them), with a bin folder holding bash, dirname and cat plus `node` ('real', 'old' or none) and the npm
 * stub (or none). harness: Harness's own Node under HOME ('real', 'old' or none), with the npm stub
 * beside it when harnessNpm. `files` are created in the package.
 */
function sandbox(script, { node = 'real', npm = true, harness = null, harnessNpm = true, files = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'model-viewer-scripts-'))
  roots.push(root)
  const pkg = join(root, 'pkg'), bin = join(root, 'bin'), home = join(root, 'home')
  mkdirSync(pkg); mkdirSync(bin); mkdirSync(home)
  for (const name of [script, 'runtimes.sh']) symlinkSync(join(packageDir, name), join(pkg, name))
  for (const tool of ['bash', 'dirname', 'cat']) symlinkSync(systemTool(tool), join(bin, tool))
  if (node === 'real') symlinkSync(process.execPath, join(bin, 'node'))
  if (node === 'old') stub(bin, 'node', OLD_NODE)
  if (npm) stub(bin, 'npm', NPM)
  if (harness) {
    const harnessBin = join(root, 'harness-node', 'bin')
    mkdirSync(harnessBin, { recursive: true })
    if (harness === 'real') symlinkSync(process.execPath, join(harnessBin, 'node'))
    else stub(harnessBin, 'node', OLD_NODE)
    if (harnessNpm) stub(harnessBin, 'npm', NPM)
    mkdirSync(join(home, '.harness', 'runtime'), { recursive: true })
    writeFileSync(join(home, '.harness', 'runtime', 'current-node'), join(harnessBin, 'node'))
  }
  for (const [rel, body] of files) { mkdirSync(dirname(join(pkg, rel)), { recursive: true }); writeFileSync(join(pkg, rel), body) }
  const log = join(root, 'npm.log')
  const run = (env = {}) => {
    const r = spawnSync(join(pkg, script), [], { env: { PATH: bin, HOME: home, NPM_LOG: log, ...TRACER, ...env }, encoding: 'utf8' })
    const npmCalls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { status: r.status, lines: r.stdout.trim().split('\n').filter(Boolean), stderr: r.stderr, npmCalls }
  }
  return { root, pkg, home, run }
}

const noHarnessNode = (box) => `miss node >= 18, and Harness's own Node is not in ${box.home}/.harness/runtime — run \`harness start\` once to lay it down`
const harnessTooOld = "miss node >= 18 — this machine's newest is v16.20.2, Harness's own; update Harness"

const THREE = [
  ['node_modules/three/package.json', '{ "version": "0.186.0" }'],
  ['node_modules/three/build/three.module.js', ''],
  ['node_modules/three/examples/jsm/loaders/GLTFLoader.js', ''],
]
const WEB = [['web/index.html', ''], ['web/app.js', '']]

describe('setup.sh', () => {
  test('installs three from the lockfile, runs the smoke test, and says which three it is', () => {
    const r = sandbox('setup.sh').run()
    assert.deepEqual(r.npmCalls, ['ci --silent --no-audit --no-fund', 'run smoke --silent'])
    assert.deepEqual(r.lines, ['smoke ok', 'ok   three 0.186.0 (3D Viewer)'])
    assert.equal(r.status, 0)
  })

  test("refuses without Node 18 or newer — this machine's or Harness's own — and without npm beside it", () => {
    for (const node of [null, 'old']) {
      const box = sandbox('setup.sh', { node })
      const r = box.run()
      assert.deepEqual(r.lines, [noHarnessNode(box)], `node: ${node}`)
      assert.equal(r.status, 1)
      assert.deepEqual(r.npmCalls, [], 'nothing is installed')
    }
    let r = sandbox('setup.sh', { node: 'old', harness: 'old' }).run()
    assert.deepEqual([r.status, r.lines, r.npmCalls], [1, [harnessTooOld], []])
    r = sandbox('setup.sh', { npm: false }).run()
    assert.deepEqual(r.lines, [`miss npm beside node ${process.version}`])
    assert.equal(r.status, 1)
  })

  test("a machine with no Node on PATH installs with Harness's own Node and the npm beside it", () => {
    const r = sandbox('setup.sh', { node: null, npm: false, harness: 'real' }).run()
    assert.deepEqual(r.npmCalls, ['ci --silent --no-audit --no-fund', 'run smoke --silent'])
    assert.deepEqual(r.lines, ['smoke ok', 'ok   three 0.186.0 (3D Viewer)'])
    assert.equal(r.status, 0)
  })

  test('stops when npm ci fails, when it leaves three or its glTF loader out, and when the smoke test fails', () => {
    let r = sandbox('setup.sh').run({ NPM_CI: 'fail' })
    assert.equal(r.status, 1)
    assert.deepEqual(r.lines, [])
    assert.match(r.stderr, /ci failed/)
    r = sandbox('setup.sh').run({ NPM_CI: 'nothing' })
    assert.deepEqual([r.status, r.lines], [1, ['miss three after npm ci']])
    r = sandbox('setup.sh').run({ NPM_CI: 'no-loader' })
    assert.deepEqual([r.status, r.lines], [1, ["miss three's glTF loader after npm ci"]])
    r = sandbox('setup.sh').run({ NPM_SMOKE: 'fail' })
    assert.equal(r.status, 1)
    assert.deepEqual(r.npmCalls, ['ci --silent --no-audit --no-fund', 'run smoke --silent'])
    assert.ok(!r.lines.some((line) => line.startsWith('ok')), 'no ok line after a failed smoke test')
  })
})

describe('doctor.sh', () => {
  test("ready: node, three and the page, one ok line each for the tools — on Harness's own Node too", () => {
    for (const [node, harness] of [['real', null], [null, 'real']]) {
      const r = sandbox('doctor.sh', { node, harness, files: [...THREE, ...WEB] }).run()
      assert.deepEqual(r.lines, [`ok   node ${process.version}`, 'ok   three 0.186.0'], `node: ${node}`)
      assert.equal(r.status, 0)
    }
  })

  test('says what is missing: Node (or too old a Node), three or its loader, the page', () => {
    for (const node of [null, 'old']) {
      const box = sandbox('doctor.sh', { node, files: [...THREE, ...WEB] })
      const r = box.run()
      assert.equal(r.lines[0], noHarnessNode(box), `node: ${node}`)
      assert.equal(r.status, 1)
    }
    let r = sandbox('doctor.sh', { node: 'old', harness: 'old', files: [...THREE, ...WEB] }).run()
    assert.deepEqual([r.status, r.lines[0]], [1, harnessTooOld])
    r = sandbox('doctor.sh', { files: WEB }).run()
    assert.deepEqual([r.status, r.lines.slice(1)], [1, ['miss node_modules/three — run ./setup.sh']])
    r = sandbox('doctor.sh', { files: [THREE[0], THREE[1], ...WEB] }).run()
    assert.deepEqual([r.status, r.lines.slice(1)], [1, ['miss node_modules/three — run ./setup.sh']])
    for (const web of [[WEB[0]], [WEB[1]], []]) {
      r = sandbox('doctor.sh', { files: [...THREE, ...web] }).run()
      assert.deepEqual([r.status, r.lines.slice(1)], [1, ['ok   three 0.186.0', 'miss web/ — the package is incomplete']], JSON.stringify(web))
    }
  })
})

describe('viewer.sh', () => {
  test('needs the port and the workspace Harness passes', () => {
    const script = join(packageDir, 'viewer.sh')
    const env = { PATH: process.env.PATH, HARNESS_VIEWER_PORT: '1', HARNESS_WORKSPACE: tmpdir() }
    for (const missing of ['HARNESS_VIEWER_PORT', 'HARNESS_WORKSPACE']) {
      const r = spawnSync(script, [], { env: { ...env, [missing]: '' }, encoding: 'utf8' })
      assert.equal(r.status, 1, missing)
      assert.match(r.stderr, new RegExp(missing), missing)
    }
  })

  test('runs the server from the package folder, wherever it is started', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'model-viewer-sh-'))
    roots.push(workspace)
    writeFileSync(join(workspace, 'part.glb'), 'glTF')
    const port = await freePort()
    const child = spawn(join(packageDir, 'viewer.sh'), [], { cwd: tmpdir(), env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace }, stdio: ['ignore', 'pipe', 'inherit'] })
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
    try {
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      const deadline = Date.now() + 15_000
      while (!out.includes('listening') && Date.now() < deadline) await sleep(20)
      assert.match(out, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}/`))
      const s = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()
      assert.deepEqual(s.models.map((m) => m.path), ['part.glb'])
    } finally {
      child.kill('SIGTERM')
    }
    assert.equal(await exited, 0, 'exec: the signal reaches node, which exits cleanly')
  })

  test("a login shell with no node on PATH runs Harness's own; with none at all, a miss and no server", () => {
    const env = { HARNESS_VIEWER_PORT: '4000', HARNESS_WORKSPACE: tmpdir() }
    const box = sandbox('viewer.sh', { node: null, npm: false, harness: 'real', harnessNpm: false })
    writeFileSync(join(box.pkg, 'viewer.mjs'), 'console.log(`viewer on ${process.execPath} from ${process.argv[1]}`)\n')
    let r = box.run(env)
    assert.deepEqual([r.status, r.lines, r.stderr], [0, [`viewer on ${process.execPath} from ${join(box.pkg, 'viewer.mjs')}`], ''])
    const bare = sandbox('viewer.sh', { node: null, npm: false })
    r = bare.run(env)
    assert.deepEqual([r.status, r.lines], [1, [noHarnessNode(bare)]])
  })
})
