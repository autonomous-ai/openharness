// What the node:test files share: a free port, the viewer started the way Harness starts it (or with
// the test preload), plain HTTP requests that fetch would normalise, and an event-stream reader.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
export const VIEWER = join(PACKAGE, 'viewer.mjs')
const PRELOAD = pathToFileURL(join(PACKAGE, 'test', 'preload.mjs')).href

export const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})

export function write(path, body = '', mtimeMs) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  if (mtimeMs) touch(path, mtimeMs)
  return path
}

export const touch = (path, mtimeMs) => utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)

/**
 * rmSync, after giving back the permissions a test took away — to real files and directories only.
 * A symbolic link is never followed: in a scratch bin it points at a real tool (node itself).
 */
export function removeTree(root) {
  const restore = (path) => {
    let st
    try { st = lstatSync(path) } catch { return }
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      chmodSync(path, 0o755)
      for (const name of readdirSync(path)) restore(join(path, name))
    } else if (st.isFile()) {
      chmodSync(path, 0o644)
    }
  }
  restore(root)
  rmSync(root, { recursive: true, force: true })
}

/**
 * The viewer on a free port. `via: 'sh'` runs viewer.sh, as Harness does; otherwise node runs
 * viewer.mjs with the test preload. `env` values of null remove the variable.
 */
export async function startViewer({ env = {}, via = 'node' } = {}) {
  const port = await freePort()
  const merged = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HARNESS_VIEWER_PORT: String(port) }
  for (const key of ['HARNESS_DSH_DIR', 'MENAGERIE', 'TEST_TIMERS', 'TEST_WATCH']) delete merged[key]
  for (const [key, value] of Object.entries(env)) { if (value === null) delete merged[key]; else merged[key] = value }
  const child = via === 'sh'
    ? spawn(join(PACKAGE, 'viewer.sh'), [], { env: merged, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, ['--import', PRELOAD, VIEWER], { env: merged, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the viewer did not start:\n${out}`)), 15_000)
    // Ready once the last of the three start-up lines is out.
    child.stdout.on('data', () => { if (/\[mujoco-viewer\] menagerie: .*\n/.test(out)) { clearTimeout(timer); resolve() } })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the viewer exited ${code}:\n${out}`)) })
  })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    port,
    child,
    output: () => out,
    /** SIGTERM, as Harness stops a pane; resolves with how it exited. */
    stop: async (signal = 'SIGTERM') => { child.kill(signal); return exited },
    get: (path, headers = {}, method = 'GET') => get(port, path, headers, method),
    json: async (path) => JSON.parse((await get(port, path)).body.toString()),
    events: (path = '/api/events') => events(port, path),
    raw: (text) => raw(port, text),
  }
}

export function get(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers, method }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Bytes straight onto the socket: a request line no HTTP client would send. Resolves with the status line. */
export function raw(port, text) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text))
    let answer = ''
    socket.on('data', (d) => { answer += d; if (answer.includes('\r\n')) socket.destroy() })
    socket.on('close', () => resolve(answer.split('\r\n')[0]))
    socket.on('error', () => resolve(answer.split('\r\n')[0]))
  })
}

/** An open event stream: `until(predicate, ms)` resolves with the first block the predicate accepts, or null. */
export function events(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let buffer = ''
      const blocks = []
      const waiters = new Set()
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        const parts = buffer.split('\n\n')
        buffer = parts.pop()
        for (const block of parts) {
          blocks.push(block)
          for (const w of waiters) if (w.predicate(block)) { waiters.delete(w); w.resolve(block) }
        }
      })
      res.on('error', () => {})
      resolve({
        status: res.statusCode,
        headers: res.headers,
        blocks,
        ended: new Promise((done) => res.on('close', done)),
        until: (predicate, ms = 8000) => new Promise((done) => {
          const hit = blocks.find(predicate)
          if (hit) return done(hit)
          const w = { predicate, resolve: done }
          waiters.add(w)
          setTimeout(() => { if (waiters.delete(w)) done(null) }, ms)
        }),
        close: () => req.destroy(),
      })
    })
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error) })
    req.end()
  })
}

/** `event: change` blocks → the paths they name. */
export const changedPaths = (block) => {
  const m = /^event: change\ndata: (.*)$/m.exec(block)
  return m ? JSON.parse(m[1]).paths : null
}

export { assert }
