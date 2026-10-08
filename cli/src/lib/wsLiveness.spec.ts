import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { BACKEND_IDLE_DEADLINE_MS, GENUINE_SLEEP_MS, watchSocketLiveness, WS_HEARTBEAT_MS, WS_IDLE_DEADLINE_MS } from './wsLiveness.js'

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

  // The 40s loopback deadline (localWsServer.ts) was unenforceable on a loaded machine: macOS
  // coalesces the 20s heartbeat so ticks land 44-80s late, every one read as a sleep, every one
  // forgiving the silence. Measured over one ~2-day harness.log: 968 such wakes reporting 24-60s
  // against 80 real sleeps (all >600s), and terminations logging `no traffic for 912-995s` — 23x
  // past the deadline, 276 times. One pass per proof of life is the bound.
  it('stops forgiving sleeps a peer never answers', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.silent = true
    let asleepMs = 0
    const woke: Array<[number, boolean]> = []
    watchSocketLiveness(ws, {
      deadlineMs: 40_000, // the loopback shape
      now: () => performance.now() + asleepMs,
      onWake: (ms, givingUp) => woke.push([ms, givingUp]),
    })
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 40_000 // a throttled tick, not a sleeping machine
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0) // the one free pass
    expect(woke).toEqual([[40_000, false]])
    asleepMs += 40_000 // and another, with nothing heard from the peer in between
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
    expect(woke).toEqual([[40_000, false], [40_000, true]])
  })

  // The bound above must never cost a REAL sleep its forgiveness. A throttled tick can land just
  // before the lid closes, leaving the pass already spent, and terminating there would be the
  // 2026-09-28 incident again: a healthy loopback socket killed on waking.
  it('forgives a genuine long sleep even after a merely throttled tick', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.silent = true
    let asleepMs = 0
    watchSocketLiveness(ws, { deadlineMs: 40_000, now: () => performance.now() + asleepMs })
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 40_000 // throttled: spends the one pass
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
    asleepMs += 1_200_000 // a real sleep, unambiguously past GENUINE_SLEEP_MS
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
    expect(ws.pings).toBe(3) // re-probed on the wake, as before the bound existed
    // Still given up on afterwards, after a deadline of AWAKE time.
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
  })

  // Guards the one ordering the bound depends on: `forgaveWithoutProof` is set BEFORE the re-probe,
  // so a peer that answers clears it and earns another pass. Set it after the ping and a healthy
  // socket dies on its second throttled tick — which no other test here would catch.
  it('forgives every sleep a peer answers', async () => {
    vi.useFakeTimers()
    const ws = socket()
    let asleepMs = 0
    watchSocketLiveness(ws, { deadlineMs: 40_000, now: () => performance.now() + asleepMs })
    for (let i = 0; i < 5; i++) {
      asleepMs += 40_000
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    }
    expect(ws.terminated).toBe(0)
  })

  // A real sleep must hand back a WHOLE deadline of awake time, not a deadline conditional on the
  // next tick being punctual — and the tick right after a wake is the most throttled moment there is.
  it('restores the pass a genuine sleep was forgiven on', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.silent = true
    let asleepMs = 0
    watchSocketLiveness(ws, { deadlineMs: 40_000, now: () => performance.now() + asleepMs })
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 40_000 // throttled: spends the pass
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 1_200_000 // a real sleep: forgiven unconditionally, and the pass comes back with it
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 40_000 // throttled again — on a restored pass this is forgiven, not fatal
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
  })

  // Pins GENUINE_SLEEP_MS itself: without this the constant could be set anywhere in (40s, 1200s]
  // — 50s, say, which forgives almost every throttled tick and is the original bug back — with every
  // other test still green.
  it('draws the genuine-sleep line at GENUINE_SLEEP_MS exactly', async () => {
    vi.useFakeTimers()
    for (const [slept, expected] of [[GENUINE_SLEEP_MS - 1, 1], [GENUINE_SLEEP_MS, 0]] as const) {
      const ws = socket()
      ws.silent = true
      let asleepMs = 0
      const watch = watchSocketLiveness(ws, { deadlineMs: 40_000, now: () => performance.now() + asleepMs })
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      asleepMs += 40_000 // spend the pass on a throttled tick
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      asleepMs += slept
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      expect(ws.terminated).toBe(expected)
      watch.stop()
    }
  })

  // The loopback peer's usual proof of life is a data frame, not a pong. markAlive is bound to all
  // three, but only the pong path was exercised with the pass spent.
  it('lets a data frame restore the pass, not only a pong', async () => {
    vi.useFakeTimers()
    const ws = socket()
    ws.silent = true
    let asleepMs = 0
    watchSocketLiveness(ws, { deadlineMs: 40_000, now: () => performance.now() + asleepMs })
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    asleepMs += 40_000
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS) // spends the pass
    ws.emit('message', Buffer.from('{}')) // the app is plainly there
    asleepMs += 40_000
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
  })

})
