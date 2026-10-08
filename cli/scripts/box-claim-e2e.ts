/** Box ticket E2E: a headless box signed in with the ticket a phone issued (`/api/auth/box/ticket`,
 * `harness login --ticket=`). No Docker and no real account: the real backend on an in-memory Mongo
 * replica set and Redis, a fixture SSO profile standing in for the phone's sign-in, and two CLI boxes
 * each in its own HOME / auth / data folder under a temp root — never the developer's ~/.harness.
 *
 *   HARNESS_BOX_E2E=1 HARNESS_E2E_SERVICES_DIR=<dir with mongodb-memory-server and redis-memory-server> \
 *     npx tsx scripts/box-claim-e2e.ts
 *
 * HARNESS_E2E_MONGOD / HARNESS_E2E_REDIS_SERVER point at system binaries instead of downloaded ones.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

if (process.env.HARNESS_BOX_E2E !== '1') throw new Error('Opt in with HARNESS_BOX_E2E=1')
const servicesDir = process.env.HARNESS_E2E_SERVICES_DIR
if (!servicesDir) throw new Error('HARNESS_E2E_SERVICES_DIR must contain mongodb-memory-server and redis-memory-server')
const services = createRequire(join(resolve(servicesDir), 'package.json'))
const { MongoMemoryReplSet } = services('mongodb-memory-server')
const { RedisMemoryServer } = services('redis-memory-server')
const exec = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await mkdtemp(join(tmpdir(), 'harness-box-e2e-'))
const children: ChildProcess[] = []
const cleanups: Array<() => unknown | Promise<unknown>> = []
const boxes: Box[] = []
console.log(`Artifacts and logs: ${root}`)

const pass = (message: string) => console.log(`PASS ${message}`)
function check(ok: unknown, message: string, detail?: unknown): void {
  if (!ok) throw new Error(`${message}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
}
async function until(label: string, ok: () => Promise<unknown>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return
    await delay(250)
  }
  throw new Error(`Timed out: ${label}; logs: ${root}`)
}
async function freePort(): Promise<number> {
  const server = netServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

interface Box { name: string; home: string; port: number; computerId: string; env: NodeJS.ProcessEnv }
let cli = ''

/** A computer of its own: HOME, auth, data, tmux and port all under the temp root. */
async function newBox(name: string, backendPort: number): Promise<Box> {
  const home = join(root, name)
  await mkdir(join(home, 'tmux'), { recursive: true })
  const port = await freePort()
  const computerId = randomUUID()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMUX: '', TMUX_PANE: '', TMUX_TMPDIR: join(home, 'tmux'), HOME: home, PORT: String(port),
    HARNESS_AUTH_DIR: join(home, 'auth'), ADAPTER_DATA_DIR: join(home, 'data'),
    ADAPTER_RUNTIME_DIR: join(home, 'runtime'), ADAPTER_CLI_DIR: join(home, 'cli'),
    ADAPTER_COMPUTER_ID: computerId, ADAPTER_COMPUTER_ID_FILE: join(home, 'computer-id'),
    BACKEND_WS_URL: `ws://127.0.0.1:${backendPort}`, WEB_URL: `http://127.0.0.1:${backendPort}`,
    ADAPTER_UPDATE_DISABLE: 'true', DISABLE_HOOK_INSTALL: 'true', ANALYTICS_ENABLED: 'false',
    CABLE_DISABLE: 'true', CABLE_FW_DISABLE: 'true',
    HARNESS_GRID_BIN: join(home, 'grid-unavailable'), DISABLE_GRID_INSTALL: 'true',
  }
  const box = { name, home, port, computerId, env }
  boxes.push(box)
  return box
}

async function harness(box: Box, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { env: box.env, timeout: 90_000 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}
/** The result line of a `--json` login. A sign-in that swaps the daemon's identity prints the daemon's
 *  status block after it, so it is not simply the last line. */
function result(stdout: string): Record<string, unknown> {
  for (const line of stdout.split('\n')) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed?.type === 'result') return parsed
    } catch { /* the status block */ }
  }
  return {}
}
const daemonStatus = async (box: Box) =>
  (await (await fetch(`http://127.0.0.1:${box.port}/api/status`)).json()) as { machineId?: string; connected?: boolean; signedIn?: boolean }
const session = (box: Box) => JSON.parse(readFileSync(join(box.home, 'auth', 'session.json'), 'utf8')) as Record<string, unknown>

let failed = true
try {
  // ── Services, the phone's account, the backend ──────────────────────────────────────────────────
  const mongo = await MongoMemoryReplSet.create({
    binary: { ...(process.env.HARNESS_E2E_MONGOD ? { systemBinary: process.env.HARNESS_E2E_MONGOD } : {}) },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
  })
  cleanups.push(() => mongo.stop())
  const redis = new RedisMemoryServer({ binary: {
    ...(process.env.HARNESS_E2E_REDIS_SERVER ? { systemBinary: process.env.HARNESS_E2E_REDIS_SERVER } : {}),
  } })
  cleanups.push(() => redis.stop())
  const redisPort = await redis.getPort()

  const phoneToken = `phone-fixture-${randomUUID()}`
  const userId = randomUUID().replaceAll('-', '')
  const email = `${userId}@local.invalid`
  const sso = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${phoneToken}`) { res.writeHead(401).end('{}'); return }
    res.end(JSON.stringify({ status: 1, data: { id: userId, email } }))
  })
  await new Promise<void>((done) => sso.listen(0, '127.0.0.1', done))
  cleanups.push(() => new Promise((done) => sso.close(done)))

  const [backendPort, proxyPort] = await Promise.all([freePort(), freePort()])
  const mongoUri = new URL(mongo.getUri('harness'))
  mongoUri.searchParams.set('directConnection', 'true')
  const backendEnv = {
    ...process.env, NODE_ENV: 'test', PORT: String(backendPort), PORT_APP_PROXY: String(proxyPort),
    DATABASE_URL: mongoUri.toString(), REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false', TERMINAL_P2P_ROLLOUT_PERCENT: '0',
    SSO_PROFILE_URL: `http://127.0.0.1:${(sso.address() as { port: number }).port}/profile`, SSO_IDENTITY_URL: '',
    HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'],
    { cwd: join(repo, 'backend'), env: backendEnv, timeout: 120_000 })
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'],
    { cwd: join(repo, 'backend'), env: backendEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const backendLog = createWriteStream(join(root, 'backend.log'))
  backend.stdout!.pipe(backendLog)
  backend.stderr!.pipe(backendLog)
  children.push(backend)
  const api = `http://127.0.0.1:${backendPort}`
  await until('backend health', async () => (await fetch(`${api}/api/health`)).ok, 90_000)
  pass('backend up on in-memory Mongo + Redis')

  /** The phone: a signed-in account calling the backend. */
  const phone = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${phoneToken}`, 'x-autonomous-env': 'prod', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = await res.json() as { data?: any; error?: unknown }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error)}`)
    return json.data
  }
  const newTicket = async (): Promise<string> => {
    const out = await phone('POST', '/api/auth/box/ticket', {}) as { ticket?: string; expiresIn?: number }
    check(out.ticket?.startsWith('hnp_') && out.expiresIn === 1800, 'ticket issued', out)
    return out.ticket!
  }

  // ── The box CLI, built from this working tree ───────────────────────────────────────────────────
  const bundleDir = join(root, 'bundle')
  await exec(process.execPath, ['build-bundle.mjs'], {
    cwd: join(repo, 'cli'), timeout: 300_000,
    env: { ...process.env, BUNDLE_OUT_DIR: bundleDir, ADAPTER_VERSION: '0.0.0-dev.box-e2e' },
  })
  cli = join(bundleDir, 'cli.js')
  check(existsSync(cli), 'CLI bundle built', cli)
  const box1 = await newBox('box1', backendPort)
  const box2 = await newBox('box2', backendPort)

  // ── A blank box: its daemon runs, serving only itself ───────────────────────────────────────────
  const started = await harness(box1, ['start'])
  check(started.code === 0, 'box1 starts signed out', started)
  await until('box1 daemon answers', async () => (await daemonStatus(box1)).signedIn === false)
  pass('blank box: daemon up, this computer only (not signed in)')

  // ── The phone issues a ticket; the box spends it ────────────────────────────────────────────────
  const ticket = await newTicket()
  pass('phone issued a box ticket')
  const login = await harness(box1, ['login', `--ticket=${ticket}`, '--json'])
  check(login.code === 0, 'box1 login --ticket', login)
  check(result(login.stdout).status === 'success' && result(login.stdout).email === email, 'box1 signed in as the phone\'s account', result(login.stdout))
  const signed = session(box1)
  check(signed.method === 'qr' && typeof signed.machineId === 'string', 'box1 session on disk', signed)
  pass(`box signed in as ${email}, machine ${signed.machineId}`)

  await until('box1 daemon on the new identity, connected', async () => {
    const s = await daemonStatus(box1)
    return s.machineId === signed.machineId && s.connected === true
  }, 60_000)
  pass('daemon restarted onto the machine id and connected to the backend')

  const compact = (id: unknown) => String(id).replaceAll('-', '').toLowerCase()
  await until('phone sees the box running', async () => {
    const { machines } = await phone('GET', '/api/machines') as { machines: Array<{ machineId: string; computerId?: string; status?: string }> }
    return machines.some((m) => m.machineId === signed.machineId && compact(m.computerId) === compact(box1.computerId) && m.status === 'running')
  }, 60_000)
  pass('phone lists the box in Machines, running')

  // ── A ticket is spent once ──────────────────────────────────────────────────────────────────────
  const reused = await harness(box2, ['login', `--ticket=${ticket}`, '--json'])
  check(reused.code !== 0 && result(reused.stdout).code === 'TICKET_INVALID', 'a spent ticket is refused', reused)
  check(!existsSync(join(box2.home, 'auth', 'session.json')), 'no session for box2 from a spent ticket')
  pass('a spent ticket is TICKET_INVALID')

  // ── A claimed box takes no second ticket, and does not spend it ─────────────────────────────────
  const second = await newTicket()
  const again = await harness(box1, ['login', '--force', `--ticket=${second}`, '--json'])
  check(again.code !== 0 && result(again.stdout).code === 'ALREADY_SIGNED_IN', 'a signed-in box refuses a ticket', again)
  check(session(box1).machineId === signed.machineId, 'box1 kept its identity')
  const box2Login = await harness(box2, ['login', `--ticket=${second}`, '--json'])
  check(box2Login.code === 0 && result(box2Login.stdout).status === 'success', 'the refused ticket still works for its box', box2Login)
  pass('a signed-in box refuses a ticket and leaves it unspent')

  failed = false
  console.log('\nALL PASS')
} catch (err) {
  console.error(`\nFAIL ${(err as Error).message}`)
} finally {
  for (const box of boxes) await harness(box, ['stop']).catch(() => {})
  for (const child of children.reverse()) {
    if (child.pid && child.exitCode == null) { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
  }
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {})
  if (!failed && process.env.HARNESS_BOX_E2E_KEEP !== '1') await rm(root, { recursive: true, force: true })
  else console.error(`Logs retained at ${root}`)
  process.exit(failed ? 1 : 0)
}
