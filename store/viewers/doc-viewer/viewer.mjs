// Doc Viewer: one loopback server per pane. It serves the reader (app/), pdf.js from this package's
// node_modules (never a CDN), and the workspace read-only under /ws/. It watches the workspace and
// pushes the document's state over server-sent events the moment anything that matters changes: a
// new PDF, a source file newer than the PDF (a compile is on its way), a verdict that says the
// compile failed. The page does the rest.
//
//   GET  /                   the reader
//   GET  /app/*              its files
//   GET  /vendor/<part>/*    pdf.js: build, web, legacy, cmaps, standard_fonts, wasm, iccs
//   GET  /ws/<path>          a workspace file (?download=1 for an attachment)
//   GET  /api/state?file=    the document state (lib/workspace.mjs)
//   GET/POST /api/reviews    list / keep an immutable PDF-and-notes review packet
//   GET /api/reviews/id/*    the packet's bounded PDF, JSON, Markdown and ZIP files
//   GET  /events?file=       the same state, pushed on every change
//   POST /api/open           open the PDF in the default app, reveal it, or open an external link
import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync, watch } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docState, safeJoin, stateKey } from './lib/workspace.mjs'
import { createReviewService, MAX_UPLOAD } from './lib/reviews.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const APP = join(here, 'app')
const PDFJS = join(here, 'node_modules', 'pdfjs-dist')
const VENDOR_PARTS = new Set(['build', 'web', 'legacy', 'cmaps', 'standard_fonts', 'wasm', 'iccs'])
// DOC_VIEWER_OPEN=log answers "opened" without opening anything (tests); =off hides the actions.
const OPEN_MODE = process.env.DOC_VIEWER_OPEN ?? (process.platform === 'darwin' || process.platform === 'linux' ? 'on' : 'off')
const TYPES = {
  '.pdf': 'application/pdf', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/vnd.iccprofile',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.zip': 'application/zip', '.map': 'application/json',
}
const clients = new Set()
const reviewToken = randomBytes(32).toString('hex')
const reviews = createReviewService(workspace)

function sendFile(req, res, full, { cache = 'no-store', download = false } = {}) {
  let st
  try { st = statSync(full) } catch { st = null }
  if (!st || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
  const headers = { 'content-type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': cache, 'last-modified': st.mtime.toUTCString() }
  if (download) headers['content-disposition'] = `attachment; filename="${basename(full).replace(/"/g, '')}"`
  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(full).pipe(res)
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req, limit = 16_384) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

async function keepReview(req, res) {
  const reject = (status, error) => { req.resume(); res.setHeader('connection', 'close'); json(res, status, { error }) }
  if (!trusted(req) || req.headers['x-review-token'] !== reviewToken || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return reject(403, 'Reload the reader before keeping a review')
  if (Number(req.headers['content-length']) > MAX_UPLOAD) return reject(413, 'A review supports a PDF of at most 30 MB')
  try {
    const body = await new Promise((resolve, reject) => {
      let size = 0, chunks = [], finished = false
      req.on('data', (chunk) => {
        if (finished) return
        size += chunk.length
        if (size > MAX_UPLOAD) { finished = true; chunks = []; reject(Object.assign(new Error('The review upload is too large'), { status: 413 })); return }
        chunks.push(chunk)
      })
      req.on('end', () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks)) } })
      req.on('error', reject); req.on('aborted', () => reject(new Error('The review upload was interrupted')))
    })
    json(res, 200, reviews.keep(body))
  } catch (error) { if (!res.destroyed) reject(error.status || 500, error.message) }
}

// Only this page may ask: a custom header forces a CORS preflight no other origin gets past, and
// the Host check stops DNS rebinding.
function trusted(req) {
  const host = String(req.headers.host ?? '')
  return req.headers['x-doc-viewer'] === '1' && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)
}

function openThing(args) {
  if (OPEN_MODE === 'log') { console.log(`[doc-viewer] open (dry run): ${args.join(' ')}`); return }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', (error) => console.log(`[doc-viewer] ${cmd} failed: ${error.message}`))
  child.unref()
}

async function handleOpen(req, res) {
  if (!trusted(req)) return json(res, 403, { ok: false, error: 'forbidden' })
  if (OPEN_MODE === 'off') return json(res, 501, { ok: false, error: 'opening is not available here' })
  let body
  try { body = JSON.parse(await readBody(req)) } catch { body = null }
  if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'bad request' })
  if (body.kind === 'url') {
    const url = String(body.url ?? '')
    if (!/^(https?:\/\/|mailto:)/i.test(url) || url.length > 4096) return json(res, 400, { ok: false, error: 'only http(s) and mailto links open' })
    openThing([url])
    return json(res, 200, { ok: true })
  }
  const full = safeJoin(workspace, String(body.path ?? ''))
  if (!full || !existsSync(full)) return json(res, 404, { ok: false, error: 'no such file' })
  if (body.kind === 'reveal') openThing(process.platform === 'darwin' ? ['-R', full] : [dirname(full)])
  else openThing([full])
  return json(res, 200, { ok: true })
}

function state(file) {
  return { ...docState(workspace, file), canOpen: OPEN_MODE !== 'off' }
}

const server = createServer((req, res) => {
  // An absolute-form target (`GET http://a:99999/`) is not a URL either: both answer 400, neither throws.
  let url, path
  try {
    url = new URL(req.url, `http://127.0.0.1:${port}`)
    path = decodeURIComponent(url.pathname)
  } catch { res.writeHead(400); res.end(); return }
  if (path === '/' || path === '/index.html') {
    const html = readFileSync(join(APP, 'index.html'), 'utf8').replace('__REVIEW_TOKEN__', reviewToken)
    res.writeHead(200, { 'content-type': TYPES['.html'], 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : html); return
  }
  if (path === '/api/reviews' && req.method === 'POST') { keepReview(req, res); return }
  if (path === '/api/reviews' && req.method === 'GET') return json(res, 200, reviews.list())
  if (path.startsWith('/api/reviews/') && ['GET', 'HEAD'].includes(req.method)) {
    const parts = path.split('/'); let full
    try { full = parts.length === 5 && reviews.file(parts[3], parts[4]) } catch { full = null }
    if (!full) { res.writeHead(404); res.end(); return }
    return sendFile(req, res, full, { download: url.searchParams.has('download') })
  }
  if (path.startsWith('/app/')) {
    const full = safeJoin(APP, path.slice('/app/'.length))
    return full ? sendFile(req, res, full) : (res.writeHead(404), res.end())
  }
  if (path.startsWith('/vendor/')) {
    const [part, ...rest] = path.slice('/vendor/'.length).split('/')
    const full = VENDOR_PARTS.has(part) ? safeJoin(join(PDFJS, part), rest.join('/')) : null
    return full ? sendFile(req, res, full, { cache: 'max-age=86400' }) : (res.writeHead(404), res.end())
  }
  if (path.startsWith('/ws/')) {
    const full = safeJoin(workspace, path.slice('/ws/'.length))
    return full ? sendFile(req, res, full, { download: url.searchParams.has('download') }) : (res.writeHead(404), res.end())
  }
  if (path === '/api/state') {
    // A verdict the agent wrote badly is an error for this request, never the end of the pane.
    let body
    try { body = state(url.searchParams.get('file') ?? '') } catch (error) { return json(res, 500, { error: error.message }) }
    return json(res, 200, body)
  }
  if (path === '/api/open' && req.method === 'POST') { handleOpen(req, res).catch((e) => json(res, 500, { ok: false, error: e.message })); return }
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const client = { res, file: url.searchParams.get('file') ?? '', key: '' }
    clients.add(client)
    push(client, true)
    req.on('close', () => clients.delete(client))
    return
  }
  // The old viewer served workspace files at the root; keep those URLs working.
  const legacy = safeJoin(workspace, path.replace(/^\/+/, ''))
  if (legacy && extname(legacy).toLowerCase() === '.pdf') return sendFile(req, res, legacy)
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
}).listen(port, '127.0.0.1', () => console.log(`[doc-viewer] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

function push(client, force = false) {
  let next
  try { next = state(client.file) } catch (error) { console.log(`[doc-viewer] state failed: ${error.message}`); return }
  const key = stateKey(next)
  if (!force && key === client.key) return
  client.key = key
  client.res.write(`event: state\ndata: ${JSON.stringify(next)}\n\n`)
}

// fs.watch is FSEvents on macOS and reliable; a slow poll backs it up on filesystems where it is not.
let timer = null
const flush = () => { timer = null; for (const c of clients) push(c) }
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const rel = String(name ?? '')
    if (rel.includes('node_modules') || rel.startsWith('.git') || rel.startsWith('.claude') || rel.startsWith('.agents')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, 120)
  })
} catch (error) {
  console.log(`[doc-viewer] watch failed: ${error.message}`)
}
setInterval(() => { if (clients.size) flush() }, 3000).unref()
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n') }, 20_000).unref()
// Harness stops the pane with a signal: end the event streams and exit, rather than dying mid-write.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const c of clients) c.res.end(); server.close(); process.exit(0) })
