/**
 * A WezTerm pane (docs/specs/2026-11-15-device-host-adapter.md): a tap activates it by `wezterm cli`, then WezTerm comes
 * forward as every app does, and the dial's words are typed into it by `wezterm cli send-text`. The pane id came from a
 * hook, so it is checked against its form before each command, which runs with no shell.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

const APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'
const WEZTERM_PANE = /^[0-9]{1,9}$/
// A pane that holds the agent's terminal but is not its own: words typed there land in whatever that terminal shows.
const HELD = 'held:'
// With no WezTerm running, `wezterm cli` would start a mux server of its own that outlives the command.
const CLI = ['cli', '--no-auto-start']

export function createWeztermAdapter(deps: OrcaDeps): HostAdapter {
  const mac = deps.platform === 'darwin'
  // Per pane, the words being typed: two sends at once would mix in its prompt. Busy queues nothing.
  const sending = new Set<string>()
  // Found once: canType runs at every look, each second for each WezTerm agent, and finding it walks PATH. None found,
  // or a run that failed, is asked again: WezTerm installed, moved or removed since.
  let found: string | null = null
  const binary = () => (found ??= deps.onPath('wezterm') ?? (mac && deps.exists(APP_WEZTERM) ? APP_WEZTERM : null))
  const ran = async (wezterm: string, args: string[]): Promise<boolean> => {
    let ok = false
    try {
      ok = (await deps.run(wezterm, args, RUN_TIMEOUT_MS)).code === 0
      return ok
    } finally {
      if (!ok) found = null
    }
  }
  return {
    id: 'wezterm',
    tap: 'before',
    paneOf(place: Place): Pane | undefined {
      const id = place.hints.WEZTERM_PANE
      if (!id || !WEZTERM_PANE.test(id)) return undefined
      // A multiplexer keeps the environment of the WezTerm pane it was started in, so that pane shows whichever of its
      // panes is in front, another agent's or a shell's; in an Orca terminal the words go through Orca. Both only focus.
      const own = place.host === 'wezterm' && place.hints.ORCA_TERMINAL_HANDLE === undefined
      return { adapter: 'wezterm', id: own ? id : `${HELD}${id}` }
    },
    // `wezterm cli` runs on every platform.
    canFocus: () => true,
    async focus(pane) {
      const id = pane.id.startsWith(HELD) ? pane.id.slice(HELD.length) : pane.id
      if (!WEZTERM_PANE.test(id)) return false
      const wezterm = binary()
      if (!wezterm) return false
      return ran(wezterm, [...CLI, 'activate-pane', '--pane-id', id])
    },
    canType: (pane) => WEZTERM_PANE.test(pane.id) && binary() !== null,
    async type(pane, text) {
      if (text === '' || text.length > MAX_TEXT || !WEZTERM_PANE.test(pane.id) || sending.has(pane.id)) return false
      const wezterm = binary()
      if (!wezterm) return false
      // `--` keeps words that start with a dash from being read as flags; `--no-paste` types them as keys, so the agent
      // does not take them as a bracketed paste, and Enter, sent on its own, submits them.
      const send = (words: string) => ran(wezterm, [...CLI, 'send-text', '--pane-id', pane.id, '--no-paste', '--', words])
      sending.add(pane.id)
      try {
        return await send(text.replace(CONTROL, ' ')) && await send('\r')
      } finally {
        sending.delete(pane.id)
      }
    },
  }
}
