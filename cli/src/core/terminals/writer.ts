/** Logical preparation can be revoked while a worker is unavailable. Only an
 * actual pane command must finish before an interrupt can safely follow it. */
import { TerminalWriteHeld, type TerminalWrite } from '../../lib/terminalTypes.js'

export function createTerminalWriter({ now = () => performance.now(), maxLanes = 4096, maxQueued = 64, maxPreparing = 8 }:
  { now?: () => number; maxLanes?: number; maxQueued?: number; maxPreparing?: number } = {}) {
  type Interrupt = { start(): void }
  type Work = { start(): void; cancel(): void }
  type Lane = { epoch: number; physical: number; preparing: number; reservations: number; logical?: Work; pending: Work[]; interrupt?: Interrupt; retired?: boolean }
  const lanes = new Map<string, Lane>()
  const lane = (id: string): Lane | undefined => {
    let found = lanes.get(id)
    if (!found) {
      if (lanes.size >= maxLanes) {
        for (const [key, old] of lanes) {
          if (old.physical || old.preparing || old.reservations || old.logical || old.interrupt || old.pending.length) continue
          old.retired = true
          lanes.delete(key)
          break
        }
        if (lanes.size >= maxLanes) return undefined
      }
      found = { epoch: 0, physical: 0, preparing: 0, reservations: 0, pending: [] }; lanes.set(id, found)
    }
    return found
  }
  const revoked = () => new TerminalWriteHeld('Terminal write cancelled before completion by an interrupt.')
  const full = () => new TerminalWriteHeld('Waiting for terminal writer capacity.')
  const wake = (state: Lane) => {
    if (state.physical) return
    if (state.interrupt) state.interrupt.start()
    else if (!state.logical) state.pending.shift()?.start()
  }
  const ticket = (state: Lane, current: () => boolean): TerminalWrite => Object.freeze({
    allowed: current,
    dispatch: async <T>(operation: () => Promise<T>): Promise<T> => {
      if (!current()) throw new TerminalWriteHeld('terminal control revoked')
      if (state.physical) throw new TerminalWriteHeld('terminal writer is still occupied')
      state.physical++
      try { return await operation() }
      finally { state.physical--; wake(state) }
    },
  })
  const epochTicket = (state: Lane, current = () => true) => {
    const epoch = state.epoch
    return ticket(state, () => current() && !state.retired && state.epoch === epoch && !state.interrupt)
  }
  const revoke = (state: Lane) => {
    state.epoch++
    state.logical?.cancel()
    state.logical = undefined
    for (const pending of state.pending.splice(0)) pending.cancel()
  }
  return {
    /** Immediate logical revocation before cancellation storage or journal I/O.
     * Actual commands retain their physical slots until they settle. */
    revoke(id: string): void {
      const state = lanes.get(id)
      if (state) revoke(state)
    },
    ticket(id: string): TerminalWrite {
      const state = lane(id)
      if (!state) return Object.freeze({ allowed: () => false, dispatch: async () => { throw full() } })
      return epochTicket(state)
    },
    /** Keep a queued message's acquired epoch between attempts. Capacity may
     * recover; an acquired epoch revoked by Cancel must never be renewed. */
    reserve(id: string): { write: TerminalWrite; release(): void } | undefined {
      const state = lane(id)
      if (!state) return undefined
      state.reservations++
      let released = false
      return { write: epochTicket(state, () => !released), release: () => {
        if (!released) { released = true; state.reservations-- }
      } }
    },
    run<T>(id: string, write: TerminalWrite, operation: (write: TerminalWrite) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const state = lane(id)
      if (!state || state.pending.length >= maxQueued) return Promise.reject(full())
      return new Promise<T>((resolve, reject) => {
        let cancelled = false, finished = false
        const current = () => !cancelled && !finished && write.allowed()
        const owned: TerminalWrite = { allowed: current, dispatch: operation => write.dispatch(() => {
          if (!current()) throw revoked()
          return operation()
        }) }
        const unlisten = () => signal?.removeEventListener('abort', abort)
        const owner: Work = { cancel: () => {
          cancelled = true
          unlisten()
          if (state.logical === owner) state.logical = undefined
          const index = state.pending.indexOf(owner)
          if (index >= 0) state.pending.splice(index, 1)
          reject(revoked())
          wake(state)
        }, start: () => {
          if (!write.allowed()) { owner.cancel(); wake(state); return }
          if (state.preparing >= maxPreparing) { finished = true; unlisten(); reject(full()); wake(state); return }
          state.logical = owner
          state.preparing++
          // Revocation releases the logical waiter, never the actual worker
          // allocation. Repeated Cancel cannot accumulate unlimited hung reads.
          const release = () => { finished = true; unlisten(); state.preparing--; if (state.logical === owner) state.logical = undefined; wake(state) }
          void (async () => operation(owned))().then(value => { release(); resolve(value) }, error => { release(); reject(error) })
        } }
        const abort = () => owner.cancel()
        if (signal?.aborted) { owner.cancel(); return }
        signal?.addEventListener('abort', abort, { once: true })
        state.pending.push(owner)
        wake(state)
      })
    },
    interrupt<T>(id: string, operation: (write: TerminalWrite) => Promise<T>): Promise<T> {
      const state = lane(id)
      if (!state) return Promise.reject(full())
      if (state.interrupt) return Promise.reject(new TerminalWriteHeld('Waiting for the previous terminal interrupt to settle.'))
      let started = false, resolve!: (value: T) => void, reject!: (error: unknown) => void
      const result = new Promise<T>((yes, no) => { resolve = yes; reject = no })
      const deadline = now() + 5000
      const epoch = state.epoch + 1
      const expired = () => new TerminalWriteHeld('Waiting for terminal interrupt confirmation: its deadline expired.')
      const release = () => { clearTimeout(timer); state.interrupt = undefined; wake(state) }
      const allowed = () => state.interrupt === reservation && state.epoch === epoch && now() < deadline
      const reservation = { start: () => {
        if (started) return
        if (!allowed()) { reject(expired()); release(); return }
        started = true
        void (async () => operation(ticket(state, allowed)))().then(value => {
          if (allowed()) resolve(value)
          else reject(expired())
          release()
        }, error => { reject(error); release() })
      } }
      const timer = setTimeout(() => { reject(expired()); if (!started) release() }, 5000)
      state.interrupt = reservation
      revoke(state)
      wake(state)
      return result
    },
  }
}

export type TerminalWriter = ReturnType<typeof createTerminalWriter>
