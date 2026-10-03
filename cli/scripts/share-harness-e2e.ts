/** Real backend, Mongo/Redis, three isolated daemons, tmux and Chrome. Only SSO and the model are fixtures.
 * HARNESS_SHARE_E2E_SERVICES points to {"mongo":"mongodb://127.0.0.1:.../?replicaSet=...","redis":"redis://127.0.0.1:..."}.
 * Services MUST be disposable. Every daemon, browser, identity, terminal and project belongs to this run.
 */
import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { WebSocket } from 'ws'
import { b64e, newEphemeral } from '../src/lib/e2ee/core.js'
import { recipientHandshake, type ObserverCipher } from '../src/sharing/crypto.js'
import { decodeTerminalLocal, encodeTerminalLocal, TerminalBinaryKind, type TerminalBinaryClear } from '../src/lib/terminalBinary.js'

if (!process.env.HARNESS_SHARE_E2E_SERVICES) throw new Error('Set HARNESS_SHARE_E2E_SERVICES to disposable service URLs.')
const exec = promisify(execFile), repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await mkdtemp(join(tmpdir(), 'harness-share-e2e-'))
const services = JSON.parse(await readFile(process.env.HARNESS_SHARE_E2E_SERVICES, 'utf8'))
const mongo = new URL(services.mongo), redis = new URL(services.redis)
assert.equal(mongo.hostname, '127.0.0.1'); assert.equal(redis.hostname, '127.0.0.1')
mongo.pathname = `/sharing_${randomUUID().replaceAll('-', '')}`
const children: ChildProcess[] = [], sockets: WebSocket[] = []
const tmuxSockets: string[] = []
const accounts = ['owner', 'ken', 'diego', 'stranger'].map(name => ({ name, token: randomUUID(), id: randomUUID(), email: `${name}@sharing.local.invalid` }))
let backendUrl = ''
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(label: string, check: () => boolean | Promise<boolean>, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(60) }
  throw new Error(`Timed out: ${label}. Logs: ${root}`)
}
async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
function run(name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(root, `${name}.log`)); child.stdout!.pipe(log); child.stderr!.pipe(log)
  children.push(child); return child
}
async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  await until('child exit', () => child.exitCode != null || child.signalCode != null, 5000)
    .catch(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} })
}
async function api(account: typeof accounts[number], path: string, method = 'GET', body?: unknown) {
  const response = await fetch(backendUrl + path, { method,
    headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json', 'x-autonomous-env': 'prod' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  return { status: response.status, body: await response.json() as any }
}
class Peer {
  readonly frames: any[] = []
  readonly binary: TerminalBinaryClear[] = []
  text = ''; stream = ''; closedCode: number | undefined; private inputSequence = 0
  private heartbeat: NodeJS.Timeout
  private cipher: ObserverCipher | null = null
  constructor(readonly ws: WebSocket, private readonly observation?: { machineId: string; id: string; ownerPublicKey: string }) {
    const ephemeral = newEphemeral()
    sockets.push(ws)
    ws.on('message', (raw, binary) => {
      let clear: any = binary ? null : JSON.parse(raw.toString())
      if (observation && clear?.type === 'observer_connected') {
        ws.send(JSON.stringify({ type: 'observer_hello', payload: { ephemeral: b64e(ephemeral.pub) } })); return
      }
      if (observation && clear?.type === 'observer_welcome') {
        this.cipher = recipientHandshake(ephemeral, observation.machineId, observation.id, observation.ownerPublicKey, clear.payload); return
      }
      if (observation && clear?.type === 'observer_closed') { ws.close(clear.payload.retry ? 1012 : 4403); return }
      if (observation && clear?.type === 'observer_frame') { clear = this.cipher!.open(clear.payload); assert.ok(clear) }
      if (binary || clear?.type === 'observer_binary') {
        const frame = decodeTerminalLocal(binary ? new Uint8Array(raw as Buffer) : Buffer.from(clear.payload.bytes, 'base64'))
        if (!frame) return
        this.binary.push(frame)
        this.text += (frame.compressed ? inflateSync(frame.bytes) : Buffer.from(frame.bytes)).toString()
        this.send('terminal_ack', { streamId: frame.streamId, lastSeq: frame.seq })
      } else {
        const frame = clear; this.frames.push(frame)
        if (frame.type === 'terminal_ready') { this.stream = frame.payload.streamId; this.inputSequence = 0 }
      }
    })
    ws.on('error', () => {})
    ws.on('close', code => { this.closedCode = code; clearInterval(this.heartbeat) })
    this.heartbeat = setInterval(() => { if (this.stream) this.send('terminal_alive', { streamId: this.stream }) }, 5000)
  }
  static async connect(port: number, machineId: string, shareId?: string) {
    const peer = new Peer(new WebSocket(`ws://127.0.0.1:${port}/api/local-ws`))
    await new Promise<void>((resolve, reject) => { peer.ws.once('open', resolve); peer.ws.once('error', reject) })
    peer.send('machine_select', { machineId, localProtocolVersion: 1, ...(shareId ? { shareId } : {}) })
    await until('local peer admission', () => peer.frames.some(f => f.type === 'connected') || peer.closedCode !== undefined)
    return peer
  }
  static async observe(link: { machineId: string; id: string; ownerPublicKey: string }, token?: string) {
    const peer = new Peer(new WebSocket(`${backendUrl.replace('http:', 'ws:')}/api/observer-ws?link=${link.id}`, token ? [token] : undefined), link)
    await until('browser observer admission', () => peer.cipher !== null || peer.closedCode !== undefined)
    return peer
  }
  send(type: string, payload: Record<string, unknown> = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) return
    const frame = this.observation ? { type: 'observer_frame', payload: this.cipher!.seal({ type, payload }) } : { type, payload }
    this.ws.send(JSON.stringify(frame))
  }
  async rpc(type: string, payload: Record<string, unknown> = {}) {
    const requestId = randomUUID(); this.send(type, { ...payload, requestId })
    await until(type, () => this.frames.some(f => f.payload?.requestId === requestId)).catch(async error => {
      await writeFile(join(root, 'rpc-failure.json'), JSON.stringify({ type, requestId, closedCode: this.closedCode, frames: this.frames }, null, 2)); throw error
    })
    return this.frames.find(f => f.payload?.requestId === requestId)!.payload
  }
  async open(agentId: string, cols = 120, rows = 40) {
    const response = await this.rpc('terminal_open', { protocolVersion: 3, agentId, cols, rows })
    assert.ok(!response.code && this.stream, JSON.stringify(response))
    await until('terminal snapshot', () => this.binary.some(f => f.kind === TerminalBinaryKind.keyframe))
    return response
  }
  input(text: string) {
    const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId: this.stream, seq: this.inputSequence++, compressed: false, bytes: Buffer.from(text) })!
    this.ws.send(frame)
  }
  async close() { clearInterval(this.heartbeat); this.ws.close(); await until('socket close', () => this.closedCode !== undefined) }
}
const sso = createServer((req, res) => {
  const user = accounts.find(a => req.headers.authorization === `Bearer ${a.token}`)
  res.setHeader('content-type', 'application/json')
  if (!user) { res.writeHead(401); res.end('{}'); return }
  res.end(JSON.stringify({ status: 1, data: { id: user.id, email: user.email } }))
})
let success = false
try {
  await new Promise<void>(resolve => sso.listen(0, '127.0.0.1', resolve))
  const backendPort = process.env.HARNESS_SHARE_BACKEND_PORT ? Number(process.env.HARNESS_SHARE_BACKEND_PORT) : await freePort()
  const proxyPort = await freePort()
  backendUrl = `http://127.0.0.1:${backendPort}`
  const backendEnv = { ...process.env, NODE_ENV: 'test', PORT: String(backendPort), PORT_APP_PROXY: String(proxyPort),
    DATABASE_URL: mongo.href, REDIS_URL: redis.href, HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false',
    SSO_PROFILE_URL: `http://127.0.0.1:${(sso.address() as { port: number }).port}/profile`,
    SSO_IDENTITY_URL: '', // the stand-in SSO has only /profile; never prove rig tokens against the real BFF
    TERMINAL_P2P_ROLLOUT_PERCENT: '0', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], { cwd: join(repo, 'backend'), env: backendEnv, timeout: 60_000 })
  run('backend', join(repo, 'backend'), ['--import', 'tsx', 'src/server.ts'], backendEnv)
  await until('backend', async () => fetch(`${backendUrl}/api/health`).then(r => r.ok).catch(() => false))
  const engine = join(root, 'codex')
  await writeFile(engine, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0) }\nif (process.argv.includes('--help')) { console.log('--approve-for-me --dangerously-bypass-approvals-and-sandbox --ask-for-approval'); process.exit(0) }\nconst { appendFileSync } = require('node:fs'); process.title = 'codex'; process.stdin.setRawMode?.(true); console.log('SHARING_READY'); process.stdin.on('data', x => { appendFileSync(${JSON.stringify(join(root, 'fixture-input.bin'))}, x); process.stdout.write('ECHO:' + x + '\\r\\n'); }); setInterval(() => {}, 1000);\n`, { mode: 0o700 })
  const fixture = join(root, 'harness-source')
  await mkdir(join(fixture, 'template'), { recursive: true })
  await writeFile(join(fixture, 'harness.json'), JSON.stringify({ spec: 1, id: 'fixture/sharing', name: 'Sharing demo', engine: 'codex',
    workspace: { template: 'template', marker: 'result.txt' }, agent: { instructions: 'AGENTS.md' },
    viewer: { command: './viewer.mjs', url: 'http://127.0.0.1:${port}/' }, verdict: '.harness/verdict.json' }))
  await writeFile(join(fixture, 'AGENTS.md'), 'Share harness test fixture.\n')
  await writeFile(join(fixture, 'template/result.txt'), 'Sharing demo')
  const viewerPage = `<html><body style="margin:0;background:#152238;color:white;font:40px sans-serif"><h1 style="position:absolute;left:20px;top:20px;margin:0;font-size:36px">Live harness</h1><button style="position:absolute;left:20px;top:100px;width:200px;height:56px;font-size:24px" onclick="fetch('/event?click=1')">Click me</button><input aria-label="Viewer text" style="position:absolute;left:20px;top:180px;width:400px;height:56px;font-size:24px" oninput="fetch('/event?text='+encodeURIComponent(this.value))"><p id="clock" style="position:absolute;left:20px;top:250px"></p><script>setInterval(() => document.getElementById('clock').textContent=Date.now(), 200)</script></body></html>`
  await writeFile(join(fixture, 'viewer.mjs'), `#!${process.execPath}\nimport { createServer } from 'node:http';\nimport { appendFileSync } from 'node:fs';\ncreateServer((req, res) => { if (req.url.startsWith('/event?')) { appendFileSync(${JSON.stringify(join(root, 'viewer-events.log'))}, req.url + '\\n'); res.end('ok'); return; } res.setHeader('Content-Type', 'text/html'); res.end(${JSON.stringify(viewerPage)}); }).listen(Number(process.env.HARNESS_VIEWER_PORT), '127.0.0.1');\n`, { mode: 0o700 })
  const machines: Array<{ machineId: string; port: number; env: NodeJS.ProcessEnv; child: ChildProcess; socket: string; workspace: string }> = []
  for (const account of accounts.slice(0, 3)) {
    const folder = join(root, account.name), data = join(folder, 'data'), auth = join(folder, 'auth'), workspace = join(folder, 'project')
    for (const dir of [data, auth, workspace]) await mkdir(dir, { recursive: true })
    const computerId = randomUUID(), port = await freePort(), socket = join(folder, 'tmux.sock')
    tmuxSockets.push(socket)
    const registered = await api(account, '/api/machines/resolve-computer', 'POST', { computerId, label: `${account.name} test machine` })
    assert.equal(registered.status, 200, JSON.stringify(registered))
    const machineId = registered.body.data.machine.machineId
    await writeFile(join(auth, 'session.json'), JSON.stringify({ version: 1, accessToken: account.token, refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3_600_000, autonomousEnv: 'prod', computerId, machineId, updatedAt: Date.now() }), { mode: 0o600 })
    await exec('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keeper'])
    const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8',
      NODE_ENV: 'test', HARNESS_SHARE_TEST_HOME: folder, LOG_FRAMES: 'true',
      NODE_OPTIONS: `--require=${join(repo, 'cli/scripts/share-harness-e2e-preload.cjs')}`,
      HARNESS_GRID_BIN: join(folder, 'no-grid'), DISABLE_GRID_INSTALL: 'true',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      TMUX: `${socket},0,0`, PORT: String(port), HARNESS_AUTH_DIR: auth,
      ADAPTER_COMPUTER_ID: computerId, ADAPTER_COMPUTER_ID_FILE: join(folder, 'computer-id'), ADAPTER_DATA_DIR: data,
      ADAPTER_RUNTIME_DIR: join(folder, 'runtime'), DSH_DIR: join(folder, 'dsh'), CODEX_PATH: engine,
      BACKEND_WS_URL: `ws://127.0.0.1:${backendPort}`, WEB_URL: backendUrl, HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog',
      DISABLE_HOOK_INSTALL: 'true', ADAPTER_UPDATE_DISABLE: 'true', ANALYTICS_ENABLED: 'false', RECAP_FORCE: 'false',
      RECAP_WITHOUT_DEVICE: 'false', CABLE_DISABLE: 'true', CABLE_FW_DISABLE: 'true', TERMINAL_BACKENDS: 'tmux',
      CLAUDE_PROJECTS_DIR: join(folder, 'claude-projects') }
    if (account.name === 'owner') await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'dsh', 'install', fixture, '--link'], { cwd: join(repo, 'cli'), env, timeout: 30_000 })
    const child = run(account.name, join(repo, 'cli'), ['--import', 'tsx', 'src/cli.ts', '__run'], env)
    await until(`${account.name} daemon`, async () => fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'x-adapter-local': '1' } }).then(r => r.json()).then((r: any) => r.connected === true).catch(() => false))
    machines.push({ machineId, port, env, child, socket, workspace })
  }
  const [host, kenMachine, diegoMachine] = machines
  let owner = await Peer.connect(host.port, host.machineId)
  const created = await owner.rpc('agent_create', { creationId: randomUUID(), engine: 'codex', cwd: host.workspace, dsh: 'fixture/sharing' })
  assert.equal(created.state, 'created', JSON.stringify(created)); const agentId = created.agent.id
  console.log('Created owner harness', agentId)
  await owner.open(agentId, 110, 33)
  await until('fixture model ready', () => owner.text.includes('SHARING_READY'))
  owner.input('owner-before-sharing')
  await until('owner terminal input', () => owner.text.includes('ECHO:owner-before-sharing'))
  const workspaceCheck = process.env.HARNESS_WORKSPACE_BROWSER_CHECK
  if (workspaceCheck) {
    const password = `Fixture-only-${randomUUID()}`
    const response = await fetch(`http://127.0.0.1:${host.port}/api/remote-password/set`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' },
      body: JSON.stringify({ password }),
    })
    assert.equal(response.status, 200, await response.text())
    const path = join(root, 'browser-workspace.json')
    await writeFile(path, JSON.stringify({ origin: process.env.HARNESS_SHARE_BROWSER_ORIGIN,
      backendUrl, token: accounts[0].token, machineId: host.machineId, agentId, password, root }), { mode: 0o600 })
    const result = await exec(process.execPath, [workspaceCheck, path], { env: process.env, timeout: 240_000 })
    console.log(result.stdout)
    // The browser took control and resized this terminal. Reclaim it explicitly before the
    // observer assertions below; viewers must inherit the controller's dimensions.
    await owner.open(agentId, 110, 33)
  }
  console.log('Owner input verified; inviting Ken and Diego')
  const invitation = await owner.rpc('harness_share_invite', { agentId, emails: [accounts[1].email.toUpperCase(), accounts[2].email], days: 30 })
  assert.equal(invitation.shares.length, 2, JSON.stringify(invitation))
  assert.ok(invitation.shares.every((s: any) => !s.pending && !s.error), JSON.stringify(invitation))
  const kenShare = invitation.shares.find((s: any) => s.email === accounts[1].email).id
  const diegoShare = invitation.shares.find((s: any) => s.email === accounts[2].email).id
  for (const account of accounts.slice(1, 3)) {
    const discovery = await api(account, '/api/harness-shares')
    assert.equal(discovery.body.data.machines.length, 1)
    const m = discovery.body.data.machines[0]
    assert.equal(m.shared, true); assert.equal(m.status, 'running'); assert.equal(m.shares.length, 1)
    assert.equal(m.shares[0].agentId, agentId); assert.ok(!m.apiKey && !m.computerId && !m.hostname)
  }
  assert.deepEqual((await api(accounts[3], '/api/harness-shares')).body.data.machines, [])
  assert.equal((await api(accounts[1], `/api/harness-shares/${kenShare}`, 'DELETE')).status, 404)
  console.log('Checking browser links and encrypted comments')
  const privateLink = (await owner.rpc('harness_share_link', { agentId, visibility: 'private' })).link
  assert.ok(privateLink.url && !privateLink.pending && !privateLink.error, JSON.stringify(privateLink))
  const discoverUrl = `${backendUrl}/api/shared-agents/${privateLink.id}`
  assert.equal((await fetch(discoverUrl)).status, 401)
  assert.equal((await api(accounts[3], `/api/shared-agents/${privateLink.id}`)).status, 403)
  const linkData = (await api(accounts[1], `/api/shared-agents/${privateLink.id}`)).body.data
  assert.equal(new URLSearchParams(new URL(privateLink.url).hash.slice(1)).get('key'), linkData.ownerPublicKey)
  const refused = await Peer.observe(linkData)
  assert.equal(refused.closedCode, 4403)
  const invited = await Peer.observe(linkData, accounts[1].token)
  await invited.open(agentId)
  const publicLink = (await owner.rpc('harness_share_link', { agentId, visibility: 'public' })).link
  assert.equal(publicLink.url, privateLink.url)
  assert.equal((await fetch(discoverUrl)).status, 200)
  const guest = await Peer.observe(linkData), commenter = await Peer.observe(linkData, accounts[3].token)
  await guest.open(agentId)
  assert.ok(guest.text.includes('owner-before-sharing'))
  assert.equal((await guest.rpc('observer_comment_post', { id: randomUUID(), text: 'anonymous spoof', authorId: 'owner', owner: true })).error, 'COMMENT_REJECTED')
  assert.equal((await guest.rpc('terminal_input', { agentId, data: 'ILLEGAL_PUBLIC_INPUT' })).code, 'VIEW_ONLY')
  const commentId = randomUUID()
  for (let retry = 0; retry < 2; retry++) assert.ok(!(await invited.rpc('observer_comment_post', { id: commentId, text: 'Fixture collaboration' })).error)
  const thread = await guest.rpc('observer_comments')
  assert.equal(thread.comments.length, 1); assert.equal(thread.canComment, false); assert.equal(thread.comments[0].canDelete, false)
  assert.equal((await commenter.rpc('observer_comment_remove', { id: commentId })).error, 'COMMENT_REJECTED')
  async function browserCheck(mode: string) {
    const check = process.env.HARNESS_SHARE_BROWSER_CHECK
    if (!check) return
    const path = join(root, `browser-${mode}.json`)
    await writeFile(path, JSON.stringify({ mode, origin: process.env.HARNESS_SHARE_BROWSER_ORIGIN,
      backendUrl, url: privateLink.url, token: mode === 'denied' ? accounts[3].token : accounts[1].token, root }))
    await exec(process.execPath, [check, path], { env: process.env, timeout: 120_000 })
    console.log(`PASS browser ${mode}`)
  }
  await browserCheck('public')
  await owner.rpc('harness_share_link', { agentId, visibility: 'private' })
  await until('private transition closes uninvited public viewers', () => guest.closedCode === 4403 && commenter.closedCode === 4403)
  assert.equal((await invited.rpc('observer_comments')).comments[0].text, 'Fixture collaboration')
  await browserCheck('private')
  await browserCheck('denied')
  await invited.close()
  console.log('Account discovery verified; connecting observers')
  let ken = await Peer.connect(kenMachine.port, host.machineId, kenShare)
  const diego = await Peer.connect(diegoMachine.port, host.machineId, diegoShare)
  for (const peer of [ken, diego]) {
    const ready = await peer.open(agentId, 200, 100)
    assert.equal(ready.readOnly, true)
    const frame = peer.binary.find(f => f.kind === TerminalBinaryKind.keyframe)!
    assert.equal(frame.cols, 110); assert.equal(frame.rows, 33)
    assert.ok(peer.text.includes('owner-before-sharing'))
    assert.equal((await peer.rpc('agent_delete', { agentId })).error, 'VIEW_ONLY')
    assert.equal((await peer.rpc('terminal_resize', { streamId: peer.stream, cols: 1, rows: 1 })).error, 'VIEW_ONLY')
    peer.input('UNAUTHORIZED_INPUT')
    peer.send('observer_viewer', { agentId })
  }
  owner.input('two-observers-世界')
  await until('owner and both observers receive live output', () => [owner, ken, diego].every(p => p.text.includes('ECHO:two-observers-世界')))
  assert.ok(!owner.text.includes('UNAUTHORIZED_INPUT'))
  await until('two recipients receive live viewer pixels', () => [ken, diego].every(p => p.frames.some(f => f.type === 'observer_viewer' && f.payload.state === 'live')), 45_000)
  const firstImage = ken.frames.find(f => f.type === 'observer_viewer' && f.payload.state === 'live').payload.data
  assert.equal(Buffer.from(firstImage, 'base64').subarray(0, 2).toString('hex'), 'ffd8')
  await until('viewer visibly updates', () => ken.frames.some(f => f.type === 'observer_viewer' && f.payload.data && f.payload.data !== firstImage))
  assert.equal((await owner.rpc('harness_share_list', { agentId })).shares.reduce((n: number, s: any) => n + s.watching, 0), 2)
  await ken.close()
  ken = await Peer.connect(kenMachine.port, host.machineId, kenShare); await ken.open(agentId)
  owner.input('reconnected-observer')
  await until('observer reconnect catches up', () => ken.text.includes('ECHO:reconnected-observer'))
  await owner.rpc('harness_share_remove', { agentId, id: kenShare })
  await until('immediate removal closes Ken', () => ken.closedCode === 4403)
  assert.deepEqual((await api(accounts[1], '/api/harness-shares')).body.data.machines, [])
  owner.input('only-diego-now')
  await until('Diego continues while Ken loses access', () => diego.text.includes('ECHO:only-diego-now'))
  assert.ok(!ken.text.includes('only-diego-now'))
  const denied = await Peer.connect(kenMachine.port, host.machineId, kenShare)
  assert.equal(denied.closedCode, 4403)
  await owner.close(); await stop(host.child)
  await until('owner disconnect is recoverable', () => diego.closedCode === 1012)
  await until('offline grant stays discoverable', async () => (await api(accounts[2], '/api/harness-shares')).body.data.machines[0]?.status === 'offline')
  host.child = run('owner-restarted', join(repo, 'cli'), ['--import', 'tsx', 'src/cli.ts', '__run'], host.env)
  await until('owner restarted', async () => fetch(`http://127.0.0.1:${host.port}/api/status`, { headers: { 'x-adapter-local': '1' } }).then(r => r.json()).then((r: any) => r.connected === true).catch(() => false))
  owner = await Peer.connect(host.port, host.machineId)
  assert.equal((await owner.rpc('harness_share_list', { agentId })).shares.length, 1)
  assert.equal((await owner.rpc('harness_share_comments', { agentId })).comments[0].text, 'Fixture collaboration')
  const rejoined = await Peer.connect(diegoMachine.port, host.machineId, diegoShare); await rejoined.open(agentId)
  await owner.open(agentId); owner.input('after-daemon-restart')
  await until('durable permission reconnect', () => rejoined.text.includes('ECHO:after-daemon-restart'))
  await owner.rpc('harness_share_remove', { agentId, id: diegoShare })
  await until('last observer removed', () => rejoined.closedCode === 4403)
  await owner.rpc('harness_share_link', { agentId, visibility: 'public' })
  const finalGuest = await Peer.observe(linkData); await finalGuest.open(agentId)
  await owner.rpc('harness_share_link', { agentId, visibility: 'off' })
  await until('stop sharing closes link viewers', () => finalGuest.closedCode === 4403)
  assert.equal((await fetch(discoverUrl)).status, 401)
  success = true
  console.log('PASS: public/private browser links → encrypted comments and moderation → daemon restart persistence → stop sharing → invite → account discovery → two read-only observers → encrypted live terminal/viewer → denied controls → reconnect → immediate revocation → offline discovery → durable daemon restart.')
} catch (error) {
  console.error(error)
  throw error
} finally {
  for (const ws of sockets) ws.terminate()
  await Promise.all(children.reverse().map(stop))
  for (const socket of tmuxSockets) await exec('tmux', ['-S', socket, 'kill-server'], { timeout: 3000 }).catch(() => {})
  sso.closeAllConnections()
  await new Promise<void>(resolve => sso.close(() => resolve()))
  if (success && process.env.HARNESS_SHARE_KEEP !== '1') await rm(root, { recursive: true, force: true })
  else console.error(`Sharing E2E logs: ${root}`)
}
