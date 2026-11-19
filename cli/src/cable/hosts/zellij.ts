/**
 * A Zellij pane (docs/plans/2026-11-19-dial-linux-design.md § 3.2): a tap focuses it by `zellij action focus-pane-id`,
 * then the terminal Zellij runs in comes forward as every app does, and the dial's words are typed into it by
 * `write-chars`, then `send-keys`. The daemon runs outside Zellij, so each command names the session. The session and
 * the pane came from a hook, so both are checked against their form before each command, which runs with no shell.
 * Zellij 0.44's `subscribe` reports no focus (testing/recordedZellij.ts), so the dial does not follow Zellij's focus.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

// Zellij takes spaces and `:` in a session name too; this form keeps a name no argument parser reads as a flag, and
// lets `:` end the session in a pane id.
const SESSION = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
const SESSION_NAME = new RegExp(`^${SESSION}$`)
const PANE_NUMBER = /^[0-9]{1,9}$/
// A pane that holds the agent's terminal but is not its own: words typed there land in whatever that pane shows.
const HELD = 'held:'
// `<session>:<pane>`. A session holds no `:`, so a held id never passes for an own one, even of a session named `held`.
const OWN_PANE = new RegExp(`^(${SESSION}):([0-9]{1,9})$`)
const ANY_PANE = new RegExp(`^(?:${HELD})?(${SESSION}):([0-9]{1,9})$`)

export function createZellijAdapter(deps: Pick<OrcaDeps, 'run' | 'onPath' | 'platform'>): HostAdapter & Required<Pick<HostAdapter, 'type' | 'canType'>> {
  // Per pane, the words being typed: two sends at once would mix in its prompt. Busy queues nothing.
  const sending = new Set<string>()
  const action = (zellij: string, session: string, args: string[]) =>
    deps.run(zellij, ['--session', session, 'action', ...args], RUN_TIMEOUT_MS)

  // `write-chars` and `send-keys` exit 0 for a pane that is gone and for a plugin's, whose ids are counted apart from
  // the terminals': only the listing tells that the pane is a terminal that is there.
  const isTerminal = async (zellij: string, session: string, id: string): Promise<boolean> => {
    const listing = await action(zellij, session, ['list-panes', '--json'])
    if (listing.code !== 0) return false
    try {
      const panes: unknown = JSON.parse(listing.stdout)
      return Array.isArray(panes) && panes.some((one) => one?.id === Number(id) && one?.is_plugin === false)
    } catch {
      return false
    }
  }

  return {
    id: 'zellij',
    tap: 'before',
    paneOf(place: Place): Pane | undefined {
      // macOS and Linux only for now: Zellij on Windows is turned on with the rest of the Windows dial.
      if (deps.platform === 'win32') return undefined
      const session = place.hints.ZELLIJ_SESSION_NAME
      const id = place.hints.ZELLIJ_PANE_ID
      if (!session || !id || !SESSION_NAME.test(session) || !PANE_NUMBER.test(id)) return undefined
      // herdr or Rex started in a Zellij pane keeps its variables, and so does tmux, either way round: that pane shows
      // whichever of their panes is in front. Only focus there.
      const own = place.host === 'zellij' && place.hints.TMUX_PANE === undefined
      return { adapter: 'zellij', id: `${own ? '' : HELD}${session}:${id}` }
    },
    canFocus: () => deps.onPath('zellij') !== null,
    async focus(pane) {
      const found = ANY_PANE.exec(pane.id)
      const zellij = found && deps.onPath('zellij')
      if (!found || !zellij) return false
      const [, session, id] = found
      return (await action(zellij, session, ['focus-pane-id', id])).code === 0
    },
    canType: (pane) => OWN_PANE.test(pane.id) && deps.onPath('zellij') !== null,
    async type(pane, text) {
      const found = OWN_PANE.exec(pane.id)
      if (text === '' || text.length > MAX_TEXT || !found || sending.has(pane.id)) return false
      const zellij = deps.onPath('zellij')
      if (!zellij) return false
      const [, session, id] = found
      sending.add(pane.id)
      try {
        // `--` keeps words that start with a dash from being read as flags; Enter, sent on its own, submits them.
        return await isTerminal(zellij, session, id)
          && (await action(zellij, session, ['write-chars', '--pane-id', id, '--', text.replace(CONTROL, ' ')])).code === 0
          && (await action(zellij, session, ['send-keys', '--pane-id', id, 'Enter'])).code === 0
      } finally {
        sending.delete(pane.id)
      }
    },
  }
}
