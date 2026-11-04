import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { parseThreadStat, readThreads, startCpuStats, threadBucket, type ThreadCpu } from './cpuStats.js'

let stop = () => {}
afterEach(() => { stop(); stop = () => {} })

describe('thread CPU', () => {
  it('reads a thread\'s name and its user plus system CPU from its stat line, whatever the name holds', () => {
    // Fields after the name: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime …
    const line = '4242 (we(ird) name)) S 1 4242 4242 0 -1 4194560 120 0 0 0 1234 56 0 0 20 0 30 0 100 0 0'
    expect(parseThreadStat(line)).toEqual({ name: 'we(ird) name)', cpuMs: 12_900 })
  })

  it('names the bucket of every thread a pod runs (Node 22, Prisma 5.22 library engine), and nothing else', () => {
    const pid = 10
    expect(threadBucket('node', 10, pid)).toBe('main')
    // The main thread is the pid, whatever process.title made its name.
    expect(threadBucket('harness-api', 10, pid)).toBe('main')
    expect(threadBucket('tokio-runtime-w', 11, pid)).toBe('prismaEngine')
    expect(threadBucket('opentelemetry-e', 12, pid)).toBe('prismaEngine')
    expect(threadBucket('libuv-worker', 13, pid)).toBe('libuvPool')
    expect(threadBucket('node', 14, pid)).toBe('v8Workers')
    expect(threadBucket('DelayedTaskSche', 15, pid)).toBe('v8Workers')
    expect(threadBucket('mystery', 16, pid)).toBe('other')
  })

  it.skipIf(process.platform !== 'linux')('reads this process\'s own threads: the main thread with CPU, and the libuv pool after zlib', async () => {
    await promisify(gzip)(Buffer.alloc(1 << 20))
    const threads = readThreads()
    const main = threads.find(thread => thread.tid === process.pid)
    expect(main?.cpuMs).toBeGreaterThan(0)
    expect(threads.some(thread => thread.name === 'libuv-worker')).toBe(true)
  })

  it('fails loudly when the folder cannot be read', () => {
    expect(() => readThreads('/nonexistent-cpu-stats-root')).toThrow()
  })
})

describe('cpu by thread', () => {
  const pid = 10
  /** A fake process: each flush reads `threads` and the process CPU as they are then. */
  function fake(initial: ThreadCpu[], processMs: number) {
    const state = { threads: initial, processMs, loop: 0.5 }
    const logs: Array<{ message: string; context: Record<string, unknown> }> = []
    let gc: ((durationMs: number, major: boolean) => void) | undefined
    const stats = startCpuStats({
      everyMs: 3_600_000, pid,
      log: (message, context) => logs.push({ message, context }),
      threads: () => state.threads,
      cpuUsage: () => ({ user: state.processMs * 1000, system: 0 }),
      loopUtilization: () => state.loop,
      observeGc: onGc => { gc = onGc; return () => { gc = undefined } },
    })
    return { state, logs, stats, gc: (ms: number, major = false) => gc?.(ms, major) }
  }

  it('splits the window\'s process CPU by thread bucket, counting a new thread in full and a gone one as exited', () => {
    const { state, logs, stats } = fake([
      { tid: 10, name: 'node', cpuMs: 1000 }, { tid: 11, name: 'tokio-runtime-w', cpuMs: 500 },
      { tid: 12, name: 'libuv-worker', cpuMs: 10 }, { tid: 13, name: 'node', cpuMs: 200 }, { tid: 14, name: 'tokio-runtime-w', cpuMs: 90 },
    ], 2000)
    state.threads = [
      { tid: 10, name: 'node', cpuMs: 1400 }, { tid: 11, name: 'tokio-runtime-w', cpuMs: 800 },
      { tid: 12, name: 'libuv-worker', cpuMs: 30 }, { tid: 13, name: 'node', cpuMs: 250 },
      // New in the window: all its CPU is the window's.
      { tid: 15, name: 'mystery', cpuMs: 40 },
      // tid 14 exited: its last share is only in the process total.
    ]
    state.processMs = 2000 + 400 + 300 + 20 + 50 + 40 + 90
    stats.flush()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.message).toBe('cpu by thread')
    expect(logs[0]!.context).toMatchObject({
      processCpuMs: 900, mainMs: 400, prismaEngineMs: 300, libuvPoolMs: 20, v8WorkersMs: 50, otherThreadsMs: 40, exitedMs: 90,
      namedPct: 86, otherNames: { mystery: 40 }, loopBusyPct: 50,
    })
    stop = stats.stop
  })

  it('adds the main thread\'s GC pauses and reply JSON, and starts each window from zero', () => {
    const { state, logs, stats, gc } = fake([{ tid: 10, name: 'node', cpuMs: 0 }], 0)
    gc(3); gc(7, true)
    stats.replyJson(2.5, 2048); stats.replyJson(0.5, 1024)
    state.threads = [{ tid: 10, name: 'node', cpuMs: 100 }]; state.processMs = 100
    stats.flush()
    expect(logs[0]!.context).toMatchObject({ gc: { pauseMs: 10, count: 2, majorMs: 7 }, replyJson: { ms: 3, count: 2, kb: 3 } })
    stats.flush()
    expect(logs[1]!.context).toMatchObject({ processCpuMs: 0, mainMs: 0, gc: { pauseMs: 0, count: 0, majorMs: 0 }, replyJson: { ms: 0, count: 0, kb: 0 } })
    stats.stop()
    gc(5)
    stats.flush()
    expect(logs[2]!.context).toMatchObject({ gc: { count: 0 } })
  })

  it('says every window when it cannot read the threads, and still logs the rest', () => {
    const logs: Array<Record<string, unknown>> = []
    const stats = startCpuStats({ everyMs: 3_600_000, log: (_m, context) => logs.push(context), observeGc: () => () => {},
      threads: () => { throw new Error('ENOENT /proc/self/task') } })
    stop = stats.stop
    stats.flush(); stats.flush()
    expect(logs).toHaveLength(2)
    for (const context of logs) {
      expect(context).toMatchObject({ threads: 'unavailable', reason: 'ENOENT /proc/self/task' })
      expect(typeof context.processCpuMs).toBe('number')
    }
  })
})
