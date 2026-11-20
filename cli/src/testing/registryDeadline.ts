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
/** Held timers, never scheduled on the host's clock, with the bound each was asked for. */
const held = new Map<unknown, { ms: number | typeof DEADLINE, run: () => void }>()
/** Real waits a registry image sync fires early. */
const due = new Map<unknown, () => void>()

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
      for (const [timer, fire] of due) { due.delete(timer); fire() }
      await options?.afterSync?.(path, actual)
    }
    return handle
  } }
}

/**
 * Whether this `setTimeout` is the registry's write queue arming a write's deadline (registryPersistence.ts
 * `RegistryWriteQueue.enqueue`, from its promise's executor): told by its caller, since its bound is the time the write
 * has left.
 */
function armsWriteDeadline(): boolean {
  const call: { stack?: string } = {}
  Error.captureStackTrace(call, globalThis.setTimeout)
  const [, caller = '', , queue = ''] = call.stack?.split('\n') ?? []
  return caller.includes('registryPersistence.') && queue.trimStart().startsWith('at RegistryWriteQueue.enqueue ')
}

/**
 * Holds every write deadline the registry's write queue arms, and every timer of each `hold` bound, until the test runs
 * it; `vi.restoreAllMocks` ends it. A registry image sync fires every other wait from 250 ms up to, not including,
 * `deadlineMs`: a sync that outlived the deadline would have expired its write. Every other timer runs on the host's
 * clock alone.
 */
export function holdRegistryDeadline(deadlineMs: number, options?: { hold?: readonly number[] }): {
  expire(): void
  fire(ms: number): void
} {
  held.clear(); due.clear()
  const run = (ms: number | typeof DEADLINE) => {
    for (const [timer, entry] of held) if (entry.ms === ms) { held.delete(timer); entry.run() }
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
    due.set(timer, () => { realClear(timer); callback(...args) })
    return timer
  }) as typeof setTimeout)
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer?: Parameters<typeof clearTimeout>[0]) => {
    held.delete(timer); due.delete(timer); realClear(timer)
  }) as typeof clearTimeout)
  return { expire: () => run(DEADLINE), fire: run }
}
