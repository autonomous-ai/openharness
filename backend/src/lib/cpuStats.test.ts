import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseThreadStat, readThreads, threadBucket } from './cpuStats.js'

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
