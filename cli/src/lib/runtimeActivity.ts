import type { ScreenReader } from './screenReader.js'
import type { RegisteredSession } from './registry.js'
import type { ActivityState } from './turnActivity.js'

export function activityRuntimeKey(session: RegisteredSession): string {
  return JSON.stringify([session.agentId, session.sessionId, session.primaryRuntimeKey, session.processIdentity])
}

/** A positive, changing live busy indicator can confirm an otherwise quiet
 * process-owned engine. Missing/unrecognized UI is always unknown. */
export class RuntimeActivityReader {
  private readonly footers = new Map<string, { runtime: string; indicator: string | null; stopped: boolean }>()
  constructor(private readonly deps: {
    readScreen: ScreenReader
    /** The engine's own server's answer (Codex's, from its worker: core/engines/nativeControls.ts). */
    codex(session: RegisteredSession): Promise<ActivityState>
    capture(session: RegisteredSession): Promise<string | null>
  }) {}
  forget(sessionId: string): void { this.footers.delete(sessionId) }
  async read(session: RegisteredSession): Promise<ActivityState> {
    const state = await this.deps.codex(session)
    if (state !== 'unknown') return state
    if (session.engine !== 'claude' && session.engine !== 'codex') return 'unknown'
    const screen = await this.deps.capture(session)
    const runtime = activityRuntimeKey(session)
    const previous = this.footers.get(session.sessionId)
    const reading = await this.deps.readScreen(session, screen)
    if (!reading) { this.footers.delete(session.sessionId); return 'unknown' }
    const indicator = reading.activity?.indicator ?? null
    const stopped = reading.stoppedGoal
    this.footers.set(session.sessionId, { runtime, indicator, stopped })
    if (previous?.runtime !== runtime) return 'unknown'
    if (stopped && previous.stopped) return 'idle'
    if (indicator && previous.indicator && indicator !== previous.indicator) return 'working'
    return 'unknown'
  }
}
