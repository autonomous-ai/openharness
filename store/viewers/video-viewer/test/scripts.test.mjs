// The shell scripts Harness runs, on a PATH that holds only what each one needs: doctor.sh says whether
// this machine has a Node that can run the viewer; viewer.sh insists on the port and the workspace, then
// runs the viewer.mjs that sits beside it, whatever the working directory. Both find Node through
// runtimes.sh: this machine's, or Harness's own under HOME (~/.harness/runtime/current-node) — the Node a
// fresh Mac, with none on PATH, gets.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { PACKAGE } from './media.mjs'

const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
// A bash line tracer's hooks (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT), passed through when set.
const TRACER = Object.fromEntries(['BASH_ENV', 'SHCOV_OUT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
const OLD_NODE = '#!/bin/sh\n# Node 16: the version check fails\n[ "$1" = "-e" ] && exit 1\necho v16.20.2\n'

/** A bin folder with the named system tools linked in, and `extra` scripts written as executables. */
function bin(tools, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'video-viewer-bin-'))
  roots.push(root)
  for (const tool of tools) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    assert.ok(found, `${tool} is on this machine`)
    symlinkSync(found, join(root, tool))
  }
  for (const [name, body] of Object.entries(extra)) {
    rmSync(join(root, name), { force: true }) // never write through a link to a real command
    if (body === 'real-node') { symlinkSync(process.execPath, join(root, name)); continue }
    writeFileSync(join(root, name), body)
    chmodSync(join(root, name), 0o755)
  }
  return root
}

/** A HOME, with Harness's own Node laid down in it when `node` is given ('real-node' or a script). */
function home(node) {
  const root = mkdtempSync(join(tmpdir(), 'video-viewer-home-'))
  roots.push(root)
  if (node) {
    const harnessBin = bin([], { node })
    mkdirSync(join(root, '.harness', 'runtime'), { recursive: true })
    writeFileSync(join(root, '.harness', 'runtime', 'current-node'), join(harnessBin, 'node'))
  }
  return root
}

const run = (script, { path, env = {}, cwd = tmpdir(), homeDir = home() }) => {
  const r = spawnSync(script, { cwd, env: { PATH: path, HOME: homeDir, ...TRACER, ...env }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const TOOLS = ['bash', 'dirname', 'cat']
const noHarnessNode = (homeDir) => `miss node >= 18, and Harness's own Node is not in ${homeDir}/.harness/runtime — run \`harness start\` once to lay it down\n`

test('doctor.sh: ok with Node 18 or newer, this machine\'s or Harness\'s own; a miss without one', () => {
  const doctor = join(PACKAGE, 'doctor.sh')
  const ok = run(doctor, { path: bin(TOOLS, { node: 'real-node' }) })
  assert.deepEqual(ok, { code: 0, out: `ok   node ${process.version}\n`, err: '' })
  const harnessOwn = run(doctor, { path: bin(TOOLS), homeDir: home('real-node') })
  assert.deepEqual(harnessOwn, { code: 0, out: `ok   node ${process.version}\n`, err: '' })
  const bareHome = home()
  const old = run(doctor, { path: bin(TOOLS, { node: OLD_NODE }), homeDir: bareHome })
  assert.deepEqual(old, { code: 1, out: noHarnessNode(bareHome), err: '' })
  const none = run(doctor, { path: bin(TOOLS), homeDir: bareHome })
  assert.deepEqual(none, { code: 1, out: noHarnessNode(bareHome), err: '' })
  const bothOld = run(doctor, { path: bin(TOOLS, { node: OLD_NODE }), homeDir: home(OLD_NODE) })
  assert.deepEqual(bothOld, { code: 1, out: "miss node >= 18 — this machine's newest is v16.20.2, Harness's own; update Harness\n", err: '' })
})

test('viewer.sh: the port and the workspace are required; then the viewer beside the script runs', () => {
  const pkg = mkdtempSync(join(tmpdir(), 'video-viewer-pkg-'))
  roots.push(pkg)
  // Linked, not copied: a line tracer maps back to them.
  for (const name of ['viewer.sh', 'runtimes.sh']) symlinkSync(join(PACKAGE, name), join(pkg, name))
  writeFileSync(join(pkg, 'viewer.mjs'), "console.log(`viewer ${process.env.HARNESS_VIEWER_PORT} ${process.env.HARNESS_WORKSPACE}`)\n")
  const path = bin(TOOLS, { node: 'real-node' })
  const script = join(pkg, 'viewer.sh')

  const noPort = run(script, { path, env: { HARNESS_WORKSPACE: '/Users/example/ws' } })
  assert.equal(noPort.code, 1)
  assert.match(noPort.err, /HARNESS_VIEWER_PORT/)
  const noWorkspace = run(script, { path, env: { HARNESS_VIEWER_PORT: '4100' } })
  assert.equal(noWorkspace.code, 1)
  assert.match(noWorkspace.err, /HARNESS_WORKSPACE/)
  assert.equal(noWorkspace.out, '')

  const elsewhere = mkdtempSync(join(tmpdir(), 'video-viewer-cwd-'))
  roots.push(elsewhere)
  mkdirSync(join(elsewhere, 'sub'))
  const started = run(script, { path, cwd: join(elsewhere, 'sub'), env: { HARNESS_VIEWER_PORT: '4100', HARNESS_WORKSPACE: '/Users/example/ws' } })
  assert.deepEqual(started, { code: 0, out: 'viewer 4100 /Users/example/ws\n', err: '' })

  // The daemon's login shell may have no node on PATH: Harness's own runs the viewer; with none at all, a miss.
  const env = { HARNESS_VIEWER_PORT: '4100', HARNESS_WORKSPACE: '/Users/example/ws' }
  const onHarnessNode = run(script, { path: bin(TOOLS), homeDir: home('real-node'), env })
  assert.deepEqual(onHarnessNode, { code: 0, out: 'viewer 4100 /Users/example/ws\n', err: '' })
  const bareHome = home()
  const noNode = run(script, { path: bin(TOOLS), homeDir: bareHome, env })
  assert.deepEqual(noNode, { code: 1, out: noHarnessNode(bareHome), err: '' })
})
