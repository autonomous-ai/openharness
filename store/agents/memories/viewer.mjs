/**
 * The Memories pane: a loopback server that reads every agent's memory and the session index, and
 * serves one page to browse them. It never writes anything an agent owns and needs no model: opening
 * the pane sends no prompt. The only file it writes is the pane header's verdict.
 *
 * While a pane is connected it looks again every few seconds and pushes a new snapshot when anything
 * changed — an agent saved a memory, the About You was rebuilt, you finished a turn somewhere.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homes } from './lib/agents.mjs'
import { search } from './lib/sessions.mjs'
import { closeIndex, fingerprint, sessionIndex, snapshot as takeSnapshot, writeVerdict } from './lib/state.mjs'

const PACKAGE = dirname(fileURLToPath(import.meta.url))
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
  '/fuzzy.js': ['fuzzy.js', 'text/javascript; charset=utf-8'],
  '/heatmap.js': ['heatmap.js', 'text/javascript; charset=utf-8'],
}
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'not', 'but', 'use', 'when', 'what', 'how', 'why', 'all', 'any', 'one', 'its', 'has', 'have', 'was', 'were', 'out', 'new', 'via', 'per'])

export function createViewer({ workspace, port = 0, intervalMs = 4000, env = process.env, home, now = () => Date.now(), snapshot = takeSnapshot } = {}) {
  const clients = new Set()
  let current = null
  let printed = ''
  let stopped = false
  let timer = null
  let heartbeat = null
  let looking = null

  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
  const json = (res, code, value) => { res.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }

  const publish = () => {
    const body = `event: snapshot\ndata: ${JSON.stringify(current)}\n\n`
    for (const client of clients) {
      if (client.writableLength > 8 * 1024 * 1024) { client.destroy(); clients.delete(client) } else client.write(body)
    }
  }

  async function look() {
    if (looking) return looking
    looking = (async () => {
      try {
        const next = await snapshot({ env, home, now: now() })
        const print = fingerprint(next)
        const changed = print !== printed
        current = next
        printed = print
        if (workspace) { try { writeVerdict(workspace, next) } catch { /* the header is a courtesy; the pane still works */ } }
        if (changed) publish()
      } catch (error) {
        current = { ...(current ?? { spec: 1, memories: [], agents: [], projects: [] }), problems: [{ agent: 'viewer', error: error instanceof Error ? error.message : String(error) }] }
      }
    })()
    try { await looking } finally { looking = null }
    return current
  }

  // Looks again only while a pane is open: a viewer nobody is watching reads nothing.
  const schedule = () => {
    clearTimeout(timer); timer = null
    if (stopped || clients.size === 0) return
    timer = setTimeout(async () => { await look(); schedule() }, intervalMs)
  }

  async function sessionSearch(text, options) {
    const index = await sessionIndex(homes(env, home))
    if (!index.db) return { hits: [], error: index.error }
    try { return { hits: search(index.db, text, options) } } catch (error) { return { hits: [], error: String(error?.message ?? error) } }
  }

  const server = createServer(async (req, res) => {
    try {
      const address = server.address()
      const hosts = new Set([`127.0.0.1:${address?.port}`, `localhost:${address?.port}`, `[::1]:${address?.port}`])
      if (!hosts.has(req.headers.host)) { json(res, 403, { error: 'Loopback requests only.' }); return }
      const url = new URL(req.url, `http://${req.headers.host}`)
      if (req.headers.origin && req.headers.origin !== url.origin) { json(res, 403, { error: 'Cross-origin requests are not allowed.' }); return }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('allow', 'GET, HEAD'); json(res, 405, { error: 'This pane only reads.' }); return }

      if (url.pathname === '/health') { json(res, 200, { ok: true }); return }
      if (url.pathname === '/api/state') { json(res, 200, current ?? await look()); return }
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').slice(0, 200)
        json(res, 200, { q, ...(await sessionSearch(q, { limit: 12 })) })
        return
      }
      if (url.pathname === '/api/related') {
        // Conversations that talk about the same thing as a memory: its title and description, any word.
        const row = (current ?? await look()).memories.find((memory) => memory.id === url.searchParams.get('id'))
        if (!row) { json(res, 404, { error: 'No such memory.' }); return }
        const words = `${row.title} ${row.description}`.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []
        const query = [...new Set(words.filter((word) => !STOP.has(word)))].slice(0, 6).join(' ')
        json(res, 200, { id: row.id, ...(await sessionSearch(query, { limit: 6, any: true })) })
        return
      }
      if (url.pathname === '/events') {
        if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return }
        if (clients.size >= 16) { json(res, 503, { error: 'Too many viewer connections.' }); return }
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        clients.add(res)
        res.on('close', () => { clients.delete(res); if (clients.size === 0) { clearTimeout(timer); timer = null } })
        await look()
        res.write(`event: snapshot\ndata: ${JSON.stringify(current)}\n\n`)
        if (!timer) schedule()
        return
      }

      const asset = ASSETS[url.pathname]
      if (!asset) { json(res, 404, { error: 'Not found' }); return }
      const content = await readFile(join(PACKAGE, 'viewer', asset[0]), 'utf8')
      res.writeHead(200, {
        ...headers,
        'content-type': asset[1],
        // Memory files are written by models and may hold anything; the page renders them as text, and
        // this policy makes sure that even a rendering mistake cannot load or run anything.
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      })
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'The viewer could not serve this request.' }); else res.end()
    }
  })

  return {
    server,
    look,
    snapshot: () => current,
    start: () => new Promise((ok, fail) => {
      server.once('error', fail)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', fail)
        void look()
        heartbeat = setInterval(() => { for (const client of clients) client.write(': pulse\n\n') }, 20_000)
        ok(server.address().port)
      })
    }),
    close: async () => {
      stopped = true; clearTimeout(timer); clearInterval(heartbeat)
      await looking?.catch(() => {})
      for (const client of clients) client.end()
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
      closeIndex()
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd())
  const port = Number(process.env.HARNESS_VIEWER_PORT || 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HARNESS_VIEWER_PORT must be a port number.')
  const viewer = createViewer({ workspace, port })
  console.log(`[memories] http://127.0.0.1:${await viewer.start()}/`)
  const close = () => viewer.close().then(() => process.exit(0))
  process.once('SIGINT', close); process.once('SIGTERM', close)
}
