// What the server tests share: a scratch workspace, the viewer started the way Harness starts it (a
// real process on a free loopback port), raw HTTP for what fetch will not send, and an SSE reader.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const pkg = join(here, '..')

const roots = []
/** A temp directory with `files` ({ rel: body | { body, at } }) written into it; removed by cleanup(). */
export function scratch(files = {}, prefix = 'doc-viewer-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  for (const [rel, spec] of Object.entries(files)) put(root, rel, spec)
  return root
}
export function put(root, rel, spec = '') {
  const { body = '', at } = typeof spec === 'object' && !Buffer.isBuffer(spec) ? spec : { body: spec }
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
  if (at) utimesSync(full, at, at)
  return full
}
export function cleanup() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `check()` is truthy; its value, or a failure naming `what`. */
export async function until(check, what, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

export const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})

/**
 * viewer.mjs on a free port with the test preload. `env` values of undefined are removed from the
 * environment. Retries on a port another process took between the probe and the listen.
 */
export async function startViewer(workspace, env = {}) {
  for (let attempt = 0; ; attempt++) {
    const port = await freePort()
    const merged = { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace, ...env }
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
    const child = spawn(process.execPath, ['--import', join(here, 'preload.mjs'), join(pkg, 'viewer.mjs')], { env: merged, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const exited = once(child, 'exit')
    const started = await Promise.race([until(() => out.includes('listening'), 'the viewer to listen', 15_000).then(() => true), exited.then(() => false)])
    if (!started) {
      if (attempt < 3 && err.includes('EADDRINUSE')) continue
      throw new Error(`viewer exited before listening: ${err}`)
    }
    return {
      port,
      base: `http://127.0.0.1:${port}`,
      child,
      output: () => out,
      errors: () => err,
      alive: () => child.exitCode === null && child.signalCode === null,
      /** SIGTERM, and wait for the exit (so V8 writes its coverage). */
      async stop() {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited }
        return child.exitCode
      },
    }
  }
}

/** A request fetch would refuse or normalise: any path, headers (Host included), method and body. */
export function raw(port, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Bytes straight onto a socket; the first line of whatever comes back ('' when the server closes). */
export function socket(port, bytes, { holdMs = 0 } = {}) {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1', () => {
      s.write(bytes)
      if (holdMs) setTimeout(() => s.destroy(), holdMs)
    })
    let out = ''
    s.on('data', (d) => { out += d })
    s.on('close', () => resolve(out.split('\r\n')[0]))
    s.on('error', () => {})
  })
}

/** An open /events stream: `next(predicate)` resolves with the first block it accepts. */
export async function openEvents(base, path) {
  const controller = new AbortController()
  const response = await fetch(base + path, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pending = null
  let ended = false
  const blocks = []
  const pump = async (ms) => {
    pending ??= reader.read().catch(() => ({ done: true }))
    const result = await Promise.race([pending, sleep(ms).then(() => null)])
    if (!result) return
    pending = null
    if (result.done) { ended = true; return }
    buffer += decoder.decode(result.value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop()
    blocks.push(...parts)
  }
  return {
    response,
    get ended() { return ended },
    async next(predicate, what = 'an event', ms = 10_000) {
      const deadline = Date.now() + ms
      for (;;) {
        const i = blocks.findIndex(predicate)
        if (i >= 0) return blocks.splice(0, i + 1).pop()
        blocks.length = 0
        if (ended) throw new Error(`stream ended before ${what}`)
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await pump(100)
      }
    },
    /** Resolves true once the server ends the stream. */
    async end(ms = 10_000) {
      const deadline = Date.now() + ms
      while (!ended && Date.now() < deadline) await pump(100)
      return ended
    },
    close() { controller.abort() },
  }
}

/** The state carried by an `event: state` block, or null. */
export function stateOf(block) {
  if (!block.startsWith('event: state\n')) return null
  return JSON.parse(block.slice(block.indexOf('data: ') + 6))
}
