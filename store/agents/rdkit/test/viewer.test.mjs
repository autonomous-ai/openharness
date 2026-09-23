// node --test test/ — the pane's server, run as Harness runs it: a child process on a free loopback port over a
// temp workspace. RDKit is never needed: the Python worker is a fake that speaks the same one-JSON-line
// protocol as `harness_rdkit.py serve`. The worker's 60 s timeout and the SSE ping's 20 s interval are
// shortened by a preload that rewrites exactly those two delays, so their branches run in milliseconds.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { workspaceFileUrl } from '../pane/files.mjs'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const VIEWER = join(PKG, 'viewer.mjs')
const BUNDLE = join(PKG, 'node_modules/3dmol/build/3Dmol-min.js')
const scratch = mkdtempSync(join(tmpdir(), 'rdkit-viewer-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const PRELOAD = join(scratch, 'short-timers.mjs')
writeFileSync(PRELOAD, `
const setTimeoutReal = globalThis.setTimeout, setIntervalReal = globalThis.setInterval
globalThis.setTimeout = (fn, ms, ...rest) => setTimeoutReal(fn, ms === 60_000 ? Number(process.env.TEST_ASK_TIMEOUT_MS) : ms, ...rest)
globalThis.setInterval = (fn, ms, ...rest) => setIntervalReal(fn, ms === 20_000 ? Number(process.env.TEST_PING_MS) : ms, ...rest)
`)

// The fake worker: by the requested file's name it answers, fails, says nothing, never answers, or dies.
const WORKER_LOG = join(scratch, 'worker.log')
const FAKE_PYTHON = join(scratch, 'python')
writeFileSync(FAKE_PYTHON, `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const { basename } = require('node:path')
const log = (line) => appendFileSync(${JSON.stringify(WORKER_LOG)}, line + '\\n')
const send = (reply) => process.stdout.write(JSON.stringify(reply) + '\\n')
log('start ' + process.argv.slice(2).join(' '))
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
    const name = basename(request.path)
    log('ask ' + name)
    if (name.startsWith('slow')) continue
    if (name.startsWith('crash')) process.exit(3)
    if (name.startsWith('fail')) { send({ id: request.id, ok: false, error: 'ValueError: no molecule' }); continue }
    if (name.startsWith('blank')) { send({ id: request.id, ok: false }); continue }
    process.stdout.write('not json\\n')
    send({ id: 99999, ok: true, result: 'nobody asked' })
    process.stderr.write('   \\n')
    setTimeout(() => process.stderr.write('warming up\\n'), 30)
    const text = JSON.stringify({ id: request.id, ok: true, result: { name, computedBy: 'viewer', op: request.op, argv: process.argv.slice(2), pythonpath: process.env.PYTHONPATH } }) + '\\n'
    process.stdout.write(text.slice(0, 12))
    setTimeout(() => process.stdout.write(text.slice(12)), 10)
  }
})
`)
chmodSync(FAKE_PYTHON, 0o755)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha1 = (text) => createHash('sha1').update(text).digest('hex')
const freePort = () => new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})

function put(root, rel, text = '', ageSeconds = 0) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
  if (ageSeconds) { const t = Date.now() / 1000 - ageSeconds; utimesSync(full, t, t) }
  return full
}

// The viewer as Harness runs it. `env` is merged over a clean environment (no HARNESS_ or RDKIT_ variables leak in).
async function viewer({ env = {}, workspace } = {}) {
  const ws = workspace ?? mkdtempSync(join(scratch, 'ws-'))
  const port = await freePort()
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HARNESS_|RDKIT_)/.test(k)))
  const child = spawn(process.execPath, ['--import', PRELOAD, VIEWER], {
    env: { ...clean, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: ws, TEST_ASK_TIMEOUT_MS: '10000', TEST_PING_MS: '60000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  for (let i = 0; !output.includes('listening on') && child.exitCode === null && i < 200; i++) await sleep(20)
  assert.match(output, /\[rdkit\] listening on http:\/\/127\.0\.0\.1:\d+\//)
  return {
    ws, port, child, exited,
    output: () => output,
    get: (path, options) => http(port, path, options),
    json: async (path) => { const r = await http(port, path); return { ...r, body: JSON.parse(r.body) } },
    stop: async (signal = 'SIGTERM') => { if (child.exitCode === null) child.kill(signal); return exited },
  }
}

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** An SSE connection that collects events; `until(predicate)` waits for one. */
function events(port) {
  const seen = []
  let res
  const ready = new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/events' }, (response) => {
      res = response
      response.setEncoding('utf8')
      response.on('data', (chunk) => { seen.push(chunk); resolve() })
    })
    req.end()
  })
  return {
    ready,
    text: () => seen.join(''),
    until: async (predicate, ms = 5000) => {
      for (let t = 0; t < ms; t += 20) { if (predicate(seen.join(''))) return seen.join(''); await sleep(20) }
      assert.fail(`no matching event in: ${seen.join('')}`)
    },
    close: () => res?.destroy(),
  }
}

describe('files', () => {
  let v
  before(async () => { v = await viewer() })
  after(() => v.stop())

  test('the pane, with its types, and HEAD without a body', async () => {
    const page = await v.get('/')
    assert.equal(page.status, 200)
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal((await v.get('/app.css')).headers['content-type'], 'text/css; charset=utf-8')
    const head = await v.get('/app.js', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, '')
    assert.ok(Number(head.headers['content-length']) > 1000)
    assert.equal(head.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal((await v.get('/files.mjs')).headers['content-type'], 'text/javascript; charset=utf-8')
  })

  test('3Dmol.js from this package, cached, and nothing else under /vendor/', async () => {
    const bundle = await v.get('/vendor/3Dmol-min.js', { method: 'HEAD' })
    if (existsSync(BUNDLE)) {
      assert.equal(bundle.status, 200)
      assert.equal(bundle.headers['cache-control'], 'max-age=3600')
    } else {
      assert.equal(bundle.status, 404) // a checkout without npm ci
    }
    assert.equal((await v.get('/vendor/jquery.js')).status, 404)
  })

  test('bond-scan writes require the pane token, same origin and bounded input', async () => {
    const page = await v.get('/')
    const token = page.body.match(/name="torsion-token" content="([a-f0-9]{64})"/)[1]
    const endpoint = '/api/torsion/keep', method = 'POST'
    assert.equal((await v.get(endpoint, { method, body: '{}' })).status, 403)
    assert.equal((await v.get(endpoint, { method, headers: { 'x-torsion-token': token, origin: 'https://outside.example' }, body: '{}' })).status, 403)
    assert.equal((await v.get(endpoint, { method, headers: { 'x-torsion-token': token, host: 'outside.example' }, body: '{}' })).status, 403)
    const headers = { 'x-torsion-token': token, origin: `http://127.0.0.1:${v.port}` }
    assert.equal((await v.get(endpoint, { method, headers, body: '{bad json' })).status, 400)
    assert.equal((await v.get(endpoint, { method, headers, body: '{}' })).status, 400)
    assert.equal((await v.get(endpoint, { method, headers: { ...headers, 'content-length': '262145' }, body: 'x'.repeat(262145) })).status, 413)
    assert.equal((await v.get(endpoint, { method, headers: { ...headers, 'transfer-encoding': 'chunked' }, body: 'x'.repeat(262145) })).status, 413)
    assert.equal((await v.get('/', { method: 'PUT' })).status, 405)
    assert.deepEqual((await v.json('/api/torsions')).body, [])
    assert.equal((await v.get('/torsion-pane.mjs')).headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal((await v.get('/')).status, 200)
  })

  test('workspace files, a download, and nothing outside the workspace', async () => {
    put(v.ws, 'out/x.json', '{"a":1}')
    put(v.ws, 'out/blob.bin', 'b')
    put(v.ws, 'out/a"b.sdf', 'mol')
    const json = await v.get('/out/x.json')
    assert.equal(json.status, 200)
    assert.equal(json.headers['content-type'], 'application/json')
    assert.equal(json.headers['cache-control'], 'no-store')
    assert.equal((await v.get('/out/blob.bin')).headers['content-type'], 'application/octet-stream')
    const download = await v.get('/out/a%22b.sdf?download')
    assert.equal(download.headers['content-disposition'], `attachment; filename="ab.sdf"; filename*=UTF-8''a%22b.sdf`)
    assert.equal(download.headers['content-type'], 'chemical/x-mdl-sdfile')
    assert.equal((await v.get('/out')).status, 404)
    assert.equal((await v.get('/out/missing.sdf')).status, 404)
    const outside = await v.get('/%2e%2e/%2e%2e/etc/hosts')
    assert.deepEqual([outside.status, JSON.parse(outside.body)], [404, { error: 'not found' }])
  })

  test('pane URLs load and download exact filenames containing URL punctuation', async () => {
    for (const name of ['candidate #1', 'candidate ?2', 'candidate %3', 'α "lead" & analogue']) {
      const folder = 'out/series #1'
      for (const extension of ['.sdf', '.conformers.sdf', '.svg']) {
        const path = `${folder}/${name}${extension}`
        const content = `${name}${extension}\nexact workspace bytes`
        put(v.ws, path, content)
        const source = workspaceFileUrl(path, { v: 123 })
        const url = new URL(source, `http://127.0.0.1:${v.port}`)
        assert.equal(url.hash, '')
        assert.equal(url.searchParams.get('v'), '123')
        const loaded = await v.get(url.pathname + url.search)
        assert.equal(loaded.status, 200, path)
        assert.equal(loaded.body, content, path)
        const saved = await v.get(workspaceFileUrl(path, { download: 1 }))
        assert.equal(saved.status, 200, path)
        assert.equal(saved.body, content, path)
        assert.match(saved.headers['content-disposition'], /^attachment;/)
        if (name.startsWith('α')) {
          const encodedName = saved.headers['content-disposition'].split("filename*=UTF-8''")[1]
          assert.equal(decodeURIComponent(encodedName), name + extension)
        }
      }
    }
  })

  test('a malformed URL is an error answer, not a dead pane', async () => {
    const bad = await v.get('/%E0%A4%A')
    assert.equal(bad.status, 500)
    assert.match(JSON.parse(bad.body).error, /URI malformed/)
    const absolute = await new Promise((resolve) => { // an absolute-form target whose host is not a URL's
      const socket = connect(v.port, '127.0.0.1', () => socket.write('GET http://[bad/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
      let text = ''
      socket.on('data', (chunk) => { text += chunk })
      socket.on('close', () => resolve(text))
    })
    assert.match(absolute, /^HTTP\/1\.1 500 .*"error":"Invalid URL"/s)
    assert.equal((await v.get('/')).status, 200)
  })

  test('a file it cannot read is an error answer', { skip: process.getuid?.() === 0 && 'root reads everything' }, async () => {
    chmodSync(put(v.ws, 'out/locked.sdf', 'secret'), 0o000)
    const locked = await v.get('/out/locked.sdf').catch((error) => assert.fail(`${error.message}: ${v.output()}`))
    assert.equal(locked.status, 500)
    assert.match(JSON.parse(locked.body).error, /EACCES/)
    const mol = await v.get('/api/mol?path=out/locked.sdf').catch((error) => assert.fail(`${error.message}: ${v.output()}`))
    assert.equal(mol.status, 500)
    assert.equal((await v.get('/')).status, 200)
  })
})

describe('/api/mol', () => {
  let v
  before(async () => { v = await viewer() })
  after(() => v.stop())

  test('MOL exports retain Unicode and quoted molecule names', async () => {
    const name = 'α "lead" #1'
    put(v.ws, `out/${name}.sdf`, 'molecule\nM  END\n$$$$\n')
    const mol = await v.get('/api/mol?path=' + encodeURIComponent(`out/${name}.sdf`))
    assert.equal(mol.status, 200)
    assert.equal(mol.body, 'molecule\nM  END\n')
    assert.equal(decodeURIComponent(mol.headers['content-disposition'].split("filename*=UTF-8''")[1]), name + '.mol')
  })

  test('the first record as a MOL file, named for the molecule', async () => {
    put(v.ws, 'out/x.conformers.sdf', 'x\n  RDKit\n\n  0  0\nM  END\n> <energy>\n1\n\n$$$$\nsecond\nM  END\n')
    const mol = await v.get('/api/mol?path=out/x.conformers.sdf')
    assert.equal(mol.status, 200)
    assert.equal(mol.body, 'x\n  RDKit\n\n  0  0\nM  END\n')
    assert.equal(mol.headers['content-disposition'], 'attachment; filename="x.mol"')
    put(v.ws, 'out/raw.mol', 'no end marker')
    assert.equal((await v.get('/api/mol?path=out/raw.mol')).body, 'no end marker')
    assert.equal((await v.get('/api/mol?path=out/none.sdf')).status, 404)
    assert.equal((await v.get('/api/mol?path=out')).status, 404)
    assert.equal((await v.get('/api/mol?path=../../etc/hosts')).status, 404)
    assert.equal((await v.get('/api/mol')).status, 404)
  })
})

describe('/api/series', () => {
  test('an empty workspace has no series, no progress and no newest molecule', async () => {
    const v = await viewer()
    try {
      const { status, body } = await v.json('/api/series')
      assert.equal(status, 200)
      assert.deepEqual(body, { dir: 'out', molecules: [], progress: null, newest: null, python: false })
      assert.deepEqual((await v.json('/api/series?dir=../elsewhere')).body.molecules, [])
    } finally { await v.stop() }
  })

  test('series.json in order, then the structures it does not list, each once', async () => {
    const ws = mkdtempSync(join(scratch, 'ws-'))
    const now = new Date().toISOString()
    put(ws, 'out/lead.sdf', 'lead', 30)
    put(ws, 'out/analogue.sdf', 'analogue', 30)
    put(ws, 'out/old.sdf', 'old', 30)
    put(ws, 'out/custom-name.sdf', 'custom', 30)
    put(ws, 'out/undated.sdf', 'undated', 40)
    put(ws, 'out/series.json', JSON.stringify({ molecules: [
      { name: 'undated', properties: { mw: 3 } },
      null, { smiles: 'C' },
      { name: 'lead', createdAt: '2026-01-01T00:00:00Z', updatedAt: now, properties: { mw: 1 } },
      { name: 'analogue', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', properties: { mw: 2 } },
      { name: 'old', createdAt: '2026-01-03T00:00:00Z', updatedAt: now, legacy: true, properties: {} },
      { name: 'custom', sdf: 'custom-name.sdf', createdAt: 'not a date', updatedAt: now },
      { name: 'gone', createdAt: '2026-01-04T00:00:00Z', updatedAt: now, properties: {} },
    ] }))
    put(ws, 'out/lead.pdb', 'same stem as a listed molecule', 10)
    put(ws, 'out/hand.mol', 'hand', 5)
    put(ws, 'out/hand.pdb', 'the same molecule, lower rank', 5)
    put(ws, 'out/scaffold.mol2', 'scaffold', 1)
    put(ws, 'out/hand.conformers.sdf', 'ensemble')
    put(ws, 'out/.hidden.sdf', 'hidden')
    put(ws, 'out/notes.txt', 'notes')
    mkdirSync(join(ws, 'out/folder.pdb'))
    const v = await viewer({ workspace: ws, env: { RDKIT_PYTHON: FAKE_PYTHON } })
    try {
      const { body } = await v.json('/api/series?dir=out')
      // Ordered by createdAt, or the file's time when that is not a date; listed first only by date.
      assert.deepEqual(body.molecules.map((m) => [m.name, m.sdf, m.stale, m.legacy]), [
        ['lead', 'out/lead.sdf', false, false],
        ['analogue', 'out/analogue.sdf', true, false], // written before its SDF last changed
        ['old', 'out/old.sdf', true, true],
        ['undated', 'out/undated.sdf', true, false], // no updatedAt: nothing says the record is this file's
        ['custom', 'out/custom-name.sdf', false, true], // no properties: an entry from before they were recorded
        ['hand', 'out/hand.mol', undefined, true], // .mol outranks .pdb for the same stem
        ['scaffold', 'out/scaffold.mol2', undefined, true],
      ])
      assert.equal(body.python, true)
      assert.equal(body.newest, 'out/scaffold.mol2')
    } finally { await v.stop() }
  })

  test('a folder it may enter but not list still shows what series.json names', { skip: process.getuid?.() === 0 && 'root lists everything' }, async () => {
    const ws = mkdtempSync(join(scratch, 'ws-'))
    put(ws, 'locked/a.sdf', 'a')
    put(ws, 'locked/b.sdf', 'b')
    put(ws, 'locked/series.json', JSON.stringify({ molecules: [{ name: 'a', updatedAt: new Date().toISOString(), properties: {} }] }))
    chmodSync(join(ws, 'locked'), 0o311)
    const v = await viewer({ workspace: ws })
    try {
      assert.deepEqual((await v.json('/api/series?dir=locked')).body.molecules.map((m) => m.name), ['a'])
    } finally { await v.stop(); chmodSync(join(ws, 'locked'), 0o755) }
  })

  test('the newest structure anywhere near the top, skipping what is not the agent\'s', async () => {
    const ws = mkdtempSync(join(scratch, 'ws-'))
    put(ws, 'out/a.sdf', 'a', 100)
    put(ws, 'deep/1/2/3/b.pdb', 'b', 50)
    put(ws, 'deep/1/2/3/4/5/too-deep.sdf', 'deep')
    put(ws, 'molecules/script-output.sdf', 'not an artifact')
    put(ws, 'node_modules/pkg/test.sdf', 'no')
    put(ws, '.cache/x.sdf', 'no')
    put(ws, 'out/b.conformers.sdf', 'ensemble')
    put(ws, 'out/readme.md', 'text')
    symlinkSync(join(ws, 'nowhere.sdf'), join(ws, 'out/broken.sdf'))
    mkdirSync(join(ws, 'closed'))
    chmodSync(join(ws, 'closed'), 0o000)
    const v = await viewer({ workspace: ws })
    try {
      const { body } = await v.json('/api/series')
      assert.equal(body.newest, 'deep/1/2/3/b.pdb')
      assert.equal(body.dir, 'deep/1/2/3')
      assert.deepEqual(body.molecules.map((m) => m.name), ['b'])
    } finally { await v.stop(); chmodSync(join(ws, 'closed'), 0o755) }
  })

  test('progress: finished, running, and a run that died or went quiet', async () => {
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise((resolve) => dead.on('exit', resolve))
    const v = await viewer()
    const progress = async (record, dir) => {
      put(v.ws, `${dir ?? 'out'}/.progress.json`, JSON.stringify(record))
      return (await v.json(`/api/series${dir ? `?dir=${dir}` : '?dir=out'}`)).body.progress
    }
    const at = Date.now() / 1000
    try {
      assert.equal((await progress({ stage: 'done', pid: dead.pid, at: 0 })).stage, 'done')
      assert.equal((await progress({ stage: 'failed', at: 0 })).stage, 'failed')
      assert.equal((await progress({ stage: 'embedding', pid: process.pid, at })).stage, 'embedding')
      assert.equal((await progress({ stage: 'embedding', pid: dead.pid, at })).stage, 'stopped')
      assert.equal((await progress({ stage: 'writing', at })).stage, 'writing')
      assert.equal((await progress({ stage: 'writing', pid: process.pid })).stage, 'stopped') // no timestamp: long gone
      assert.equal((await progress({ stage: 'embedding', pid: 1, at }, 'series2')).stage, 'embedding') // not ours to signal, but alive
      put(v.ws, 'out/.progress.json', '{torn')
      assert.equal((await v.json('/api/series?dir=out')).body.progress, null)
    } finally { await v.stop() }
  })
})

describe('/api/molecule', () => {
  test('the toolchain\'s record when it is this SDF\'s, with its depiction', async () => {
    const v = await viewer()
    try {
      put(v.ws, 'out/a.sdf', 'A-sdf')
      put(v.ws, 'out/a.conformers.sdf', 'A-ensemble')
      put(v.ws, 'out/drawn.svg', '<svg/>')
      put(v.ws, 'out/a.molecule.json', JSON.stringify({ spec: 'rdkit-molecule/1', name: 'a', svg: 'drawn.svg', sdfSha1: sha1('A-sdf') }))
      const { status, body } = await v.json('/api/molecule?path=out/a.sdf')
      assert.equal(status, 200)
      assert.deepEqual([body.name, body.svgText, body.computedBy], ['a', '<svg/>', 'toolchain'])
      assert.equal((await v.json('/api/molecule?path=out/a.conformers.sdf')).body.computedBy, 'toolchain') // hashed against a.sdf
      put(v.ws, 'out/b.pdb', 'B-pdb')
      put(v.ws, 'out/b.molecule.json', JSON.stringify({ spec: 'rdkit-molecule/1', name: 'b', sdfSha1: sha1('B-pdb') }))
      const b = await v.json('/api/molecule?path=out/b.pdb')
      assert.deepEqual([b.body.computedBy, b.body.svgText], ['toolchain', undefined]) // no b.svg: the depiction is optional
      put(v.ws, 'out/c.mol', 'C')
      put(v.ws, 'out/c.molecule.json', JSON.stringify({ spec: 'rdkit-molecule/1', name: 'c' }))
      assert.equal((await v.json('/api/molecule?path=out/c.mol')).body.computedBy, 'toolchain') // no hash to check
    } finally { await v.stop() }
  })

  test('what is not a structure in the workspace is not found', async () => {
    const v = await viewer()
    try {
      put(v.ws, 'out/notes.txt', 'text')
      for (const path of ['out/none.sdf', 'out', 'out/notes.txt', '../../etc/hosts', '']) {
        const { status, body } = await v.json(`/api/molecule?path=${path}`)
        assert.equal(status, 404, path)
        assert.match(body.error, /is not there/)
      }
    } finally { await v.stop() }
  })

  test('without a Python for RDKit the pane says how to get one', { skip: existsSync(join(PKG, '.venv/bin/python')) && 'this package has its own .venv' }, async () => {
    const v = await viewer()
    try {
      put(v.ws, 'out/x.sdf', 'x')
      const { status, body } = await v.json('/api/molecule?path=out/x.sdf')
      assert.deepEqual([status, body.error], [422, 'RDKit is not installed for the pane (run toolchain/setup.sh)'])
    } finally { await v.stop() }
  })

  test('the worker describes a stale or foreign SDF, once per version of the file', async () => {
    writeFileSync(WORKER_LOG, '')
    const dsh = mkdtempSync(join(scratch, 'dsh-'))
    mkdirSync(join(dsh, '.venv/bin'), { recursive: true })
    symlinkSync(FAKE_PYTHON, join(dsh, '.venv/bin/python'))
    const v = await viewer({ env: { HARNESS_DSH_DIR: dsh } })
    try {
      put(v.ws, 'out/hand.sdf', 'hand')
      put(v.ws, 'out/hand.molecule.json', JSON.stringify({ spec: 'rdkit-molecule/1', name: 'hand', sdfSha1: 'an older sdf' }))
      const first = await v.json('/api/molecule?path=out/hand.sdf')
      assert.equal(first.status, 200, JSON.stringify(first.body))
      assert.deepEqual([first.body.name, first.body.computedBy, first.body.op], ['hand.sdf', 'viewer', 'describe'])
      assert.deepEqual(first.body.argv, ['-u', join(PKG, 'toolchain/harness_rdkit.py'), 'serve'])
      assert.equal(first.body.pythonpath, join(PKG, 'toolchain'))
      assert.equal((await v.json('/api/molecule?path=out/hand.sdf')).body.name, 'hand.sdf')
      put(v.ws, 'out/hand.sdf', 'hand, edited')
      put(v.ws, 'out/other.molecule.json', '{"spec": "something else"}')
      put(v.ws, 'out/other.sdf', 'other')
      await v.json('/api/molecule?path=out/hand.sdf')
      await v.json('/api/molecule?path=out/other.sdf')
      await sleep(100)
      assert.deepEqual((await import('node:fs')).readFileSync(WORKER_LOG, 'utf8').trim().split('\n'),
        [`start -u ${join(PKG, 'toolchain/harness_rdkit.py')} serve`, 'ask hand.sdf', 'ask hand.sdf', 'ask other.sdf'])
      assert.match(v.output(), /\[rdkit\] worker: warming up/)
    } finally { await v.stop() }
  })

  test('a failure is reported and not cached; a dead worker is replaced; a silent one times out', async () => {
    writeFileSync(WORKER_LOG, '')
    const v = await viewer({ env: { RDKIT_PYTHON: FAKE_PYTHON, TEST_ASK_TIMEOUT_MS: '1500' } })
    const ask = (path) => v.json(`/api/molecule?path=${path}`)
    try {
      for (const name of ['fail.sdf', 'blank.sdf', 'crash.sdf', 'crash2.sdf', 'slow.sdf', 'fine.sdf']) put(v.ws, `out/${name}`, name)
      assert.deepEqual(await ask('out/fail.sdf').then((r) => [r.status, r.body.error]), [422, 'ValueError: no molecule'])
      assert.deepEqual(await ask('out/fail.sdf').then((r) => [r.status, r.body.error]), [422, 'ValueError: no molecule'])
      assert.deepEqual(await ask('out/blank.sdf').then((r) => [r.status, r.body.error]), [422, 'describe failed'])
      assert.deepEqual(await ask('out/crash.sdf').then((r) => [r.status, r.body.error]), [422, 'the RDKit worker stopped'])
      assert.equal((await ask('out/fine.sdf')).status, 200) // a new worker
      assert.deepEqual(await ask('out/slow.sdf').then((r) => [r.status, r.body.error]), [422, 'RDKit took longer than 60 s'])
      // A request the file changed under: the newer one owns the cache, the older one's failure leaves it be.
      const older = ask('out/slow.sdf')
      await sleep(50)
      put(v.ws, 'out/slow.sdf', 'slow, edited')
      const newer = ask('out/slow.sdf')
      assert.deepEqual((await Promise.all([older, newer])).map((r) => r.status), [422, 422])
      const log = (await import('node:fs')).readFileSync(WORKER_LOG, 'utf8').trim().split('\n')
      assert.equal(log.filter((line) => line === 'ask fail.sdf').length, 2)
      assert.equal(log.filter((line) => line.startsWith('start')).length, 2)
    } finally { await v.stop() }
  })

  test('an SDF it cannot read is described afresh, not matched to a record', { skip: process.getuid?.() === 0 && 'root reads everything' }, async () => {
    const v = await viewer({ env: { RDKIT_PYTHON: FAKE_PYTHON } })
    try {
      chmodSync(put(v.ws, 'out/locked.sdf', 'locked'), 0o000)
      put(v.ws, 'out/locked.molecule.json', JSON.stringify({ spec: 'rdkit-molecule/1', name: 'locked', sdfSha1: sha1('locked') }))
      const { status, body } = await v.json('/api/molecule?path=out/locked.sdf')
      assert.deepEqual([status, body.computedBy], [200, 'viewer'])
    } finally { await v.stop() }
  })

  test('a Python that cannot be started is an answer, not a dead pane', async () => {
    const notExecutable = put(scratch, 'not-executable-python', 'x')
    chmodSync(notExecutable, 0o644)
    const v = await viewer({ env: { RDKIT_PYTHON: notExecutable } })
    try {
      put(v.ws, 'out/x.sdf', 'x')
      put(v.ws, 'out/y.sdf', 'y')
      assert.deepEqual(await v.json('/api/molecule?path=out/x.sdf').then((r) => [r.status, r.body.error]), [422, 'the RDKit worker stopped'])
      assert.deepEqual(await v.json('/api/molecule?path=out/y.sdf').then((r) => [r.status, r.body.error]), [422, 'the RDKit worker stopped'])
      assert.equal(v.child.exitCode, null)
    } finally { await v.stop() }
  })
})

describe('live', () => {
  test('changes are batched, noise is ignored, progress is pushed, and clients are pinged', async () => {
    const v = await viewer({ env: { TEST_PING_MS: '100' } })
    const stream = events(v.port)
    try {
      await stream.ready
      assert.match(stream.text(), /^: hello/)
      await sleep(300) // let the watcher settle on the fresh workspace
      put(v.ws, '.harness/verdict.json', '{}')
      put(v.ws, 'node_modules/x.js', '')
      put(v.ws, '__pycache__/x.pyc', '')
      put(v.ws, 'out/.x.sdf.123.tmp', '')
      put(v.ws, 'out/one.sdf', '1')
      await sleep(40)
      put(v.ws, 'out/two.sdf', '2')
      const change = await stream.until((text) => /event: change\ndata: .*two\.sdf/.test(text))
      const files = JSON.parse(change.match(/event: change\ndata: (.*)\n/)[1]).files
      assert.ok(files.includes('out/one.sdf') && files.includes('out/two.sdf'), files.join(','))
      assert.ok(!files.some((f) => /harness|node_modules|pycache|\.tmp$/.test(f)), files.join(','))
      put(v.ws, 'out/.progress.json', JSON.stringify({ stage: 'done', name: 'x' }))
      const pushed = await stream.until((text) => text.includes('event: progress'))
      assert.match(pushed, /event: progress\ndata: {"dir":"out","progress":{"stage":"done","name":"x"}}/)
      await stream.until((text) => text.includes(': ping'))
    } finally { stream.close(); await sleep(50); await v.stop() }
  })

  test('a workspace it cannot watch still serves', async () => {
    const v = await viewer({ workspace: join(scratch, 'does-not-exist') })
    try {
      assert.match(v.output(), /\[rdkit\] watch failed: /)
      assert.equal((await v.json('/api/series')).body.newest, null)
    } finally { await v.stop() }
  })

  test('SIGTERM and SIGINT stop it cleanly, with its worker', async () => {
    writeFileSync(WORKER_LOG, '')
    const v = await viewer({ env: { RDKIT_PYTHON: FAKE_PYTHON } })
    put(v.ws, 'out/fine.sdf', 'fine')
    assert.equal((await v.json('/api/molecule?path=out/fine.sdf')).status, 200)
    assert.deepEqual(await v.stop('SIGTERM'), { code: 0, signal: null })
    const w = await viewer()
    assert.deepEqual(await w.stop('SIGINT'), { code: 0, signal: null })
  })
})
