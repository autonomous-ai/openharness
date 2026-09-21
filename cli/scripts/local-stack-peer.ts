/** Disposable backend + daemon for Desktop's local_stack_e2e_test.dart.
 * Real Mongo/Redis, SSO validation boundary, WebSockets, E2EE and tmux. Only the
 * identity provider and model CLI are deterministic fixtures; no real account.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as netServer, createConnection } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { newIdentity, b64e } from '../src/lib/e2ee/core.js'
import { RelaySessionCrypto } from '../src/lib/e2ee/relayClient.js'
import { decodeTerminalLocal, encodeTerminalLocal } from '../src/lib/terminalBinary.js'

if (process.env.HARNESS_STACK_E2E !== '1') throw new Error('Opt in with HARNESS_STACK_E2E=1')
const exec = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await mkdtemp(join(tmpdir(), 'harness-stack-'))
const socket = join(root, 'tmux.sock')
const docker = process.env.HARNESS_E2E_DOCKER_CONTEXT
  ? ['--context', process.env.HARNESS_E2E_DOCKER_CONTEXT] : []
const containers: string[] = []
const children: ChildProcess[] = []
const token = `fixture-${randomUUID()}`
const computerId = randomUUID().replaceAll('-', '')
const clientIdentity = newIdentity()
const machineIdentity = newIdentity()
let daemon: ChildProcess | undefined
let stopping = false
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(label: string, check: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return
    await delay(150)
  }
  throw new Error(`Timed out: ${label}; logs: ${root}`)
}
async function freePort() {
  const server = netServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
function run(name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(root, `${name}.log`), { flags: 'a' })
  child.stdout!.pipe(log)
  child.stderr!.pipe(log)
  children.push(child)
  return child
}
async function stop(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode != null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  await until('child exit', async () => child.exitCode != null || child.signalCode != null, 5000)
    .catch(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* exited */ } })
}
async function cleanup(code: number) {
  if (stopping) return
  stopping = true
  for (const child of children.reverse()) await stop(child)
  await exec('tmux', ['-S', socket, 'kill-server']).catch(() => {})
  for (const name of containers) await exec('docker', [...docker, 'rm', '-f', name]).catch(() => {})
  if (code === 0 && process.env.HARNESS_STACK_KEEP !== '1') await rm(root, { recursive: true, force: true })
  else console.error(`Stack fixture logs retained at ${root}`)
  process.exit(code)
}
process.on('SIGTERM', () => { void cleanup(0) })
process.on('SIGINT', () => { void cleanup(0) })
process.stdin.resume()
process.stdin.on('end', () => { void cleanup(0) })
process.on('uncaughtException', error => { console.error(error); void cleanup(1) })
process.on('unhandledRejection', error => { console.error(error); void cleanup(1) })

try {
  const [mongoPort, redisPort, backendPort, proxyPort, cliPort] = await Promise.all(Array.from({ length: 5 }, freePort))
  const sso = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); return }
    res.end(JSON.stringify({ status: 1, data: { id: computerId, email: `${computerId}@local.invalid` } }))
  })
  await new Promise<void>(resolve => sso.listen(0, '127.0.0.1', resolve))
  const ssoPort = (sso.address() as { port: number }).port
  for (const [kind, port, image, args] of [
    ['mongo', mongoPort, 'mongo:7', ['--replSet', 'rs0', '--bind_ip_all']],
    ['redis', redisPort, 'redis:7-alpine', []],
  ] as const) {
    const name = `harness-stack-${kind}-${process.pid}`
    containers.push(name)
    await exec('docker', [...docker, 'run', '--rm', '-d', '--name', name,
      '-p', `127.0.0.1:${port}:${kind === 'mongo' ? 27017 : 6379}`, image, ...args], { timeout: 120_000 })
  }
  await until('Mongo replica set', async () => {
    await exec('docker', [...docker, 'exec', containers[0]!, 'mongosh', '--quiet', '--eval',
      'try { if (rs.status().ok === 1) quit(0) } catch (_) { try { rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]}) } catch (_) {} } quit(1)'])
    return true
  }, 60_000)
  await until('Redis published port', () => new Promise<boolean>(resolve => {
    const client = createConnection({ host: '127.0.0.1', port: redisPort })
    const finish = (ok: boolean) => { client.destroy(); resolve(ok) }
    client.setTimeout(1000)
    client.on('connect', () => client.write('PING\r\n'))
    client.on('data', data => finish(data.toString().includes('PONG')))
    client.on('error', () => finish(false))
    client.on('timeout', () => finish(false))
  }))
  const backendEnv = { ...process.env, NODE_ENV: 'test', PORT: String(backendPort), PORT_APP_PROXY: String(proxyPort),
    DATABASE_URL: `mongodb://127.0.0.1:${mongoPort}/harness?replicaSet=rs0&directConnection=true`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false',
    SSO_PROFILE_URL: `http://127.0.0.1:${ssoPort}/profile`, SSO_IDENTITY_URL: '', TERMINAL_P2P_ROLLOUT_PERCENT: '0',
    HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'],
    { cwd: join(repo, 'backend'), env: backendEnv, timeout: 60_000 })
  run('backend', join(repo, 'backend'), ['--import', 'tsx', 'src/server.ts'], backendEnv)
  const backendUrl = `http://127.0.0.1:${backendPort}`
  await until('backend health', async () => (await fetch(`${backendUrl}/api/health`)).ok)
  const resolved = await fetch(`${backendUrl}/api/machines/resolve-computer`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-autonomous-env': 'prod' },
    body: JSON.stringify({ computerId, label: 'E2E fixture' }) })
  const body = await resolved.json() as { data?: { machine?: { machineId?: string } } }
  const machineId = body.data?.machine?.machineId
  if (!resolved.ok || !machineId) throw new Error(`Fixture machine registration failed (${resolved.status})`)
  const dataDir = join(root, 'data'), authDir = join(root, 'auth'), workspace = join(root, 'project')
  for (const path of [join(dataDir, 'e2e'), authDir, workspace, join(root, 'bin')]) await mkdir(path, { recursive: true })
  await writeFile(join(authDir, 'session.json'), JSON.stringify({ version: 1, accessToken: token,
    refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, autonomousEnv: 'prod', computerId, machineId, updatedAt: Date.now() }), { mode: 0o600 })
  await writeFile(join(dataDir, 'e2e/identity.json'), JSON.stringify({ priv: b64e(machineIdentity.priv), pub: b64e(machineIdentity.pub) }), { mode: 0o600 })
  await writeFile(join(dataDir, 'e2e/paired.json'), JSON.stringify([{ identityPub: b64e(clientIdentity.pub), label: 'E2E client', pairedAt: Date.now(), role: 'web' }]), { mode: 0o600 })
  const engine = join(root, 'bin/codex')
  await writeFile(engine, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0) }
process.title = 'codex';
process.stdin.setRawMode?.(true);
console.log('STACK_READY pid=' + process.pid);
process.stdin.on('data', chunk => process.stdout.write('ECHO:' + chunk.toString() + '\\r\\n'));
setInterval(() => {}, 1000);
`, { mode: 0o700 })
  await exec('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keeper'])
  const daemonEnv = { ...process.env, NODE_ENV: 'test', TMUX: `${socket},0,0`, PORT: String(cliPort),
    HARNESS_AUTH_DIR: authDir, ADAPTER_COMPUTER_ID: computerId, ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    ADAPTER_DATA_DIR: dataDir, DSH_DIR: join(root, 'dsh'), CODEX_PATH: engine,
    BACKEND_WS_URL: `ws://127.0.0.1:${backendPort}`, WEB_URL: backendUrl,
    DISABLE_HOOK_INSTALL: 'true', ADAPTER_UPDATE_DISABLE: 'true', ANALYTICS_ENABLED: 'false', RECAP_FORCE: 'false',
    RECAP_WITHOUT_DEVICE: 'false', CABLE_DISABLE: 'true', CABLE_FW_DISABLE: 'true',
    TMUX_REAP_INTERVAL_MS: '5000', TERMINAL_RECONCILE_INTERVAL_MS: '5000', TERMINAL_BACKENDS: 'tmux', CLAUDE_PROJECTS_DIR: join(root, 'claude-projects') }
  const dshSource = join(root, 'harness-source')
  await mkdir(join(dshSource, 'template'), { recursive: true })
  await mkdir(join(dshSource, 'skills/example'), { recursive: true })
  await writeFile(join(dshSource, 'harness.json'), JSON.stringify({
    spec: 1, id: 'fixture/example', name: 'Example', engine: 'codex',
    workspace: { template: 'template', marker: 'example.txt' },
    agent: { instructions: 'AGENTS.md', skills: ['skills'] },
    viewer: { command: './viewer.mjs', url: 'http://127.0.0.1:${port}/' },
    verdict: '.harness/verdict.json',
  }))
  await writeFile(join(dshSource, 'AGENTS.md'), 'Fixture instructions.\n')
  await writeFile(join(dshSource, 'skills/example/SKILL.md'), '---\nname: example\ndescription: Fixture skill.\n---\nFixture.\n')
  await writeFile(join(dshSource, 'template/example.txt'), 'Fixture artifact\n')
  await writeFile(join(dshSource, 'viewer.mjs'), `#!${process.execPath}
import { createServer } from 'node:http';
createServer((_, res) => res.end('Fixture viewer')).listen(Number(process.env.HARNESS_VIEWER_PORT), '127.0.0.1');
`, { mode: 0o700 })
  await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'dsh', 'install', dshSource, '--link'],
    { cwd: join(repo, 'cli'), env: daemonEnv, timeout: 30_000 })
  async function bootDaemon() {
    daemon = run('daemon', join(repo, 'cli'), ['--import', 'tsx', 'src/cli.ts', '__run'], daemonEnv)
    await until('daemon connection', async () => {
      const status = await fetch(`http://127.0.0.1:${cliPort}/api/status`, { headers: { 'x-adapter-local': '1' } }).then(r => r.json()) as { connected?: boolean }
      return status.connected === true
    })
  }
  await bootDaemon()

  // Desktop sees its normal loopback protocol; the other leg uses the real
  // backend plus the production signed handshake and encrypted terminal codec.
  const bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => bridge.once('listening', resolve))
  let encryptedFrames = 0
  bridge.on('connection', local => {
    const crypto = new RelaySessionCrypto({ machineId, selfIdentity: clientIdentity, peerPub: machineIdentity.pub })
    const remote = new WebSocket(`ws://127.0.0.1:${backendPort}/api/web-ws`, [token])
    remote.on('open', () => remote.send(JSON.stringify({ type: 'machine_select', payload: { machineId } })))
    remote.on('error', () => local.close())
    remote.on('close', () => local.close())
    local.on('close', () => remote.close())
    remote.on('message', (raw, binary) => {
      if (local.readyState !== WebSocket.OPEN) return
      if (binary) {
        const clear = crypto.decryptTerminal(new Uint8Array(raw as Buffer))
        if (clear) { encryptedFrames++; local.send(encodeTerminalLocal(clear)) }
        return
      }
      const frame = JSON.parse(raw.toString())
      if (frame.type === 'connected') { remote.send(JSON.stringify(crypto.helloFrame())); return }
      if (frame.type === 'e2e_welcome') {
        if (!crypto.handleWelcome(frame.payload)) throw new Error('E2EE welcome authentication failed')
        local.send(JSON.stringify({ type: 'connected', payload: { machineId } }))
        return
      }
      const decoded = crypto.unwrapIncoming(frame)
      if (decoded) local.send(JSON.stringify(decoded))
    })
    local.on('message', (raw, binary) => {
      if (binary) {
        const clear = decodeTerminalLocal(new Uint8Array(raw as Buffer))
        const sealed = clear && crypto.encryptTerminal(clear)
        if (sealed) { encryptedFrames++; remote.send(sealed) }
      } else {
        const frame = JSON.parse(raw.toString())
        if (frame.type !== 'machine_select') remote.send(JSON.stringify(crypto.wrapOutgoing(frame)))
      }
    })
  })
  const control = createServer((req, res) => {
    void (async () => {
      if (req.url === '/restart') { await stop(daemon); await bootDaemon() }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ encryptedFrames }))
    })().catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  await new Promise<void>(resolve => control.listen(0, '127.0.0.1', resolve))
  console.log(JSON.stringify({ machineId, workspace, localPort: cliPort,
    remotePort: (bridge.address() as { port: number }).port,
    controlPort: (control.address() as { port: number }).port, logs: root }))
} catch (error) { console.error(error); await cleanup(1) }
