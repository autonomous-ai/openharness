import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createTcpServer, connect, type AddressInfo, type Server as TcpServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { localDatabase } from './mongo.js'

/**
 * Stability 3.2 and 3.5 KPI bench: what one bad client, a slow Redis and a slow SSO do to everyone else's latency.
 *
 * It runs the real backend (`src/server.ts`, a child process) against its own loopback MongoDB, its own `redis-server`
 * behind a proxy that can delay every packet, and a fake SSO that answers the identity route after a chosen delay. It
 * never reads DATABASE_URL, REDIS_URL or any real service. Good clients sign in, register one computer each, then list
 * their machines in a loop (auth, Mongo and Redis presence on every call); a tenth of their calls carry a token the
 * backend has not seen yet, the way refreshed sign-ins arrive. Every scenario runs the same clients for the same time:
 *
 *   normal      nothing injected
 *   bad-client  one more account loads its own Swarm in full (the first load a client makes), 128 calls in flight
 *               and no pause
 *   redis-slow  every Redis packet waits 5 s
 *   sso-slow    the SSO answers after 5 s
 *
 * `npx tsx integration/bench/resilience.ts [--seconds 20] [--bad-in-flight 128] [--out DIR]` from `backend/`, with `redis-server` on PATH.
 */

const GOOD_CLIENTS = 8
const THINK_MS = 100
const FRESH_TOKEN_SHARE = 0.1
const INJECTED_DELAY_MS = 5_000
const CALL_TIMEOUT_MS = 30_000

interface Sample { ms: number; status: number }
interface ScenarioResult { name: string; calls: number; p50: number; p95: number; p99: number; max: number; statuses: Record<string, number>; badCalls?: number }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    }).on('error', reject)
  })
}

/** A TCP proxy that holds every chunk, both ways, for `delayMs` (read per chunk, so it can change mid-connection). */
function delayProxy(target: number): Promise<{ port: number; setDelay(ms: number): void; close(): void }> {
  let delayMs = 0
  const relay = (from: NodeJS.ReadableStream, to: NodeJS.WritableStream) =>
    from.on('data', (chunk: Buffer) => { if (delayMs) setTimeout(() => to.write(chunk), delayMs); else to.write(chunk) })
  const server: TcpServer = createTcpServer(client => {
    const upstream = connect(target, '127.0.0.1')
    relay(client, upstream); relay(upstream, client)
    const end = () => { client.destroy(); upstream.destroy() }
    client.on('error', end).on('close', end); upstream.on('error', end).on('close', end)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as AddressInfo).port,
    setDelay: ms => { delayMs = ms },
    close: () => server.close(),
  })))
}

/** Answers `Bearer <user>.<anything>` as that user, after `delayMs`: the identity and profile routes share one shape. */
function fakeSso(): Promise<{ port: number; setDelay(ms: number): void; close(): void }> {
  let delayMs = 0
  const server: Server = createHttpServer((req, res) => {
    const token = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
    const user = token.split('.')[0]
    setTimeout(() => {
      if (!user.startsWith('bench-')) { res.writeHead(401).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 1, data: { id: `ext-${user}`, email: `${user}@bench.example` } }))
    }, delayMs)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as AddressInfo).port,
    setDelay: ms => { delayMs = ms },
    close: () => { server.closeAllConnections(); server.close() },
  })))
}

async function startRedis(): Promise<{ port: number; process: ChildProcess }> {
  const port = await freePort()
  const child = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { execFileSync('redis-cli', ['-p', String(port), 'ping'], { stdio: 'pipe' }); return { port, process: child } } catch { await sleep(50) }
  }
  child.kill()
  throw new Error('redis-server did not start')
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function call(base: string, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Sample> {
  const started = performance.now()
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    await response.arrayBuffer()
    return { ms: performance.now() - started, status: response.status }
  } catch {
    return { ms: performance.now() - started, status: 0 }
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)])
}

function summarize(name: string, samples: Sample[], badCalls?: number): ScenarioResult {
  const sorted = samples.map(s => s.ms).sort((a, b) => a - b)
  const statuses: Record<string, number> = {}
  for (const s of samples) statuses[s.status || 'timeout'] = (statuses[s.status || 'timeout'] ?? 0) + 1
  return { name, calls: samples.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99),
    max: Math.round(sorted.at(-1) ?? 0), statuses, ...(badCalls === undefined ? {} : { badCalls }) }
}

interface BadClient { user: string; path: string; inFlight: number }

async function scenario(base: string, name: string, seconds: number, users: string[], round: number, bad?: BadClient): Promise<ScenarioResult> {
  const until = Date.now() + seconds * 1000
  const samples: Sample[] = []
  let fresh = 0
  const good = users.map(async user => {
    while (Date.now() < until) {
      const token = Math.random() < FRESH_TOKEN_SHARE ? `${user}.r${round}-f${fresh++}` : `${user}.steady`
      samples.push(await call(base, token, 'GET', '/api/machines'))
      await sleep(THINK_MS)
    }
  })
  let badCalls = 0
  const flood = bad ? Array.from({ length: bad.inFlight }, async () => {
    while (Date.now() < until) { await call(base, `${bad.user}.steady`, 'GET', bad.path); badCalls++ }
  }) : []
  await Promise.all([...good, ...flood])
  return summarize(name, samples, bad ? badCalls : undefined)
}

function render(results: ScenarioResult[], revision: string, seconds: number, inFlight: number): string {
  const rows = results.map(r => `| ${r.name} | ${r.calls} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${Object.entries(r.statuses).map(([k, v]) => `${k}: ${v}`).join(', ')} | ${r.badCalls ?? ''} |`)
  const normal = results.find(r => r.name === 'normal')
  const bad = results.find(r => r.name === 'bad-client')
  const rise = normal && bad && normal.p95 ? `${Math.round((bad.p95 / normal.p95 - 1) * 100)}%` : 'n/a'
  return [
    `# Resilience bench, ${revision}`,
    '',
    `${GOOD_CLIENTS} good clients, ${seconds} s per scenario, GET /api/machines with ${THINK_MS} ms think time, ${FRESH_TOKEN_SHARE * 100}% fresh tokens. The bad client loads its Swarm in full with ${inFlight} calls in flight. Latency in ms.`,
    '',
    '| Scenario | Good calls | p50 | p95 | p99 | max | Statuses | Bad client calls |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `KPI 3.2, good clients' p95 rise under one bad client: ${rise} (target under 10%).`,
    `KPI 3.5, p95 with Redis 5 s slow: ${results.find(r => r.name === 'redis-slow')?.p95 ?? 'n/a'} ms; with SSO 5 s slow: ${results.find(r => r.name === 'sso-slow')?.p95 ?? 'n/a'} ms (target under 1000 ms).`,
    '',
  ].join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const seconds = Number(args[args.indexOf('--seconds') + 1]) || 20
  const inFlight = Number(args[args.indexOf('--bad-in-flight') + 1]) || 128
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(process.cwd(), 'integration/bench/results')
  const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()

  const database = await localDatabase()
  const redis = await startRedis()
  const proxy = await delayProxy(redis.port)
  const sso = await fakeSso()
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const ssoUrl = `http://127.0.0.1:${sso.port}`
  await mkdir(out, { recursive: true })
  const log = createWriteStream(join(out, `resilience-${revision}.log`))
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      PORT: String(port),
      PORT_APP_PROXY: String(await freePort()),
      DATABASE_URL: database.uri,
      REDIS_URL: `redis://127.0.0.1:${proxy.port}`,
      SSO_IDENTITY_URL: `${ssoUrl}/identity`,
      SSO_PROFILE_URL: `${ssoUrl}/profile`,
      AUTONOMOUS_BFF_URL: ssoUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend.stdout!.pipe(log); backend.stderr!.pipe(log)
  try {
    for (let i = 0; ; i++) {
      if ((await call(base, 'none', 'GET', '/api/health')).status === 200) break
      if (i > 600 || backend.exitCode !== null) throw new Error('backend did not start; see the log in the results folder')
      await sleep(100)
    }
    const users = Array.from({ length: GOOD_CLIENTS }, (_, i) => `bench-good${i}`)
    const badUser = 'bench-bad'
    for (const [i, user] of [...users, badUser].entries()) {
      const computerId = (i + 1).toString(16).padStart(32, '0')
      const made = await call(base, `${user}.steady`, 'POST', '/api/machines/resolve-computer', { computerId, label: 'bench' })
      if (made.status !== 200) throw new Error(`could not register a computer for ${user}: HTTP ${made.status}`)
    }
    const tab = await fetch(`${base}/api/super-tabs`, { method: 'POST', headers: { authorization: `Bearer ${badUser}.steady`, 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'bench-bad-swarm', name: 'Bench' }) }).then(r => r.json()) as { data?: { id?: string; state?: { id?: string } } }
    const tabId = tab.data?.id ?? tab.data?.state?.id
    if (!tabId) throw new Error(`could not create the bad client's Swarm: ${JSON.stringify(tab).slice(0, 200)}`)
    const bad: BadClient = { user: badUser, path: `/api/super-tabs/${tabId}/parts`, inFlight }
    if ((await call(base, `${badUser}.steady`, 'GET', bad.path)).status !== 200) throw new Error('the bad client cannot read its Swarm')
    const results: ScenarioResult[] = []
    results.push(await scenario(base, 'normal', seconds, users, 1))
    results.push(await scenario(base, 'bad-client', seconds, users, 2, bad))
    await sleep(2_000)
    proxy.setDelay(INJECTED_DELAY_MS)
    results.push(await scenario(base, 'redis-slow', seconds, users, 3))
    proxy.setDelay(0)
    await sleep(INJECTED_DELAY_MS + 2_000)
    sso.setDelay(INJECTED_DELAY_MS)
    results.push(await scenario(base, 'sso-slow', seconds, users, 4))
    sso.setDelay(0)

    const markdown = render(results, revision, seconds, inFlight)
    const name = `resilience-${revision}-${new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')}`
    await writeFile(join(out, `${name}.json`), `${JSON.stringify({ revision, seconds, inFlight, results }, null, 2)}\n`)
    await writeFile(join(out, `${name}.md`), markdown)
    process.stdout.write(`${markdown}\nWrote ${join(out, name)}.json and .md\n`)
  } finally {
    backend.kill('SIGKILL')
    sso.close(); proxy.close(); redis.process.kill()
    await database.stop()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
