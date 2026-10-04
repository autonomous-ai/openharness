/**
 * Turn activity: whether an agent is really working, beyond what its transcript says. A turn's
 * transcript can go quiet while the agent thinks or runs a long tool, so an open turn is checked against
 * the runtime: Codex's own activity file, or what the pane shows.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md).
 */
import { isTerminalEngine } from '../../engines/types.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { CodexActivityReader, RuntimeActivityReader, activityRuntimeKey } from '../../lib/runtimeActivity.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { TurnActivity, type ActivityFrame } from '../../lib/turnActivity.js'

export interface TurnActivityDeps {
  terminals: Pick<TerminalBackendCoordinator, 'capture'>
  bySession: (sessionId: string) => RegisteredSession | undefined
  sessionTurnOpen: (sessionId: string) => boolean
  /** Read whatever the session's transcript has that the tail has not delivered yet (Watcher.pollSession). */
  drain: (sessionId: string) => Promise<void>
}

export function createTurnActivity({ terminals, bySession, sessionTurnOpen, drain }: TurnActivityDeps) {
  const codexActivity = new CodexActivityReader()
  const runtimeActivity = new RuntimeActivityReader({
    codex: session => codexActivity.read(session),
    capture: async session => {
      const screen = await terminals.capture(session, { mode: 'visible', ansi: true })
      return screen.state === 'succeeded' ? screen.value : null
    },
  })
  const turnActivity = new TurnActivity({
    runtime: sessionId => {
      const session = bySession(sessionId)
      return session?.active ? { key: activityRuntimeKey(session), turnOpen: sessionTurnOpen(sessionId) } : undefined
    },
    drain: sessionId => drain(sessionId),
    probe: async sessionId => {
      const session = bySession(sessionId)
      return session?.active ? runtimeActivity.read(session) : 'unknown'
    },
  })
  /** The activity the app shows for an agent; none for a plain terminal. */
  const activityFrame = (session: RegisteredSession): ActivityFrame | null =>
    isTerminalEngine(session.engine) ? null : turnActivity.snapshot(session.sessionId) ?? null
  return { codexActivity, runtimeActivity, turnActivity, activityFrame }
}

export type TurnActivityReaders = ReturnType<typeof createTurnActivity>
