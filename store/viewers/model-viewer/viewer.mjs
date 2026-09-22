// 3D Viewer: one loopback server per pane, no dependencies but three.js for the page.
//
//   the page      GET /                 the viewport (web/index.html) and GET /app/… its modules
//   the engine    GET /vendor/three/…   three.js from this package's node_modules — never a CDN
//   the files     GET /ws/…             a file from the workspace (byte ranges, so video seeks)
//   the state     GET /api/state        every model, video and still in the workspace, newest first,
//                                       plus the verdict and the build feed (.harness/build.json)
//   live          GET /events           server-sent events: `state` whenever any of that changes
//
// A model file is announced only once it has stopped growing, so a writer that is not atomic never
// hands the page half a GLB. A build feed that says "building" is checked against its pid: a script
// that was killed does not leave the pane saying "rebuilding" forever.
import { createServer } from 'node:http'
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, watch } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDesignController } from './design.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspacePath = resolve(process.env.HARNESS_WORKSPACE || '.')
const workspace = existsSync(workspacePath) ? realpathSync(workspacePath) : workspacePath
const WEB = join(here, 'web')
const THREE = join(here, 'node_modules/three')
const token = randomBytes(24).toString('hex')
const consumer = process.env.HARNESS_DSH_DIR || ''
const designs = createDesignController({ workspace,
  python: process.env.BLENDER_PYTHON || join(consumer, '.venv/bin/python'),
  toolchain: process.env.BLENDER_TOOLCHAIN || join(consumer, 'toolchain'),
  notify: () => broadcast(),
})

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.gif': 'image/gif',
}
const MODEL = new Set(['.glb', '.gltf'])
const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.mov'])
const STILL = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.harness', '.claude', '.agents', '.codex', 'dist', 'build', '.cache', 'textures'])
const MAX_DEPTH = 6
const MAX_FILES = 20_000

// ---------------------------------------------------------------------------------------------------
// The workspace, scanned

function scan() {
  const models = [], videos = [], stills = []
  let seen = 0
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || seen > MAX_FILES) return
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (seen++ > MAX_FILES || name.startsWith('.')) continue
      const full = join(dir, name)
      if (full === join(workspace, 'out/designs')) continue
      let st
      try { st = lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (!SKIP.has(name) && !name.endsWith('-frames')) walk(full, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      const ext = extname(name).toLowerCase()
      const bucket = MODEL.has(ext) ? models : VIDEO.has(ext) ? videos : STILL.has(ext) ? stills : null
      if (!bucket) continue
      const entry = { path: relative(workspace, full).split(sep).join('/'), size: st.size, mtime: Math.round(st.mtimeMs) }
      // the Blender harness writes report.json beside its export: the pane checks units against it
      if (bucket === models && existsSync(join(dir, 'report.json'))) entry.report = relative(workspace, join(dir, 'report.json')).split(sep).join('/')
      bucket.push(entry)
    }
  }
  walk(workspace, 0)
  const newest = (a, b) => b.mtime - a.mtime
  return { models: models.sort(newest).slice(0, 60), videos: videos.sort(newest).slice(0, 30), stills: stills.sort(newest).slice(0, 30) }
}

function readJson(rel) {
  try { return JSON.parse(readFileSync(join(workspace, rel), 'utf8')) } catch { return null }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

let frames = null // { at, dir } — a render writing frames, for workspaces without a build feed

function state() {
  const build = readJson('.harness/build.json')
  if (build && typeof build === 'object') {
    build.alive = build.state === 'building' ? alive(build.pid) !== false : null
    if (build.state === 'building' && build.alive === false) { build.state = 'stopped' }
  }
  const inferred = frames && Date.now() - frames.at < 4000 ? { state: 'building', step: 'Rendering frames', dir: frames.dir } : null
  return { workspace: basename(workspace), ...scan(), verdict: readJson('.harness/verdict.json'), build, inferred, design: designs.state(), now: Date.now() }
}

// ---------------------------------------------------------------------------------------------------
// Serving

function safe(root, rel) {
  const full = normalize(join(root, rel))
  if (!(full === root || full.startsWith(root + sep))) return null
  try {
    const actual = realpathSync(full), base = realpathSync(root)
    return actual === base || actual.startsWith(base + sep) ? actual : null
  } catch { return full }
}

function sendFile(req, res, full, cache) {
  let st
  try { st = statSync(full) } catch { st = null }
  if (!st || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache, 'last-modified': st.mtime.toUTCString() }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]))
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(full, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': st.size })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(full).pipe(res)
}

const clients = new Set()

const server = createServer(async (req, res) => {
  try {
    if (!['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) { res.writeHead(403); res.end('loopback host required'); return }
    // An absolute-form target (`GET http://a:99999/`) makes URL throw, a bad escape decodeURIComponent.
    let path
    try { path = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname) } catch { res.writeHead(400); res.end(); return }
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)) }
    if (req.method === 'POST') {
      if (req.headers['x-design-token'] !== token || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return json(403, { error: 'Invalid design request' })
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > (path === '/api/design/keep' ? 1600000 : 16384)) throw new Error('Design request is too large'); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (path === '/api/design/preview') return json(200, designs.preview(body))
      if (path === '/api/design/keep') return json(200, designs.keep(body))
      if (path === '/api/design/use-values') return json(200, designs.useValues(body))
      if (path === '/api/design/cancel') { designs.cancel(body); return json(200, { ok: true }) }
      return json(404, { error: 'Not found' })
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: 'Method not allowed' })
    if (path === '/' || path === '/index.html') {
      const html = readFileSync(join(WEB, 'index.html'), 'utf8').replace('__DESIGN_TOKEN__', token)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) })
      res.end(req.method === 'HEAD' ? undefined : html); return
    }
    if (path.startsWith('/__design/')) {
      const [key, ...parts] = path.slice(10).split('/')
      return sendFile(req, res, designs.file(key, parts.join('/')), 'no-store')
    }
    if (path.startsWith('/app/')) {
      const full = safe(WEB, path.slice(5))
      return full ? sendFile(req, res, full, 'no-cache') : void (res.writeHead(403), res.end())
    }
    if (path.startsWith('/vendor/three/')) {
      const rel = path.slice('/vendor/three/'.length)
      const full = /^(build|examples\/jsm)\//.test(rel) ? safe(THREE, rel) : null
      return full ? sendFile(req, res, full, 'max-age=86400') : void (res.writeHead(403), res.end())
    }
    if (path.startsWith('/ws/')) {
      const full = safe(workspace, path.slice(4))
      return full ? sendFile(req, res, full, 'no-store') : void (res.writeHead(403), res.end())
    }
    if (path === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(state()))
      return
    }
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
    // The first version of this pane fetched workspace files at the root; keep that working.
    const legacy = safe(workspace, path.replace(/^\/+/, ''))
    if (legacy && existsSync(legacy)) return sendFile(req, res, legacy, 'no-store')
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  } catch (error) {
    if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: String(error.message).slice(-3000) })) }
    else res.end()
  }
})

server.listen(port, '127.0.0.1', () => console.log(`[model-viewer] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

// ---------------------------------------------------------------------------------------------------
// Live: watch, wait for writes to settle, broadcast

let last = ''
function broadcast() {
  const snapshot = state()
  const key = JSON.stringify({ ...snapshot, now: 0 })
  if (key === last) return
  last = key
  const message = `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`
  for (const client of clients) client.write(message)
}

// Sizes of the model files as last seen; a model is announced when two looks 200 ms apart agree.
let settleTimer = null
function settle() {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    const before = scan().models.map((m) => `${m.path}:${m.size}:${m.mtime}`).join('|')
    setTimeout(() => {
      const after = scan().models.map((m) => `${m.path}:${m.size}:${m.mtime}`).join('|')
      if (before !== after) { settle(); return }
      broadcast()
    }, 200)
  }, 150)
}

let framesTimer = null
let framesExpiry = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    // No name (fs.watch does not promise one): something changed, so look again.
    const n = String(name ?? '').split(sep).join('/')
    if (n.includes('node_modules/') || n.startsWith('.git/') || n.includes('__pycache__')) return
    if (n.startsWith('out/designs/')) return
    if (/-frames\//.test(n)) {
      frames = { at: Date.now(), dir: n.slice(0, n.indexOf('-frames/') + 7) }
      if (!framesTimer) { broadcast(); framesTimer = setTimeout(() => { framesTimer = null; broadcast() }, 1000) }
      clearTimeout(framesExpiry); framesExpiry = setTimeout(() => broadcast(), 4200)
      return
    }
    if (n.startsWith('.harness/') && !/^\.harness\/(build|verdict|design)\.json$/.test(n)) return
    settle()
  })
} catch (error) {
  console.log(`[model-viewer] watch failed: ${error.message}; polling`)
  setInterval(() => broadcast(), 2000).unref()
}

// A build that dies without saying so: re-check the pid while anything is building.
setInterval(() => {
  if (!clients.size) return
  const build = readJson('.harness/build.json')
  if (build?.state === 'building') broadcast()
}, 1500).unref()
setInterval(() => { for (const client of clients) client.write(': ping\n\n') }, 20_000).unref()
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { for (const client of clients) client.end(); server.close(); await designs.close(); process.exit(0) })
