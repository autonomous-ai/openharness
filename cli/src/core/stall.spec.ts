import { channel } from 'node:diagnostics_channel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testFaults } from './serviceHost.js'
import { processStallDeps, startStalls, type StallDeps } from './stall.js'

function deps(randoms: number[] = []) {
  const held: number[] = []
  const lines: string[] = []
  let signal: (() => void) | null = null
  let spawn: (() => void) | null = null
  let unsubscribed = 0
  const fake: StallDeps = {
    hold: (ms) => { held.push(ms) },
    random: () => randoms.shift() ?? 0.5,
    onSignal: (listener) => {
      signal = listener
      return () => { unsubscribed++; signal = null }
    },
    onSpawn: (listener) => {
      spawn = listener
      return () => { unsubscribed++; spawn = null }
    },
    log: (line) => lines.push(line),
  }
  return { fake, held, lines, signal: () => signal?.(), spawn: () => spawn?.(), unsubscribed: () => unsubscribed }
}

// Holds run in the check phase; this lets one turn of the loop pass.
const turn = () => new Promise((resolve) => setImmediate(resolve))

describe('holding the core\'s event loop on demand, for the stall tests', () => {
  afterEach(() => { vi.useRealTimers() })

  it('is inert unless the faults name it', () => {
    const d = deps()
    expect(startStalls(testFaults(undefined), d.fake)).toBeNull()
    expect(startStalls(testFaults('search,viewers.attach'), d.fake)).toBeNull()
    expect(d.lines).toEqual([])
  })

  it('a fixed length holds for exactly that, on every SIGUSR2, in the check phase', async () => {
    const d = deps()
    const stalls = startStalls(testFaults('search, core.stall:3000'), d.fake)!
    expect(d.lines).toEqual(['[stall] armed: holds of 3000 ms, and on SIGUSR2'])
    d.signal()
    d.signal()
    expect(d.held).toEqual([])
    await turn()
    expect(d.held).toEqual([3000, 3000])
    expect(d.lines.slice(1)).toEqual(['[stall] holding the event loop for 3000 ms', '[stall] holding the event loop for 3000 ms'])
    stalls.stop()
    expect(d.unsubscribed()).toBe(1)
  })

  it('a range picks each length at random within it, and stall() holds at once', async () => {
    const d = deps([0, 1, 0.25])
    const stalls = startStalls(testFaults('core.stall:2000-8000'), d.fake)!
    expect(d.lines[0]).toBe('[stall] armed: holds of 2000-8000 ms, and on SIGUSR2')
    expect(stalls.stall()).toBe(2000)
    expect(stalls.stall()).toBe(8000)
    d.signal()
    await turn()
    expect(d.held).toEqual([2000, 8000, 3500])
  })

  it('with a period, holds come again and again at random intervals averaging it, until stopped', () => {
    vi.useFakeTimers()
    // The first interval (0.5 + 0) × 10 s, the next (0.5 + 1) × 10 s, a length of 2000 + 0.5 × 2000.
    const d = deps([0, 1, 0.5])
    const stalls = startStalls(testFaults('core.stall:2000-4000@10000'), d.fake)!
    expect(d.lines[0]).toBe('[stall] armed: holds of 2000-4000 ms about every 10000 ms, and on SIGUSR2')
    vi.advanceTimersByTime(4_999)
    expect(d.held).toEqual([])
    // Due at 5 s, held in the check phase that follows.
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(1)
    expect(d.held).toEqual([3000])
    vi.advanceTimersByTime(14_998)
    expect(d.held).toEqual([3000])
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(1)
    expect(d.held).toHaveLength(2)
    stalls.stop()
    vi.advanceTimersByTime(60_000)
    expect(d.held).toHaveLength(2)
    expect(d.unsubscribed()).toBe(1)
    // Stopping twice is harmless.
    stalls.stop()
  })

  it.each([
    'core.stall', 'core.stall:', 'core.stall:abc', 'core.stall:5000-2000', 'core.stall:2000@0', 'core.stall:2000@',
    'core.stall:2000@1000/fork',
  ])('a malformed %s is said out loud and holds nothing', (entry) => {
    const d = deps()
    expect(startStalls(testFaults(entry), d.fake)).toBeNull()
    expect(d.lines).toEqual([`[stall] ignored ${entry}: the form is core.stall:<ms>[-<maxMs>][@<periodMs>][/spawn]`])
    expect(d.held).toEqual([])
  })

  it('with /spawn, each hold waits for the next child process and begins once it is running', async () => {
    vi.useFakeTimers()
    // The first interval (0.5 + 0) × 10 s, the next (0.5 + 0.5) × 10 s, a length of 1000 + 0.5 × 2000.
    const d = deps([0, 0.5, 0.5])
    const stalls = startStalls(testFaults('core.stall:1000-3000@10000/spawn'), d.fake)!
    expect(d.lines[0]).toBe('[stall] armed: holds of 1000-3000 ms about every 10000 ms, and on SIGUSR2, each as the core starts a child process')
    // A child with no hold asked for passes untouched.
    d.spawn()
    vi.advanceTimersByTime(1)
    expect(d.held).toEqual([])
    // The period comes due, and a signal asks too: one hold, at the next child, after the code that
    // started it has run on.
    vi.advanceTimersByTime(4_999)
    d.signal()
    expect(d.held).toEqual([])
    d.spawn()
    expect(d.held).toEqual([])
    vi.advanceTimersByTime(1)
    expect(d.held).toEqual([2000])
    d.spawn()
    vi.advanceTimersByTime(1)
    expect(d.held).toEqual([2000])
    stalls.stop()
    expect(d.unsubscribed()).toBe(2)
  })

  it('the process\'s own deps hold the thread for real and listen for SIGUSR2', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const before = process.listenerCount('SIGUSR2')
    const stalls = startStalls(testFaults('core.stall:30'), processStallDeps)!
    expect(process.listenerCount('SIGUSR2')).toBe(before + 1)
    const started = performance.now()
    process.emit('SIGUSR2')
    await turn()
    expect(performance.now() - started).toBeGreaterThanOrEqual(25)
    stalls.stop()
    expect(process.listenerCount('SIGUSR2')).toBe(before)
    expect(log).toHaveBeenCalledWith('[stall] holding the event loop for 30 ms')
    expect(processStallDeps.random()).toBeLessThan(1)
    log.mockRestore()
  })

  it('the process\'s own deps see every child process started', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stalls = startStalls(testFaults('core.stall:5/spawn'), processStallDeps)!
    process.emit('SIGUSR2')
    expect(log).not.toHaveBeenCalledWith('[stall] holding the event loop for 5 ms')
    channel('child_process').publish({ process: null })
    await turn()
    expect(log).toHaveBeenCalledWith('[stall] holding the event loop for 5 ms')
    stalls.stop()
    expect(channel('child_process').hasSubscribers).toBe(false)
    log.mockRestore()
  })
})
