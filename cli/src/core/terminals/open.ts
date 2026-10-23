/** The core's narrow launch call. Shell setup and request policy belong to the shell service. */
import { randomUUID } from 'node:crypto'
import type { TerminalsPort } from '../api.js'
import { createAndRegisterPane, type CreateAgentPaneDeps } from '../../lib/createAgentPane.js'
import type { RegisteredSession, registry } from '../../lib/registry.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'

export interface TerminalOpenerDeps {
  /** Where a new terminal's pane is made (main.ts `createBackend`); null with no backend ready. */
  createBackend: (CreateAgentPaneDeps['tmuxBackend'] & Pick<TerminalBackend, 'releaseHold'>) | null
  registry: CreateAgentPaneDeps['registry'] & Pick<typeof registry, 'setLaunch'>
  announceSession(session: RegisteredSession): void
  blocksFolder(cwd: string): boolean
  /** What it answers when no backend is ready: the configured backend's own code (terminalBackend.ts
   *  `noBackendCode`); `TMUX_UNAVAILABLE`, as before, by default. */
  noBackendCode?: string
}

export function createTerminalOpener({ createBackend, registry, announceSession, blocksFolder, noBackendCode = 'TMUX_UNAVAILABLE' }: TerminalOpenerDeps): Pick<TerminalsPort, 'open'> {
  return { open: async ({ argv, cwd }) => {
    if (!createBackend) return { ok: false, error: noBackendCode }
    if (blocksFolder(cwd)) return { ok: false, error: 'WORKTREE_BUSY' }
    const result = await createAndRegisterPane({
      tmuxBackend: createBackend, registry, engine: 'terminal', cwd, spawnCwd: cwd,
      argv: [...argv], sessionLabel: `harness-shell-${randomUUID()}`, bypassPermission: false,
    })
    if (!result.ok) return result
    await createBackend.releaseHold(result.spawned.runtime)
    const ready = registry.setLaunch(result.pending.agentId, { state: 'ready' })
    if (!ready) return { ok: false, error: 'TERMINAL_CLOSED' }
    announceSession(ready)
    return { ok: true, agentId: ready.agentId }
  } }
}
