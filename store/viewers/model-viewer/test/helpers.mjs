// What the tests share: the server started the way Harness starts it, raw HTTP (fetch would tidy the
// paths a sandbox test needs to send as they are), and a reader for the server-sent events.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const packageDir = join(here, '..')
const preload = pathToFileURL(join(here, 'preload.mjs')).href

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
  })
}

/** A scratch workspace; `put` writes a file (making its folders), `done` removes it all. */
export function scratch(prefix = 'model-viewer-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const put = (rel, body = '') => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body) }
  return { dir, put, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * viewer.mjs on `workspace`, with test/preload.mjs loaded. `env` is merged into this process's
 * environment (so NODE_V8_COVERAGE reaches the child); a key set to undefined is removed.
 * `stop()` sends SIGTERM and waits for the exit, which is when V8 writes the child's coverage.
 */
export async function startViewer({ workspace, env = {}, cwd } = {}) {
  const port = await freePort()
  const merged = { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace, ...env }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  const child = spawn(process.execPath, ['--import', preload, join(packageDir, 'viewer.mjs')], { env: merged, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the viewer did not start: ${stderr}`)), 15_000)
    child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('listening')) { clearTimeout(timer); resolve() } })
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`the viewer exited ${code}: ${stderr}`)) })
  })
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    child,
    exited,
    output: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      return exited
    },
  }
}

/** One request with the path exactly as given. Resolves { status, headers, body } or { error }. */
export function raw(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', (error) => resolve({ error: error.code ?? error.message }))
    req.end()
  })
}

/** Bytes straight onto the socket: what came back, up to the first line. */
export function socket(port, text) {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1', () => s.write(text))
    let out = ''
    s.on('data', (d) => { out += d; if (out.includes('\r\n\r\n')) s.end() })
    s.on('error', () => {})
    s.on('close', () => resolve(out.split('\r\n')[0]))
  })
}

/** The SSE stream at `path`: every event as { event, data, comment }, and `until` to wait for one. */
export function events(port, path = '/events') {
  const list = []
  const wake = new Set()
  let buffer = ''
  let ended = false
  const req = request({ host: '127.0.0.1', port, path }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      let cut
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const item = { event: null, data: null, comment: null }
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) item.comment = line.slice(1).trim()
          else if (line.startsWith('event: ')) item.event = line.slice(7)
          else if (line.startsWith('data: ')) item.data = JSON.parse(line.slice(6))
        }
        list.push(item)
      }
      for (const fn of wake) fn()
    })
    res.on('end', () => { ended = true; for (const fn of wake) fn() })
  })
  req.on('error', () => { ended = true; for (const fn of wake) fn() })
  req.end()
  return {
    list,
    get ended() { return ended },
    /** The first item at index >= `from` passing `predicate`; fails after `ms`. */
    async until(predicate, { from = 0, ms = 10_000, what = 'an event' } = {}) {
      const deadline = Date.now() + ms
      for (;;) {
        const index = list.findIndex((item, i) => i >= from && predicate(item))
        if (index >= 0) return { item: list[index], index }
        const left = deadline - Date.now()
        assert.ok(left > 0, `timed out waiting for ${what}`)
        await new Promise((resolve) => { const done = () => { wake.delete(done); clearTimeout(t); resolve() }; const t = setTimeout(done, left); wake.add(done) })
      }
    },
    close() { req.destroy() },
  }
}

/** Is a state event (`item.event === 'state'`) whose data passes `predicate`. */
export const stateWhere = (predicate) => (item) => item.event === 'state' && predicate(item.data)
