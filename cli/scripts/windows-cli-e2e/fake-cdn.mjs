#!/usr/bin/env node
/**
 * The fake CDN for the Windows end to end (docs/testing/windows-cli-e2e.md): an HTTPS server on this Mac that answers
 * as cdn.autonomous.ai and storage.googleapis.com once the VM's hosts file points those names here (vm-cdn.ps1). The
 * real `irm https://cdn.autonomous.ai/harness/staging/cli/install.ps1 | iex` then installs this branch's build, laid
 * out by `fake-cdn.sh stage` exactly as the staging publish would lay it out in the bucket.
 *
 * - A path under harness/staging/ is served from the local root, or is a 404. It is never forwarded: the real staging
 *   is not touched, and a file the stage forgot fails the run instead of quietly installing the real one.
 * - Any other path is served locally when the stage put it there (Node, at its official versioned path), and is
 *   otherwise forwarded to the real host, so the VM's other software keeps working while the hosts lines are in.
 *
 *   node fake-cdn.mjs serve --root <dir> --cert <pem> --key <pem> [--bind 192.168.65.1] [--port 443] [--http-port 80]
 *   node fake-cdn.mjs pty-manifest <dry-run metadata.json> <out metadata.json> <prefix> [platform...]
 *   node fake-cdn.mjs layout <version> <pty version> <node version> [prefix]   the stage's paths, as name=value lines
 */
import { createReadStream, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { extname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { mergePlatforms, runtimeEntry } from '../lib/runtimeManifest.mjs'

export const BUCKET = 's3-autonomous-upgrade-3'
export const CDN_HOST = 'cdn.autonomous.ai'
export const STORAGE_HOST = 'storage.googleapis.com'
export const HOSTS = [CDN_HOST, STORAGE_HOST]
export const STAGING_PREFIX = 'harness/staging'

/**
 * The bucket object a request names, or null when it names none. The CDN serves the bucket at its root; the storage
 * host serves it under /<bucket>/. A `..` segment, a backslash or a NUL is refused outright (`bad`), so no request
 * reaches outside the root, and none slips past the staging rule as harness/staging/../x.
 */
export function objectFor(host, url) {
  const name = hostName(host)
  let path
  try { path = decodeURIComponent(String(url).split('?')[0].split('#')[0]) } catch { return { bad: true } }
  if (path.includes('\0') || path.includes('\\')) return { bad: true }
  const segments = path.split('/').filter(Boolean)
  if (segments.some((s) => s === '..' || s === '.')) return { bad: true }
  if (name === CDN_HOST) return segments.length ? { object: segments.join('/') } : null
  if (name === STORAGE_HOST) return segments[0] === BUCKET && segments.length > 1 ? { object: segments.slice(1).join('/') } : null
  return null
}

export const isStaging = (object) => object === STAGING_PREFIX || object.startsWith(`${STAGING_PREFIX}/`)

/**
 * What to do with a request: `local` (serve the object from the root), `missing` (a staging object the stage did not
 * lay out: 404), `bad` (400) or `forward` (to the real host). `has(object)` says whether the root holds the object.
 */
export function route(host, url, has) {
  const target = objectFor(host, url)
  if (target?.bad) return { action: 'bad' }
  if (target && has(target.object)) return { action: 'local', object: target.object }
  if (target && isStaging(target.object)) return { action: 'missing', object: target.object }
  return { action: 'forward' }
}

/**
 * Where the stage puts each file, and the address its manifest names (B1 publish scripts, and the staging layout the
 * first real publish uses: CLI and pty under harness/staging/<kind>/<version>/, Node at its official versioned path).
 */
const cdn = (object) => `https://${CDN_HOST}/${object}`
const storage = (object) => `https://${STORAGE_HOST}/${BUCKET}/${object}`
const ptyObjectOf = (prefix, ptyVersion, platform) => `${prefix}/pty/${ptyVersion}/harness-pty-${ptyVersion}-${platform}.zip`

export function stagingLayout({ version, ptyVersion, nodeVersion, prefix = STAGING_PREFIX }) {
  const cliObject = (name) => `${prefix}/cli/${version}/${name}`
  const ptyObject = (platform) => ptyObjectOf(prefix, ptyVersion, platform)
  const nodeObject = (arch) => `harness/runtime/node/v${nodeVersion}/node-v${nodeVersion}-win-${arch}.zip`
  return {
    manifestBase: storage(`${prefix}/`),
    installScript: { object: `${prefix}/cli/install.ps1`, url: cdn(`${prefix}/cli/install.ps1`) },
    manifests: { cli: `${prefix}/cli/metadata.json`, pty: `${prefix}/pty/metadata.json`, runtime: `${prefix}/runtime/metadata.json` },
    cli: Object.fromEntries(['cli.js', 'notify.mjs'].map((name) => [name, { object: cliObject(name), url: cdn(cliObject(name)) }])),
    pty: Object.fromEntries(['win32-x64', 'win32-arm64'].map((p) => [p, { object: ptyObject(p), url: cdn(ptyObject(p)) }])),
    node: Object.fromEntries(['x64', 'arm64'].map((arch) => [`win32-${arch}`, { object: nodeObject(arch), url: storage(nodeObject(arch)) }])),
  }
}

/** The layout as `name=value` lines for a shell (`cli_js_url=https://…`): every leaf, its path joined by `_`. */
export function layoutLines(layout) {
  const lines = []
  const walk = (value, path) => {
    if (typeof value === 'string') { lines.push(`${path.join('_').replace(/[^A-Za-z0-9_]/g, '_')}=${value}`); return }
    for (const [key, inner] of Object.entries(value)) walk(inner, [...path, key])
  }
  walk(layout, [])
  return lines
}

/**
 * The staging pty manifest from publish-pty-payload.sh's dry run: the same zips (sha256, size), at their staging
 * address. Only [platforms] are kept, so a platform the stage had no payload for is absent rather than wrong.
 */
export function stagePtyManifest(dryRun, prefix, platforms = ['win32-x64', 'win32-arm64']) {
  const entries = {}
  for (const platform of platforms) {
    const entry = dryRun?.pty?.[platform]
    if (!entry) throw new Error(`the dry-run manifest has no pty ${platform}`)
    entries[platform] = runtimeEntry({ ...entry, url: cdn(ptyObjectOf(prefix, entry.version, platform)) })
  }
  return mergePlatforms({}, 'pty', entries)
}

const READS = new Set(['GET', 'HEAD'])
const hostName = (host) => String(host ?? '').toLowerCase().replace(/:\d+$/, '')

const TYPES = { '.json': 'application/json', '.ps1': 'text/plain; charset=utf-8', '.zip': 'application/zip', '.js': 'text/javascript', '.mjs': 'text/javascript' }

/**
 * The request handler. [forward] sends a request on to the real host (injected, so a test needs no network).
 * [log] gets one line per request.
 */
export function createHandler({ root, scheme = 'https', forward = forwardTo, log = (line) => console.log(line) }) {
  const base = realpathSync(root)
  const fileOf = (object) => join(base, ...object.split('/'))
  const has = (object) => {
    const file = fileOf(object)
    return file.startsWith(base + sep) && existsSync(file) && statSync(file).isFile()
  }
  return (req, res) => {
    const host = req.headers.host ?? ''
    const say = (what) => log(`${new Date().toISOString().slice(11, 23)} ${req.method} ${scheme}://${host}${req.url} -> ${what}`)
    // Reads only, before anything else: a forwarded PUT, POST or DELETE could write to the real bucket.
    if (!READS.has(req.method)) { say('405'); res.writeHead(405, { allow: 'GET, HEAD' }).end(); return }
    // Only the two names the VM's hosts lines send here. Any other Host (the bind address, localhost, a name the
    // client typed) gets 421: forwarding it would make the fake an open proxy.
    if (!HOSTS.includes(hostName(host))) { say('421'); res.writeHead(421, { 'content-type': 'text/plain' }).end(`this server answers only for ${HOSTS.join(' and ')}\n`); return }
    const decision = route(host, req.url, has)
    if (decision.action === 'bad') { say('400'); res.writeHead(400).end('bad path\n'); return }
    if (decision.action === 'missing') { say('404 (staging, not staged)'); res.writeHead(404, { 'content-type': 'text/plain' }).end(`not staged: ${decision.object}\n`); return }
    if (decision.action === 'local') {
      const file = fileOf(decision.object)
      const size = statSync(file).size
      say(`local 200 (${size} bytes)`)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store' })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(file).pipe(res)
      return
    }
    forward(req, res, { scheme, host: hostName(host), say })
  }
}

/** Forwards to the real host, resolved by this Mac's own DNS (the VM's hosts lines do not reach it). */
export function forwardTo(req, res, { scheme, host, say }) {
  // The handler checks both already; this keeps a future caller from forwarding a write or another host.
  if (!READS.has(req.method) || !HOSTS.includes(host)) throw new Error(`refusing to forward ${req.method} ${host}`)
  const client = scheme === 'https' ? https : http
  const upstream = client.request({ host, servername: host, port: scheme === 'https' ? 443 : 80, method: req.method, path: req.url, headers: { ...req.headers, host } }, (answer) => {
    say(`forwarded ${answer.statusCode}`)
    res.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(res)
  })
  upstream.on('error', (error) => {
    say(`forward failed: ${error.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`fake CDN could not reach ${host}: ${error.message}\n`)
  })
  req.pipe(upstream)
}

/**
 * Accepts only connections made to [bind]. The server listens on every address because macOS lets a standard user
 * open port 443 only on the wildcard (192.168.65.1:443 is EACCES without sudo, measured 2026-10-18), and this keeps
 * the fake reachable from the VM's network only.
 */
export function onlyTo(server, bind) {
  server.on('connection', (socket) => {
    if (socket.localAddress?.replace(/^::ffff:/, '') !== bind) socket.destroy()
  })
  return server
}

function serve(values) {
  const root = values.root, bind = values.bind ?? '192.168.65.1'
  const port = Number(values.port ?? 443), httpPort = Number(values['http-port'] ?? 80)
  if (!root || !values.cert || !values.key) throw new Error('serve needs --root, --cert and --key')
  const tls = { cert: readFileSync(values.cert), key: readFileSync(values.key) }
  const secure = onlyTo(https.createServer(tls, createHandler({ root, scheme: 'https' })), bind)
  secure.listen(port, '0.0.0.0', () => console.log(`fake CDN: https://${bind}:${port}/ serving ${root} as ${HOSTS.join(', ')}`))
  if (httpPort) {
    const plain = onlyTo(http.createServer(createHandler({ root, scheme: 'http' })), bind)
    plain.listen(httpPort, '0.0.0.0', () => console.log(`fake CDN: http://${bind}:${httpPort}/ forwards plain HTTP for the same names`))
  }
}

function main(argv) {
  const [command, ...rest] = argv
  if (command === 'serve') {
    const { values } = parseArgs({ args: rest, options: { root: { type: 'string' }, cert: { type: 'string' }, key: { type: 'string' }, bind: { type: 'string' }, port: { type: 'string' }, 'http-port': { type: 'string' } } })
    return serve(values)
  }
  if (command === 'pty-manifest') {
    const [src, dst, prefix, ...platforms] = rest
    const doc = stagePtyManifest(JSON.parse(readFileSync(src, 'utf8')), prefix, platforms.length ? platforms : undefined)
    return writeFileSync(dst, JSON.stringify(doc, null, 2) + '\n')
  }
  if (command === 'layout') {
    const [version, ptyVersion, nodeVersion, prefix] = rest
    return console.log(layoutLines(stagingLayout({ version, ptyVersion, nodeVersion, prefix: prefix || STAGING_PREFIX })).join('\n'))
  }
  throw new Error('usage: fake-cdn.mjs serve --root <dir> --cert <pem> --key <pem> [--bind <ip>] [--port 443] [--http-port 80] | pty-manifest <src> <dst> <prefix> [platform...] | layout <version> <pty version> <node version> [prefix] (name=value lines)')
}

// realpath: reached through a symlinked folder, argv[1] is the link and the plain comparison never matches
// (runtimeManifest.mjs has that trap; the release simulation hit it, 2026-10-16).
const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ''
if (import.meta.url === invoked) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`error: ${error.message}`); process.exit(1) }
}
