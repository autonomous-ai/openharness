/**
 * Types into and switches to an Orca terminal, by the handle its hook sent (ORCA_TERMINAL_HANDLE). The handle came
 * from a hook and the text from the dial, so both are checked here, and `orca` runs with no shell: the text is one
 * argument, never a command line. Nothing here polls Orca. Orca itself comes forward as every app does (open.ts).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import type { HostAdapter } from './adapter.js'
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
// detectHost's multiplexers. Each keeps the environment of the terminal it was started in, so the handle names that
// terminal, not where the agent is: words typed there land in whichever pane it shows, another agent's or a shell's. So
// an agent in one has no Orca pane: no words, no rest, no tap through Orca.
const MULTIPLEXERS: ReadonlySet<string> = new Set(['herdr', 'rex', 'zellij', 'tmux'])

export interface OrcaDeps {
  /** Its stdout too: tmux's answer is what it printed (tmux.ts). */
  run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }>
  onPath(name: string): string | null
  exists(path: string): boolean
  platform: NodeJS.Platform
}

export function orcaDeps(): OrcaDeps {
  return {
    run: (file, args, timeoutMs) => new Promise((resolve) => {
      // The timeout's kill waits for the process to exit: one deaf to SIGTERM, or stuck where even SIGKILL waits, kept the
      // call and its terminal's one-command slot open for good. The deadline answers by itself.
      const deadline = setTimeout(() => resolve({ code: null, stdout: '' }), timeoutMs)
      execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
        clearTimeout(deadline)
        // A number is the exit code; a timeout's kill or a binary that could not start has none.
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout })
      })
    }),
    onPath: (name) => resolveBinaryOnPath(name),
    exists: existsSync,
    platform: process.platform,
  }
}

function createOrcaActions(deps: OrcaDeps): { send(handle: string, text: string): Promise<boolean>; switchTo(handle: string): Promise<PaneSwitch> } {
  // Per terminal, the switch under way: a second one is that same run. A swipe's rest runs a switch, and a tap 0.4 to 1 s
  // after it was refused as busy: on Linux the dial said Orca did not open the pane it had just shown.
  const switching = new Map<string, Promise<PaneSwitch>>()
  // Per terminal, the words being typed or waiting to be: two transcripts typed at once would mix in its prompt.
  const sending = new Set<string>()

  const orcaBinary = (): string | null =>
    deps.onPath('orca') ?? (deps.platform === 'darwin' && deps.exists(APP_ORCA) ? APP_ORCA : null)

  return {
    async send(handle, text) {
      if (text === '' || text.length > MAX_TEXT || !ORCA_HANDLE.test(handle)) return false
      // Busy queues nothing: the dial asks again, never stacked behind.
      if (sending.has(handle)) return false
      const orca = orcaBinary()
      if (!orca) return false
      const line = text.replace(CONTROL, ' ')
      sending.add(handle)
      try {
        // A switch types nothing: the words wait for one under way, then are typed, never beside it.
        const shown = switching.get(handle)
        if (shown) await shown
        // Joined to its flag: orca reads a separate argument that starts with -- as the next flag, not as the text.
        return (await deps.run(orca, ['terminal', 'send', '--terminal', handle, `--text=${line}`, '--enter', '--wait-submit', '5', '--json'], RUN_TIMEOUT_MS)).code === 0
      } finally {
        sending.delete(handle)
      }
    },
    // Picks the terminal inside Orca. Words being typed there make it busy: it runs nothing and queues nothing.
    async switchTo(handle) {
      if (!ORCA_HANDLE.test(handle)) return 'failed'
      const under = switching.get(handle)
      if (under) return under
      if (sending.has(handle)) return 'busy'
      const orca = orcaBinary()
      if (!orca) return 'failed'
      const run = deps.run(orca, ['terminal', 'switch', '--terminal', handle, '--json'], RUN_TIMEOUT_MS)
        .then(({ code }): PaneSwitch => (code === 0 ? 'ok' : 'failed'))
        .finally(() => switching.delete(handle))
      switching.set(handle, run)
      return run
    },
  }
}

/** An Orca terminal, by its handle: words are typed there, and a rest or a tap switches to it before Orca comes forward. */
export function createOrcaAdapter(deps: OrcaDeps): HostAdapter & Required<Pick<HostAdapter, 'show' | 'type'>> {
  const orca = createOrcaActions(deps)
  return {
    id: 'orca',
    tap: 'before',
    paneOf: (place) => {
      if (MULTIPLEXERS.has(place.host)) return undefined
      const handle = place.hints.ORCA_TERMINAL_HANDLE
      return handle && ORCA_HANDLE.test(handle) ? { adapter: 'orca', id: handle } : undefined
    },
    // `orca terminal switch` runs on every platform.
    canFocus: () => true,
    focus: async (pane) => (await orca.switchTo(pane.id)) === 'ok',
    show: (pane) => orca.switchTo(pane.id),
    type: (pane, text) => orca.send(pane.id, text),
  }
}
