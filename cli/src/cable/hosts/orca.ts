/**
 * Types into and switches to an Orca terminal, by the handle its hook sent (ORCA_TERMINAL_HANDLE). The handle came
 * from a hook and the text from the dial, so both are checked here, and `orca` runs with no shell: the text is one
 * argument, never a command line. Nothing here polls Orca. Orca itself comes forward as every app does (open.ts).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import type { PaneSwitch } from './types.js'

export const ORCA_HANDLE = /^term_[0-9a-f-]{36}$/

const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
/** How long any app's command may run (open.ts too). */
export const RUN_TIMEOUT_MS = 10_000
/** The longest text typed into a terminal; the mod's prompt takes no more either (observed.ts). */
export const MAX_TEXT = 2000
// A newline would submit part of the text and an escape would steer the agent's screen: the text is typed as one line,
// and --enter submits it.
const CONTROL = /\p{Cc}/gu

export interface OrcaDeps {
  run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null }>
  onPath(name: string): string | null
  exists(path: string): boolean
  platform: NodeJS.Platform
}

export function orcaDeps(): OrcaDeps {
  return {
    run: (file, args, timeoutMs) => new Promise((resolve) => {
      // The timeout's kill waits for the process to exit: one deaf to SIGTERM, or stuck where even SIGKILL waits, kept the
      // call and its terminal's one-command slot open for good. The deadline answers by itself.
      const deadline = setTimeout(() => resolve({ code: null }), timeoutMs)
      execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (error) => {
        clearTimeout(deadline)
        // A number is the exit code; a timeout's kill or a binary that could not start has none.
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null })
      })
    }),
    onPath: (name) => resolveBinaryOnPath(name),
    exists: existsSync,
    platform: process.platform,
  }
}

export function createOrcaActions(deps: OrcaDeps): { send(handle: string, text: string): Promise<boolean>; switchTo(handle: string): Promise<PaneSwitch> } {
  // One command at a time per terminal: two transcripts typed at once would mix in its prompt.
  const running = new Set<string>()

  const orcaBinary = (): string | null =>
    deps.onPath('orca') ?? (deps.platform === 'darwin' && deps.exists(APP_ORCA) ? APP_ORCA : null)

  // Busy runs nothing and queues nothing: a later command for the terminal is asked for again, never stacked behind.
  async function alone(handle: string, args: string[]): Promise<PaneSwitch> {
    if (!ORCA_HANDLE.test(handle)) return 'failed'
    if (running.has(handle)) return 'busy'
    const orca = orcaBinary()
    if (!orca) return 'failed'
    running.add(handle)
    try {
      return (await deps.run(orca, args, RUN_TIMEOUT_MS)).code === 0 ? 'ok' : 'failed'
    } finally {
      running.delete(handle)
    }
  }

  return {
    async send(handle, text) {
      if (text === '' || text.length > MAX_TEXT) return false
      const line = text.replace(CONTROL, ' ')
      // Joined to its flag: orca reads a separate argument that starts with -- as the next flag, not as the text.
      return (await alone(handle, ['terminal', 'send', '--terminal', handle, `--text=${line}`, '--enter', '--wait-submit', '5', '--json'])) === 'ok'
    },
    // Picks the terminal inside Orca, under the same one-at-a-time as the words typed into it.
    switchTo(handle) {
      return alone(handle, ['terminal', 'switch', '--terminal', handle, '--json'])
    },
  }
}
