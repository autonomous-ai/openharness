/**
 * The core's read-only view of terminals, as a service in its own process reaches it (core/terminalWatch.ts is
 * the core's side): each viewer's terminal frames asked of the core over the link, in order, and what each
 * viewer is shown told back (`service_event` kind `watch`), handed to whoever listens here.
 */
import type { TerminalWatch, TerminalWatchOutput } from '../core/api.js'

type Payload = Record<string, unknown>

/** What the core said a viewer is shown, or null when it is not that. */
export function watchIn(payload: Payload): { viewer: string; output: TerminalWatchOutput } | null {
  if (payload.kind !== 'watch' || typeof payload.viewer !== 'string' || !payload.output || typeof payload.output !== 'object') return null
  const output = payload.output as Payload
  if (typeof output.binary === 'string') return { viewer: payload.viewer, output: { binary: output.binary } }
  if (typeof output.type === 'string' && output.payload && typeof output.payload === 'object') {
    return { viewer: payload.viewer, output: { type: output.type, payload: output.payload as Payload } }
  }
  return null
}

/** `query` asks the core (`CoreConnection.query`, services/process.ts); it rejects when the link goes. */
export function watchLink(query: (query: string, payload: Payload) => Promise<Payload>) {
  const listeners = new Set<(viewer: string, output: TerminalWatchOutput) => void>()
  const watch: TerminalWatch = {
    // A frame the core could not take (the link went) is a viewer's frame lost: its stream closes as the
    // relay's does, and the viewer opens it again.
    frame: async (viewer, type, payload) => { await query('watch_frame', { viewer, type, payload }).catch(() => {}) },
    close: async (viewer) => { await query('watch_close', { viewer }).catch(() => {}) },
    onOutput: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    watch,
    /** What the core told this service: true when it was a viewer's output, now heard here. */
    heard(payload: Payload): boolean {
      const shown = watchIn(payload)
      if (!shown) return false
      for (const listener of listeners) {
        try { listener(shown.viewer, shown.output) } catch { /* that listener's viewer misses the frame */ }
      }
      return true
    },
  }
}
