// Opt-in local integration: real hn, daemon, backend, Mongo/Redis, DSH viewers and Chrome.
// The OAuth provider and model process are deterministic fixtures; no production account is used.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, cp, readFile } from 'node:fs/promises'
import { join, resolve, extname, sep, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

assert.equal(process.env.HN_VIEWER_LIVE_TEST, '1', 'Opt in with HN_VIEWER_LIVE_TEST=1')
for (const key of ['HN_VIEWER_SERVICES_DIR', 'HN_VIEWER_TOOLS_DIR', 'HN_VIEWER_WEB_DIR', 'HN_VIEWER_BINARY', 'HN_VIEWER_MONGOD', 'HN_VIEWER_REDIS']) {
  assert.ok(process.env[key] && existsSync(process.env[key]), `Set ${key} to an existing test dependency`)
}
const repo = resolve(process.env.HN_VIEWER_REPO || join(dirname(fileURLToPath(import.meta.url)), '../..'))
const cliRequire = createRequire(join(repo, 'cli/package.json'))
const { WebSocket } = cliRequire('ws')
const services = createRequire(join(process.env.HN_VIEWER_SERVICES_DIR, 'package.json'))
const { MongoMemoryReplSet } = services('mongodb-memory-server')
const { RedisMemoryServer } = services('redis-memory-server')
const { chromium } = createRequire(join(process.env.HN_VIEWER_TOOLS_DIR, 'package.json'))('playwright')
const exec = promisify(execFile)
const ports = { backend: 19680, proxy: 19681, web: 19682, sso: 19683, daemon: 19684, mongo: 19685, redis: 19686 }
for (const port of Object.values(ports)) {
  assert.ok(port >= 19680 && port <= 19699 && ![18473, 18907].includes(port))
  const probe = netServer().listen(port, '127.0.0.1')
  await once(probe, 'listening')
  await new Promise(resolve => probe.close(resolve))
}
const root = await mkdtemp('/tmp/hnvl-')
const prefix = `hn-viewer-live-${process.pid}`
const webDir = resolve(process.env.HN_VIEWER_WEB_DIR)
const chrome = process.env.HN_VIEWER_CHROME || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium')
const tmux = process.env.HN_VIEWER_TMUX || (process.platform === 'darwin' ? '/opt/homebrew/bin/tmux' : '/usr/bin/tmux')
const base = `http://127.0.0.1:${ports.backend}`, webBase = `http://127.0.0.1:${ports.web}`, ssoBase = `http://127.0.0.1:${ports.sso}`
const cleanups = [], checks = []
if (process.platform === 'darwin') {
  const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
  cleanups.push(() => awake.kill())
}
let complete = false, context, browser
console.log(`Isolated test directory: ${root}`)
const pass = s => { checks.push(s); console.log(`PASS ${s}`) }
async function until(label, check, ms = 60000) {
  const end = Date.now() + ms
  while (!await check()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 6000)
  await exited
  clearTimeout(timer)
}
function run(name, cwd, args, env) {
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(root, `${name}.log`))
  child.stdout.pipe(log); child.stderr.pipe(log)
  cleanups.push(() => stop(child))
  return child
}
async function listen(server, port) {
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(() => { server.closeAllConnections?.(); server.close() })
}
const safeEnv = { PATH: process.env.PATH, TMPDIR: root, HOME: join(root, 'home'), LANG: 'en_US.UTF-8',
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'share'), XDG_CACHE_HOME: join(root, 'cache'),
  NODE_ENV: 'test', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const token = `hn-viewer-${randomUUID()}`, userId = randomUUID().replaceAll('-', '')
const password = `hn-test-${randomUUID()}`
const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-autonomous-env': 'prod' }
const codes = new Map()
let hnEnv, hnBinary, owner, agentId, controlsId
async function hn(...args) {
  assert.equal(hnEnv.PORT, String(ports.daemon)); assert.equal(hnEnv.HN_SOCKET_NAME, prefix)
  return exec(hnBinary, ['-L', prefix, '--port', String(ports.daemon), ...args], { env: hnEnv, timeout: 30000 })
}
async function desktop(machineId) {
  const ws = new WebSocket(`ws://127.0.0.1:${ports.daemon}/api/local-ws`)
  cleanups.push(() => ws.terminate())
  const frames = []
  ws.on('message', (raw, binary) => { if (!binary) frames.push(JSON.parse(raw.toString())) })
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
  await until('local machine connection', () => frames.some(f => f.type === 'connected'))
  return { ws, async rpc(type, payload = {}) {
    const requestId = randomUUID()
    ws.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
    await until(type, () => frames.some(f => f.payload?.requestId === requestId))
    const result = frames.find(f => f.payload?.requestId === requestId).payload
    assert.ok(!result.error, `${type}: ${JSON.stringify(result)}`)
    return result
  } }
}
async function semantics(page) {
  await page.locator('flt-glass-pane').waitFor({ state: 'attached', timeout: 45000 })
  const enable = page.locator('flt-semantics-placeholder')
  await until('Flutter accessibility entrypoint', async () => await enable.count() || await page.locator('flt-semantics').count())
  if (await enable.count()) await enable.evaluate(el => el.click())
}
try {
  for (const dir of [safeEnv.HOME, safeEnv.XDG_CONFIG_HOME, safeEnv.XDG_DATA_HOME, safeEnv.XDG_CACHE_HOME, join(root, 'bin'), join(root, 'auth'), join(root, 'data'), join(root, 'dsh'), join(root, 'runtime')]) await mkdir(dir, { recursive: true })
  const mongo = await MongoMemoryReplSet.create({ binary: { systemBinary: process.env.HN_VIEWER_MONGOD },
    instanceOpts: [{ port: ports.mongo }], replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  cleanups.push(() => mongo.stop())
  const redis = new RedisMemoryServer({ binary: { systemBinary: process.env.HN_VIEWER_REDIS }, instance: { port: ports.redis } })
  assert.equal(await redis.getPort(), ports.redis)
  cleanups.push(() => redis.stop())
  await listen(createServer(async (req, res) => {
    const u = new URL(req.url, ssoBase)
    if (u.pathname === '/oauth2/authorize') {
      const redirect = new URL(u.searchParams.get('redirect_uri'))
      assert.equal(redirect.origin, webBase)
      const code = randomUUID(); codes.set(code, u.searchParams.get('code_challenge'))
      redirect.searchParams.set('state', u.searchParams.get('state')); redirect.searchParams.set('code', code)
      res.writeHead(302, { location: redirect.href }).end(); return
    }
    res.setHeader('content-type', 'application/json')
    if (u.pathname === '/oauth2/token') {
      let body = ''; for await (const chunk of req) body += chunk
      const form = new URLSearchParams(body), challenge = codes.get(form.get('code'))
      codes.delete(form.get('code'))
      if (challenge !== createHash('sha256').update(form.get('code_verifier') || '').digest('base64url')) { res.writeHead(400).end('{}'); return }
      res.end(JSON.stringify({ access_token: token, refresh_token: 'test-refresh', expires_in: 3600, token_type: 'Bearer' })); return
    }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end('{}'); return }
    res.end(JSON.stringify({ status: 1, data: { id: userId, email: `${userId}@local.invalid` } }))
  }), ports.sso)
  await listen(createServer(async (req, res) => {
    try {
      const u = new URL(req.url, webBase), pathname = decodeURIComponent(u.pathname)
      const file = resolve(webDir, '.' + (pathname === '/' || pathname === '/callback' ? '/index.html' : pathname))
      if (!file.startsWith(webDir + sep)) { res.writeHead(403).end(); return }
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream'
      const data = await readFile(file)
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' }); res.end(data)
    } catch { res.writeHead(404).end() }
  }), ports.web)
  const backendEnv = { ...safeEnv, PORT: String(ports.backend), PORT_APP_PROXY: String(ports.proxy),
    DATABASE_URL: mongo.getUri('hn_viewer'), REDIS_URL: `redis://127.0.0.1:${ports.redis}`,
    HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false', SSO_ISSUER: ssoBase, SSO_CLIENT_ID: 'hn-viewer-test',
    SSO_PROFILE_URL: ssoBase + '/profile', SSO_IDENTITY_URL: '', WEB_URL: webBase, WEB_ORIGINS: webBase,
    AUTONOMOUS_BFF_URL: ssoBase, AUTONOMOUS_CAMPAIGN_API_URL: ssoBase,
    TERMINAL_P2P_ROLLOUT_PERCENT: '0', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], { cwd: join(repo, 'backend'), env: backendEnv, timeout: 60000 })
  let backend = run('backend', join(repo, 'backend'), ['--import', 'tsx', 'src/server.ts'], backendEnv)
  await until('backend health', () => fetch(base + '/api/health').then(r => r.ok).catch(() => false))
  const computerId = randomUUID().replaceAll('-', '')
  const registered = await fetch(base + '/api/machines/resolve-computer', { method: 'POST', headers: authHeaders, body: JSON.stringify({ computerId, label: 'hn viewer test' }) }).then(r => r.json())
  const machineId = registered.data?.machine?.machineId
  assert.ok(machineId, JSON.stringify(registered))
  await writeFile(join(root, 'auth/session.json'), JSON.stringify({ version: 1, accessToken: token, refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000, autonomousEnv: 'prod', computerId, machineId, updatedAt: Date.now() }), { mode: 0o600 })
  const engine = join(root, 'bin/claude')
  await writeFile(engine, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('2.1.0 (Claude Code)');process.exit(0)}\nif(process.argv.includes('--help')){console.log('--dangerously-skip-permissions --permission-mode --model');process.exit(0)}\nprocess.title='claude';process.stdin.setRawMode?.(true);console.log('HN_VIEWER_ENGINE_READY');process.stdin.on('data',x=>{require('node:fs').appendFileSync(${JSON.stringify(join(root, 'engine-input.log'))},x);process.stdout.write('ECHO:'+x+'\\r\\n')});setInterval(()=>{},1000);\n`, { mode: 0o700 })
  // Every daemon tmux operation is forced onto this test's server, even with TMUX unset.
  await writeFile(join(root, 'bin/tmux'), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in -L*|-S*) exit 125;; esac; done\nexec '${tmux.replaceAll("'", "'\\''")}' -L '${prefix}' "$@"\n`, { mode: 0o700 })
  const daemonEnv = { ...safeEnv, PATH: join(root, 'bin') + ':' + safeEnv.PATH, PORT: String(ports.daemon),
    HARNESS_AUTH_DIR: join(root, 'auth'), ADAPTER_COMPUTER_ID: computerId, ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), DSH_DIR: join(root, 'dsh'),
    CLAUDE_PATH: engine, CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDE_PROJECTS_DIR: join(root, 'claude/projects'),
    BACKEND_WS_URL: base.replace('http:', 'ws:'), WEB_URL: webBase, HARNESS_STORE_CATALOG_URL: ssoBase + '/empty-catalog',
    HARNESS_GRID_BIN: join(root, 'no-grid'), DISABLE_GRID_INSTALL: 'true', DISABLE_HOOK_INSTALL: 'true',
    ADAPTER_UPDATE_DISABLE: 'true', ANALYTICS_ENABLED: 'false', RECAP_FORCE: 'false', RECAP_WITHOUT_DEVICE: 'false',
    CABLE_DISABLE: 'true', CABLE_FW_DISABLE: 'true', TERMINAL_BACKENDS: 'tmux', HARNESS_VIEWER_BROWSER: chrome,
    LOG_FRAMES: 'true', TMUX_REAP_INTERVAL_MS: '5000', TERMINAL_RECONCILE_INTERVAL_MS: '5000' }
  await exec(tmux, ['-L', prefix, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keeper'], { env: daemonEnv })
  cleanups.push(() => exec(tmux, ['-L', prefix, 'kill-server'], { env: daemonEnv }).catch(() => {}))
  const packages = ['agents/blender', 'viewers/model-viewer']
  const controls = join(root, 'controls-package')
  await mkdir(join(controls, 'template'), { recursive: true })
  await writeFile(join(controls, 'template/fixture.txt'), 'Disposable viewer input fixture')
  await writeFile(join(controls, 'AGENTS.md'), 'Disposable local viewer integration fixture.\n')
  await writeFile(join(controls, 'harness.json'), JSON.stringify({ spec: 1, id: 'fixture/hn-viewer', name: 'Viewer controls', engine: 'claude', workspace: { template: 'template', marker: 'fixture.txt' }, agent: { instructions: 'AGENTS.md' }, viewer: { command: './viewer.mjs', url: 'http://127.0.0.1:${port}/' } }))
  const controlHtml = '<html><body style="margin:0;background:#152238;color:white;font:32px sans-serif"><h1 style="position:absolute;left:20px;top:20px;margin:0;font-size:32px">Viewer input fixture</h1><button style="position:absolute;left:20px;top:100px;width:200px;height:56px;font-size:24px" onclick="fetch(\'/event?click=1\')">Click me</button><input aria-label="Viewer text" style="position:absolute;left:20px;top:180px;width:400px;height:56px;font-size:24px" oninput="fetch(\'/event?text=\'+encodeURIComponent(this.value))"><script>addEventListener("keydown",e=>fetch("/event?key="+encodeURIComponent(e.key)))</script></body></html>'
  await writeFile(join(controls, 'viewer.mjs'), `#!${process.execPath}\nimport {createServer} from 'node:http';import {appendFileSync} from 'node:fs';createServer((req,res)=>{if(req.url.startsWith('/event?')){appendFileSync(${JSON.stringify(join(root, 'viewer-events.log'))},req.url+'\\n');res.end('ok');return}res.setHeader('content-type','text/html');res.end(${JSON.stringify(controlHtml)})}).listen(Number(process.env.HARNESS_VIEWER_PORT),'127.0.0.1');\n`, { mode: 0o700 })
  await writeFile(join(root, 'dsh/installed.json'), JSON.stringify([...packages.map(path => {
    const dir = join(repo, 'store', path)
    return { id: JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8')).id, dir, source: dir, ref: null, commit: null, linked: true, installedAt: Date.now() }
  }), { id: 'fixture/hn-viewer', dir: controls, source: controls, ref: null, commit: null, linked: true, installedAt: Date.now() }]))
  const daemon = run('daemon', join(repo, 'cli'), ['--import', 'tsx', 'src/cli.ts', '__run'], daemonEnv)
  await until('real daemon ready', () => {
    if (daemon.exitCode !== null) throw new Error('Test daemon exited; inspect its isolated log')
    return fetch(`http://127.0.0.1:${ports.daemon}/api/status`, { headers: { 'x-adapter-local': '1' } }).then(r => r.json()).then(v => v.connected && v.discoveryReady).catch(() => false)
  })
  const setPassword = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'remote-password', 'set', '--stdin'], { cwd: join(repo, 'cli'), env: daemonEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  setPassword.stdin.end(password + '\n')
  const [passwordCode] = await once(setPassword, 'exit'); assert.equal(passwordCode, 0)
  owner = await desktop(machineId)
  const workspace = join(root, 'workspace')
  await cp(join(repo, 'store/agents/blender/template'), workspace, { recursive: true })
  await mkdir(join(workspace, 'out'), { recursive: true })
  const positions = Buffer.from(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]).buffer)
  await writeFile(join(workspace, 'out/triangle.gltf'), JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Live hn triangle' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ uri: `data:application/octet-stream;base64,${positions.toString('base64')}`, byteLength: positions.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }] }))
  const created = await owner.rpc('agent_create', { engine: 'claude', cwd: workspace, dsh: 'autonomous/blender', bypassPermission: false, name: 'hn Blender test', creationId: randomUUID() })
  agentId = created.agent?.id; assert.ok(agentId, JSON.stringify(created))
  let viewerUrl
  await until('real Blender viewer', async () => { const a = (await owner.rpc('agents_list')).agents.find(a => a.id === agentId); assert.ok(!a?.viewerError, a?.viewerError); viewerUrl = a?.viewerUrl; return viewerUrl })
  hnBinary = join(root, 'hn'); await cp(process.env.HN_VIEWER_BINARY, hnBinary)
  hnEnv = { ...daemonEnv, HN_SOCKET_NAME: prefix, HN_TMPDIR: root, HN_DESKTOP: 'off', HARNESS_TUI_DESK: 'off', HARNESS_TUI_NOTIFY: 'off' }
  cleanups.push(() => hn('kill-server').catch(() => {}))
  assert.equal((await hn('view', '-p', '-t', agentId)).stdout.trim(), viewerUrl)
  const link = (await hn('view', '-pw', '-t', agentId)).stdout.trim()
  assert.equal(new URL(link).origin, webBase)
  assert.equal(new URL(link).searchParams.get('agent'), agentId)
  pass('real hn discovers a real Blender harness and produces direct and private-browser destinations')
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-swiftshader'] })
  cleanups.push(() => browser.close())
  context = await browser.newContext({ viewport: { width: 1200, height: 850 } })
  // A wrong web build must not contact a production backend or sign-in provider.
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  const direct = await context.newPage(); await direct.goto(viewerUrl)
  await direct.waitForFunction(() => document.querySelector('#model-name')?.textContent === 'triangle.gltf' && !!document.querySelector('#tree .row'))
  await direct.screenshot({ path: join(root, 'blender-direct.png') })
  pass('Chrome opens the actual model viewer and renders the glTF fixture')
  await direct.close()
  const page = await context.newPage(), pageErrors = [], requests = []
  page.on('pageerror', e => pageErrors.push(e.message))
  page.on('request', req => requests.push(req.url()))
  await page.goto(link); await semantics(page)
  const exchanged = page.waitForResponse(r => r.url() === base + '/api/auth/exchange' && r.status() === 200, { timeout: 45000 })
  await page.getByRole('button', { name: 'Continue with SSO', exact: true }).click({ timeout: 45000 })
  await exchanged
  await page.waitForURL(url => url.searchParams.get('viewer') === '1' && url.searchParams.get('agent') === agentId, { timeout: 45000 })
  await semantics(page)
  await page.getByRole('textbox').fill(password, { timeout: 45000 })
  await page.getByRole('textbox').press('Enter')
  await until('browser linked machine', () => page.evaluate(() => localStorage.getItem('harness.web.v1.viewer_e2ee_machine_peers')?.includes('machineId')))
  await page.getByRole('textbox', { name: 'Viewer input' }).waitFor({ state: 'attached', timeout: 60000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(root, 'browser-companion.png') })
  await writeFile(join(root, 'browser-dom.html'), await page.content())
  assert.ok(!requests.some(u => /\/api\/desk(?:\?|$|\/)/.test(u)), 'viewer tab must not read or overwrite the desk')
  assert.deepEqual(pageErrors, [])
  pass('real browser sign-in round trip preserves hn destination and password-links to the isolated daemon')
  await mkdir(join(root, 'controls-workspace'))
  const second = await owner.rpc('agent_create', { engine: 'claude', cwd: join(root, 'controls-workspace'), dsh: 'fixture/hn-viewer', bypassPermission: false, name: 'hn input test', creationId: randomUUID() })
  controlsId = second.agent?.id; assert.ok(controlsId, JSON.stringify(second))
  await until('controls viewer', async () => (await owner.rpc('agents_list')).agents.some(a => a.id === controlsId && a.viewerUrl))
  const controlsLink = (await hn('view', '-pw', '-t', controlsId)).stdout.trim()
  await page.goto(controlsLink); await semantics(page)
  const input = page.getByRole('textbox', { name: 'Viewer input' })
  await input.waitFor({ state: 'attached', timeout: 60000 })
  async function pointer(x, y) {
    const bounds = await input.boundingBox(); assert.ok(bounds)
    await page.mouse.click(bounds.x + x * bounds.width / Math.max(160, Math.min(1920, Math.round(bounds.width))), bounds.y + y * bounds.height / Math.max(120, Math.min(1200, Math.round(bounds.height))))
  }
  const events = () => existsSync(join(root, 'viewer-events.log')) ? readFileSync(join(root, 'viewer-events.log'), 'utf8') : ''
  await pointer(100, 128)
  await until('real viewer mouse input', () => events().includes('click=1'))
  await pointer(150, 208)
  await page.keyboard.insertText('Hello é 中文')
  await until('real Unicode viewer input', () => events().includes(encodeURIComponent('Hello é 中文')))
  await page.keyboard.press('ArrowLeft')
  await until('real special key input', () => events().includes('key=ArrowLeft'))
  await page.setViewportSize({ width: 2400, height: 1400 })
  await page.waitForTimeout(800)
  const oldClicks = events().split('click=1').length
  await pointer(100, 128)
  await until('pointer mapping after renderer resolution cap', () => events().split('click=1').length > oldClicks)
  await page.screenshot({ path: join(root, 'browser-input-resized.png') })
  assert.ok(!existsSync(join(root, 'engine-input.log')), 'browser input must not reach the terminal')
  pass('real mouse, Unicode text, special keys and resize reach the viewer without typing into its terminal')
  await page.getByRole('button', { name: 'Reload viewer', exact: true }).click()
  await input.waitFor({ state: 'attached', timeout: 60000 })
  await page.setViewportSize({ width: 1200, height: 850 })
  await page.reload(); await semantics(page)
  await input.waitFor({ state: 'attached', timeout: 60000 })
  assert.ok(!requests.some(u => /\/api\/desk(?:\?|$|\/)/.test(u)))
  assert.deepEqual(pageErrors, [])
  pass('reload and a fresh browser connection recover the viewer without restoring the desk')
  await stop(backend)
  await input.waitFor({ state: 'detached', timeout: 45000 })
  await page.screenshot({ path: join(root, 'browser-disconnected.png') })
  backend = run('backend-restarted', join(repo, 'backend'), ['--import', 'tsx', 'src/server.ts'], backendEnv)
  await until('restarted backend health', () => fetch(base + '/api/health').then(r => r.ok).catch(() => false))
  await input.waitFor({ state: 'attached', timeout: 60000 })
  const beforeReconnectClick = events().split('click=1').length
  await pointer(100, 128)
  await until('input after backend reconnect', () => events().split('click=1').length > beforeReconnectClick)
  pass('a real backend outage shows disconnection and reconnects with working viewer input')
  await page.goto(webBase + '/?viewer=1&machine=%FF&agent=fixture')
  await semantics(page)
  await page.getByText('This viewer link is incomplete. Run hn view again.', { exact: true }).waitFor()
  assert.ok(!requests.some(u => /\/api\/desk(?:\?|$|\/)/.test(u)))
  assert.deepEqual(pageErrors, [])
  assert.ok(!existsSync(join(root, 'engine-input.log')))
  pass('a malformed UTF-8 viewer link shows recovery guidance without opening the workspace')
  assert.ok((await owner.rpc('agents_list')).agents.some(a => a.id === agentId))
  await page.close()
  assert.ok((await owner.rpc('agents_list')).agents.some(a => a.id === agentId))
  pass('closing the browser leaves the harness running')

  // A real daemon expires the stream if this disposable hn process stops sending alive/acks.
  // Its tmux program must survive; waking the client must restore the existing pane and input.
  await hn('new-session', '-d', '-s', 'recovery')
  await hn('open-harness', '-s', agentId)
  const terminalPane = (await hn('display-message', '-p', '#{pane_id}')).stdout.trim()
  await until('real terminal before pause', async () => (await hn('capture-pane', '-p', '-t', terminalPane)).stdout.includes('HN_VIEWER_ENGINE_READY'))
  const terminalBefore = (await exec(tmux, ['-L', prefix, 'list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'], { env: daemonEnv })).stdout
  const hnPid = Number((await hn('display-message', '-p', '#{pid}')).stdout.trim())
  assert.ok(Number.isInteger(hnPid) && hnPid > 1)
  const command = (await exec('ps', ['-p', String(hnPid), '-o', 'command='])).stdout.trim()
  assert.ok(command.startsWith(hnBinary + ' ') && command.includes(`-L ${prefix} `), 'only stop this fixture hn')
  const daemonLog = join(root, 'daemon.log')
  const logStart = (await readFile(daemonLog, 'utf8')).length
  process.kill(hnPid, 'SIGSTOP')
  try {
    await until('actual daemon heartbeat expiry', async () => (await readFile(daemonLog, 'utf8')).slice(logStart).includes("reason: 'heartbeat timeout'"), 45000)
  } finally {
    process.kill(hnPid, 'SIGCONT')
  }
  // capture-pane contains the previous screen during reconnect; the input round trip proves live I/O.
  await until('real terminal accepts input after lease expiry', async () => {
    await hn('send-keys', '-t', terminalPane, '-l', 'HN_LEASE_RECOVERED')
    return (await hn('capture-pane', '-p', '-t', terminalPane)).stdout.includes('ECHO:HN_LEASE_RECOVERED')
  }, 15000)
  const terminalAfter = (await exec(tmux, ['-L', prefix, 'list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'], { env: daemonEnv })).stdout
  assert.equal(terminalAfter, terminalBefore, 'recovery must keep the same programs')
  assert.equal((await hn('display-message', '-p', '-t', terminalPane, '#{pane_id}')).stdout.trim(), terminalPane)
  pass('real daemon lease expiry recovers the same hn pane and process with working terminal input')
  // A second, isolated hn client uses the real shared desk through this daemon/backend.
  // Start with stacked panes, then exercise the actual prefix key through a private PTY.
  const layoutPrefix = prefix + '-layout', outerPrefix = prefix + '-layout-outer'
  const layoutEnv = { ...hnEnv, HN_SOCKET_NAME: layoutPrefix, HARNESS_TUI_DESK: 'sync' }
  const layoutTab = randomUUID().replaceAll('-', '')
  const desk = async ops => {
    const response = await fetch(`http://127.0.0.1:${ports.daemon}/api/desk${ops ? '/ops' : ''}`, {
      method: ops ? 'POST' : 'GET', headers: { 'x-adapter-local': '1', 'content-type': 'application/json' },
      ...(ops ? { body: JSON.stringify({ ops }) } : {}),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    return result.data ?? result
  }
  const layoutHn = (...args) => {
    assert.equal(layoutEnv.PORT, String(ports.daemon)); assert.equal(layoutEnv.HN_SOCKET_NAME, layoutPrefix)
    return exec(hnBinary, ['-L', layoutPrefix, '--port', String(ports.daemon), '-f', '/dev/null', ...args], { env: layoutEnv, timeout: 15000 })
  }
  const outer = (...args) => exec(tmux, ['-L', outerPrefix, ...args], { env: layoutEnv, timeout: 15000 })
  await desk([
    { op: 'tab.create', id: layoutTab, name: 'Layout fixture', nameIsCustom: true },
    ...[agentId, controlsId].map(id => ({ op: 'pane.add', tabId: layoutTab, machineId, agentId: id })),
    { op: 'tab.layout', id: layoutTab, layout: { presets: { 2: 'rows' } } },
  ])
  cleanups.push(() => outer('kill-server').catch(() => {}))
  cleanups.push(() => layoutHn('kill-server').catch(() => {}))
  await outer('-f', '/dev/null', 'new-session', '-d', '-s', 'layout', '-x', '120', '-y', '36',
    'env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET', hnBinary, '-L', layoutPrefix,
    '--port', String(ports.daemon), '-f', '/dev/null')
  await until('real desk panes', async () => (await outer('capture-pane', '-p', '-t', 'layout')).stdout.includes('HN_VIEWER_ENGINE_READY'))
  await until('two real desk panes', async () => (await layoutHn('display-message', '-p', '#{window_panes}')).stdout.trim() === '2')
  const paneIds = (await layoutHn('list-panes', '-F', '#{pane_id}')).stdout
  await outer('send-keys', '-t', 'layout', 'C-b', 'Space')
  await until('C-b Space changes real desk to columns', async () => {
    const positions = (await layoutHn('list-panes', '-F', '#{pane_left} #{pane_top}')).stdout.trim().split('\n').map(row => row.split(' '))
    return positions.length === 2 && positions[0][0] !== positions[1][0] && positions[0][1] === positions[1][1]
  })
  const chosen = (await layoutHn('display-message', '-p', '#{window_layout}')).stdout.trim()
  await until('real backend stores native layout', async () => (await desk()).tabs.find(t => t.id === layoutTab)?.layout?.tmux === chosen)
  await desk([{ op: 'tab.rename', id: layoutTab, name: 'Remote rename', nameIsCustom: true }])
  for (let i = 0; i < 12; i++) {
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal((await layoutHn('display-message', '-p', '#{window_layout}')).stdout.trim(), chosen, 'real desk reply reverted the layout')
  }
  assert.equal((await layoutHn('list-panes', '-F', '#{pane_id}')).stdout, paneIds)
  const desktopLayout = structuredClone((await desk()).tabs.find(t => t.id === layoutTab).layout)
  assert.equal(desktopLayout.presets['2'], 'columns', 'C-b Space must update the desktop preset too')
  delete desktopLayout.tmux
  desktopLayout.sizes = {}
  await desk([{ op: 'tab.layout', id: layoutTab, layout: desktopLayout }])
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal((await layoutHn('display-message', '-p', '#{window_layout}')).stdout.trim(), chosen,
      'desktop layout serialization reset the real terminal')
  }
  desktopLayout.presets['2'] = 'rows'
  await desk([{ op: 'tab.layout', id: layoutTab, layout: desktopLayout }])
  await until('intentional desktop layout reaches hn', async () => {
    const positions = (await layoutHn('list-panes', '-F', '#{pane_left} #{pane_top}')).stdout.trim().split('\n').map(row => row.split(' '))
    return positions.length === 2 && positions[0][0] === positions[1][0] && positions[0][1] !== positions[1][1]
  })
  assert.equal((await layoutHn('list-panes', '-F', '#{pane_id}')).stdout, paneIds)
  pass('real C-b Space survives desktop serialization; deliberate remote changes still apply without replacing panes')
  // Reordering from desktop uses the same real desk API as the UI. Keep the
  // unequal slots and focused harness, then exercise the reverse direction.
  const placed = async () => (await layoutHn('list-panes', '-F',
    '#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}')).stdout.trim().split('\n')
      .map(row => row.split('|')).sort((a, b) => Number(a[2]) - Number(b[2]) || Number(a[1]) - Number(b[1]))
  const initial = await placed()
  await layoutHn('select-pane', '-t', initial[1][0])
  await layoutHn('resize-pane', '-t', initial[0][0], '-D', '2')
  const resized = (await layoutHn('display-message', '-p', '#{window_layout}')).stdout.trim()
  await until('real divider saved before reorder', async () => (await desk()).tabs.find(t => t.id === layoutTab)?.layout?.tmux === resized)
  const slots = (await placed()).map(row => row.slice(1))
  await desk([{ op: 'pane.move', tabId: layoutTab, machineId, agentId: controlsId, index: 0 }])
  await until('real desktop reorder reaches hn', async () => (await placed())[0][0] === initial[1][0])
  assert.deepEqual((await placed()).map(row => row.slice(1)), slots)
  assert.equal((await layoutHn('display-message', '-p', '#{pane_id}')).stdout.trim(), initial[1][0])
  await layoutHn('swap-pane', '-s', initial[0][0], '-t', initial[1][0], '-d')
  await until('real terminal swap reaches desktop', async () => (await desk()).tabs.find(t => t.id === layoutTab).panes[0].agentId === agentId)
  assert.deepEqual((await placed()).map(row => row[0]), initial.map(row => row[0]))
  pass('desktop reorder and terminal swap share pane order through the real backend, preserving focus and dividers')
  await layoutHn('kill-server')

  await owner.rpc('agent_delete', { agentId: controlsId }); controlsId = null
  await owner.rpc('agent_delete', { agentId }); agentId = null
  complete = true
} catch (error) {
  if (context) for (const [i, page] of context.pages().entries()) {
    await page.screenshot({ path: join(root, `failure-${i}.png`), timeout: 5000 }).catch(() => {})
    await writeFile(join(root, `failure-${i}.html`), await page.content().catch(() => 'unavailable'))
  }
  throw error
} finally {
  if (controlsId && owner?.ws.readyState === WebSocket.OPEN) await owner.rpc('agent_delete', { agentId: controlsId }).catch(() => {})
  if (agentId && owner?.ws.readyState === WebSocket.OPEN) await owner.rpc('agent_delete', { agentId }).catch(() => {})
  for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch (error) { console.error('Cleanup:', error.message) } }
  await writeFile(join(root, 'results.json'), JSON.stringify({ complete, checks, topology: 'one physical Mac; real daemon/backend/Mongo/Redis/Chrome; fixture OAuth provider/model process' }, null, 2))
}
