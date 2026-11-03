import { createHook, executionAsyncResource } from 'node:async_hooks'
import { Session } from 'node:inspector/promises'
import { performance } from 'node:perf_hooks'
import type { FastifyInstance } from 'fastify'
import { logger } from '../utils/logger.js'
import { enterWork } from './queryStats.js'

/**
 * Where this process spends its CPU, logged from production without a debugger (#314: five pods with few people).
 * Off unless CPU_SELF_PROFILE=1. Two logs, neither with user data, only code locations and route/frame/job names:
 *
 * - `cpu by kind`, every minute: event-loop busy ms per kind of work, an HTTP route pattern, a web-ws or manager-ws
 *   frame type, or a timer's function name for background jobs. A kind is set where the work starts (markCpuKind) and
 *   follows every callback and promise that work creates, as AsyncLocalStorage does, so awaited DB replies count too.
 * - `cpu profile`, 30 s every 15 min: the V8 sampling profiler of this process, top files and functions by self time.
 *
 * ponytail: the async hook adds overhead to every callback and promise (a few % in the bench); it is a diagnostic flag.
 */
const KIND = Symbol('cpuKind')
type Tagged = { [KIND]?: string }
let enabled = false
let current: string | undefined, since = 0
let busy = new Map<string, number>()
/** Names one window keeps; work under any further name counts as `other`, so memory stays bounded. */
const MAX_KINDS = 50

/** Names the work running now, and everything it goes on to schedule: always for the query stats (lib/queryStats.ts),
 *  and for the CPU accounting when the profile is on. */
export function markCpuKind(kind: string): void {
  enterWork(kind)
  if (!enabled) return
  const resource = executionAsyncResource() as Tagged
  if (resource) resource[KIND] = kind
  account(); switchTo(kind)
}

/** While a profile runs, when each kind of work began, so its samples can be split by route (`byRoute`). Bounded: past
 *  MAX_MARKS a window stops marking and its later samples count under the last kind. */
let marks: Array<[number, string]> | null = null
const MAX_MARKS = 1_000_000
function switchTo(kind: string | undefined): void {
  current = kind
  if (marks && marks.length < MAX_MARKS) marks.push([performance.now(), kind ?? '(idle)'])
}

function account(): void {
  const now = performance.now()
  if (current !== undefined) {
    const kind = busy.has(current) || busy.size < MAX_KINDS ? current : 'other'
    busy.set(kind, (busy.get(kind) ?? 0) + now - since)
  }
  since = now
}

/** A WebSocket frame's kind: `<prefix> <type>` for a type in [known], else `<prefix> other`, so nothing a client
 *  sends becomes a log key. */
export function frameKind(prefix: string, type: unknown, known: ReadonlySet<string>): string {
  return `${prefix} ${typeof type === 'string' && known.has(type) ? type : 'other'}`
}

/** A Redis message's kind: `bus <subscriber> <channel kind>`, the channel's name before its first `:` (`termup:<machine>` is
 *  `termup`), never the id after it. A name that is not one of the bus's own counts as `other`. Before these were named, a
 *  sixth of prod's CPU ran under `untagged` (2026-10-31): Redis deliveries, the daemons' sockets and the share sockets. */
export function busKind(subscriber: string, channel: string): string {
  const name = channel.split(':', 1)[0]!
  return `bus ${subscriber} ${/^[a-z0-9-]{1,24}$/.test(name) ? name : 'other'}`
}

/** Every HTTP request is named by its route pattern, never its URL (no ids). */
export function registerCpuKinds(app: FastifyInstance): void {
  app.addHook('onRequest', async request => { markCpuKind(`http ${request.method} ${request.routeOptions.url ?? 'unrouted'}`) })
}

/** With CPU_SELF_PROFILE=1, starts the profile and names HTTP requests; off, adds nothing to the server. Returns its
 *  stop, or undefined when off. */
export function selfProfileFromEnv(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env, options?: SelfProfileOptions): (() => void) | undefined {
  if (env.CPU_SELF_PROFILE !== '1') return undefined
  registerCpuKinds(app)
  return startSelfProfile(options)
}

export type SelfProfileOptions = { everyMs?: number; profileMs?: number; reportMs?: number; log?: (message: string, context: Record<string, unknown>) => void }

export function startSelfProfile({ everyMs = 15 * 60_000, profileMs = 30_000, reportMs = 60_000,
  log = (message, context) => logger.info(message, context) }: SelfProfileOptions = {}): () => void {
  enabled = true
  const hook = createHook({
    init(_id, type, _trigger, resource) {
      const inherited = (executionAsyncResource() as Tagged)?.[KIND]
      const timer = type === 'Timeout' ? (resource as { _onTimeout?: { name?: string } })._onTimeout?.name : undefined
      const kind = inherited ?? (type === 'Timeout' ? `job ${timer || 'anonymous'}` : undefined)
      if (kind) (resource as Tagged)[KIND] = kind
    },
    before() { account(); switchTo((executionAsyncResource() as Tagged)?.[KIND] ?? 'untagged') },
    after() { account(); switchTo(undefined) },
  }).enable()

  let cpu = process.cpuUsage(), wall = performance.now()
  const report = setInterval(() => {
    account()
    const used = process.cpuUsage(cpu), elapsed = performance.now() - wall
    const kinds = Object.fromEntries([...busy].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, ms]) => [k, Math.round(ms)]))
    log('cpu by kind', { windowMs: Math.round(elapsed), processCpuMs: Math.round((used.user + used.system) / 1000), busyMs: kinds })
    busy = new Map(); cpu = process.cpuUsage(); wall = performance.now()
  }, reportMs)
  report.unref()

  // One profile at a time: a second would replace the first one's marks (and V8 runs one coverage session per process).
  let profiling = false
  const profile = async () => {
    if (profiling) return
    profiling = true
    const session = new Session()
    session.connect()
    try {
      await session.post('Profiler.enable')
      // Call counts for the same window: ~2.6% CPU while on (messages + changes load on a copy of prod's busiest Swarm).
      await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
      const start = performance.now()
      const recorded: Array<[number, string]> = [[start, current ?? '(idle)']]
      marks = recorded
      await session.post('Profiler.start')
      await new Promise(resolve => setTimeout(resolve, profileMs).unref())
      const { profile: p } = await session.post('Profiler.stop')
      marks = null
      const kinds = { start, marks: recorded }
      const { result: coverage } = await session.post('Profiler.takePreciseCoverage')
      await session.post('Profiler.stopPreciseCoverage')
      log('cpu profile', { profileMs, ...topSelfTime(p, kinds), calls: topCalls(coverage) })
    } catch (error) {
      logger.warn('cpu profile failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      marks = null
      profiling = false
      session.disconnect()
    }
  }
  const first = setTimeout(() => void profile(), Math.min(everyMs, 60_000)).unref()
  const every = setInterval(() => void profile(), everyMs).unref()
  return () => { enabled = false; hook.disable(); clearInterval(report); clearTimeout(first); clearInterval(every) }
}

type Frame = { functionName: string; url: string; lineNumber: number }
type Profile = { nodes: { id: number; callFrame: Frame; children?: number[] }[]; samples?: number[]; timeDeltas?: number[]; startTime?: number }
/** When each kind of work began during the profile, in performance.now() ms, from `start` (the profile's own start). */
type Kinds = { start: number; marks: ReadonlyArray<readonly [number, string]> }
type RouteProfile = { sampledMs: number; inclusive: Record<string, number>; callers: Record<string, number> }

/**
 * The profile by self time (`files`, `functions`), and what the self time alone cannot tell, the stacks being dropped:
 * - `callers`: a dependency's or built-in's self time (Prisma's decoding, structuredClone) by the nearest function of ours
 *   above it, as `<function> ← <our function>`;
 * - `inclusive`: each function of ours by the time spent in it and everything it called, counted once per sample however
 *   deep it recurses.
 * - `byRoute` (with `kinds`): the same two for each kind of work that ran a sample (an HTTP route, a frame, a job), so a
 *   built-in's cost is known per route, not only per caller.
 * Ours is what runs from `dist/` or `src/`; V8's own entries (idle, program, garbage collector) have no stack and count in
 * none of them.
 */
export function topSelfTime(profile: Profile, kinds?: Kinds): { sampledMs: number; files: Record<string, number>; functions: Record<string, number>
  callers: Record<string, number>; inclusive: Record<string, number>; byRoute?: Record<string, RouteProfile> } {
  const byId = new Map(profile.nodes.map(n => [n.id, n.callFrame]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  // Named once per node: a 30 s profile has tens of thousands of samples, each walking its stack.
  const ourName = new Map(profile.nodes.filter(n => isOurs(n.callFrame.url)).map(n => [n.id, name(n.callFrame)]))
  const files = new Map<string, number>(), functions = new Map<string, number>(), callers = new Map<string, number>(), inclusive = new Map<string, number>()
  const add = (m: Map<string, number>, key: string, us: number) => m.set(key, (m.get(key) ?? 0) + us)
  let total = 0, at = 0, mark = 0
  const routes = new Map<string, { us: number; callers: Map<string, number>; inclusive: Map<string, number> }>()
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const frame = byId.get(samples[i]!), us = deltas[i + 1] ?? 0
    at += deltas[i] ?? 0
    if (!frame) continue
    total += us
    const file = shortFile(frame.url) || `(${frame.functionName || 'native'})`
    add(files, file, us)
    const fn = name(frame)
    add(functions, fn, us)
    if (!frame.url && frame.functionName.startsWith('(')) continue
    const ours = new Set<string>()
    let nearest: string | undefined
    for (let id: number | undefined = samples[i]; id !== undefined; id = parent.get(id)) {
      const key = ourName.get(id)
      if (!key) continue
      nearest ??= key
      ours.add(key)
    }
    if (nearest && !ourName.has(samples[i]!)) add(callers, `${fn} ← ${nearest}`, us)
    for (const key of ours) add(inclusive, key, us)
    if (!kinds?.marks.length) continue
    // Samples come in time order, so the kind that ran each one is found by walking the marks forward once.
    const when = kinds.start + at / 1000
    while (mark + 1 < kinds.marks.length && kinds.marks[mark + 1]![0] <= when) mark++
    const kind = kinds.marks[mark]![1]
    let route = routes.get(kind)
    if (!route) routes.set(kind, route = { us: 0, callers: new Map(), inclusive: new Map() })
    route.us += us
    if (nearest && !ourName.has(samples[i]!)) add(route.callers, `${fn} ← ${nearest}`, us)
    for (const key of ours) add(route.inclusive, key, us)
  }
  const top = (m: Map<string, number>, n: number) =>
    Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => [k, Math.round(us / 1000)]))
  const byRoute = kinds ? Object.fromEntries([...routes].sort((a, b) => b[1].us - a[1].us).slice(0, 15).map(([kind, r]) =>
    [kind, { sampledMs: Math.round(r.us / 1000), inclusive: top(r.inclusive, 10), callers: top(r.callers, 10) }])) : undefined
  return { sampledMs: Math.round(total / 1000), files: top(files, 20), functions: top(functions, 30), callers: top(callers, 30), inclusive: top(inclusive, 40),
    ...(byRoute ? { byRoute } : {}) }
}

type Coverage = Array<{ url: string; functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; count: number }> }> }>

/** How many times each function of ours ran in the window (V8 precise coverage), most first. A sampling profile tells time,
 *  never counts; a function called millions of times for little each (a filter callback, a hash) shows here. An anonymous
 *  function is named by its file and character offset. */
export function topCalls(coverage: Coverage, n = 30): Record<string, number> {
  const calls = new Map<string, number>()
  for (const script of coverage) {
    if (!isOurs(script.url)) continue
    const file = shortFile(script.url)
    for (const fn of script.functions) {
      const range = fn.ranges[0]
      if (!range?.count) continue
      const key = fn.functionName ? `${fn.functionName} ${file}` : `(anonymous) ${file}@${range.startOffset}`
      calls.set(key, (calls.get(key) ?? 0) + range.count)
    }
  }
  return Object.fromEntries([...calls].sort((a, b) => b[1] - a[1]).slice(0, n))
}

const name = (frame: Frame) => {
  const file = shortFile(frame.url) || `(${frame.functionName || 'native'})`
  return `${frame.functionName || '(anonymous)'} ${file}${frame.url ? `:${frame.lineNumber + 1}` : ''}`
}
const isOurs = (url: string) => /^(dist|src)\//.test(shortFile(url))

/** `file:///app/dist/lib/hub.js` → `dist/lib/hub.js`; a dependency → `node_modules/<package>/<file>`. */
function shortFile(url: string): string {
  const path = url.replace(/^file:\/\//, '')
  const modules = path.lastIndexOf('/node_modules/')
  if (modules >= 0) return path.slice(modules + 1)
  const cwd = `${process.cwd()}/`
  return path.startsWith(cwd) ? path.slice(cwd.length) : path
}
