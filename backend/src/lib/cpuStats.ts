import { readdirSync, readFileSync } from 'node:fs'

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
