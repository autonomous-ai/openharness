// Start toolchain/viewer.mjs on a workspace the way Harness does, and talk to it over raw HTTP (so a
// path is sent exactly as written, without fetch normalising it first).
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

export const TOOLCHAIN = fileURLToPath(new URL('../..', import.meta.url))
const PRELOAD = new URL('./child.mjs', import.meta.url).href

export const delay = (ms) => new Promise((ok) => setTimeout(ok, ms))

export async function until(check, what, timeout = 5000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await delay(20)
  }
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) })
  })
}

export async function startViewer(workspace) {
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', PRELOAD, `${TOOLCHAIN}viewer.mjs`], {
    env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  await until(() => output.includes('listening on') || child.exitCode !== null, 'the viewer to listen')
  return {
    port,
    output: () => output,
    get: (path, headers = {}) => request(port, path, headers),
    events: () => events(port),
    stop: async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } },
  }
}

function request(port, path, headers) {
  return new Promise((ok, fail) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        ok({ status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], body, json: () => JSON.parse(body) })
      })
    }).on('error', fail)
  })
}

/** An open /events stream: `next(event)` resolves with the next matching block's data. */
function events(port) {
  return new Promise((ok, fail) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let buffer = ''
      const seen = []
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        let i
        while ((i = buffer.indexOf('\n\n')) >= 0) { seen.push(buffer.slice(0, i)); buffer = buffer.slice(i + 2) }
      })
      ok({
        status: res.statusCode,
        type: res.headers['content-type'],
        seen,
        next: (event) => until(() => {
          const at = seen.findIndex((block) => block.startsWith(`event: ${event}\n`))
          if (at < 0) return null
          const [block] = seen.splice(0, at + 1).slice(-1)
          return JSON.parse(block.slice(block.indexOf('data: ') + 6))
        }, `a ${event} event`),
        comment: (text) => until(() => seen.includes(`: ${text}`), `": ${text}"`),
        close: () => req.destroy(),
      })
    })
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') fail(error) })
  })
}
