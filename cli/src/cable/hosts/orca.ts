/**
 * Types into and brings forward an Orca terminal, by the handle its hook sent (ORCA_TERMINAL_HANDLE). The handle came
 * from a hook and the text from the dial, so both are checked here, and `orca` runs with no shell: the text is one
 * argument, never a command line. Nothing here polls Orca.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'

export const ORCA_HANDLE = /^term_[0-9a-f-]{36}$/

const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
const ORCA_BUNDLE = 'com.stablyai.orca'
const RUN_TIMEOUT_MS = 10_000
const MAX_TEXT = 2000
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

export function createOrcaActions(deps: OrcaDeps): { send(handle: string, text: string): Promise<boolean>; open(handle: string): Promise<boolean> } {
  // One command at a time per terminal: two transcripts typed at once would mix in its prompt.
  const running = new Set<string>()

  const orcaBinary = (): string | null =>
    deps.onPath('orca') ?? (deps.platform === 'darwin' && deps.exists(APP_ORCA) ? APP_ORCA : null)

  async function alone(handle: string, work: (orca: string) => Promise<boolean>): Promise<boolean> {
    if (!ORCA_HANDLE.test(handle) || running.has(handle)) return false
    const orca = orcaBinary()
    if (!orca) return false
    running.add(handle)
    try {
      return await work(orca)
    } finally {
      running.delete(handle)
    }
  }

  const exitsZero = async (file: string, args: string[]): Promise<boolean> => (await deps.run(file, args, RUN_TIMEOUT_MS)).code === 0

  return {
    async send(handle, text) {
      if (text === '' || text.length > MAX_TEXT) return false
      const line = text.replace(CONTROL, ' ')
      return alone(handle, (orca) => exitsZero(orca, ['terminal', 'send', '--terminal', handle, '--text', line, '--enter', '--wait-submit', '5', '--json']))
    },
    open(handle) {
      return alone(handle, async (orca) => {
        if (!await exitsZero(orca, ['terminal', 'switch', '--terminal', handle, '--json'])) return false
        // The switch picks the terminal inside Orca; on macOS Orca itself still has to come to the front. Its own path,
        // so no `open` earlier on PATH runs instead.
        if (deps.platform === 'darwin') await deps.run('/usr/bin/open', ['-b', ORCA_BUNDLE], RUN_TIMEOUT_MS)
        return true
      })
    },
  }
}
