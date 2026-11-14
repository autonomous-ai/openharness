import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { IsolatedDaemon, until as untilDaemon } from './daemon.js'
import { LocalClient } from './client.js'
import { forgetGroup, watchGroup } from './reaper.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { backendListeningPortIn } from '../../src/testing/backendListeningPort.js'

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

/** A backend that stopped answering held its test until Vitest's 180 s limit, with no word of which call. */
export const BACKEND_API_TIMEOUT_MS = 30_000

/** One call to the test backend as `a`: its status and its body parsed, or null for a body that is not JSON. The limit
 *  covers reading the body too: a backend that sent its headers and then stalled is no answer either. */
export async function backendApi(url: string, a: Account, path: string, method = 'GET', body?: unknown,
  ms = BACKEND_API_TIMEOUT_MS): Promise<{ status: number; body: any }> {
  const signal = AbortSignal.timeout(ms)
  try {
    const r = await fetch(`${url}${path}`, { method, signal, headers: { authorization: `Bearer ${a.token}`,
      'x-autonomous-env': 'prod', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json().catch((error: unknown) => { if (signal.aborted) throw error; return null }) }
  } catch (error) {
    if (!signal.aborted) throw error
    throw new Error(`the test backend did not answer ${method} ${path} within ${ms} ms`, { cause: error })
  }
}

/** backend.stop(): closes every daemon, then stops every service, the last started first, and then throws what a close
 *  could not do. A root left behind or a process that would not end was swallowed here and seen by no one. */
export async function stopAll(daemons: Array<Pick<IsolatedDaemon, 'close'>>, stops: Array<() => unknown>): Promise<void> {
  const failed: unknown[] = []
  for (const d of daemons) await d.close().catch((error: unknown) => { failed.push(error) })
  // One that throws, at once or later, still lets the others stop: Mongo and Redis come last.
  for (const s of [...stops].reverse()) await (async () => s())().catch(() => {})
  if (failed.length) throw new AggregateError(failed, `${failed.length} daemon(s) under test did not close: ${failed.map(String).join('; ')}`)
}

/** A wait that cannot end well: thrown by a check, it ends the wait at once instead of being tried again. */
class WaitEnded extends Error {}

async function until(label: string, check: () => Promise<boolean>, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await check().catch(error => { if (error instanceof WaitEnded) throw error; return false })) {
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
    await stopAll([], stops)
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
    // mongod's own start, which a Mac under load takes longer than the library's 10 s for.
    instanceOpts: [{ launchTimeout: 120_000 }],
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
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: mongo.getUri('spike'),
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false',
    SSO_PROFILE_URL: `http://127.0.0.1:${(sso.address() as { port: number }).port}/profile`,
    SSO_IDENTITY_URL: '', TERMINAL_P2P_ROLLOUT_PERCENT: '0',
    HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  t = Date.now()
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'],
    { cwd: join(repo, 'backend'), env, timeout: 180_000 })
  log(`db push ${Date.now() - t}ms`)
  t = Date.now()
  const logPath = join(mkdtempSync(join(tmpdir(), 'spike-backend-')), 'backend.log')
  const logFd = openSync(logPath, 'a')
  // PORT=0 and PORT_APP_PROXY=0: the system picks each port as the backend binds it, and the harness reads the port
  // the backend bound from its log. A port picked here ahead could be taken before the backend bound it, as the
  // daemon's was in cli-e2e run 43568618113 (shard 2, turns.e2e.ts), and the harness then waited on whoever held it.
  // Ended by the worker's reaper should the worker go without stopping it (reaper.ts): one killed run's backend was
  // still running 1.5 days later (2026-11-11).
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: join(repo, 'backend'), stdio: ['ignore', logFd, logFd], ...ownProcessGroup(),
    env: { ...env, PORT: '0', PORT_APP_PROXY: '0', BACKEND_INSTANCE_ID: 'spike-0' } })
  if (child.pid) {
    watchGroup(child.pid)
    // Whatever it started goes with it.
    child.once('exit', () => { IsolatedDaemon.killGroup(child); forgetGroup(child.pid!) })
  }
  // Wait for the exit, with a SIGKILL after 5 s, before Mongo and Redis go.
  stops.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await exited
    clearTimeout(timer)
  })
  let port: number | null = null
  try {
    // A backend that died while starting (a bad migration, a missing setting) fails at once, not at the deadline. Ready, not
    // only alive: /api/health answers before its Redis is connected, and a first request then failed (COMPUTER_LOCK_UNAVAILABLE).
    await until('backend readiness', async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new WaitEnded(`the backend exited (${child.exitCode ?? child.signalCode}) while starting`)
      port ??= backendListeningPortIn(logPath)
      if (port === null) return false
      return (await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(5_000) })).ok
    })
  } catch (error) {
    throw new Error(`${(error as Error).message}; backend log ${logPath}:\n${readFileSync(logPath, 'utf8').slice(-2000)}`)
  }
  log(`backend ${Date.now() - t}ms`)
  const url = `http://127.0.0.1:${port}`
  const backend: RealBackend = {
    url, wsUrl: `ws://127.0.0.1:${port}`, logPath,
    api: (a, path, method, body) => backendApi(url, a, path, method, body),
    stop: () => stopAll(owned.get(backend) ?? [], stops),
  }
  owned.set(backend, [])
  return backend
}

/** An isolated daemon signed in as `a` against `backend`, with a client on its account machine. The daemon is
 *  closed by backend.stop(), also when this throws after creating it. `before` runs once its folders exist and before
 *  it starts: a test that changes what the daemon finds on its PATH (shared tabs' `gh`) does it there. `submissionGate` makes
 *  its fake engines keep every prompt they were typed, in `submitted-prompts` of the daemon's root. */
export async function signIn(backend: RealBackend, a: Account, env: Record<string, string> = {},
  before?: (daemon: IsolatedDaemon) => void | Promise<void>, options: { submissionGate?: boolean } = {}): Promise<{ daemon: IsolatedDaemon; machineId: string; client: LocalClient }> {
  const computerId = randomUUID()
  const r = await backend.api(a, '/api/machines/resolve-computer', 'POST', { computerId, label: a.name })
  if (r.status !== 200) throw new Error(`Sign-in of ${a.name} refused: ${r.status} ${JSON.stringify(r.body)}`)
  const machineId = r.body.data.machine.machineId as string
  const daemon = await IsolatedDaemon.create({ ...(options.submissionGate ? { submissionGate: true } : {}), env: {
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
