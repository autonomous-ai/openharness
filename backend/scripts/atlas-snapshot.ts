/**
 * Saves the database numbers of DB roadmap Phase 1 (docs/superpowers/specs/2026-10-29-database-optimization-roadmap.md,
 * "What we measured") for a before/after comparison: a day of the cluster's process metrics and its slow-query log from
 * the Atlas Admin API, and each collection's documents, data and index sizes read from a secondary.
 *
 *   ATLAS_GROUP_ID=… ATLAS_CLUSTER=autonomous-code-prod \
 *   ATLAS_CLIENT_ID=… ATLAS_CLIENT_SECRET=…            # a service account, or ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY
 *   MONGO_READONLY_URL=…                               # the read-only user
 *   npx tsx scripts/atlas-snapshot.ts --label before [--out DIR]
 *
 *   npx tsx scripts/atlas-snapshot.ts --compare atlas-snapshots/before-… atlas-snapshots/after-…
 *
 * Safety: it only reads. The database URL is always switched to readPreference=secondary, and the run is refused when
 * the user can write. It never reads DATABASE_URL. Privacy: the slow log keeps each operation's namespace, plan, timings
 * and the keys of its filter, never the logged line, which holds the query's values. Secrets come only from the
 * environment and are never printed. A part whose settings are missing is skipped and named; a part that fails fails
 * the run (exit 1) after the other parts are saved.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MongoClient } from 'mongodb'
import { filterShape } from '../src/lib/queryStats.js'

const ATLAS_VERSION = 'application/vnd.atlas.2023-01-01+json'
const DAY_MS = 86_400_000

/** What the roadmap's table reads. PROCESS_CPU in the summary is user + kernel. */
export const METRICS = ['PROCESS_NORMALIZED_CPU_USER', 'PROCESS_NORMALIZED_CPU_KERNEL', 'SYSTEM_NORMALIZED_CPU_USER',
  'OPCOUNTER_QUERY', 'OPCOUNTER_GETMORE', 'OPCOUNTER_CMD', 'OPCOUNTER_UPDATE', 'OPCOUNTER_INSERT', 'OPCOUNTER_DELETE',
  'DOCUMENT_METRICS_RETURNED', 'NETWORK_BYTES_OUT', 'QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED', 'QUERY_TARGETING_SCANNED_PER_RETURNED',
  'OP_EXECUTION_TIME_READS', 'OP_EXECUTION_TIME_WRITES', 'SYSTEM_MEMORY_AVAILABLE', 'CONNECTIONS']

/** The summary's rows: label, and a factor to the unit the label names. */
const ROWS: [string, string, number][] = [
  ['PROCESS_CPU', 'Process CPU (%)', 1], ['OPCOUNTER_QUERY', 'Queries / s', 1], ['OPCOUNTER_GETMORE', 'getMores / s', 1],
  ['OPCOUNTER_CMD', 'Commands / s', 1], ['OPCOUNTER_UPDATE', 'Updates / s', 1], ['OPCOUNTER_INSERT', 'Inserts / s', 1],
  ['DOCUMENT_METRICS_RETURNED', 'Documents returned / s', 1], ['NETWORK_BYTES_OUT', 'Network out (MB/s)', 1e-6],
  ['QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED', 'Scanned per returned', 1], ['OP_EXECUTION_TIME_READS', 'Read time (ms)', 1],
  ['OP_EXECUTION_TIME_WRITES', 'Write time (ms)', 1], ['SYSTEM_MEMORY_AVAILABLE', 'Memory available (MB)', 1e-6], ['CONNECTIONS', 'Connections', 1],
]
/** Atlas units → bytes, for the rows above that are sizes. */
const BYTES: Record<string, number> = { BYTES: 1, KILOBYTES: 1e3, MEGABYTES: 1e6, GIGABYTES: 1e9, BYTES_PER_SECOND: 1, KILOBYTES_PER_SECOND: 1e3,
  MEGABYTES_PER_SECOND: 1e6, GIGABYTES_PER_SECOND: 1e9 }

type Stat = { average: number; peak: number; latest: number }
type Measurement = { name: string; units: string; dataPoints: { timestamp: string; value: number | null }[] }
type Process = { id: string; hostname: string; port: number; typeName: string; userAlias?: string }
type SlowOp = { at: string; ns: string; op: string; shape: string; plan: string; ms: number; docsExamined?: number; keysExamined?: number; returned?: number }
export type SlowSummary = { count: number; unreadable: number; totalSeconds: number; peakSecondsPerMinute: number
  top: { ns: string; op: string; shape: string; count: number; seconds: number }[] }
export type Sizes = { primary: string; readFrom: string; dataBytes: number; indexBytes: number
  collections: { name: string; count: number; dataBytes: number; storageBytes: number; indexBytes: number; nindexes: number }[] }
export type Summary = { label: string; takenAt: string; skipped: string[]; failed: string[]; primaryProcess?: string
  primary?: Record<string, Stat>; units?: Record<string, string>; slowOps?: SlowSummary; sizes?: Sizes }

/* ---------- safety ---------- */

const URL_PARTS = /^(mongodb(?:\+srv)?:\/\/)(?:([^@/]*)@)?([^/?]+)(\/[^?]*)?(?:\?(.*))?$/

/** The URL with readPreference=secondary and retryWrites=false, whatever it asked. */
export function secondaryUrl(url: string): string {
  const parts = URL_PARTS.exec(url)
  if (!parts) throw new Error('MONGO_READONLY_URL is not a mongodb:// or mongodb+srv:// URL.')
  const [, scheme, auth, hosts, path, query] = parts
  const params = new URLSearchParams(query ?? '')
  params.set('readPreference', 'secondary')
  params.set('retryWrites', 'false')
  return `${scheme}${auth ? `${auth}@` : ''}${hosts}${path || '/'}?${params}`
}

const hostsOf = (url: string) => (URL_PARTS.exec(url)?.[3] ?? '').split(',').map(h => h.replace(/:\d+$/, ''))
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Any text with each URL's password as `***`. */
export function redactUrl(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/[^:@/\s]+):[^@/\s]+@/g, '$1:***@')
}

const WRITES = /^(insert|update|remove|drop|create|rename|convertToCapped|collMod|compact|applyOps|bypassDocumentValidation|reIndex|setFeatureCompatibilityVersion|shutdown|replSetReconfig|fsync|killop|killAnyCursor|killAnySession|planCacheWrite|enableProfiler|setParameter|grantRole|revokeRole|changePassword|changeOwnPassword|changeCustomData|enableSharding|moveChunk|splitChunk|cleanupOrphaned|restore|invalidateUserCache|unlock|setDefaultRWConcern|appendOplogNote|dropConnections)/

type ConnectionStatus = { authInfo?: { authenticatedUsers?: unknown[]; authenticatedUserPrivileges?: { actions?: string[] }[] } }

/** Refuses a user that can write, and a remote database reached without signing in. */
export function assertReadOnly(status: ConnectionStatus, host: string): void {
  const users = status.authInfo?.authenticatedUsers ?? []
  if (!users.length) {
    if (LOOPBACK.has(host)) return
    throw new Error('Refused: a database that is not on this computer, without signing in. Use the read-only user.')
  }
  const actions = new Set((status.authInfo?.authenticatedUserPrivileges ?? []).flatMap(p => p.actions ?? []))
  const writes = [...actions].filter(a => WRITES.test(a)).sort()
  if (writes.length) throw new Error(`Refused: this user can write (${writes.join(', ')}). Use the read-only user.`)
}

/* ---------- Atlas Admin API ---------- */

type Auth = { kind: 'service'; clientId: string; clientSecret: string } | { kind: 'digest'; publicKey: string; privateKey: string }

function atlasClient(base: string, auth: Auth) {
  let token: string | undefined
  const md5 = (s: string) => createHash('md5').update(s).digest('hex')

  async function bearer(): Promise<string> {
    if (token) return token
    if (auth.kind !== 'service') throw new Error('unreachable')
    const response = await fetch(`${base}/api/oauth/token`, { method: 'POST', body: 'grant_type=client_credentials',
      headers: { authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } })
    if (!response.ok) throw new Error(`Atlas refused the service account (${response.status}).`)
    token = (await response.json() as { access_token: string }).access_token
    return token
  }

  function digest(challenge: string, uri: string): string {
    if (auth.kind !== 'digest') throw new Error('unreachable')
    const field = (name: string) => new RegExp(`${name}="?([^",]+)"?`).exec(challenge)?.[1] ?? ''
    const realm = field('realm'), nonce = field('nonce'), cnonce = randomBytes(8).toString('hex'), nc = '00000001'
    const response = md5(`${md5(`${auth.publicKey}:${realm}:${auth.privateKey}`)}:${nonce}:${nc}:${cnonce}:auth:${md5(`GET:${uri}`)}`)
    return `Digest username="${auth.publicKey}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}", algorithm=MD5`
  }

  return async function get<T>(path: string, query: [string, string][] = []): Promise<T> {
    const search = query.length ? `?${new URLSearchParams(query)}` : ''
    const uri = `/api/atlas/v2${path}${search}`
    const headers: Record<string, string> = { accept: ATLAS_VERSION }
    if (auth.kind === 'service') headers.authorization = `Bearer ${await bearer()}`
    let response = await fetch(`${base}${uri}`, { headers })
    const challenge = response.headers.get('www-authenticate')
    if (auth.kind === 'digest' && response.status === 401 && challenge?.startsWith('Digest ')) {
      await response.body?.cancel()
      response = await fetch(`${base}${uri}`, { headers: { ...headers, authorization: digest(challenge, uri) } })
    }
    if (!response.ok) throw new Error(`Atlas answered ${response.status} to ${path}.`)
    return await response.json() as T
  }
}

function stat(points: number[]): Stat | undefined {
  if (!points.length) return undefined
  const round = (n: number) => Math.round(n * 100) / 100
  return { average: round(points.reduce((a, b) => a + b, 0) / points.length), peak: round(Math.max(...points)), latest: round(points.at(-1)!) }
}

/** A day of the primary's metrics, by name, with PROCESS_CPU as user + kernel at each point. */
function summarizeMeasurements(measurements: Measurement[]): { primary: Record<string, Stat>; units: Record<string, string> } {
  const primary: Record<string, Stat> = {}, units: Record<string, string> = {}
  const values = (m: Measurement) => m.dataPoints.map(p => p.value).filter((v): v is number => typeof v === 'number')
  for (const m of measurements) {
    const s = stat(values(m))
    if (s) { primary[m.name] = s; units[m.name] = m.units }
  }
  const user = measurements.find(m => m.name === 'PROCESS_NORMALIZED_CPU_USER'), kernel = measurements.find(m => m.name === 'PROCESS_NORMALIZED_CPU_KERNEL')
  if (user && kernel) {
    const sums = user.dataPoints.map((p, i) => p.value === null || kernel.dataPoints[i]?.value == null ? null : p.value + kernel.dataPoints[i]!.value!)
    const s = stat(sums.filter((v): v is number => v !== null))
    if (s) { primary.PROCESS_CPU = s; units.PROCESS_CPU = 'PERCENT' }
  }
  return { primary, units }
}

/** A logged slow operation without its values: namespace, command, plan, timings and the keys it filtered on. */
function slowOp(line: string, namespace: string): SlowOp | undefined {
  try {
    const entry = JSON.parse(line) as { t?: { $date?: string }; attr?: Record<string, unknown> }
    const attr = entry.attr ?? {}
    const ms = Number(attr.durationMillis)
    if (!Number.isFinite(ms)) return undefined
    const command = (attr.command && typeof attr.command === 'object' ? attr.command : {}) as Record<string, unknown>
    const num = (v: unknown) => typeof v === 'number' ? v : undefined
    return { at: entry.t?.$date ?? '', ns: String(attr.ns ?? namespace), op: Object.keys(command)[0] ?? String(attr.type ?? '?'),
      shape: filterShape('$runCommandRaw', command), plan: String(attr.planSummary ?? '').replace(/\{[^}]*\}/g, m => m.replace(/:\s*[^,}]+/g, '')), ms,
      docsExamined: num(attr.docsExamined), keysExamined: num(attr.keysExamined), returned: num(attr.nreturned) }
  } catch {
    return undefined
  }
}

function summarizeSlow(ops: SlowOp[], unreadable: number): SlowSummary {
  const perMinute = new Map<number, number>(), groups = new Map<string, SlowSummary['top'][number]>()
  for (const op of ops) {
    const minute = Math.floor(Date.parse(op.at) / 60_000)
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + op.ms)
    const key = `${op.ns}\0${op.op}\0${op.shape}`
    const group = groups.get(key) ?? { ns: op.ns, op: op.op, shape: op.shape, count: 0, seconds: 0 }
    group.count++; group.seconds += op.ms / 1000
    groups.set(key, group)
  }
  const seconds = (ms: number) => Math.round(ms) / 1000
  return { count: ops.length, unreadable, totalSeconds: seconds(ops.reduce((a, o) => a + o.ms, 0)),
    peakSecondsPerMinute: seconds(Math.max(0, ...perMinute.values())),
    top: [...groups.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 20).map(g => ({ ...g, seconds: Math.round(g.seconds * 1000) / 1000 })) }
}

async function snapshotAtlas(get: ReturnType<typeof atlasClient>, groupId: string, cluster: string, now: number) {
  const group = `/groups/${encodeURIComponent(groupId)}`
  const { results } = await get<{ results: Process[] }>(`${group}/processes`, [['itemsPerPage', '500']])
  const name = (p: Process) => (p.userAlias || p.hostname).toLowerCase()
  const processes = results.filter(p => name(p).startsWith(`${cluster.toLowerCase()}-`) || name(p) === cluster.toLowerCase())
  if (!processes.length) {
    throw new Error(`No process of cluster ${cluster}. Processes seen: ${[...new Set(results.map(name))].join(', ') || 'none'}.`)
  }
  const measurements: Record<string, Measurement[]> = {}, slow: Record<string, SlowOp[]> = {}
  let unreadable = 0
  for (const p of processes) {
    const path = `${group}/processes/${encodeURIComponent(p.id)}`
    const reply = await get<{ measurements: Measurement[] }>(`${path}/measurements`,
      [['granularity', 'PT5M'], ['period', 'P1D'], ...METRICS.map((m): [string, string] => ['m', m])])
    measurements[p.id] = reply.measurements
    const logs = await get<{ slowQueries: { line: string; namespace: string }[] }>(`${path}/performanceAdvisor/slowQueryLogs`,
      [['since', String(now - DAY_MS)], ['duration', String(DAY_MS)], ['nLogs', '20000']])
    slow[p.id] = []
    for (const q of logs.slowQueries ?? []) {
      const op = slowOp(q.line, q.namespace)
      if (op) slow[p.id]!.push(op)
      else unreadable++
    }
  }
  const primaryProcess = processes.find(p => p.typeName === 'REPLICA_PRIMARY') ?? processes[0]!
  return { processes, measurements, slow, primaryProcess: primaryProcess.id, ...summarizeMeasurements(measurements[primaryProcess.id] ?? []),
    slowOps: summarizeSlow(Object.values(slow).flat(), unreadable) }
}

/* ---------- sizes from a secondary ---------- */

async function snapshotSizes(url: string): Promise<Sizes> {
  const client = new MongoClient(secondaryUrl(url))
  try {
    await client.connect()
    const db = client.db()
    const status = await db.admin().command({ connectionStatus: 1, showPrivileges: true }) as ConnectionStatus
    for (const host of hostsOf(url)) assertReadOnly(status, host)
    const hello = await db.admin().command({ hello: 1 }) as { primary?: string }
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .filter(c => c.type !== 'view' && !c.name.startsWith('system.')).map(c => c.name)
    let readFrom = ''
    const collections: Sizes['collections'] = []
    for (const name of names) {
      const [stats] = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }], { readPreference: 'secondary' }).toArray() as
        { host: string; storageStats: { count: number; size: number; storageSize: number; totalIndexSize: number; nindexes: number } }[]
      if (!stats) continue
      readFrom ||= stats.host
      const s = stats.storageStats
      collections.push({ name, count: s.count, dataBytes: s.size, storageBytes: s.storageSize, indexBytes: s.totalIndexSize, nindexes: s.nindexes })
    }
    collections.sort((a, b) => b.dataBytes + b.indexBytes - (a.dataBytes + a.indexBytes))
    return { primary: hello.primary ?? '', readFrom, dataBytes: collections.reduce((a, c) => a + c.dataBytes, 0),
      indexBytes: collections.reduce((a, c) => a + c.indexBytes, 0), collections }
  } finally {
    await client.close()
  }
}

/* ---------- the run ---------- */

const fmt = (n: number) => String(Number(n.toFixed(1)))

function markdown(summary: Summary): string {
  const lines = [`# Atlas snapshot: ${summary.label}`, '', `Taken ${summary.takenAt}.`, '']
  if (summary.primary) {
    lines.push(`Primary ${summary.primaryProcess}, last 24 h at 5-minute points.`, '', '| Metric | Average | Peak | Latest |', '|---|---|---|---|')
    for (const [name, label, factor] of ROWS) {
      const s = summary.primary[name]
      if (!s) continue
      const f = label.includes('MB') ? (BYTES[summary.units?.[name] ?? ''] ?? 1) * factor : factor
      lines.push(`| ${label} | ${fmt(s.average * f)} | ${fmt(s.peak * f)} | ${fmt(s.latest * f)} |`)
    }
    lines.push('')
  }
  if (summary.slowOps) {
    const s = summary.slowOps
    lines.push(`Slow operations (Atlas's slow log, last 24 h): ${s.count}, ${fmt(s.totalSeconds)} s in all, ${fmt(s.peakSecondsPerMinute)} s in the worst minute` +
      `${s.unreadable ? `, ${s.unreadable} lines unreadable` : ''}.`, '', '| Namespace | Op | Filter keys | Count | Seconds |', '|---|---|---|---|---|',
    ...s.top.map(t => `| ${t.ns} | ${t.op} | \`${t.shape}\` | ${t.count} | ${fmt(t.seconds)} |`), '')
  }
  if (summary.sizes) {
    const z = summary.sizes, mb = (b: number) => fmt(b / 1e6)
    lines.push(`Sizes, read from ${z.readFrom}: ${z.collections.length} collections, ${mb(z.dataBytes)} MB of data, ${mb(z.indexBytes)} MB of indexes.`, '',
      '| Collection | Documents | Data (MB) | Indexes (MB) | Indexes |', '|---|---|---|---|---|',
      ...z.collections.slice(0, 15).map(c => `| ${c.name} | ${c.count} | ${mb(c.dataBytes)} | ${mb(c.indexBytes)} | ${c.nindexes} |`), '')
  }
  for (const s of summary.skipped) lines.push(`Skipped ${s}`)
  for (const f of summary.failed) lines.push(`Failed ${f}`)
  return `${lines.join('\n')}\n`
}

export async function runSnapshot({ env, out, label, now = Date.now(), print = console.log }:
  { env: NodeJS.ProcessEnv; out: string; label: string; now?: number; print?: (line: string) => void }): Promise<{ ok: boolean; skipped: string[]; failed: string[] }> {
  const summary: Summary = { label, takenAt: new Date(now).toISOString(), skipped: [], failed: [] }
  const files: Record<string, unknown> = {}
  const base = (env.ATLAS_BASE_URL ?? 'https://cloud.mongodb.com').replace(/\/$/, '')
  const auth: Auth | undefined = env.ATLAS_CLIENT_ID && env.ATLAS_CLIENT_SECRET ? { kind: 'service', clientId: env.ATLAS_CLIENT_ID, clientSecret: env.ATLAS_CLIENT_SECRET }
    : env.ATLAS_PUBLIC_KEY && env.ATLAS_PRIVATE_KEY ? { kind: 'digest', publicKey: env.ATLAS_PUBLIC_KEY, privateKey: env.ATLAS_PRIVATE_KEY } : undefined

  if (!auth) summary.skipped.push('atlas: set ATLAS_CLIENT_ID and ATLAS_CLIENT_SECRET, or ATLAS_PUBLIC_KEY and ATLAS_PRIVATE_KEY')
  else if (!env.ATLAS_GROUP_ID || !env.ATLAS_CLUSTER) summary.skipped.push('atlas: set ATLAS_GROUP_ID and ATLAS_CLUSTER')
  else {
    try {
      const atlas = await snapshotAtlas(atlasClient(base, auth), env.ATLAS_GROUP_ID, env.ATLAS_CLUSTER, now)
      Object.assign(summary, { primaryProcess: atlas.primaryProcess, primary: atlas.primary, units: atlas.units, slowOps: atlas.slowOps })
      files['measurements.json'] = { processes: atlas.processes, measurements: atlas.measurements }
      files['slow-queries.json'] = atlas.slow
    } catch (error) {
      summary.failed.push(`atlas: ${redactUrl(error instanceof Error ? error.message : String(error))}`)
    }
  }
  if (!env.MONGO_READONLY_URL) summary.skipped.push('sizes: set MONGO_READONLY_URL to the read-only user')
  else {
    try {
      summary.sizes = await snapshotSizes(env.MONGO_READONLY_URL)
      files['sizes.json'] = summary.sizes
    } catch (error) {
      summary.failed.push(`sizes: ${redactUrl(error instanceof Error ? error.message : String(error))}`)
    }
  }

  await mkdir(out, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(out, name), `${JSON.stringify(content, null, 1)}\n`)
  await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`)
  await writeFile(join(out, 'summary.md'), markdown(summary))
  print(`Saved to ${out}`)
  for (const s of summary.skipped) print(`Skipped ${s}`)
  for (const f of summary.failed) print(`Failed ${f}`)
  const ran = Boolean(summary.primary || summary.sizes)
  return { ok: ran && !summary.failed.length, skipped: summary.skipped, failed: summary.failed }
}

/** Two snapshots' numbers side by side, with the change. */
export function compareSnapshots(before: Summary, after: Summary): string {
  const rows: [string, number | undefined, number | undefined][] = []
  for (const [name, label, factor] of ROWS) {
    for (const key of ['average', 'peak'] as const) {
      const f = label.includes('MB') ? (BYTES[before.units?.[name] ?? ''] ?? 1) * factor : factor
      const b = before.primary?.[name]?.[key], a = after.primary?.[name]?.[key]
      if (b !== undefined || a !== undefined) rows.push([`${label}, ${key}`, b === undefined ? b : b * f, a === undefined ? a : a * f])
    }
  }
  rows.push(['Slow operations, seconds', before.slowOps?.totalSeconds, after.slowOps?.totalSeconds],
    ['Slow operations, worst minute (s)', before.slowOps?.peakSecondsPerMinute, after.slowOps?.peakSecondsPerMinute],
    ['Data (MB)', before.sizes && before.sizes.dataBytes / 1e6, after.sizes && after.sizes.dataBytes / 1e6],
    ['Indexes (MB)', before.sizes && before.sizes.indexBytes / 1e6, after.sizes && after.sizes.indexBytes / 1e6])
  const change = (b?: number, a?: number) => b === undefined || a === undefined || b === 0 ? '–' : `${a >= b ? '+' : ''}${Math.round((a / b - 1) * 100)}%`
  const cell = (n?: number) => n === undefined ? '–' : fmt(n)
  return [`| Metric | ${before.label} (${before.takenAt}) | ${after.label} (${after.takenAt}) | Change |`, '|---|---|---|---|',
    ...rows.filter(([, b, a]) => b !== undefined || a !== undefined).map(([label, b, a]) => `| ${label} | ${cell(b)} | ${cell(a)} | ${change(b, a)} |`)].join('\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const option = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined }
  const compare = args.indexOf('--compare')
  if (compare >= 0) {
    const [before, after] = [args[compare + 1], args[compare + 2]]
    if (!before || !after) throw new Error('Usage: --compare BEFORE_DIR AFTER_DIR')
    const read = async (dir: string) => JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as Summary
    console.log(compareSnapshots(await read(before), await read(after)))
    return
  }
  const label = option('label') ?? 'snapshot'
  const out = option('out') ?? join('atlas-snapshots', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const result = await runSnapshot({ env: process.env, out, label })
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(redactUrl(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
