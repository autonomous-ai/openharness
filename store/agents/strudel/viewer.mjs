// The Strudel pane's server: Strudel's own REPL as a web component, playing the .strudel file named by
// ?file= (workspace-relative, or the newest .strudel when none is named) and hot-swapping the pattern the
// moment the file changes — without stopping the transport. Strudel comes from this package's
// node_modules (`@strudel/repl`, as npm publishes it), never from a CDN, so the pane works offline.
//
//   GET /            the pane (pane/index.html; pane.mjs draws the transport, the voices, the lanes)
//   GET /_pane/*     the pane's own files
//   GET /vendor/*    @strudel/repl's dist, unmodified
//   GET /_files      [{ path, mtime }] — the workspace's .strudel files, newest first
//   GET /_takes      saved performance summaries
//   POST /_takes     token-protected binary metadata + WAV; atomic, retry-safe archive
//   GET /events      server-sent events: one "change" per save
//   GET /<path>      a file from the workspace, never outside it
import { createServer } from 'node:http'
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  watch
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keepTake, listTakes, MAX_UPLOAD } from './takes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const token = randomBytes(32).toString('hex')
let saving = false
const TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.strudel': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}
// The whole dist directory: index.js is the script-tag build, and it resolves its audio clock worker
// relative to its own URL (dist/assets/clockworker-*.js), so the siblings have to be reachable too.
const VENDOR = join(here, 'node_modules/@strudel/repl/dist')

const PANE = join(here, 'pane')
const page = () => readFileSync(join(PANE, 'index.html'), 'utf8').replace('__TAKE_TOKEN__', token)

function safe(root, rel) {
  const full = normalize(join(root, rel))
  if (full !== root && !full.startsWith(root + sep)) return null
  try {
    const real = realpathSync(full),
      base = realpathSync(root)
    return real === base || real.startsWith(base + sep) ? full : null
  } catch {
    return null
  }
}
/** The workspace's .strudel files, newest first — what the pane opens when no file is named. */
function tracks() {
  const found = []
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (relative(workspace, full).split(sep).join('/') === 'out/takes') continue
      if (e.isDirectory() && depth < 4) walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.strudel')) {
        try {
          found.push({ path: relative(workspace, full).split(sep).join('/'), mtime: statSync(full).mtimeMs })
        } catch {}
      }
    }
  }
  walk(workspace, 0)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 50)
}
function send(res, full, req, fresh = false) {
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  const size = statSync(full).size
  const headers = {
    'content-type': type,
    'content-length': size,
    'cache-control': full.startsWith(VENDOR) && !fresh ? 'max-age=3600' : 'no-store',
    'accept-ranges': 'bytes'
  }
  let start = 0,
    end = size - 1,
    status = 200
  if (req.headers.range && req.method !== 'HEAD') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
      end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
    } else start = size
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    status = 206
    headers['content-range'] = `bytes ${start}-${end}/${size}`
    headers['content-length'] = end - start + 1
  }
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || !size) {
    res.end()
    return
  }
  const stream = createReadStream(full, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
createServer(async (req, res) => {
  const reject = (status, error) => {
    req.resume()
    res.setHeader('connection', 'close')
    json(res, status, { error })
  }
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
    reject(403, 'Loopback requests only')
    return
  }
  let path
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    path = decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400)
    res.end('bad path')
    return
  }
  if (path === '/_takes' && req.method === 'POST') {
    if (
      req.headers['x-take-token'] !== token ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
    ) {
      reject(403, 'Reload this pane before keeping a take')
      return
    }
    if (saving) {
      reject(409, 'Another take is being saved. Try again in a moment.')
      return
    }
    if (Number(req.headers['content-length']) > MAX_UPLOAD) {
      reject(413, 'Take exceeds 50 MB')
      return
    }
    saving = true
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_UPLOAD) throw Object.assign(new Error('Take exceeds 50 MB'), { status: 413 })
        chunks.push(chunk)
      }
      const result = keepTake(workspace, Buffer.concat(chunks))
      json(res, 201, result)
      for (const client of clients) client.write('event: takes\ndata: {}\n\n')
    } catch (error) {
      if (!res.destroyed) json(res, error.status || 500, { error: error.message })
    } finally {
      saving = false
    }
    return
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    json(res, 405, { error: 'Method not allowed' })
    return
  }
  if (path === '/_takes') {
    json(res, 200, listTakes(workspace))
    return
  }
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(page())
    return
  }
  if (path.startsWith('/_pane/')) {
    send(res, safe(PANE, path.slice('/_pane/'.length)), req, true)
    return
  }
  if (path === '/_files') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(tracks()))
    return
  }
  if (path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive'
    })
    res.write(': hello\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (path.startsWith('/vendor/')) {
    send(res, safe(VENDOR, path.slice('/vendor/'.length)), req)
    return
  }
  send(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () =>
  console.log(`[strudel] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`)
)

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    /* c8 ignore next */ // name is null only where fs.watch cannot report file names; macOS FSEvents always does
    const n = String(name ?? '')
    if (
      !n ||
      n.startsWith('.harness') ||
      n.includes('node_modules') ||
      n === 'out' ||
      /^out[\\/]takes(?:[\\/]|$)/.test(n)
    )
      return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      for (const c of clients) c.write('event: change\ndata: {}\n\n')
    }, 200)
  })
} catch (error) {
  console.log(`[strudel] watch failed: ${error.message}`)
}
setInterval(() => {
  for (const c of clients) c.write(': ping\n\n')
}, 20_000).unref()
