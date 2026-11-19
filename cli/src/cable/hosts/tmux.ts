/**
 * A pane in the person's own tmux (docs/specs/2026-11-15-device-wave1-checks.md, F1 "The tap"): a tap switches one of
 * their clients to the pane a hook named, then the app around tmux comes forward as every app does. A pane whose app is
 * known (the one holding the client that shows its session) is instead made its own session's active window and pane, at
 * a tap and at a rest while that app is in front (docs/plans/2026-11-19-dial-tmux-terminal-design.md): every client on
 * that session shows it, and none is moved to another session. Those are the two things done there, each only once the
 * pane's process is checked to be the agent's or one of its parents, and never on a session Harness made: nothing is
 * typed, made or closed (Q1). Beside them, a lookup reads which client shows a pane's session, to place the agent on the
 * page of the app that holds it (createTmuxOuter). tmux is the daemon's, with no `-L` or `-S`: the master's PATH may hold
 * none, so the devices find it as the core does (tmuxFinder), the same binary and so the same server. Each value came
 * from a hook or from tmux, so it is checked against its form, and tmux runs with no shell.
 */
import { HARNESS_OWNER_OPTION, isHarnessSession, paneOwnerFormat } from '../../lib/harnessSessionLabel.js'
import { ensureTmuxOnPath, type TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { APP_IDS } from './hostDetect.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import { parentChain, scannedApps, type ProcessName } from './scannedApp.js'
import { TAB_TTY } from './tabs.js'

const TMUX_PANE_ID = /^%[0-9]{1,9}$/
const PID = /^[1-9][0-9]{0,9}$/
/** This adapter's pane: tmux's pane id and the agent's process, `%3:100`, as the hook's event named them, and the app
 *  holding the client that shows its session when one was found, `%3:100:terminal-app`. */
const PANE_AND_PID = /^(%[0-9]{1,9}):([1-9][0-9]{0,9})(?::([a-z-]{1,32}))?$/
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
const OUTER_EVERY_MS = 5_000

export interface TmuxDeps {
  run: OrcaDeps['run']
  /** Where tmux is, as the core finds it (tmuxFinder). */
  tmux(): Promise<TmuxPathOutcome>
  /** The machine's processes, as the open scan reads them; it rejects when the table cannot be read. */
  processes(): Promise<readonly ProcessName[]>
  log(line: string): void
  /** The app in front (cableHost.latestFront()): a rest shows a pane only in the app the person is looking at. */
  front(): string | undefined
}

/** tmux as the core finds it (lib/tmuxOnPath.ts), asked once in this process and shared by the adapter and the lookup.
 *  On a copy of the environment: this process's own PATH stays the master's. */
export function tmuxFinder(find = (): Promise<TmuxPathOutcome> => ensureTmuxOnPath({ ...process.env })): () => Promise<TmuxPathOutcome> {
  let found: Promise<TmuxPathOutcome> | undefined
  return () => (found ??= find())
}

/** One run of tmux where it was found; nothing when no tmux was. */
async function runTmux(deps: Pick<TmuxDeps, 'run' | 'tmux'>, args: string[]): Promise<{ code: number | null; stdout: string } | undefined> {
  const found = await deps.tmux()
  if (found.state === 'absent') return undefined
  return deps.run(found.state === 'adopted' ? found.path : 'tmux', args, RUN_TIMEOUT_MS)
}

/** What tmux says of a pane: its process, and whether it is the person's by the rule the hook and the client filter
 *  hold (no daemon's tag, not in a session Harness named). `tmux` when no tmux was found, `pane` when tmux did not
 *  answer in form. */
async function paneFacts(deps: Pick<TmuxDeps, 'run' | 'tmux'>, id: string): Promise<{ pid: number; persons: boolean } | 'tmux' | 'pane'> {
  const said = await runTmux(deps, ['display-message', '-p', '-t', id, TMUX_PANE_FACTS])
  if (!said) return 'tmux'
  const facts = TMUX_PANE_FACT.exec(said.stdout.trim())
  if (said.code !== 0 || !facts) return 'pane'
  const [, pid, session, owner] = facts
  return { pid: Number(pid), persons: !owner && !isHarnessSession(session) }
}

/** Whether the pane's process is [pid] or one of its parents, as the open scan walks them: a second tmux server of the
 *  person's (`-L`) can have a pane of the same id, and a process the table does not hold is in no pane. */
function holdsPane(rows: readonly ProcessName[], pid: number, panePid: number): boolean {
  return parentChain(pid, new Map(rows.map((p) => [p.pid, p]))).some((p) => p.pid === panePid)
}

/** The parts of this adapter's pane id; nothing when it is out of form, its app field one no listed app's. */
function paneParts(pane: Pane): { id: string; pid: number; app?: string } | undefined {
  const parts = PANE_AND_PID.exec(pane.id)
  if (!parts) return undefined
  const [, id, pid, app] = parts
  return app === undefined || APP_IDS.includes(app) ? { id, pid: Number(pid), app } : undefined
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
    const listed = await runTmux(deps, ['list-clients', '-F', TMUX_CLIENTS])
    if (listed?.code !== 0) return undefined
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

  /** Whether the pane may be shown: only once tmux names the pane's process and it is the agent's or one of its parents,
   *  as a second tmux server of the person's (`-L`) can have a pane of the same id. And only while the pane is still the
   *  person's: the hook checked that at its last event, and a pane can move into a session Harness made since (Q1). */
  async function checkedPane(id: string, agentPid: number): Promise<boolean | 'refused'> {
    const facts = await paneFacts(deps, id)
    if (typeof facts === 'string') return false
    if (!facts.persons) return notItsPane()
    const rows = await deps.processes().catch(() => undefined)
    if (!rows) return false
    return holdsPane(rows, agentPid, facts.pid) || notItsPane()
  }

  /** The pane's window, then the pane, made active on the pane's own session, in one run of tmux. */
  async function select(id: string): Promise<boolean> {
    return (await runTmux(deps, ['select-window', '-t', id, ';', 'select-pane', '-t', id]))?.code === 0
  }

  return {
    id: 'tmux',
    tap: 'before',
    // The pane carries the hook's caller, the agent's process: the pane's own is checked against it at the tap. And the
    // app holding its session's client, when one was found: that app's tab is where the person sees the pane.
    paneOf(place: Place): Pane | undefined {
      const id = place.hints.TMUX_PANE
      if (!id || !TMUX_PANE_ID.test(id) || !PID.test(String(place.pid))) return undefined
      const app = place.outer && APP_IDS.includes(place.outer.app) ? `:${place.outer.app}` : ''
      return { adapter: 'tmux', id: `${id}:${place.pid}${app}` }
    },
    canFocus: () => true,
    /** A pane with its app is selected on its own session: the tap raises that app's tab, whose client shows the session.
     *  Without one, the person's client used last is switched to the pane. */
    async focus(pane) {
      const parts = paneParts(pane)
      if (!parts) return false
      const checked = await checkedPane(parts.id, parts.pid)
      if (checked !== true) return checked
      if (parts.app) return select(parts.id)
      const client = await personsClient()
      return !!client && (await runTmux(deps, ['switch-client', '-c', client, '-t', parts.id]))?.code === 0
    },
    // A rest never switches a client: only the session's own pane moves, and only in the app the person looks at.
    canShow(pane) {
      const app = paneParts(pane)?.app
      return app !== undefined && app === deps.front()
    },
    async show(pane) {
      const parts = paneParts(pane)
      return parts && (await checkedPane(parts.id, parts.pid)) === true && (await select(parts.id)) ? 'ok' : 'failed'
    },
  }
}

export interface TmuxOuterDeps {
  run: TmuxDeps['run']
  tmux: TmuxDeps['tmux']
  processes: TmuxDeps['processes']
  log: TmuxDeps['log']
  now(): number
  platform: NodeJS.Platform
  roots: readonly string[]
  bundleId(bundle: string): Promise<string | undefined>
}

/** The app that holds the tmux client showing an agent's pane, and that client's tty when it names a tab. */
interface ClientPlace { app?: string; tty?: string }
/** The step of a lookup that could not be read, as its line names it: no tmux found, the pane's facts, the process
 *  table, the session's clients, the client's app. */
type NotRead = 'tmux' | 'pane' | 'processes' | 'clients' | 'app'

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
   *  listed app; the step that could not be read, when one could not. */
  async function placeOf(id: string, pid: number): Promise<ClientPlace | NotRead> {
    const facts = await paneFacts(deps, id)
    if (typeof facts === 'string') return facts
    if (!facts.persons) return {}
    // One read of the table serves the pane's proof and the client's walk.
    const rows = await deps.processes().catch(() => undefined)
    if (!rows) return 'processes'
    if (!holdsPane(rows, pid, facts.pid)) return {}
    // By the pane id, which tmux resolves to its session: a session's name could read as another target (`$0`, `@1`).
    const listed = await runTmux(deps, ['list-clients', '-t', id, '-F', TMUX_CLIENT_PLACES])
    if (listed?.code !== 0) return 'clients'
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
    // Every other step answers its own word: what is left to throw is the app scan.
    const place = await placeOf(id, pid).catch((): NotRead => 'app')
    if (typeof place === 'string') {
      deps.log(`[device] tmux client · not read · ${place}`)
      return {}
    }
    deps.log(`[device] tmux client · ${place.app ? 'found' : 'none'}`)
    return place
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
