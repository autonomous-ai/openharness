/**
 * A pane in the person's own tmux (docs/specs/2026-11-15-device-wave1-checks.md, F1 "The tap"): a tap switches one of
 * their clients to the pane a hook named, then the app around tmux comes forward as every app does. That switch is the
 * one thing done there, only once the pane's process is checked to be the agent's or one of its parents, and it never
 * moves a client on a session Harness made: nothing is typed, made or closed (Q1). Beside it, a lookup reads which client
 * shows a pane's session, to place the agent on the page of the app that holds it (createTmuxOuter). tmux is the daemon's:
 * the name on its PATH, with no `-L` or `-S`. Each value came from a hook or from tmux, so it is checked against its form,
 * and tmux runs with no shell.
 */
import { HARNESS_OWNER_OPTION, isHarnessSession, paneOwnerFormat } from '../../lib/harnessSessionLabel.js'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import { parentChain, scannedApps, type ProcessName } from './scannedApp.js'
import { TAB_TTY } from './tabs.js'

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
/** Each client of one session: when it was used last, its process, its tty. The tty is last: a control client has none. */
const TMUX_CLIENT_PLACES = '#{client_activity}|#{client_pid}|#{client_tty}'
/** One line of TMUX_CLIENT_PLACES; one with no whole activity or no pid in form is no client. */
const TMUX_CLIENT_PLACE = /^([0-9]+)\|([1-9][0-9]{0,9})\|(.*)$/
/** How long a pane's answer holds, from its lookup's start: Command Code's turn-start comes at every tool call, and a
 *  lookup is a `ps` and up to BUNDLES_A_PASS `plutil` runs. */
export const OUTER_EVERY_MS = 5_000

export interface TmuxDeps {
  run: OrcaDeps['run']
  /** The machine's processes, as the open scan reads them; it rejects when the table cannot be read. */
  processes(): Promise<readonly ProcessName[]>
  log(line: string): void
}

/** What tmux says of a pane: its process, and whether it is the person's by the rule the hook and the client filter
 *  hold (no daemon's tag, not in a session Harness named). Nothing when tmux did not answer in form. */
async function paneFacts(run: TmuxDeps['run'], id: string): Promise<{ pid: number; persons: boolean } | undefined> {
  const said = await run('tmux', ['display-message', '-p', '-t', id, TMUX_PANE_FACTS], RUN_TIMEOUT_MS)
  const facts = TMUX_PANE_FACT.exec(said.stdout.trim())
  if (said.code !== 0 || !facts) return undefined
  const [, pid, session, owner] = facts
  return { pid: Number(pid), persons: !owner && !isHarnessSession(session) }
}

/** Whether the pane's process is [pid] or one of its parents, as the open scan walks them: a second tmux server of the
 *  person's (`-L`) can have a pane of the same id, and a process the table does not hold is in no pane. */
function holdsPane(rows: readonly ProcessName[], pid: number, panePid: number): boolean {
  return parentChain(pid, new Map(rows.map((p) => [p.pid, p]))).some((p) => p.pid === panePid)
}

export function createTmuxAdapter(deps: TmuxDeps): HostAdapter {
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
      const facts = await paneFacts(deps.run, id)
      if (!facts) return false
      if (!facts.persons) return notItsPane()
      const rows = await deps.processes().catch(() => undefined)
      if (!rows) return false
      if (!holdsPane(rows, Number(agentPid), facts.pid)) return notItsPane()
      const client = await personsClient()
      return !!client && (await deps.run('tmux', ['switch-client', '-c', client, '-t', id], RUN_TIMEOUT_MS)).code === 0
    },
  }
}

export interface TmuxOuterDeps {
  run: TmuxDeps['run']
  processes: TmuxDeps['processes']
  log: TmuxDeps['log']
  now(): number
  platform: NodeJS.Platform
  roots: readonly string[]
  bundleId(bundle: string): Promise<string | undefined>
}

/** The app that holds the tmux client showing an agent's pane, and that client's tty when it names a tab. */
interface ClientPlace { app?: string; tty?: string }

/** Nothing at once when the hints name no tmux pane in form or the caller is no pid; else the client's place, `{}` when
 *  none is found. Never rejects. */
export type TmuxOuter = (hints: Readonly<Record<string, string>>, pid: number) => Promise<ClientPlace> | undefined

/**
 * Where the person sees an agent in a pane of their own tmux: in the app that holds the client used last on the pane's
 * session, at that client's tty. The pane's own hints cannot say: tmux sets TERM_PROGRAM=tmux, and the bundle id is the
 * one the server started with, none when the daemon started it (Diego's Mac, 2026-11-19), and another app's after a
 * re-attach. It only reads, the pane's facts and its session's clients, and only for a pane of the person's that holds
 * the hook's caller (pid).
 */
export function createTmuxOuter(deps: TmuxOuterDeps): TmuxOuter {
  // By pane and caller: an answer holds for the caller whose chain held the pane, a pane of the same id may be another
  // server's. A lookup in flight is shared past its 5 s, so a tmux that hangs to its timeout runs no second one.
  const asked = new Map<string, { at: number; answer: Promise<ClientPlace>; settled: boolean }>()

  /** `{}` when the pane is not the person's, holds no process of the caller's, or no client of its session is in a
   *  listed app; nothing when tmux or the process table could not be read. */
  async function placeOf(id: string, pid: number): Promise<ClientPlace | undefined> {
    const facts = await paneFacts(deps.run, id)
    if (!facts) return undefined
    if (!facts.persons) return {}
    // One read of the table serves the pane's proof and the client's walk.
    const rows = await deps.processes()
    if (!holdsPane(rows, pid, facts.pid)) return {}
    // By the pane id, which tmux resolves to its session: a session's name could read as another target (`$0`, `@1`).
    const listed = await deps.run('tmux', ['list-clients', '-t', id, '-F', TMUX_CLIENT_PLACES], RUN_TIMEOUT_MS)
    if (listed.code !== 0) return undefined
    let client: { activity: number; pid: number; tty: string } | undefined
    for (const line of listed.stdout.split('\n')) {
      const row = TMUX_CLIENT_PLACE.exec(line)
      // tmux gives the activity in whole seconds: on a tie the one listed later, which attached later, wins (personsClient).
      if (row && (!client || Number(row[1]) >= client.activity)) client = { activity: Number(row[1]), pid: Number(row[2]), tty: row[3] }
    }
    if (!client) return {}
    const apps = await scannedApps([client.pid], { platform: deps.platform, roots: deps.roots, processes: async () => rows, bundleId: deps.bundleId })
    const app = apps.get(client.pid)
    if (!app) return {}
    // A tty out of form names no tab: a control client has none, and Linux's are no tab the dial selects.
    return TAB_TTY.test(client.tty) ? { app, tty: client.tty } : { app }
  }

  async function lookUp(id: string, pid: number): Promise<ClientPlace> {
    const place = await placeOf(id, pid).catch(() => undefined)
    deps.log(`[device] tmux client · ${!place ? 'not read' : place.app ? 'found' : 'none'}`)
    return place ?? {}
  }

  return (hints, pid) => {
    const id = hints.TMUX_PANE
    if (!id || !TMUX_PANE_ID.test(id) || !PID.test(String(pid))) return undefined
    const now = deps.now()
    // Only panes asked in the last 5 s, or still in flight, are kept.
    for (const [key, ask] of asked) if (ask.settled && now - ask.at >= OUTER_EVERY_MS) asked.delete(key)
    const key = `${id}:${pid}`
    const last = asked.get(key)
    if (last) return last.answer
    const ask = { at: now, answer: lookUp(id, pid), settled: false }
    void ask.answer.then(() => { ask.settled = true })
    asked.set(key, ask)
    return ask.answer
  }
}
