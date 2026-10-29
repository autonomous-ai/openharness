import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { MongoClient } from 'mongodb'
import { assertReadOnly, compareSnapshots, redactUrl, runSnapshot, secondaryUrl } from '../scripts/atlas-snapshot.js'

// The Atlas snapshot script (DB roadmap Phase 1) against a fake Atlas Admin API and a two-node loopback replica set.
// It never reads DATABASE_URL, and nothing here reaches Atlas or any shared database.

const GROUP = 'g1'
const KEYS = { publicKey: 'pub-key', privateKey: 'priv-secret' }
const SERVICE = { clientId: 'svc-id', clientSecret: 'svc-secret' }
const NOW = Date.parse('2026-10-29T08:00:00Z')
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

type Seen = { method: string; path: string; query: URLSearchParams; accept?: string; auth?: string }

const PROCESSES = [
  { id: 'autonomous-code-prod-shard-00-00.x.mongodb.net:27017', hostname: 'autonomous-code-prod-shard-00-00.x.mongodb.net', port: 27017, typeName: 'REPLICA_PRIMARY', userAlias: 'autonomous-code-prod-shard-00-00.x.mongodb.net' },
  { id: 'autonomous-code-prod-shard-00-01.x.mongodb.net:27017', hostname: 'autonomous-code-prod-shard-00-01.x.mongodb.net', port: 27017, typeName: 'REPLICA_SECONDARY', userAlias: 'autonomous-code-prod-shard-00-01.x.mongodb.net' },
  { id: 'other-cluster-shard-00-00.x.mongodb.net:27017', hostname: 'other-cluster-shard-00-00.x.mongodb.net', port: 27017, typeName: 'REPLICA_PRIMARY', userAlias: 'other-cluster-shard-00-00.x.mongodb.net' },
]

/** Two points a metric: CPU 40 then 80 on the primary, so the average is 60 and the peak 80. */
function measurements(processId: string, metrics: string[]) {
  const primary = processId === PROCESSES[0]!.id
  const values: Record<string, [number, number]> = {
    PROCESS_NORMALIZED_CPU_USER: primary ? [30, 70] : [5, 5], PROCESS_NORMALIZED_CPU_KERNEL: primary ? [10, 10] : [1, 1],
    OPCOUNTER_QUERY: [600, 800], NETWORK_BYTES_OUT: [10_000_000, 20_000_000], QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED: [2, 3],
  }
  return { processId, granularity: 'PT5M', measurements: metrics.map(name => ({ name, units: 'SCALAR',
    dataPoints: (values[name] ?? [1, null]).map((value, i) => ({ timestamp: new Date(NOW - (2 - i) * 300_000).toISOString(), value })) })) }
}

const slowLine = (ms: number, at: number, email: string) => JSON.stringify({ t: { $date: new Date(at).toISOString() }, s: 'I', c: 'COMMAND', msg: 'Slow query',
  attr: { type: 'command', ns: 'prod.users', command: { find: 'users', filter: { email, autonomousEnv: 'prod' }, $db: 'prod' }, planSummary: 'IXSCAN { email: 1 }',
    keysExamined: 1, docsExamined: 1, nreturned: 1, durationMillis: ms } })

function fakeAtlas(mode: 'digest' | 'service') {
  const seen: Seen[] = []
  const nonce = randomUUID()
  const server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url!, 'http://x')
    seen.push({ method: req.method!, path: url.pathname, query: url.searchParams, accept: req.headers.accept, auth: req.headers.authorization })
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/api/oauth/token') {
      const ok = mode === 'service' && req.headers.authorization === `Basic ${Buffer.from(`${SERVICE.clientId}:${SERVICE.clientSecret}`).toString('base64')}`
      return ok ? send(200, { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' }) : send(401, { error: 'bad client' })
    }
    if (mode === 'service' && req.headers.authorization !== 'Bearer tok-1') return send(401, { error: 'no token' })
    if (mode === 'digest') {
      const auth = req.headers.authorization ?? ''
      const field = (name: string) => new RegExp(`${name}="?([^",]+)"?`).exec(auth)?.[1]
      const ha1 = md5(`${KEYS.publicKey}:MMS Public API:${KEYS.privateKey}`), ha2 = md5(`${req.method}:${field('uri')}`)
      const expected = md5(`${ha1}:${nonce}:${field('nc')}:${field('cnonce')}:auth:${ha2}`)
      if (!auth.startsWith('Digest ') || field('username') !== KEYS.publicKey || field('response') !== expected || field('uri') !== req.url) {
        return send(401, { error: 'auth' }, { 'www-authenticate': `Digest realm="MMS Public API", domain="", nonce="${nonce}", algorithm=MD5, qop="auth", stale=false` })
      }
    }
    if (req.headers.accept !== 'application/vnd.atlas.2023-01-01+json') return send(406, { error: 'version' })
    const processPath = /^\/api\/atlas\/v2\/groups\/g1\/processes\/([^/]+)\/(measurements|performanceAdvisor\/slowQueryLogs)$/.exec(url.pathname)
    if (url.pathname === '/api/atlas/v2/groups/g1/processes') return send(200, { results: PROCESSES, totalCount: PROCESSES.length })
    if (processPath?.[2] === 'measurements') return send(200, measurements(decodeURIComponent(processPath[1]!), url.searchParams.getAll('m')))
    if (processPath?.[2] === 'performanceAdvisor/slowQueryLogs') {
      const primary = decodeURIComponent(processPath[1]!) === PROCESSES[0]!.id
      return send(200, { slowQueries: primary ? [
        { namespace: 'prod.users', line: slowLine(30_000, NOW - 3_600_000, 'alice@example.com') },
        { namespace: 'prod.users', line: slowLine(40_000, NOW - 3_600_000 + 10_000, 'bob@example.com') },
        { namespace: 'prod.users', line: slowLine(500, NOW - 60_000, 'carol@example.com') },
        { namespace: 'prod.x', line: 'not json' },
      ] : [] })
    }
    send(404, { error: 'not found' })
  })
  return { server, seen }
}

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => {
  const address = server.address() as { port: number }
  resolve(`http://127.0.0.1:${address.port}`)
}))

let replica: MongoMemoryReplSet
let uri: string

beforeAll(async () => {
  // The second member can never be elected, so the first stays primary and the second a secondary for the whole file.
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    instanceOpts: [{ replicaMemberConfig: { priority: 1 } }, { replicaMemberConfig: { priority: 0 } }],
    replSet: { count: 2, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  await replica.waitUntilRunning()
  uri = replica.getUri(`atlas_snapshot_${randomUUID().replaceAll('-', '_')}`)
  const client = await MongoClient.connect(uri)
  try {
    const db = client.db()
    // A fresh set briefly refuses writes even once its primary says it is writable, and the second member may still
    // be syncing: retry each seed write until it lands, then wait until the second member is a secondary.
    const deadline = Date.now() + 60_000
    const settled = async <T>(write: () => Promise<T>): Promise<T> => {
      for (;;) {
        try { return await write() } catch (error) {
          if (Date.now() > deadline || (error as { code?: number }).code !== 10107) throw error
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
    }
    // Upserts by fixed ids, so a write that was refused after it partly applied lands once when retried.
    const upserts = (docs: { _id: string }[]) => docs.map(doc => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } }))
    await settled(() => db.collection<{ _id: string }>('product_usage_receipts').bulkWrite(upserts(Array.from({ length: 50 }, (_, i) => ({ _id: `r${i}`, expiresAt: new Date(NOW) }))), { writeConcern: { w: 2 } }))
    await settled(() => db.collection('product_usage_receipts').createIndex({ expiresAt: 1 }))
    await settled(() => db.collection<{ _id: string }>('SwarmGroup').bulkWrite(upserts([{ _id: 'g', tabId: 't', note: 'x'.repeat(100) } as { _id: string }]), { writeConcern: { w: 2 } }))
    for (;;) {
      const { members } = await db.admin().command({ replSetGetStatus: 1 }) as { members: { stateStr: string }[] }
      if (members.every(m => m.stateStr === 'PRIMARY' || m.stateStr === 'SECONDARY')) break
      if (Date.now() > deadline) throw new Error('The second member never became a secondary')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally {
    await client.close()
  }
})
afterAll(async () => { await replica?.stop() })

async function snapshot(mode: 'digest' | 'service', extra: Partial<NodeJS.ProcessEnv> = {}) {
  const { server, seen } = fakeAtlas(mode)
  const base = await listen(server)
  const out = await mkdtemp(join(tmpdir(), 'atlas-snapshot-test-'))
  const env: NodeJS.ProcessEnv = { ATLAS_BASE_URL: base, ATLAS_GROUP_ID: GROUP, ATLAS_CLUSTER: 'autonomous-code-prod', MONGO_READONLY_URL: uri,
    ...mode === 'digest' ? { ATLAS_PUBLIC_KEY: KEYS.publicKey, ATLAS_PRIVATE_KEY: KEYS.privateKey } : { ATLAS_CLIENT_ID: SERVICE.clientId, ATLAS_CLIENT_SECRET: SERVICE.clientSecret },
    ...extra }
  const printed: string[] = []
  try {
    const result = await runSnapshot({ env, out, label: 'before', now: NOW, print: line => printed.push(line) })
    return { result, seen, out, printed }
  } finally {
    server.close()
  }
}

describe('runSnapshot', () => {
  it('saves the cluster metrics, a slow log with shapes only and the sizes from a secondary, with API keys', async () => {
    const { result, seen, out, printed } = await snapshot('digest')
    expect(result).toEqual({ ok: true, skipped: [], failed: [] })
    // Only the named cluster's processes, a day at 5-minute points, every metric the roadmap lists.
    const asked = seen.filter(s => s.path.endsWith('/measurements') && s.auth?.startsWith('Digest '))
    expect(asked.map(s => decodeURIComponent(s.path.split('/')[7]!)).sort()).toEqual([PROCESSES[0]!.id, PROCESSES[1]!.id])
    expect(asked[0]!.query.get('granularity')).toBe('PT5M')
    expect(asked[0]!.query.get('period')).toBe('P1D')
    expect(asked[0]!.query.getAll('m')).toEqual(expect.arrayContaining(['PROCESS_NORMALIZED_CPU_USER', 'OPCOUNTER_QUERY', 'DOCUMENT_METRICS_RETURNED',
      'NETWORK_BYTES_OUT', 'QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED', 'OP_EXECUTION_TIME_READS', 'SYSTEM_MEMORY_AVAILABLE', 'CONNECTIONS']))
    const slowAsked = seen.find(s => s.path.endsWith('/slowQueryLogs') && s.auth?.startsWith('Digest '))!
    expect(slowAsked.query.get('since')).toBe(String(NOW - 86_400_000))
    expect(slowAsked.query.get('duration')).toBe('86400000')

    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'))
    expect(summary.label).toBe('before')
    // CPU is user + kernel: (30+10, 70+10) → average 60, peak 80.
    expect(summary.primary.PROCESS_CPU).toEqual({ average: 60, peak: 80, latest: 80 })
    expect(summary.primary.OPCOUNTER_QUERY).toEqual({ average: 700, peak: 800, latest: 800 })
    // 30 s and 40 s in the same minute, then 0.5 s: 70.5 s in all, 70 s in the worst minute; the unreadable line counted.
    expect(summary.slowOps).toMatchObject({ count: 3, unreadable: 1, totalSeconds: 70.5, peakSecondsPerMinute: 70 })
    expect(summary.slowOps.top[0]).toMatchObject({ ns: 'prod.users', op: 'find', shape: '{"autonomousEnv":"?","email":"?"}', count: 3, seconds: 70.5 })
    expect(summary.sizes.collections[0]).toMatchObject({ name: 'product_usage_receipts', count: 50, nindexes: 2 })

    const slowFile = await readFile(join(out, 'slow-queries.json'), 'utf8')
    expect(slowFile).not.toMatch(/alice|bob|carol/)
    const sizes = JSON.parse(await readFile(join(out, 'sizes.json'), 'utf8'))
    // Mongo names the member that answered by this machine's name; its port tells which one it was.
    const port = (address: string) => Number(address.split(':').at(-1))
    const members = replica.servers.filter(s => s.instanceInfo).map(s => s.instanceInfo!.port)
    expect(members).toContain(port(sizes.readFrom))
    expect(port(sizes.readFrom)).not.toBe(port(sizes.primary))
    const markdown = await readFile(join(out, 'summary.md'), 'utf8')
    expect(markdown).toContain('| Process CPU (%) | 60 | 80 | 80 |')
    expect(printed.join('\n')).toContain(out)
    expect(printed.join('\n')).not.toMatch(/priv-secret|pub-key/)
  })

  it('signs in with a service account when one is set', async () => {
    const { result, seen } = await snapshot('service')
    expect(result.ok).toBe(true)
    expect(seen.filter(s => s.path === '/api/oauth/token')).toHaveLength(1)
    expect(seen.filter(s => s.path.startsWith('/api/atlas/')).every(s => s.auth === 'Bearer tok-1')).toBe(true)
  })

  it('says which parts it skipped when their settings are missing, and still saves the rest', async () => {
    const { result, out } = await snapshot('digest', { ATLAS_PUBLIC_KEY: undefined, ATLAS_PRIVATE_KEY: undefined })
    expect(result).toEqual({ ok: true, skipped: ['atlas: set ATLAS_CLIENT_ID and ATLAS_CLIENT_SECRET, or ATLAS_PUBLIC_KEY and ATLAS_PRIVATE_KEY'], failed: [] })
    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'))
    expect(summary.sizes.collections.length).toBeGreaterThan(0)
    expect(summary.skipped).toEqual(result.skipped)
  })

  it('fails the run when a part fails, without printing the database password', async () => {
    const { result } = await snapshot('digest', { MONGO_READONLY_URL: 'mongodb://reader:hunter2@127.0.0.1:1/prod?serverSelectionTimeoutMS=300' })
    expect(result.ok).toBe(false)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatch(/^sizes: /)
    expect(result.failed[0]).not.toContain('hunter2')
  })

  it('refuses a cluster name that matches no process, naming the ones it saw', async () => {
    const { result } = await snapshot('digest', { ATLAS_CLUSTER: 'no-such-cluster' })
    expect(result.ok).toBe(false)
    expect(result.failed[0]).toContain('autonomous-code-prod-shard-00-00')
  })
})

describe('safety checks', () => {
  it('always reads from a secondary, whatever the URL asked', () => {
    expect(secondaryUrl('mongodb+srv://r:p@cluster.x.mongodb.net/prod?readPreference=primary&retryWrites=true'))
      .toBe('mongodb+srv://r:p@cluster.x.mongodb.net/prod?readPreference=secondary&retryWrites=false')
  })

  it('hides the password of a URL', () => {
    expect(redactUrl('failed mongodb+srv://reader:hunter2@cluster.x.mongodb.net/prod')).toBe('failed mongodb+srv://reader:***@cluster.x.mongodb.net/prod')
  })

  const status = (actions: string[], users = [{ user: 'reader', db: 'admin' }]) => ({ authInfo: { authenticatedUsers: users,
    authenticatedUserPrivileges: [{ resource: { db: '', collection: '' }, actions }] } })

  it('accepts a user that can only read', () => {
    expect(() => assertReadOnly(status(['find', 'listCollections', 'collStats', 'dbStats', 'listIndexes', 'killCursors']), 'cluster.x.mongodb.net')).not.toThrow()
  })

  it('refuses a user that can write, naming what it could do', () => {
    expect(() => assertReadOnly(status(['find', 'insert', 'update', 'dropCollection']), 'cluster.x.mongodb.net'))
      .toThrow('Refused: this user can write (dropCollection, insert, update). Use the read-only user.')
  })

  it('refuses a remote database without sign-in, and allows one only on this computer', () => {
    expect(() => assertReadOnly(status([], []), 'cluster.x.mongodb.net')).toThrow(/without signing in/)
    expect(() => assertReadOnly(status([], []), '127.0.0.1')).not.toThrow()
  })
})

describe('compareSnapshots', () => {
  it('shows each number before and after with its change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-compare-test-'))
    const write = async (name: string, cpu: number, slow: number) => {
      await mkdir(join(dir, name))
      await writeFile(join(dir, name, 'summary.json'), JSON.stringify({ label: name, takenAt: '2026-10-29T08:00:00.000Z',
        primary: { PROCESS_CPU: { average: cpu, peak: cpu * 2, latest: cpu } }, slowOps: { count: 1, totalSeconds: slow, peakSecondsPerMinute: slow, unreadable: 0, top: [] },
        sizes: { collections: [], dataBytes: 100, indexBytes: 50 } }))
      return join(dir, name)
    }
    const table = compareSnapshots(JSON.parse(await readFile(join(await write('before', 40, 60), 'summary.json'), 'utf8')),
      JSON.parse(await readFile(join(await write('after', 10, 6), 'summary.json'), 'utf8')))
    expect(table).toContain('| Process CPU (%), average | 40 | 10 | -75% |')
    expect(table).toContain('| Slow operations, seconds | 60 | 6 | -90% |')
  })
})
