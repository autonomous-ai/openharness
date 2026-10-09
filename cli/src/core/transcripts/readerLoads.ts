import { loadEngine, type InProcessModules, type OtherEngine } from '../../engines/inProcess.js'

/** Only loading code is bounded here; a reader already folding history is never abandoned mid-write. */
const LOAD_WAIT_MS = 5_000
const LOADING = Symbol('reader still loading')

export function createReaderLoads(waitMs = LOAD_WAIT_MS) {
  const imports = new Map<OtherEngine, Promise<InProcessModules[OtherEngine] | null>>()
  const retrying = new Set<OtherEngine>()
  const held = new Map<string, { engine: OtherEngine; identity: string; retry: (stillHeld: () => boolean) => Promise<unknown> }>()
  return {
    async read(engine: OtherEngine, sessionId: string, identity: string, current: () => boolean,
      retry: (stillHeld: () => boolean) => Promise<unknown>) {
      // A newer attempt owns this import's result. A late callback from an earlier hold must not
      // force a second fold behind it (Cursor would replay its first turn twice).
      held.delete(sessionId)
      let loading = imports.get(engine)
      if (!loading) { loading = loadEngine(engine); imports.set(engine, loading) }
      let timer!: ReturnType<typeof setTimeout>
      const waiting = new Promise<typeof LOADING>(resolve => {
        timer = setTimeout(() => resolve(LOADING), waitMs)
        timer.unref()
      })
      let value: InProcessModules[OtherEngine] | null | typeof LOADING
      try { value = await Promise.race([loading, waiting]) }
      finally { clearTimeout(timer) }
      if (value !== LOADING) return value
      if (current()) held.set(sessionId, { engine, identity, retry })
      // One callback per shared import, regardless of how often hooks ask again. Forget/rebind
      // removes ownership from held; the callback itself never retains a per-session retry closure.
      if (!retrying.has(engine)) {
        retrying.add(engine)
        void loading.then(module => {
          retrying.delete(engine)
          for (const [id, pending] of held) {
            if (pending.engine !== engine) continue
            if (!module) { held.delete(id); continue }
            const stillHeld = () => held.get(id) === pending
            void pending.retry(stillHeld).finally(() => { if (stillHeld()) held.delete(id) })
          }
        })
      }
      return null
    },
    supersede(sessionId: string, identity: string): void {
      if (held.get(sessionId)?.identity !== identity) held.delete(sessionId)
    },
    forget(sessionId: string): void { held.delete(sessionId) },
  }
}
