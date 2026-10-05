/** A wake-up hint only. Terminal output is untrusted; the process and tmux
 * marker must independently confirm an exit before any lifecycle changes. */
import type { RegisteredSession } from './registry.js'
import type { RuntimeCheck, TmuxPaneState } from './tmux.js'

export const ENGINE_EXIT_NOTICE = '\x1b]777;harness-engine-exit\x07'
const notice = Buffer.from(ENGINE_EXIT_NOTICE)

export class EngineExitNoticeScanner {
  private tail = Buffer.alloc(0)
  push(bytes: Uint8Array): boolean {
    const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const joined = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk
    const found = joined.includes(notice)
    // Retain only an incomplete marker, never arbitrary terminal history.
    let keep = Math.min(notice.length - 1, joined.length)
    while (keep > 0 && !joined.subarray(joined.length - keep).equals(notice.subarray(0, keep))) keep--
    this.tail = Buffer.from(joined.subarray(joined.length - keep))
    return found
  }
}

interface ExitDeps {
  current(id: string): RegisteredSession | undefined
  /** Stop/restart owns the registry until its lifecycle transaction completes. */
  blocked(session: RegisteredSession): boolean
  pane(pane: string): Promise<TmuxPaneState | null>
  process(session: RegisteredSession): Promise<RuntimeCheck>
  retain(session: RegisteredSession, paneAlive: boolean): void
}

/** Share one check across viewers. A false hint, uncertain probe, or changed
 * launch does nothing; periodic discovery remains the compatibility fallback. */
export function createEngineExitObserver(deps: ExitDeps) {
  const pending = new Set<string>()
  return async (id: string): Promise<void> => {
    const entry = deps.current(id)
    if (!entry || pending.has(id) || deps.blocked(entry) || entry.engine === 'terminal'
      || entry.launch?.state !== 'ready' || !entry.processIdentity || !entry.tmuxPane) return
    const saved = { ...entry, processIdentity: { ...entry.processIdentity } }
    pending.add(id)
    try {
      const pane = await deps.pane(saved.tmuxPane)
      if (!pane || pane.engineExit == null || deps.blocked(saved)) return
      if ((await deps.process(saved)).state !== 'gone') return
      const now = deps.current(id)
      if (!now || deps.blocked(now) || now.engine !== saved.engine || now.tmuxPane !== saved.tmuxPane
        || now.sessionId !== saved.sessionId || now.launch?.state !== 'ready'
        || now.processIdentity?.pid !== saved.processIdentity.pid
        || now.processIdentity?.startMarker !== saved.processIdentity.startMarker
        || now.processIdentity?.executable !== saved.processIdentity.executable) return
      deps.retain(now, !pane.dead)
    } catch { /* A failed observation cannot close a live agent. */ }
    finally { pending.delete(id) }
  }
}
