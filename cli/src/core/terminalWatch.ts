/**
 * A read-only view of agents' terminals for a feature's own viewers (`core.terminals.watch`): Share's
 * observers. The plan's "read-only terminal subscription" (docs/design/2026-10-06-core-boundary-next.md,
 * "Sharing"): Share used to read panes through a stream manager of its own over the core's terminals; now the
 * core runs that manager, read-only, and a feature in its own process hands it each viewer's terminal frames
 * and hears back what each viewer is shown. A viewer can only watch: the manager is read-only, and refuses
 * input before any reaches a pane, as Share's own did.
 *
 * What a viewer is shown goes to whoever asked for it: a listener in the core's process (`onOutput`), or the
 * process that sent the viewer's frames (`tell`). A terminal's bytes go as `binary`, base64 of the local
 * binary frame (lib/terminalBinary.ts `encodeTerminalLocal`), as Share already carried them to its observers.
 */
import type { RegisteredSession } from '../lib/registry.js'
import type { TerminalBackendCoordinator } from '../lib/terminalBackendCoordinator.js'
import { encodeTerminalLocal } from '../lib/terminalBinary.js'
import { TerminalStreamManager } from '../lib/terminalStreamManager.js'
import type { TerminalWatch, TerminalWatchOutput } from './api.js'

type Payload = Record<string, unknown>

/** The most viewers whose process is remembered; past it the oldest is forgotten. Share takes 100 at most. */
export const KEPT_VIEWERS = 1_000

export interface TerminalWatchDeps {
  terminals: Pick<TerminalBackendCoordinator, 'openStream'>
  resolve: (agentId: string) => RegisteredSession | undefined
  /** Tell a process what its viewer is shown; false when it could not be told (the stream then closes). */
  tell: (service: string, viewer: string, output: TerminalWatchOutput) => boolean
  /** The processes that may watch: a viewer is only ever an experiment's. */
  watchers: ReadonlySet<string>
  /** Swapped in tests for a manager they can drive. */
  manager?: (deps: ConstructorParameters<typeof TerminalStreamManager>[0]) => Pick<TerminalStreamManager, 'handleFrame' | 'closeConnection' | 'stop'>
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function createTerminalWatch(deps: TerminalWatchDeps) {
  const listeners = new Set<(viewer: string, output: TerminalWatchOutput) => void>()
  /** Which process each viewer is a process's, oldest first. */
  const owners = new Map<string, string>()
  const show = (viewer: string, output: TerminalWatchOutput): boolean => {
    const owner = owners.get(viewer)
    if (owner) return deps.tell(owner, viewer, output)
    let shown = false
    for (const listener of listeners) {
      try { listener(viewer, output); shown = true } catch { /* that listener's viewer misses the frame */ }
    }
    return shown
  }
  let manager: Pick<TerminalStreamManager, 'handleFrame' | 'closeConnection' | 'stop'> | null = null
  /** Built at the first viewer: a daemon no one shares costs no stream manager. */
  const streams = () => manager ??= (deps.manager ?? ((d) => new TerminalStreamManager(d)))({
    readOnly: true,
    terminals: deps.terminals as TerminalBackendCoordinator,
    resolveAgent: deps.resolve,
    streamingAvailable: true,
    sendTarget: (viewer, type, payload) => show(viewer, { type, payload }),
    sendBinaryTarget: (viewer, frame) => {
      const bytes = encodeTerminalLocal(frame)
      return bytes !== null && show(viewer, { binary: Buffer.from(bytes).toString('base64') })
    },
  })

  const watch: TerminalWatch = {
    frame: async (viewer, type, payload) => { await streams().handleFrame(viewer, type, payload) },
    close: async (viewer) => {
      await manager?.closeConnection(viewer)
      owners.delete(viewer)
    },
    onOutput: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  return {
    /** The watch of the core's own `CoreApi`, for a feature in this process. */
    watch,

    /** A process's viewer's frame (`watch_frame`) or its end (`watch_close`): null for any other query. */
    async answer(service: string, query: string, payload: Payload): Promise<Payload | null> {
      if (query !== 'watch_frame' && query !== 'watch_close') return null
      if (!deps.watchers.has(service)) return { error: 'NOT_A_WATCHER' }
      const viewer = text(payload.viewer)
      if (!viewer) return { error: 'INVALID_VIEWER' }
      if (query === 'watch_close') { await watch.close(viewer); return {} }
      const type = text(payload.type)
      if (!type.startsWith('terminal_')) return { error: 'INVALID_FRAME' }
      owners.delete(viewer)
      owners.set(viewer, service)
      if (owners.size > KEPT_VIEWERS) owners.delete(owners.keys().next().value!)
      await watch.frame(viewer, type, payload.payload && typeof payload.payload === 'object' ? payload.payload as Payload : {})
      return {}
    },

    /** A process went: every viewer it had stops being shown anything. */
    async gone(service: string): Promise<void> {
      for (const [viewer, owner] of [...owners]) if (owner === service) await watch.close(viewer)
    },

    async stop(): Promise<void> { await manager?.stop() },
  }
}

export type TerminalWatchLink = ReturnType<typeof createTerminalWatch>
