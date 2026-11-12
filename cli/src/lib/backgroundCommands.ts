/**
 * How many background commands a harness's engine still runs, read on demand for a close's `inspect`
 * (docs/plans/2026-11-12-background-count-design.md). Each engine's rule is its own module's; this only finds what
 * that rule reads. `null` is "Harness cannot know": an engine whose shape is not pinned, a table that cannot be read,
 * an engine process no longer there. It never blocks a close, so nothing here may throw.
 */

import { claudeBackgroundCommands } from '../engines/claude/backgroundCommands.js'
import { loadEngine, type InProcessModules } from '../engines/inProcess.js'
import { processRows, type ProcessRow } from './processTable.js'
import type { RegisteredSession } from './registry.js'
import { sameProcessIdentity } from './terminalRuntime.js'

export interface BackgroundCommandsDeps {
  platform?: NodeJS.Platform
  rows?: () => Promise<ProcessRow[] | null>
  hermes?: () => Promise<Pick<InProcessModules['hermes'], 'hermesBackgroundCommands' | 'hermesHomeForSession'> | null>
}

/** How many background commands [session]'s engine still runs; null when Harness cannot know. Never throws. */
export async function backgroundCommands(
  session: Pick<RegisteredSession, 'engine' | 'agentId' | 'sessionId' | 'hermesHome' | 'processIdentity'>,
  { platform = process.platform, rows = processRows, hermes = () => loadEngine('hermes') }: BackgroundCommandsDeps = {},
): Promise<number | null> {
  try {
    switch (session.engine) {
      case 'claude': {
        // Its shells are told apart by argv, which Windows' table does not carry in that shape.
        if (platform === 'win32' || !session.processIdentity) return null
        const table = await rows()
        const engine = table?.find((row) => sameProcessIdentity(row, session.processIdentity))
        if (!table || !engine) return null
        // Direct children only: a pipeline's subshells carry the same argv one level down.
        return claudeBackgroundCommands(table.filter((row) => row.parentPid === engine.pid))
      }
      case 'hermes': {
        const module = await hermes()
        if (!module || !session.sessionId) return null
        return await module.hermesBackgroundCommands(await module.hermesHomeForSession(session), session.sessionId)
      }
      default:
        return null
    }
  } catch {
    return null
  }
}
