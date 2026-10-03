#!/usr/bin/env node
/**
 * The sandbox's two small services, in one process (daemons/e2e/sandbox.mjs starts it):
 *
 *   stub SSO   127.0.0.1:<ssoPort>/identity and /profile answer the backend's token check
 *              (backend lib/ssoAuth.ts) for exactly one random token: the sandbox user's. Anything else is 401.
 *   proxy      127.0.0.1:<proxyPort> → the backend, and harnessd's BACKEND_WS_URL. Every HTTP request is
 *              logged (method, path, status); every WebSocket frame on /api/adapter-ws is logged by its
 *              `type` only (never a payload), so a scenario can count `GET /api/zoo`, `zoo.turn` ops and
 *              `zoo_changed` frames per harnessd run. The backend's own port can change under it (a
 *              restart on another build) without harnessd noticing more than a reconnect.
 *
 * Config comes from a JSON file (argv[2]) the sandbox rewrites; `SIGHUP` re-reads it.
 * Log: one JSON object per line in <logDir>/requests.jsonl.
 */
import http from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const configFile = process.argv[2]
if (!configFile) { console.error('usage: services.mjs <config.json>'); process.exit(2) }
let config = JSON.parse(readFileSync(configFile, 'utf8'))
process.on('SIGHUP', () => {
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); log({ kind: 'config', backendPort: config.backendPort }) } catch { /* keep the old one */ }
})

// `ws` from the cli's own dependencies: this folder has none of its own.
const require = createRequire(join(config.repo, 'cli', 'package.json'))
const { WebSocket, WebSocketServer } = require('ws')

const requestsLog = join(config.logDir, 'requests.jsonl')
function log(entry) {
  try { appendFileSync(requestsLog, JSON.stringify({ at: Date.now(), ...entry }) + '\n') } catch { /* best effort */ }
}

// ── stub SSO ─────────────────────────────────────────────────────────────────────────────────────────
const sso = http.createServer((req, res) => {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim()
  const path = (req.url ?? '').split('?')[0]
  const ok = token && token === config.user.token && (path === '/identity' || path === '/profile')
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
  res.end(JSON.stringify(ok
    ? { status: 1, data: { id: config.user.externalId, email: config.user.email } }
    : { status: 0, message: 'invalid token' }))
})
sso.listen(config.ssoPort, '127.0.0.1')

// ── logging proxy ────────────────────────────────────────────────────────────────────────────────────
function target() { return { host: '127.0.0.1', port: config.backendPort } }

const proxy = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const path = (req.url ?? '').split('?')[0]
    // What a zoo op was, by name only: the counting a scenario needs, none of the content.
    let ops
    if (path === '/api/zoo/ops' && body.length) {
      try { ops = (JSON.parse(body.toString('utf8')).ops ?? []).map((op) => op?.op ?? op?.type ?? '?') } catch { ops = ['<bad json>'] }
    }
    const upstream = http.request({ ...target(), method: req.method, path: req.url, headers: req.headers }, (up) => {
      log({ kind: 'http', method: req.method, path, status: up.statusCode, ...(ops ? { ops } : {}) })
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', (err) => {
      log({ kind: 'http', method: req.method, path, status: 502, error: err.message, ...(ops ? { ops } : {}) })
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: { code: 'BACKEND_UNREACHABLE', message: err.message } }))
    })
    upstream.end(body)
  })
})

const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false })
let wsSeq = 0
proxy.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0]
  const conn = ++wsSeq
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  const upstream = new WebSocket(`ws://127.0.0.1:${config.backendPort}${req.url}`, protocols, {
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(sec-websocket-|connection|upgrade|host)/i.test(k))),
  })
  let settled = false
  upstream.on('unexpected-response', (_r, response) => {
    settled = true
    log({ kind: 'ws-refused', path, conn, status: response.statusCode })
    try { socket.end(`HTTP/1.1 ${response.statusCode} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) } catch { /* gone */ }
    response.resume()
  })
  upstream.on('error', (err) => {
    if (settled) return
    settled = true
    log({ kind: 'ws-error', path, conn, error: err.message })
    try { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } catch { /* gone */ }
  })
  upstream.on('open', () => {
    settled = true
    wss.handleUpgrade(req, socket, head, (client) => {
      log({ kind: 'ws-open', path, conn })
      const describe = (data, isBinary) => {
        if (isBinary) return { binary: data.length }
        try {
          const frame = JSON.parse(data.toString('utf8'))
          // adapter-ws wraps what it sends up as { t: 'up', frame: { type } }; down frames are { type }.
          return { t: frame?.t, type: frame?.frame?.type ?? frame?.type }
        } catch { return { text: data.length } }
      }
      client.on('message', (data, isBinary) => {
        log({ kind: 'ws', dir: 'up', path, conn, ...describe(data, isBinary) })
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
      })
      upstream.on('message', (data, isBinary) => {
        log({ kind: 'ws', dir: 'down', path, conn, ...describe(data, isBinary) })
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
      })
      const closeBoth = (who) => (code, reason) => {
        log({ kind: 'ws-close', path, conn, by: who, code })
        const c = typeof code === 'number' && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000
        try { client.close(c, reason) } catch { client.terminate() }
        try { upstream.close(c, reason) } catch { upstream.terminate() }
      }
      client.on('close', closeBoth('harnessd'))
      upstream.on('close', closeBoth('backend'))
      client.on('error', () => upstream.terminate())
    })
  })
})
proxy.listen(config.proxyPort, '127.0.0.1')

log({ kind: 'services', ssoPort: config.ssoPort, proxyPort: config.proxyPort, backendPort: config.backendPort })
