/**
 * The registry expires a write after a fixed deadline on the host's clock, so how fast a machine writes its disk
 * would decide registry tests. This holds that deadline off the clock, and stands in for a loaded disk: a registry
 * image sync outlives every real wait from 250 ms to just under the deadline.
 *
 * It imports only vitest: a spec loads it through `vi.hoisted`, before `node:fs/promises` is mocked, so loading
 * `registryPersistence.ts` here would bind the real one. One module instance holds the state, so a spec's
 * `vi.resetModules()` gives its fs factory no second copy.
 */
import { vi } from 'vitest'

type Callback = (...args: unknown[]) => void

const SLOW_WAIT_MS = 250
const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout
/** The bound a write deadline is held under: the time it has left is no bound of its own. */
const DEADLINE = Symbol('write deadline')
type Timer<Bound> = { ms: Bound, run: () => void }
/** Held timers, never scheduled on the host's clock, with the bound each was asked for. */
const held = new Map<unknown, Timer<number | typeof DEADLINE>>()
/** Real waits a registry image sync fires early. */
const due = new Map<unknown, Timer<number>>()

/**
 * Runs each timer of [timers] whose bound [chosen] picks, taken out as it runs, as the host's clock would: one a callback
 * sets runs at a later pass, one a callback clears does not run, and one that throws is thrown on its own once the pass
 * is over, which goes on without it. Returns how many it ran.
 */
function runPass<Bound>(timers: Map<unknown, Timer<Bound>>, chosen: (ms: Bound) => boolean): number {
  let ran = 0
  for (const [timer, entry] of [...timers]) {
    if (timers.get(timer) !== entry || !chosen(entry.ms)) continue
    timers.delete(timer); ran++
    try { entry.run() } catch (error) { queueMicrotask(() => { throw error }) }
  }
  return ran
}

/** A prepared registry image, including one flushed in the storage worker, advances the simulated slow-disk waits. */
export function registryImageSynced(): void { runPass(due, () => true) }

/** An `fs/promises` whose registry image (`registry.json.*.tmp`) syncs fire every real wait still due. */
export async function slowSyncFsPromises(
  original: () => Promise<typeof import('node:fs/promises')>,
  options?: { afterSync?: (path: string, actual: typeof import('node:fs/promises')) => Promise<void> },
): Promise<typeof import('node:fs/promises')> {
  const actual = await original()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle)
    handle.sync = async () => {
      await sync()
      const path = String(args[0])
      if (!(path.includes('registry.json.') && path.endsWith('.tmp'))) return
      registryImageSynced()
      await options?.afterSync?.(path, actual)
    }
    return handle
  } }
}

/**
 * Whether this `setTimeout` is the registry's write queue arming a write's deadline (registryPersistence.ts
 * `RegistryWriteQueue.enqueue`, from its promise's executor): told by its caller, since its bound is the time the write
 * has left. The stack keeps the three frames it reads, whatever limit a spec set, and no more.
 */
function armsWriteDeadline(): boolean {
  const call: { stack?: string } = {}
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 3
  try { Error.captureStackTrace(call, globalThis.setTimeout) } finally { Error.stackTraceLimit = limit }
  const [, caller = '', , queue = ''] = call.stack?.split('\n') ?? []
  return caller.includes('registryPersistence.') && queue.trimStart().startsWith('at RegistryWriteQueue.enqueue ')
}

/**
 * Holds every write deadline the registry's write queue arms, and every timer of each `hold` bound, until the test runs
 * it; `vi.restoreAllMocks` ends it. A registry image sync fires every other wait from 250 ms up to, not including,
 * `deadlineMs`: a sync that outlived the deadline would have expired its write. Every other timer runs on the host's
 * clock alone. `expire()` and `fire(ms)` throw, by name, when they hold none to run.
 */
export function holdRegistryDeadline(deadlineMs: number, options?: { hold?: readonly number[] }): {
  expire(): void
  fire(ms: number): void
  /** How many write deadlines it holds. */
  deadlines(): number
} {
  held.clear(); due.clear()
  const run = (ms: number | typeof DEADLINE, name: string) => {
    if (!runPass(held, (bound) => bound === ms)) throw new Error(`no held ${name}`)
  }
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Callback, ms?: number, ...args: unknown[]) => {
    const bound = armsWriteDeadline() ? DEADLINE : ms !== undefined && options?.hold?.includes(ms) ? ms : undefined
    if (bound !== undefined) {
      // A real handle, so a caller's unref or clear still works; its own callback does nothing.
      const timer = realTimeout(() => {}, 0)
      held.set(timer, { ms: bound, run: () => callback(...args) })
      return timer
    }
    if (ms === undefined || ms < SLOW_WAIT_MS || ms >= deadlineMs) return realTimeout(callback, ms, ...args)
    const timer = realTimeout(() => { due.delete(timer); callback(...args) }, ms)
    due.set(timer, { ms, run: () => { realClear(timer); callback(...args) } })
    return timer
  }) as typeof setTimeout)
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer?: Parameters<typeof clearTimeout>[0]) => {
    held.delete(timer); due.delete(timer); realClear(timer)
  }) as typeof clearTimeout)
  return { expire: () => run(DEADLINE, 'write deadline'), fire: (ms) => run(ms, `${ms} ms timer`), deadlines: () => [...held.values()].filter((entry) => entry.ms === DEADLINE).length }
}
