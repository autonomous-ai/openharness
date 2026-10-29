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
  account(); current = kind
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
    before() { account(); current = (executionAsyncResource() as Tagged)?.[KIND] ?? 'untagged' },
    after() { account(); current = undefined },
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

  const profile = async () => {
    const session = new Session()
    session.connect()
    try {
      await session.post('Profiler.enable')
      await session.post('Profiler.start')
      await new Promise(resolve => setTimeout(resolve, profileMs).unref())
      const { profile: p } = await session.post('Profiler.stop')
      log('cpu profile', { profileMs, ...topSelfTime(p) })
    } catch (error) {
      logger.warn('cpu profile failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      session.disconnect()
    }
  }
  const first = setTimeout(() => void profile(), Math.min(everyMs, 60_000)).unref()
  const every = setInterval(() => void profile(), everyMs).unref()
  return () => { enabled = false; hook.disable(); clearInterval(report); clearTimeout(first); clearInterval(every) }
}

type Profile = { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples?: number[]; timeDeltas?: number[] }

export function topSelfTime(profile: Profile): { sampledMs: number; files: Record<string, number>; functions: Record<string, number> } {
  const byId = new Map(profile.nodes.map(n => [n.id, n.callFrame]))
  const files = new Map<string, number>(), functions = new Map<string, number>()
  let total = 0
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const frame = byId.get(samples[i]!), us = deltas[i + 1] ?? 0
    if (!frame) continue
    total += us
    const file = shortFile(frame.url) || `(${frame.functionName || 'native'})`
    files.set(file, (files.get(file) ?? 0) + us)
    const fn = `${frame.functionName || '(anonymous)'} ${file}${frame.url ? `:${frame.lineNumber + 1}` : ''}`
    functions.set(fn, (functions.get(fn) ?? 0) + us)
  }
  const top = (m: Map<string, number>, n: number) =>
    Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => [k, Math.round(us / 1000)]))
  return { sampledMs: Math.round(total / 1000), files: top(files, 20), functions: top(functions, 30) }
}

/** `file:///app/dist/lib/hub.js` → `dist/lib/hub.js`; a dependency → `node_modules/<package>/<file>`. */
function shortFile(url: string): string {
  const path = url.replace(/^file:\/\//, '')
  const modules = path.lastIndexOf('/node_modules/')
  if (modules >= 0) return path.slice(modules + 1)
  const cwd = `${process.cwd()}/`
  return path.startsWith(cwd) ? path.slice(cwd.length) : path
}
