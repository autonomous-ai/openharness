// Tier A's clock (clock.ts): virtual time moves only while the world is quiet, to the next timer, never by a fixed step,
// and a world whose timers never let it reach its end stops with a name rather than spinning for good.
import { pbkdf2 } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVAL_EPOCH, installClock, MAX_ADVANCES, quiet, settle } from './clock.js'

// As dialAppEval.spec.ts mocks it: each read is counted from its call.
vi.mock('node:fs/promises', async (real) => (await import('./clock.js')).countFsCalls(await real<object>()))

const nothingInFlight = (): number => 0
/** Virtual ms since the clock was installed. */
const now = (): number => Date.now() - EVAL_EPOCH

afterEach(() => { vi.useRealTimers() })

describe("tier A's clock", () => {
  it('settle advances to the next timer only once the world is quiet', async () => {
    installClock()
    // Work queued ahead of the read on the thread pool holds it for many real turns, as a loaded host does.
    const backlog = Array.from({ length: 64 }, () => promisify(pbkdf2)('eval', 'salt', 20_000, 32, 'sha256'))
    const fired: number[] = []
    // The timer is set only once a real read lands: advancing first would run the end of the settle before it.
    void readFile(fileURLToPath(import.meta.url)).then(() => {
      setTimeout(() => fired.push(now()), 500)
    })
    await settle(1_000, undefined, nothingInFlight)
    expect(fired).toEqual([500])
    expect(now()).toBe(1_000)
    await Promise.all(backlog)
  })

  it('quiet waits for a file that is closing, the last step of every read', async () => {
    const handle = await open(fileURLToPath(import.meta.url))
    // Work queued ahead of the close on the thread pool holds it for many real turns, as a loaded host does.
    const backlog = Array.from({ length: 64 }, () => promisify(pbkdf2)('eval', 'salt', 20_000, 32, 'sha256'))
    let closed = false
    void handle.close().then(() => { closed = true })
    await quiet(nothingInFlight)
    expect(closed).toBe(true)
    await Promise.all(backlog)
  })

  it('settle stops at its limit, and as soon as until holds', async () => {
    installClock()
    let ticks = 0
    setInterval(() => { ticks++ }, 100)
    await settle(1_000, undefined, nothingInFlight)
    expect([now(), ticks]).toEqual([1_000, 10])
    await settle(60_000, () => ticks === 13, nothingInFlight)
    expect([now(), ticks]).toEqual([1_300, 13])
  })

  it('a world that sets a timer from every timer stops with "runaway timers"', async () => {
    installClock()
    // Each wait's next timer is set once the last one's promise lands, after its tick: due at once, it never lets time
    // move on. A timer set inside a tick is due a millisecond later, which time does reach.
    const forever = async (): Promise<void> => {
      for (;;) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    void forever()
    // A small limit: each advance waits real turns, so the product's would take as long as the host is loaded.
    await expect(settle(1_000, undefined, nothingInFlight, 100)).rejects.toThrow(/^runaway timers: 100 timers ran/)
  })

  it('the runaway limit is 100,000 timers a settle', () => {
    expect(MAX_ADVANCES).toBe(100_000)
  })
})
