import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer as netServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { IsolatedDaemon, until as untilDaemon } from './daemon.js'
import { LocalClient } from './client.js'

const exec = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export interface Account { name: string; token: string; id: string; email: string }
export const account = (name: string): Account => ({ name, token: `spike-${randomUUID()}`,
  id: randomUUID().replaceAll('-', ''), email: `${name}@spike.invalid` })

export interface RealBackend {
  url: string
  wsUrl: string
  /** The backend process's own log (stdout and stderr), for a failing test to print. */
  logPath: string
  api(a: Account, path: string, method?: string, body?: unknown): Promise<{ status: number; body: any }>
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  const s = netServer().listen(0, '127.0.0.1')
  await once(s, 'listening')
  const port = (s.address() as { port: number }).port
  await new Promise(r => s.close(r))
  return port
}

async function until(label: string, check: () => Promise<boolean>, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await check().catch(() => false)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(r => setTimeout(r, 200))
  }
}

/** Daemons signed in against a backend, closed by its stop() so a failed sign-in cannot leak one. */
const owned = new WeakMap<RealBackend, IsolatedDaemon[]>()

export async function startRealBackend(accounts: Account[], log: (line: string) => void): Promise<RealBackend> {
  const stops: Array<() => unknown> = []
  try {
    return await boot(accounts, log, stops)
  } catch (error) {
    // The handle is never returned on a failed start, so nobody else can stop what already runs.
    for (const s of stops.reverse()) await Promise.resolve(s()).catch(() => {})
    throw error
  }
}

async function boot(accounts: Account[], log: (line: string) => void, stops: Array<() => unknown>): Promise<RealBackend> {
  const services = createRequire(join(resolve(process.env.HARNESS_E2E_SERVICES_DIR!), 'package.json'))
  const { MongoMemoryReplSet } = services('mongodb-memory-server')
  const { RedisMemoryServer } = services('redis-memory-server')
  let t = Date.now()
  const mongo = await MongoMemoryReplSet.create({
    binary: { ...(process.env.HARNESS_E2E_MONGOD ? { systemBinary: process.env.HARNESS_E2E_MONGOD } : {}) },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
  })
  stops.push(() => mongo.stop())
  const redis = new RedisMemoryServer({ binary: {
    ...(process.env.HARNESS_E2E_REDIS_SERVER ? { systemBinary: process.env.HARNESS_E2E_REDIS_SERVER } : {}) } })
  stops.push(() => redis.stop())
  const redisPort = await redis.getPort()
  const byToken = new Map(accounts.map(a => [`Bearer ${a.token}`, a]))
  const sso = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const a = byToken.get(String(req.headers.authorization))
    if (!a) { res.writeHead(401).end('{}'); return }
    res.end(JSON.stringify({ status: 1, data: { id: a.id, email: a.email } }))
  }).listen(0, '127.0.0.1')
  await once(sso, 'listening')
  stops.push(() => { sso.closeAllConnections(); sso.close() })
  log(`services ${Date.now() - t}ms`)
  const port = await freePort(), proxyPort = await freePort()
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: mongo.getUri('spike'),
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false',
    SSO_PROFILE_URL: `http://127.0.0.1:${(sso.address() as { port: number }).port}/profile`,
    SSO_IDENTITY_URL: '', TERMINAL_P2P_ROLLOUT_PERCENT: '0',
    HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  t = Date.now()
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'],
    { cwd: join(repo, 'backend'), env, timeout: 60_000 })
  log(`db push ${Date.now() - t}ms`)
  t = Date.now()
  const logPath = join(mkdtempSync(join(tmpdir(), 'spike-backend-')), 'backend.log')
  const logFd = openSync(logPath, 'a')
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: join(repo, 'backend'), stdio: ['ignore', logFd, logFd],
    env: { ...env, PORT: String(port), PORT_APP_PROXY: String(proxyPort), BACKEND_INSTANCE_ID: 'spike-0' } })
  // Wait for the exit, with a SIGKILL after 5 s (as IsolatedDaemon.stop does), before Mongo and Redis go.
  stops.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await exited
    clearTimeout(timer)
  })
  const url = `http://127.0.0.1:${port}`
  try {
    await until('backend health', async () => (await fetch(`${url}/api/health`)).ok)
  } catch (error) {
    throw new Error(`${(error as Error).message}; backend log ${logPath}:\n${readFileSync(logPath, 'utf8').slice(-2000)}`)
  }
  log(`backend ${Date.now() - t}ms`)
  const backend: RealBackend = {
    url, wsUrl: `ws://127.0.0.1:${port}`, logPath,
    async api(a, path, method = 'GET', body) {
      const r = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${a.token}`,
        'x-autonomous-env': 'prod', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    async stop() {
      for (const d of owned.get(backend) ?? []) await d.close().catch(() => {})
      for (const s of stops.reverse()) await Promise.resolve(s()).catch(() => {})
    },
  }
  owned.set(backend, [])
  return backend
}

/** An isolated daemon signed in as `a` against `backend`, with a client on its account machine. The daemon is
 *  closed by backend.stop(), also when this throws after creating it. `before` runs once its folders exist and before
 *  it starts: a test that changes what the daemon finds on its PATH (shared tabs' `gh`) does it there. */
export async function signIn(backend: RealBackend, a: Account, env: Record<string, string> = {},
  before?: (daemon: IsolatedDaemon) => void | Promise<void>): Promise<{ daemon: IsolatedDaemon; machineId: string; client: LocalClient }> {
  const computerId = randomUUID()
  const r = await backend.api(a, '/api/machines/resolve-computer', 'POST', { computerId, label: a.name })
  const machineId = r.body.data.machine.machineId as string
  const daemon = await IsolatedDaemon.create({ env: {
    ADAPTER_COMPUTER_ID: computerId, BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.url,
    HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', ...env } })
  owned.get(backend)?.push(daemon)
  writeFileSync(join(daemon.root, 'auth/session.json'), JSON.stringify({ version: 1, accessToken: a.token,
    refreshToken: 'x', autonomousEnv: 'prod', computerId, machineId,
    expiresAt: Date.now() + 3_600_000, updatedAt: Date.now() }), { mode: 0o600 })
  await before?.(daemon)
  await daemon.start()
  await untilDaemon('connected', async () => (await (await fetch(`http://127.0.0.1:${daemon.port}/api/status`,
    // Without the local credential the status is cut down to what says a daemon is here (hookServer.ts `publicStatus`).
    { headers: daemon.localHeaders() })).json()).connected === true, 60_000, 200)
  return { daemon, machineId, client: await LocalClient.connect(daemon, { machineId }) }
}
