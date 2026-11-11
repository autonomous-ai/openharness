import { readdirSync, readFileSync } from 'node:fs'
import { constants, performance, PerformanceObserver } from 'node:perf_hooks'
import type { FastifyInstance } from 'fastify'
import { logger } from '../utils/logger.js'

/**
 * Where this process's CPU goes, by thread (Watch Production gap 2, #2801). On 11-04 a pod-minute had 43.9 s of process CPU
 * and `cpu by kind` (lib/selfProfile.ts) named 15.3 s of it: that log sees the main thread only, and ~40% ran off it.
 * Linux names each thread, so one read of `/proc/self/task/<tid>/stat` per thread a minute splits it with nothing per
 * request. Measured on Node 22.23 with Prisma 5.22 (library engine, in-process), arm64 Ubuntu:
 *
 * - the main thread's tid is the pid;
 * - `tokio-runtime-w` (and its tracing exporter `opentelemetry-e`) are the Prisma query engine's: it runs each query,
 *   encodes and decodes BSON and builds the JSON string the client then parses;
 * - `libuv-worker` is the libuv pool: zlib, fs, crypto, dns lookups;
 * - `node` threads other than the main one, and `DelayedTaskSche`, are V8's platform workers: concurrent GC and JIT.
 *
 * `cpu by thread`, every minute, always on: process CPU, each bucket's CPU, `exitedMs` (threads that ended inside the
 * window, known only by the process total) and `namedPct`, the four named buckets' share. On the main thread, two
 * counters say what part of it is GC pauses (a `gc` PerformanceObserver) and reply JSON (registerReplyJsonTiming); the
 * rest of it is split by route in `cpu by kind`. Off Linux the thread split says `unavailable` and the rest still logs.
 */

export type ThreadBucket = 'main' | 'prismaEngine' | 'libuvPool' | 'v8Workers' | 'other'
export type ThreadCpu = { tid: number; name: string; cpuMs: number }

/** USER_HZ: the unit of /proc's CPU times, 100 on every Linux architecture the pods run on. */
const TICKS_PER_SECOND = 100

/** A thread's name and its user + system CPU in ms, from its `/proc/<pid>/task/<tid>/stat` line. The name sits between the
 *  first `(` and the last `)` and may hold either; utime and stime are the 14th and 15th fields. */
export function parseThreadStat(text: string): { name: string; cpuMs: number } {
  const open = text.indexOf('('), close = text.lastIndexOf(')')
  if (open < 0 || close < open) throw new Error('not a stat line')
  // Fields after the name start at the 3rd (state): utime is the 14th, stime the 15th.
  const fields = text.slice(close + 2).split(' ')
  const ticks = Number(fields[11]) + Number(fields[12])
  if (!Number.isFinite(ticks)) throw new Error('stat line without CPU times')
  return { name: text.slice(open + 1, close), cpuMs: ticks * 1000 / TICKS_PER_SECOND }
}

export function threadBucket(name: string, tid: number, pid: number): ThreadBucket {
  if (tid === pid) return 'main'
  if (name.startsWith('tokio-runtime') || name.startsWith('opentelemetry')) return 'prismaEngine'
  if (name === 'libuv-worker') return 'libuvPool'
  if (name === 'node' || name.startsWith('DelayedTaskSche') || name.startsWith('V8')) return 'v8Workers'
  return 'other'
}

/** Every thread of this process with its CPU so far. A thread that exits between the listing and its read is skipped; an
 *  unreadable folder throws (not Linux, or /proc not mounted). */
export function readThreads(root = '/proc/self/task'): ThreadCpu[] {
  const threads: ThreadCpu[] = []
  for (const entry of readdirSync(root)) {
    let text: string
    try { text = readFileSync(`${root}/${entry}/stat`, 'utf8') } catch { continue }
    threads.push({ tid: Number(entry), ...parseThreadStat(text) })
  }
  return threads
}

export type CpuStats = {
  /** One reply's JSON: how long `JSON.stringify` took and the bytes it made. */
  replyJson(ms: number, bytes: number): void
  /** Logs the window now and starts the next one (the timer calls it every minute). */
  flush(): void
  stop(): void
}

export type CpuStatsOptions = {
  everyMs?: number
  log?: (message: string, context: Record<string, unknown>) => void
  pid?: number
  threads?: () => ThreadCpu[]
  cpuUsage?: () => NodeJS.CpuUsage
  /** The main thread's event-loop utilization since the last call, 0 to 1. */
  loopUtilization?: () => number
  /** Calls onGc for every main-thread GC pause; returns its stop. */
  observeGc?: (onGc: (durationMs: number, major: boolean) => void) => () => void
}

const MAX_NAMES = 10

function loopSinceLast(): () => number {
  let last = performance.eventLoopUtilization()
  return () => {
    const now = performance.eventLoopUtilization()
    const since = performance.eventLoopUtilization(now, last)
    last = now
    return since.utilization
  }
}

function gcObserver(onGc: (durationMs: number, major: boolean) => void): () => void {
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const kind = (entry as { detail?: { kind?: number } }).detail?.kind
      onGc(entry.duration, kind === constants.NODE_PERFORMANCE_GC_MAJOR)
    }
  })
  observer.observe({ entryTypes: ['gc'] })
  return () => observer.disconnect()
}

export function startCpuStats({ everyMs = 60_000, log = (message, context) => logger.info(message, context), pid = process.pid,
  threads = () => readThreads(), cpuUsage = () => process.cpuUsage(), loopUtilization = loopSinceLast(),
  observeGc = gcObserver }: CpuStatsOptions = {}): CpuStats {
  const toMs = (usage: NodeJS.CpuUsage) => (usage.user + usage.system) / 1000
  const read = (): { threads: ThreadCpu[] } | { error: string } => {
    try { return { threads: threads() } } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }
  const byTid = (snapshot: ReturnType<typeof read>) => new Map('threads' in snapshot ? snapshot.threads.map(t => [t.tid, t.cpuMs]) : [])
  let processMs = toMs(cpuUsage()), started = performance.now(), before = byTid(read())
  let gc = { pauseMs: 0, count: 0, majorMs: 0 }, json = { ms: 0, count: 0, bytes: 0 }
  let stopGc: (() => void) | undefined = observeGc((ms, major) => {
    if (!stopGc) return
    gc.pauseMs += ms; gc.count++
    if (major) gc.majorMs += ms
  })

  const flush = () => {
    const nowMs = toMs(cpuUsage()), processCpuMs = nowMs - processMs
    const context: Record<string, unknown> = { windowMs: Math.round(performance.now() - started), processCpuMs: Math.round(processCpuMs) }
    const current = read()
    if ('threads' in current) {
      const sums: Record<ThreadBucket, number> = { main: 0, prismaEngine: 0, libuvPool: 0, v8Workers: 0, other: 0 }
      const names = new Map<string, number>()
      let counted = 0
      for (const thread of current.threads) {
        // A thread new in the window has all its CPU in it.
        const delta = Math.max(0, thread.cpuMs - (before.get(thread.tid) ?? 0))
        const bucket = threadBucket(thread.name, thread.tid, pid)
        sums[bucket] += delta; counted += delta
        if (bucket === 'other' && delta > 0) names.set(thread.name, (names.get(thread.name) ?? 0) + delta)
      }
      const named = sums.main + sums.prismaEngine + sums.libuvPool + sums.v8Workers
      Object.assign(context, {
        mainMs: Math.round(sums.main), prismaEngineMs: Math.round(sums.prismaEngine), libuvPoolMs: Math.round(sums.libuvPool),
        v8WorkersMs: Math.round(sums.v8Workers), otherThreadsMs: Math.round(sums.other),
        // Threads that ended inside the window: in the process total, gone from /proc.
        exitedMs: Math.round(Math.max(0, processCpuMs - counted)),
        namedPct: processCpuMs > 0 ? Math.round(Math.min(named, processCpuMs) / processCpuMs * 100) : 0,
        otherNames: Object.fromEntries([...names].sort((a, b) => b[1] - a[1]).slice(0, MAX_NAMES).map(([name, ms]) => [name, Math.round(ms)])),
      })
    } else Object.assign(context, { threads: 'unavailable', reason: current.error })
    Object.assign(context, {
      gc: { pauseMs: Math.round(gc.pauseMs), count: gc.count, majorMs: Math.round(gc.majorMs) },
      replyJson: { ms: Math.round(json.ms), count: json.count, kb: Math.round(json.bytes / 1024) },
      loopBusyPct: Math.round(loopUtilization() * 100),
    })
    log('cpu by thread', context)
    processMs = nowMs; started = performance.now(); before = byTid(current)
    gc = { pauseMs: 0, count: 0, majorMs: 0 }; json = { ms: 0, count: 0, bytes: 0 }
  }

  const timer = setInterval(flush, everyMs)
  timer.unref()
  return {
    replyJson(ms, bytes) { json.ms += ms; json.count++; json.bytes += bytes },
    flush,
    stop() { clearInterval(timer); const stop = stopGc; stopGc = undefined; stop?.() },
  }
}

/**
 * Every object reply's JSON, timed: what `JSON.stringify` of big replies costs the main thread. Fastify's own serializer
 * for a route without a response schema is that same `JSON.stringify` (fastify/lib/reply.js serialize), so the bytes do
 * not change. A response schema would be bypassed by this serializer, so a route declaring one is refused at startup;
 * none has one. Replies sent as strings or buffers are not serialized and not counted. Size is in characters, not bytes,
 * to keep the count free.
 */
export function registerReplyJsonTiming(app: FastifyInstance, stats: Pick<CpuStats, 'replyJson'>): void {
  app.addHook('onRoute', route => {
    if (route.schema?.response) {
      throw new Error(`${String(route.method)} ${route.url}: a response schema would be bypassed by the timed reply serializer ` +
        '(lib/cpuStats.ts registerReplyJsonTiming); serialize in the handler instead')
    }
  })
  app.setReplySerializer(payload => {
    const start = performance.now()
    const text = JSON.stringify(payload)
    stats.replyJson(performance.now() - start, text.length)
    return text
  })
}
