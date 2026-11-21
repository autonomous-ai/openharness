/**
 * Tier A's virtual time (docs/plans/2026-11-21-dial-app-eval-plan.md, "Decisions"): the timers, `Date` and `performance`
 * are fake, so the designed delays (the 1 s front settle, the 1 s list gap, the 1.5 s answer grace) count and the
 * machine's speed does not. Time moves only while the world is quiet, and then to the next timer, never by a fixed
 * step: a run's virtual times are the same on every host. `setImmediate`, `nextTick` and microtasks stay real, so the
 * real reads of the fixtures land.
 */
import { vi } from 'vitest'

export const EVAL_EPOCH = Date.UTC(2026, 10, 21, 9)
/** Per settle: the cable's 1 s tick and the carousel's refresh always leave a next timer, so a world that sets a timer
 *  from every timer would otherwise never reach the settle's end. */
export const MAX_ADVANCES = 100_000
/** A world still busy after this long of real time is stuck, not slow: a read of a temp file takes milliseconds. */
const QUIET_WITHIN_MS = 10_000
/** A real read under way that the count of calls below does not see, a file handle's own read and close and the
 *  callback API: the libuv requests each holds while it runs. A handle's close is named `CloseReq` there. */
const PENDING_IO: ReadonlySet<string> = new Set(['FSReqCallback', 'FSReqPromise', 'CloseReq'])

/** The calls into node:fs/promises in flight, in a spec that mocks that module with countFsCalls. */
let fsCalls = 0

/**
 * `node:fs/promises` with each call that returns a promise counted while it is in flight, for a spec's mock of that
 * module: on Node 26 a readFile holds no request the resource list shows (2026-11-21), so a read is counted from its
 * call to its end.
 */
export function countFsCalls<T extends object>(fs: T): T {
  return Object.fromEntries(Object.entries(fs).map(([name, member]: [string, unknown]) => {
    if (name === 'default' && typeof member === 'object' && member !== null) return [name, countFsCalls(member)]
    if (typeof member !== 'function') return [name, member]
    return [name, (...args: unknown[]): unknown => {
      const result: unknown = member(...args)
      if (result instanceof Promise) {
        fsCalls++
        const landed = (): void => { fsCalls-- }
        result.then(landed, landed)
      }
      return result
    }]
  })) as T
}

export function installClock(): void {
  vi.useFakeTimers({ now: EVAL_EPOCH, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const busy = (inFlight: () => number): boolean =>
  inFlight() > 0 || fsCalls > 0 || process.getActiveResourcesInfo().some((resource) => PENDING_IO.has(resource))

/** Resolves once no store read and no call into node:fs/promises is in flight and no real read is under way, on two
 *  real turns in a row. */
export async function quiet(inFlight: () => number): Promise<void> {
  const since = process.hrtime.bigint()
  for (let calm = 0; calm < 2;) {
    await turn()
    calm = busy(inFlight) ? 0 : calm + 1
    if (calm === 0 && process.hrtime.bigint() - since > BigInt(QUIET_WITHIN_MS) * 1_000_000n) {
      throw new Error(`the world was not quiet in ${QUIET_WITHIN_MS} ms: ${inFlight()} store reads in flight`)
    }
  }
}

/**
 * Lets the world run for `ms` of virtual time, or until `until` holds once it is quiet. `maxAdvances` is for this
 * file's tests: each advance waits real turns, so reaching the product's limit takes as long as the host is loaded.
 */
export async function settle(ms: number, until: (() => boolean) | undefined, inFlight: () => number,
  maxAdvances = MAX_ADVANCES): Promise<void> {
  let ended = false
  const end = setTimeout(() => { ended = true }, ms)
  try {
    for (let advances = 0; ; advances++) {
      await quiet(inFlight)
      if (ended || until?.()) return
      if (advances === maxAdvances) throw new Error(`runaway timers: ${maxAdvances} timers ran and a settle of ${ms} ms never reached its end`)
      vi.advanceTimersToNextTimer()
    }
  } finally {
    clearTimeout(end)
  }
}
