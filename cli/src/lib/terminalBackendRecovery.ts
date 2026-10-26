import type { AgentEngine } from '../engines/types.js'
import type { TerminalBackend } from './terminalBackend.js'

/** Retry a backend missing at boot only when its executable has arrived. New installs can finish
 * after the daemon starts; a cached absence otherwise refuses every launch until a restart. */
export function createTerminalBackendRecovery<B extends TerminalBackend>(deps: {
  backend: B | null
  available(): boolean
  ownedPanes(): ReadonlyMap<string, AgentEngine>
  recovered(backend: B): void
}) {
  let ready: B | null = null
  let pending: Promise<B | null> | null = null
  return (): Promise<B | null> => {
    if (ready) return Promise.resolve(ready)
    if (pending) return pending
    const backend = deps.backend
    if (!backend || !deps.available()) return Promise.resolve(null)
    pending = (async () => {
      try {
        const result = await backend.prepare({ ownedPanes: deps.ownedPanes() })
        if (result.state !== 'ready') return null
        // Install the route before any caller can spawn a pane or receive its hooks.
        deps.recovered(backend)
        ready = backend
        return backend
      } catch (error) {
        console.warn(`[terminal] ${backend.name} recovery failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    })().finally(() => { pending = null })
    return pending
  }
}
