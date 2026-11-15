/**
 * A pane in the person's own tmux (docs/specs/2026-11-15-device-wave1-checks.md, F1 "The tap"): a tap switches one of
 * their clients to the pane a hook named, then the app around tmux comes forward as every app does. That switch is the
 * one thing done there, only once the pane's process is checked to be the agent's or one of its parents, and it never
 * moves a client on a session Harness made: nothing is typed, made or closed (Q1). tmux is the daemon's: the name on its
 * PATH, with no `-L` or `-S`. Each value came from a hook, so it is checked against its form, and tmux runs with no shell.
 */
import { HARNESS_OWNER_OPTION, isHarnessSession, paneOwnerFormat } from '../../lib/harnessSessionLabel.js'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import { parentChain, type ProcessName } from './scannedApp.js'

const TMUX_PANE_ID = /^%[0-9]{1,9}$/
const PID = /^[1-9][0-9]{0,9}$/
/** This adapter's pane: tmux's pane id and the agent's process, `%3:100`, as the hook's event named them. */
const PANE_AND_PID = /^(%[0-9]{1,9}):([1-9][0-9]{0,9})$/
/** The pane, in one call: its process, its session, and the tag of the daemon that made it, as the hook reads them
 *  (`describePane`). The tag is the pane's option and, read on any tmux so no `tmux -V` is asked, the one its start
 *  command carries before tmux 3.0 (a newer tmux never puts it there). Before 3.0 the option is the window's: it counts
 *  wherever it is read, as not switching is the mistake that costs nothing. */
const TMUX_PANE_FACTS = `#{pane_pid}|#{session_name}|#{${HARNESS_OWNER_OPTION}}${paneOwnerFormat(false)}`
/** One line of TMUX_PANE_FACTS: the tag is last, cut at the last bar, as the hook cuts it; the session may hold a bar. */
const TMUX_PANE_FACT = /^([1-9][0-9]{0,9})\|(.*)\|([^|]*)$/
/** Each client: when it was used last, its name, the tag of the pane it shows, its session. The daemon's own names for
 *  the tag and the session prefix, which the hook mirrors. The session's name is last: it may hold a bar. */
const TMUX_CLIENTS = `#{client_activity}|#{client_name}|#{${HARNESS_OWNER_OPTION}}|#{session_name}`
/** One line of TMUX_CLIENTS, cut at its first three bars; one with fewer, an activity that is no whole number or an
 *  empty name is no client. */
const TMUX_CLIENT = /^([0-9]+)\|([^|]+)\|([^|]*)\|(.*)$/

export interface TmuxDeps {
  run: OrcaDeps['run']
  /** The machine's processes, as the open scan reads them; it rejects when the table cannot be read. */
  processes(): Promise<readonly Pick<ProcessName, 'pid' | 'ppid'>[]>
  log(line: string): void
}

export function createTmuxAdapter(deps: TmuxDeps): HostAdapter {
  /** The agent's process and its parents, as the open scan walks them: an agent whose process is gone is in no pane. */
  async function chainOf(pid: number): Promise<Set<number>> {
    const table = new Map((await deps.processes()).map((p) => [p.pid, p]))
    return new Set(parentChain(pid, table).map((p) => p.pid))
  }

  /**
   * The client used last among those not on a session Harness made. Every terminal Harness has open (Desktop's, a
   * phone's, hn's) is a tmux client on this server, and a bare `switch-client` moves the client used last, one of those
   * included (the spec, F1 "The tap"). Before tmux 3.0 the tag is the window's: it counts wherever it is read, as not
   * switching is the mistake that costs nothing. tmux gives the activity in whole seconds: on a tie the one listed later,
   * which attached later, wins.
   */
  async function personsClient(): Promise<string | undefined> {
    const listed = await deps.run('tmux', ['list-clients', '-F', TMUX_CLIENTS], RUN_TIMEOUT_MS)
    if (listed.code !== 0) return undefined
    let last: { activity: number; name: string } | undefined
    for (const line of listed.stdout.split('\n')) {
      const client = TMUX_CLIENT.exec(line)
      if (!client) continue
      const [, activity, name, tag, session] = client
      if (tag || isHarnessSession(session)) continue
      if (!last || Number(activity) >= last.activity) last = { activity: Number(activity), name }
    }
    return last?.name
  }

  /** A pane the tap may not switch to: another process's, or one Harness made. */
  function notItsPane(): 'refused' {
    deps.log('[device] open · tmux · not its pane')
    return 'refused'
  }

  return {
    id: 'tmux',
    tap: 'before',
    // The pane carries the hook's caller, the agent's process: the pane's own is checked against it at the tap.
    paneOf(place: Place): Pane | undefined {
      const id = place.hints.TMUX_PANE
      return id && TMUX_PANE_ID.test(id) && PID.test(String(place.pid)) ? { adapter: 'tmux', id: `${id}:${place.pid}` } : undefined
    },
    canFocus: () => true,
    /** The person's client is switched to the pane only once tmux names the pane's process and it is the agent's or one
     *  of its parents: a second tmux server of theirs (`-L`) can have a pane of the same id. And only while the pane is
     *  still the person's: the hook checked that at its last event, and a pane can move into a session Harness made
     *  since (Q1). */
    async focus(pane) {
      const ids = PANE_AND_PID.exec(pane.id)
      if (!ids) return false
      const [, id, agentPid] = ids
      const said = await deps.run('tmux', ['display-message', '-p', '-t', id, TMUX_PANE_FACTS], RUN_TIMEOUT_MS)
      const facts = TMUX_PANE_FACT.exec(said.stdout.trim())
      if (said.code !== 0 || !facts) return false
      const [, panePid, session, owner] = facts
      // The rule the hook and the client filter hold: a daemon's tag, or a session Harness named.
      if (owner || isHarnessSession(session)) return notItsPane()
      const chain = await chainOf(Number(agentPid)).catch(() => undefined)
      if (!chain) return false
      if (!chain.has(Number(panePid))) return notItsPane()
      const client = await personsClient()
      return !!client && (await deps.run('tmux', ['switch-client', '-c', client, '-t', id], RUN_TIMEOUT_MS)).code === 0
    },
  }
}
