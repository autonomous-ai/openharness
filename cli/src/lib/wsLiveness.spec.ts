import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { BACKEND_IDLE_DEADLINE_MS, watchSocketLiveness, WS_HEARTBEAT_MS, WS_IDLE_DEADLINE_MS } from './wsLiveness.js'

class FakeSocket extends EventEmitter {
  pings = 0
  terminated = 0
  /** Peer stopped answering (half-open TCP, a laptop back from sleep). */
  silent = false
  pingThrows = false
  ping(): void {
    if (this.pingThrows) throw new Error('not open')
    this.pings++
    if (!this.silent) this.emit('pong')
  }
  terminate(): void { this.terminated++ }
}

const socket = () => new FakeSocket() as unknown as WebSocket & FakeSocket

afterEach(() => { vi.useRealTimers() })

describe('watchSocketLiveness', () => {
  it('keeps a responsive socket alive indefinitely, pinging on the heartbeat', async () => {
    vi.useFakeTimers()
    const ws = socket()
    watchSocketLiveness(ws)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS * 10)
    expect(ws.pings).toBe(10)
    expect(ws.terminated).toBe(0)
  })

  it('gives a silent peer the whole deadline — three pings — not one missed pong', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.silent = true
    const idle: number[] = []
    watchSocketLiveness(ws, { onIdle: (ms) => idle.push(ms) })
    await vi.advanceTimersByTimeAsync(WS_IDLE_DEADLINE_MS - 1)
    expect(ws.terminated).toBe(0)
    expect(ws.pings).toBe(2)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
    expect(idle).toEqual([WS_IDLE_DEADLINE_MS])
  })

  it('counts data and the peer\'s own pings as proof of life, not only pongs', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.silent = true
    watchSocketLiveness(ws)
    await vi.advanceTimersByTimeAsync(40_000)
    ws.emit('message', Buffer.from('{}'))
    await vi.advanceTimersByTimeAsync(40_000)
    expect(ws.terminated).toBe(0)
    ws.emit('ping')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(ws.terminated).toBe(0)
    await vi.advanceTimersByTimeAsync(WS_IDLE_DEADLINE_MS)
    expect(ws.terminated).toBe(1)
  })

  it('runs the piggybacked tick only on a surviving socket, and stops cleanly', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.silent = true
    let ticks = 0
    const watch = watchSocketLiveness(ws, { onTick: () => { ticks++ } })
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS * 2)
    expect(ticks).toBe(2)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
    expect(ticks).toBe(2) // the terminating tick does no other work
    watch.stop()
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS * 5)
    expect(ws.terminated).toBe(1)
  })

  it('stops by itself when the socket closes, whether or not the owner remembered to', async () => {
    vi.useFakeTimers()
    const ws = socket()
    watchSocketLiveness(ws)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.pings).toBe(1)
    ws.emit('close', 1000)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS * 5)
    expect(ws.pings).toBe(1)
  })

  // Node's clock runs on while a Mac sleeps: the first tick after a long sleep saw the whole sleep as
  // silence and terminated every socket, the app's loopback one included (2026-09-28, `no traffic for
  // 2287s`). Sleep is simulated by moving the clock without running any timer.
  it('re-probes instead of terminating on the first tick after the computer slept', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.silent = true
    let asleepMs = 0
    const woke: number[] = []
    watchSocketLiveness(ws, { now: () => performance.now() + asleepMs, onWake: (ms) => woke.push(ms) })
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 2_280_000
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
    expect(ws.pings).toBe(2) // the wake tick asks at once
    expect(woke).toEqual([2_280_000])
    // A peer that stays silent is still given up on, after a deadline of AWAKE time.
    await vi.advanceTimersByTimeAsync(WS_IDLE_DEADLINE_MS - WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
  })

  it('keeps a live peer across a sleep without a single missed beat', async () => {
    vi.useFakeTimers()
    const ws = socket()
    let asleepMs = 0
    watchSocketLiveness(ws, { now: () => performance.now() + asleepMs })
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 600_000
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS * 10)
    expect(ws.terminated).toBe(0)
  })

  it('hangs up at once after a sleep the far end could not have waited through', async () => {
    vi.useFakeTimers()
    const ws = socket()
    let asleepMs = 0
    const verdicts: boolean[] = []
    const opts = { now: () => performance.now() + asleepMs, peerGivesUpAfterMs: BACKEND_IDLE_DEADLINE_MS,
      onWake: (_: number, hungUp: boolean) => { verdicts.push(hungUp) } }
    watchSocketLiveness(ws, opts)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 30_000 // shorter than the backend waits: the link may well still be there
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
    asleepMs += BACKEND_IDLE_DEADLINE_MS
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
    expect(verdicts).toEqual([false, true])
  })

  it('terminates a socket it cannot even ping', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.pingThrows = true
    watchSocketLiveness(ws)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
  })
})
