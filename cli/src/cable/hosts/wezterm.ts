/**
 * A WezTerm pane (docs/specs/2026-11-15-device-host-adapter.md): a tap activates it by `wezterm cli`, then WezTerm comes
 * forward as every app does, and the dial's words are typed into it by `wezterm cli send-text`. The pane id came from a
 * hook, so it is checked against its form before each command, which runs with no shell.
 *
 * WezTerm's tab of an outer place (docs/plans/2026-11-21-dial-linux-followups-design.md, "The tab"): the WezTerm pane
 * holding a multiplexer's client, found by the client's tty in `wezterm cli list`, and activated after WezTerm is in front.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import { clientTtyForm } from './tabs.js'
import type { PaneSwitch } from './types.js'

const APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'
const WEZTERM_PANE = /^[0-9]{1,9}$/
// A pane that holds the agent's terminal but is not its own: words typed there land in whatever that terminal shows.
const HELD = 'held:'
// With no WezTerm running, `wezterm cli` would start a mux server of its own that outlives the command.
const CLI = ['cli', '--no-auto-start']
/** The most panes a `wezterm cli list` is read with: a longer one is not WezTerm's answer to rely on. */
export const LISTED_PANES_MAX = 256

/** `wezterm cli`, found once: canType runs at every look, each second for each WezTerm agent, and finding it walks PATH.
 *  None found, or a run that failed, is asked again: WezTerm installed, moved or removed since. */
function weztermCli(deps: OrcaDeps) {
  let found: string | null = null
  const binary = () =>
    (found ??= deps.onPath('wezterm') ?? (deps.platform === 'darwin' && deps.exists(APP_WEZTERM) ? APP_WEZTERM : null))
  /** What the command printed, or null when it failed. */
  const run = async (wezterm: string, args: string[]): Promise<string | null> => {
    let out: string | null = null
    try {
      const { code, stdout } = await deps.run(wezterm, [...CLI, ...args], RUN_TIMEOUT_MS)
      if (code === 0) out = stdout
      return out
    } finally {
      if (out === null) found = null
    }
  }
  return { binary, run }
}

export function createWeztermAdapter(deps: OrcaDeps): HostAdapter {
  // Per pane, the words being typed: two sends at once would mix in its prompt. Busy queues nothing.
  const sending = new Set<string>()
  const cli = weztermCli(deps)
  const ran = async (wezterm: string, args: string[]): Promise<boolean> => (await cli.run(wezterm, args)) !== null
  return {
    id: 'wezterm',
    tap: 'before',
    paneOf(place: Place): Pane | undefined {
      const id = place.hints.WEZTERM_PANE
      if (!id || !WEZTERM_PANE.test(id)) return undefined
      // A multiplexer, a terminal or an editor started in a WezTerm pane keeps its variables, and that pane shows whichever
      // of their panes is in front, or a shell that runs what is typed: only a pane WezTerm made the agent's terminal for
      // takes words. Any other only focuses.
      return place.ptyOwner === 'wezterm' ? { adapter: 'wezterm', id } : { adapter: 'wezterm', id: `${HELD}${id}`, held: true }
    },
    // `wezterm cli` runs on every platform.
    canFocus: () => true,
    async focus(pane) {
      const id = pane.id.startsWith(HELD) ? pane.id.slice(HELD.length) : pane.id
      if (!WEZTERM_PANE.test(id)) return false
      const wezterm = cli.binary()
      if (!wezterm) return false
      return ran(wezterm, ['activate-pane', '--pane-id', id])
    },
    canType: (pane) => WEZTERM_PANE.test(pane.id) && cli.binary() !== null,
    async type(pane, text) {
      if (text === '' || text.length > MAX_TEXT || !WEZTERM_PANE.test(pane.id) || sending.has(pane.id)) return false
      const wezterm = cli.binary()
      if (!wezterm) return false
      // `--` keeps words that start with a dash from being read as flags; `--no-paste` types them as keys, so the agent
      // does not take them as a bracketed paste, and Enter, sent on its own, submits them.
      const send = (words: string) => ran(wezterm, ['send-text', '--pane-id', pane.id, '--no-paste', '--', words])
      sending.add(pane.id)
      try {
        return await send(text.replace(CONTROL, ' ')) && await send('\r')
      } finally {
        sending.delete(pane.id)
      }
    },
  }
}

/** The id of the pane on [tty] in `wezterm cli list --format json`'s [stdout]; none when no pane holds it, or when the
 *  list is out of form anywhere: an answer not wholly WezTerm's names no pane to activate. Only `pane_id` and `tty_name`
 *  are read. */
function paneOnTty(stdout: string, tty: string): string | undefined {
  let entries: unknown
  try {
    entries = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(entries) || entries.length > LISTED_PANES_MAX) return undefined
  let holding: string | undefined
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { pane_id: id, tty_name: name } = entry as { pane_id?: unknown; tty_name?: unknown }
    if (typeof id !== 'number' || !WEZTERM_PANE.test(String(id)) || typeof name !== 'string') return undefined
    if (name === tty) holding ??= String(id)
  }
  return holding
}

/** The WezTerm pane holding a multiplexer's client, by the client's tty: a rest activates it while WezTerm is in front,
 *  and a tap once WezTerm came forward. */
export function createWeztermTabAdapter(deps: OrcaDeps & { front(): string | undefined }):
HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const cli = weztermCli(deps)
  // Windows' WezTerm names no tty a client could be found by.
  const form = clientTtyForm(deps.platform)
  const inForm = (pane: Pane) => form?.test(pane.id) === true
  // One list a verb. Activating a pane also makes its tab its window's active one (recordedWezterm.ts activatePane),
  // so no activate-tab runs.
  const activate = async (pane: Pane): Promise<boolean> => {
    if (!inForm(pane)) return false
    const wezterm = cli.binary()
    if (!wezterm) return false
    const listed = await cli.run(wezterm, ['list', '--format', 'json'])
    const id = listed === null ? undefined : paneOnTty(listed, pane.id)
    return id !== undefined && (await cli.run(wezterm, ['activate-pane', '--pane-id', id])) !== null
  }
  return {
    id: 'wezterm-tab',
    tap: 'after',
    paneOf(place: Place): Pane | undefined {
      const tty = place.outer?.app === 'wezterm' ? place.outer.tty : undefined
      return tty !== undefined && form?.test(tty) ? { adapter: 'wezterm-tab', id: tty } : undefined
    },
    canFocus: inForm,
    canShow: (pane) => inForm(pane) && deps.front() === 'wezterm',
    focus: activate,
    show: async (pane): Promise<PaneSwitch> => (await activate(pane) ? 'ok' : 'failed'),
  }
}
