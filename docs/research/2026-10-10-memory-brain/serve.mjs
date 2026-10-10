#!/usr/bin/env node
/**
 * Serves these prototypes on this computer, and, for pages opened with ?real, this computer's own
 * memories: what the Memories viewer reads (store/agents/memories/lib), read on each request and never
 * written anywhere. Loopback only; it only reads.
 *
 *   node docs/research/2026-10-10-memory-brain/serve.mjs [port]
 *   open http://127.0.0.1:<port>/            invented memories
 *   open http://127.0.0.1:<port>/?real       yours
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (name) => import(new URL(`../../../store/agents/memories/lib/${name}`, import.meta.url).href)
const { snapshot } = await lib('state.mjs')
const { sessionIndex } = await lib('state.mjs')
const { asks, search } = await lib('sessions.mjs')
const { homes } = await lib('agents.mjs')

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' }
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }

async function index() {
  const found = await sessionIndex(homes(process.env, homedir()))
  if (!found.db) throw new Error(found.error ?? 'No session index.')
  return found.db
}

const server = createServer(async (req, res) => {
  try {
    const { port } = server.address()
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { json(res, 403, { error: 'Loopback only.' }); return }
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') { json(res, 403, { error: 'Only these pages may ask.' }); return }
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/real/snapshot') { json(res, 200, await snapshot({ env: process.env, home: homedir(), now: Date.now() })); return }
    if (url.pathname === '/real/asks') { json(res, 200, { asks: asks(await index(), { limit: 4000, maxChars: 400 }) }); return }
    if (url.pathname === '/real/search') { json(res, 200, { hits: search(await index(), (url.searchParams.get('q') ?? '').slice(0, 200), { limit: 24 }) }); return }
    const path = normalize(join(here, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)))
    if (!path.startsWith(here + sep) || !TYPES[extname(path)]) { json(res, 404, { error: 'Not found.' }); return }
    const body = await readFile(path).catch(() => null)
    if (!body) { json(res, 404, { error: 'Not found.' }); return }
    res.writeHead(200, { 'content-type': TYPES[extname(path)], 'cache-control': 'no-store' })
    res.end(body)
  } catch (error) {
    json(res, 500, { error: String(error?.message ?? error) })
  }
})

server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(`Memory brain prototypes: http://127.0.0.1:${server.address().port}/   (yours: add ?real)`)
})
