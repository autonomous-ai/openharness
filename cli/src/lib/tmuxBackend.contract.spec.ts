import { describe, vi } from 'vitest'
import { isolatedTmux } from '../testing/isolatedTmux.js'
import { runTerminalBackendContract } from './terminalBackend.contract.js'
import { TmuxBackend } from './tmuxBackend.js'
import { DEFAULT_HOST_THEME } from './hostTheme.js'

const enabled = process.env.RUN_TERMINAL_CONTRACT === '1' && process.platform !== 'win32'
;(enabled ? runTerminalBackendContract : () => describe.skip('tmux contract', () => {}))('tmux', async () => {
  // A private tmux server: the backend runs bare `tmux`, so the environment points it at the fixture's
  // socket directory and clears the variables that would reach the developer's own server.
  const server = await isolatedTmux({ PATH: process.env.PATH, TERM: 'xterm-256color' })
  vi.stubEnv('TMUX', undefined)
  vi.stubEnv('TMUX_PANE', undefined)
  vi.stubEnv('TMUX_TMPDIR', server.root)
  const cleanup = async () => { await server.close(); vi.unstubAllEnvs() }
  const backend = new TmuxBackend(() => DEFAULT_HOST_THEME)
  // A backend that cannot be readied fails the suite saying why, and leaves no server or stubbed environment.
  const prepared = await backend.prepare({ ownedPanes: new Map() }).catch(async (error: unknown) => {
    await cleanup()
    throw new Error(`tmux contract: prepare threw: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (prepared.state !== 'ready') {
    await cleanup()
    throw new Error(`tmux contract: tmux is unavailable (${prepared.code}): ${prepared.reason}`)
  }
  return { backend, cleanup }
})
