// setup.sh, doctor.sh and viewer.sh, run for real against a scratch copy of the package with a PATH
// that holds only what they may use: bash, dirname and cat, plus a `node` and an `npm` the test controls
// (the real node, one too old, or none; an npm that records what it was asked and exits as told). The
// scripts find Node through runtimes.sh, so each case also says whether Harness's own Node is laid down
// under HOME (~/.harness/runtime/current-node) — the Node a fresh Mac, with none on PATH, gets.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'
import { cleanup, pkg, put, scratch } from './helpers.mjs'

after(cleanup)

const PDFJS_FILES = ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'web/pdf_viewer.mjs', 'web/pdf_viewer.css', 'legacy/build/pdf.min.mjs', 'legacy/web/pdf_viewer.mjs']
const APP_FILES = ['app/index.html', 'app/app.js', 'app/app.css', 'app/reviews.mjs', 'lib/workspace.mjs', 'lib/reviews.mjs', 'lib/zip.mjs']
// A bash line tracer's hooks (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT), passed through when set.
const TRACER = Object.fromEntries(['BASH_ENV', 'SHCOV_OUT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
// A node whose `-e` version check fails, as Node 18 fails `>= 20`.
const OLD_NODE = '#!/bin/sh\n[ "$1" = "-e" ] && exit 1\necho "v18.0.0"\n'

/** Where `name` lives on this machine's PATH. */
function tool(name) {
  for (const dir of String(process.env.PATH).split(delimiter)) {
    const full = join(dir, name)
    try { accessSync(full, constants.X_OK); return full } catch { /* next */ }
  }
  throw new Error(`${name} is not on PATH`)
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

/**
 * A scratch package holding `script` and runtimes.sh (linked from this package, so a line tracer maps
 * back to them) and a bin directory for PATH.
 * node: 'real' | 'old' | 'none'; npm: an exit code, or null for none.
 * harness: Harness's own Node under HOME — 'real' | 'old' | null — with harnessNpm (an exit code, or null) beside it.
 */
function sandbox(script, { node = 'real', npm = null, harness = null, harnessNpm = null } = {}) {
  const root = scratch({}, 'doc-viewer-sh-')
  const dir = join(root, 'pkg')
  mkdirSync(dir)
  for (const name of [script, 'runtimes.sh']) symlinkSync(join(pkg, name), join(dir, name))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const name of ['bash', 'dirname', 'cat']) symlinkSync(tool(name), join(bin, name))
  const npmStub = (where, code) => stub(where, 'npm', `#!/bin/sh\necho "$*" >> '${join(root, 'npm.log')}'\nexit ${code}\n`)
  if (node === 'real') symlinkSync(process.execPath, join(bin, 'node'))
  if (node === 'old') stub(bin, 'node', OLD_NODE)
  if (npm !== null) npmStub(bin, npm)
  const home = join(root, 'home')
  if (harness) {
    const harnessBin = join(root, 'harness-node', 'bin')
    mkdirSync(harnessBin, { recursive: true })
    if (harness === 'real') symlinkSync(process.execPath, join(harnessBin, 'node'))
    else stub(harnessBin, 'node', OLD_NODE)
    if (harnessNpm !== null) npmStub(harnessBin, harnessNpm)
    put(home, '.harness/runtime/current-node', join(harnessBin, 'node'))
  }
  const npmCalls = () => (existsSync(join(root, 'npm.log')) ? readFileSync(join(root, 'npm.log'), 'utf8').split('\n').filter(Boolean) : [])
  const run = (env = {}) => {
    // From another directory: each script finds its own.
    const r = spawnSync(join(dir, script), [], { cwd: root, env: { PATH: bin, HOME: home, ...TRACER, ...env }, encoding: 'utf8' })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  return { root, dir, bin, home, run, npmCalls }
}

const noHarnessNode = (box) => `miss node >= 20, and Harness's own Node is not in ${box.home}/.harness/runtime — run \`harness start\` once to lay it down\n`

function installPdfjs(dir, { skip = null, version = '9.9.9' } = {}) {
  for (const f of PDFJS_FILES) if (f !== skip) put(dir, `node_modules/pdfjs-dist/${f}`, '')
  put(dir, 'node_modules/pdfjs-dist/package.json', JSON.stringify({ name: 'pdfjs-dist', version }))
}

test('the scripts are executable in the package, and runtimes.sh is beside them', () => {
  for (const script of ['setup.sh', 'doctor.sh', 'viewer.sh']) accessSync(join(pkg, script), constants.X_OK)
  accessSync(join(pkg, 'runtimes.sh'), constants.R_OK)
})

test('setup: no node, or one older than 20, and no Node of Harness\'s own is a miss before npm runs', () => {
  for (const node of ['none', 'old']) {
    const box = sandbox('setup.sh', { node, npm: 0 })
    const r = box.run()
    assert.equal(r.code, 1, node)
    assert.equal(r.out, noHarnessNode(box), node)
    assert.deepEqual(box.npmCalls(), [], node)
  }
})

test('setup: Harness\'s own Node too old as well says to update Harness', () => {
  const box = sandbox('setup.sh', { node: 'old', npm: 0, harness: 'old' })
  const r = box.run()
  assert.equal(r.code, 1)
  assert.equal(r.out, "miss node >= 20 — this machine's newest is v18.0.0, Harness's own; update Harness\n")
  assert.deepEqual(box.npmCalls(), [])
})

test('setup: no node on PATH is no miss — Harness\'s own Node and the npm beside it install pdf.js', () => {
  const box = sandbox('setup.sh', { node: 'none', harness: 'real', harnessNpm: 0 })
  installPdfjs(box.dir)
  const r = box.run()
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'ok   pdf.js 9.9.9 (viewer components, modern and legacy builds)\n')
  assert.deepEqual(box.npmCalls(), ['ci --silent --no-audit --no-fund'])
})

test('setup: no npm beside the node is a miss', () => {
  const r = sandbox('setup.sh', { npm: null }).run()
  assert.equal(r.code, 1)
  assert.equal(r.out, `miss npm beside node ${process.version}\n`)
})

test('setup: a failing npm ci stops setup with its exit code', () => {
  const box = sandbox('setup.sh', { npm: 3 })
  const r = box.run()
  assert.equal(r.code, 3)
  assert.equal(r.out, '')
  assert.deepEqual(box.npmCalls(), ['ci --silent --no-audit --no-fund'])
})

test('setup: a pdf.js file missing after npm ci is named', () => {
  const box = sandbox('setup.sh', { npm: 0 })
  installPdfjs(box.dir, { skip: 'legacy/web/pdf_viewer.mjs' })
  const r = box.run()
  assert.equal(r.code, 1)
  assert.equal(r.out, 'miss pdfjs-dist/legacy/web/pdf_viewer.mjs after npm ci\n')
})

test('setup: npm ci from the lockfile, in the package, then the version installed', () => {
  const box = sandbox('setup.sh', { npm: 0 })
  installPdfjs(box.dir)
  const r = box.run()
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'ok   pdf.js 9.9.9 (viewer components, modern and legacy builds)\n')
  assert.deepEqual(box.npmCalls(), ['ci --silent --no-audit --no-fund'])
})

test('doctor: no node, or one older than 20, and no Node of Harness\'s own is a miss', () => {
  for (const node of ['none', 'old']) {
    const box = sandbox('doctor.sh', { node })
    const r = box.run()
    assert.equal(r.code, 1, node)
    assert.equal(r.out, noHarnessNode(box), node)
  }
})

test('doctor: pdf.js not installed says to run setup', () => {
  const box = sandbox('doctor.sh')
  const r = box.run()
  assert.equal(r.code, 1)
  assert.equal(r.out, 'miss node_modules/pdfjs-dist/build/pdf.min.mjs — run ./setup.sh\n')
  installPdfjs(box.dir, { skip: 'web/pdf_viewer.css' })
  assert.equal(box.run().out, 'miss node_modules/pdfjs-dist/web/pdf_viewer.css — run ./setup.sh\n')
})

test('doctor: a reader file missing means the package is incomplete', () => {
  const box = sandbox('doctor.sh')
  installPdfjs(box.dir)
  for (const f of APP_FILES) if (f !== 'app/app.css') put(box.dir, f, '')
  const r = box.run()
  assert.equal(r.code, 1)
  assert.equal(r.out, 'miss app/app.css — the package is incomplete\n')
})

test('doctor: everything there is one ok line, on this machine\'s Node or on Harness\'s own', () => {
  for (const [node, harness] of [['real', null], ['none', 'real']]) {
    const box = sandbox('doctor.sh', { node, harness })
    installPdfjs(box.dir, { version: '6.3.289' })
    for (const f of APP_FILES) put(box.dir, f, '')
    const r = box.run()
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'ok   pdf.js 6.3.289 and the reader\n', node)
  }
})

test('viewer.sh: the port and the workspace are required', () => {
  const box = sandbox('viewer.sh')
  const noPort = box.run({ HARNESS_WORKSPACE: box.root })
  assert.equal(noPort.code, 1)
  assert.match(noPort.err, /HARNESS_VIEWER_PORT/)
  const noWorkspace = box.run({ HARNESS_VIEWER_PORT: '4000' })
  assert.equal(noWorkspace.code, 1)
  assert.match(noWorkspace.err, /HARNESS_WORKSPACE/)
})

test('viewer.sh: runs node on the viewer.mjs beside it, from anywhere', () => {
  const box = sandbox('viewer.sh', { node: 'none' })
  stub(box.bin, 'node', '#!/bin/sh\n[ "$1" = "-e" ] && exit 0\necho "node $*"\n')
  const r = box.run({ HARNESS_VIEWER_PORT: '4000', HARNESS_WORKSPACE: box.root })
  assert.equal(r.code, 0, r.err)
  const [word, file] = r.out.trim().split(' ')
  assert.equal(word, 'node')
  assert.equal(realpathSync(join(file, '..')), realpathSync(box.dir))
  assert.match(file, /\/viewer\.mjs$/)
})

test('viewer.sh: a login shell with no node on PATH runs Harness\'s own; with none at all, a miss and no server', () => {
  const box = sandbox('viewer.sh', { node: 'none', harness: 'real' })
  writeFileSync(join(box.dir, 'viewer.mjs'), 'console.log(`viewer on ${process.execPath}`)\n')
  const env = { HARNESS_VIEWER_PORT: '4000', HARNESS_WORKSPACE: box.root }
  const r = box.run(env)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, `viewer on ${process.execPath}\n`)
  const bare = sandbox('viewer.sh', { node: 'none' })
  const none = bare.run(env)
  assert.equal(none.code, 1)
  assert.equal(none.out, noHarnessNode(bare))
})
