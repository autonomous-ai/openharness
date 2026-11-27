/**
 * Where the person sees a Codex session its own server runs (observed.ts askServed). Codex 0.167+ runs a `codex` typed in
 * a terminal as a client of one daemon a Codex home (`codex app-server --listen unix:// … --managed-daemon`, codex-rs
 * rust-v0.172.0), which the first such TUI starts in a session of its own, on no terminal, and which launchd holds once
 * that TUI exits. The daemon holds the rollout and runs every hook, with its own environment, the first TUI's: neither a
 * hook's hints, nor its caller's terminal, nor the daemon's parents say where the person sees the session (Diego, CLI
 * 0.6.90, 2026-11-26: a Codex in Terminal on no page). Its TUI does, and Codex tells a hook nothing of it: the client is
 * the one Codex on a terminal working in the session's folder. With none there, the session is on no app's page. Of
 * several, none is guessed: all in one app place it at that app with no tab, as that app holds whichever is the client
 * (Ken's VM, 2026-11-27, #4663 step 10: two in VS Code's terminals on Other's page); in two apps, or with one whose
 * parents name none, it is on no app's page. Windows names no terminal (a TUI there has a console, never a tty), so
 * every Codex TUI there counts as on one, and its folder is read through harness-pty (externals/support.ts
 * processCwds; docs/plans/2026-11-27-windows-codex-rescan-design.md).
 *
 * A TUI in the person's tmux or herdr walks up to the multiplexer's server, which no app holds. A served hook's hints
 * are the first TUI's, so the path the hints take never placed it: a Codex in tmux inside an app was on no app's page
 * and never nested, and its notices rang loudly with the person there (a tester's 20/20 `alert · rule:turn`,
 * 2026-11-28). The one TUI is asked of the lookup by process the open scan asks for a session it found nested
 * (ObservedDeps.madeBy, nested). Zellij has no lookup by process (its session's name comes from the hints): its own item.
 *
 * Of a process only its parents, its terminal and its folder are compared, and its arguments are read only to tell a
 * server (externals/codex.ts codexServer) and the daemon; none is kept.
 *
 * What one lookup costs, on an M1 Pro (2026-11-26): the table with its arguments (externals/support.ts listProcesses,
 * 63 ms, lib/processTable.ts), 8 ms on the event loop to tell Codex's processes in a table of 900 (6.5 of them the
 * engines' ownership snapshot, which each open scan reads too), one `lsof -a -d cwd` for every Codex TUI (39 ms for 1 and
 * for 16), one `ps -o tty=` for each in a session's folder, once a lookup (3.5 ms for one; one for 16 took 57 ms, so
 * each is asked alone) and one walk of those found (scannedApp.ts). Windows' numbers come from the VM (design, Cost).
 * Asked only for a Codex hook from a caller not yet told, a daemon's session's start, a turn's while it has no client or
 * no tab, and a Codex session the scan finds on no terminal (observed.ts).
 */
import { agentCommandOwnershipSnapshot } from '../../lib/engineBin.js'
import { commandOf, engineProcessMatch } from '../../lib/processTable.js'
import { codexServer } from '../../lib/sessionSearch/externals/codex.js'
import { folderKey, listProcesses, processCwds } from '../../lib/sessionSearch/externals/support.js'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import type { Outer, Pane } from './adapter.js'
import type { Nested, NestedLookup, NestedPlace } from './outer.js'
import { learnApps, parentChain, type ProcessName, readTtyName, type WindowsProcess } from './scannedApp.js'
import { clientTtyForm } from './tabs.js'
import type { Nest } from './types.js'

/** The Codex TUIs whose folders a lookup reads, at most: past this many, none is told apart, as a bound unread could
 *  hold a second one in the session's folder. */
export const MAX_CLIENTS = 16

/** The TUIs' daemon by its own arguments (rust-v0.172.0): `--managed-daemon`, or an app server on a unix socket, which a
 *  TUI's `--remote` reaches as it reaches the daemon. Any other server (`codex mcp-server`, an editor's app server over
 *  stdio) runs with its own client's environment, so its hints place its hooks. */
const MANAGED_DAEMON = /(?:^|\s)--managed-daemon(?:\s|$)/
const APP_SERVER = /(?:^|\s)app-server(?:\s|$)/
const UNIX_LISTEN = /(?:^|\s)--listen(?:=|\s+)unix:\/\//

/** A hook's caller, or the process the open scan found holding a session, and the session's folder. */
export interface ServedAsk { pid: number; cwd?: string }

/** A session the TUIs' Codex daemon runs, and where the person sees it when that is known: the app holding its TUI,
 *  that TUI's tab and process. Several TUIs all in one app give that app alone, and their processes beside it: the app
 *  is certain only while every one of them runs (observed.ts tick). A TUI in tmux or herdr gives the app holding the
 *  multiplexer's client, that multiplexer and the TUI's pane in it, and the TUI beside them; `nest` and `pane` come only
 *  with a client. */
export interface Served { client?: Outer; clients?: readonly ServedClient[]; nest?: Nest; pane?: Pane }

/** A TUI that may be a session's client, with its start as the table read it (RunningProcess.generation), so a later
 *  process given its pid is never taken for it. */
export interface ServedClient { pid: number; generation?: string }

export interface CodexServedDeps {
  platform: NodeJS.Platform
  /** The machine's processes with their arguments, and on Windows their starts (externals/support.ts listProcesses);
   *  none when unreadable. */
  processes(): Promise<readonly (RunningProcess & { startMarker?: string })[]>
  /** The folder of each of these processes, as the kernel resolved it (externals/support.ts processCwds); a process whose
   *  folder cannot be read is left out. */
  cwds(pids: readonly number[]): Promise<ReadonlyMap<number, string>>
  /** One process's terminal as ps names it (`ttys005`, `pts/2`), none on none; rejects when ps failed (scannedApp.ts
   *  readTtyName). Never asked on Windows, which names none. */
  tty(pid: number): Promise<string | undefined>
  /** The app each of these processes runs in, from its parents in [rows] (scannedApp.ts learnApps). */
  apps(pids: readonly number[], rows: readonly WindowsProcess[]): Promise<ReadonlyMap<number, string>>
  /** A folder as the kernel resolves it (externals/support.ts folderKey). */
  folder(path: string): Promise<string>
  /** The multiplexer that made each of these processes' terminals, over [rows] (ObservedDeps.madeBy). Absent, as where
   *  the scan learns no app, no TUI is looked up by process. */
  madeBy?(pids: readonly number[], rows: readonly ProcessName[]): Promise<ReadonlyMap<number, Omit<Nested, 'pid' | 'rows'>>>
  /** Where the person sees a process nested in that multiplexer (ObservedDeps.nested). */
  nested?: NestedLookup
}

/**
 * For each ask: none when its caller is not the TUIs' daemon, so its hints place it: no Codex server (the nearest Codex
 * among it and its parents serves no other client), one whose arguments name no daemon, or an app's own, one no Codex
 * started whose parents name an app (the ChatGPT app's, an editor's), which runs with that app's environment. Else where the person sees the session:
 * the client is the one Codex TUI on a terminal in the session's folder, npm's node launcher and its native Codex being
 * one; several there all in one app give that app alone; the one whose parents name no app, the app holding its
 * multiplexer's client, when the lookup by process names one. Fails when the table could not be read: nothing is told
 * then.
 */
export async function codexServed(asks: readonly ServedAsk[], deps: CodexServedDeps): Promise<(Served | undefined)[]> {
  const rows = await deps.processes()
  // A table that could not be read is empty, as it always holds the process reading it: taken for an answer, every
  // caller would be no server, and the daemon's hooks placed by the first TUI's hints.
  if (!rows.length) throw new Error('process table not read')
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const ownership = agentCommandOwnershipSnapshot()
  const codex = new Set(rows.filter((row) => engineProcessMatch(row, 'codex', ownership).score > 0).map((row) => row.pid))
  // The hook's own shell, where it did not exec, is passed: its caller is the server still.
  const servers = asks.map(({ pid }) => {
    const nearest = parentChain(pid, byPid).find((row) => codex.has(row.pid))
    return nearest && codexServer(nearest) && daemonArgs(nearest.args) ? nearest : undefined
  })
  if (!servers.some((server) => server)) return asks.map(() => undefined)
  // Each keeps its start, so a Windows walk ends at a reused pid (parentChain): a daemon whose first TUI exited, its pid
  // now a later Code.exe's, is never read as VS Code's own server.
  const names = rows.map((row): WindowsProcess => ({ pid: row.pid, ppid: row.ppid, executable: commandOf(row),
    ...(row.startMarker !== undefined ? { startMarker: row.startMarker } : {}) }))
  const owned = servers.filter((server): server is RunningProcess =>
    server !== undefined && !parentChain(server.pid, byPid).slice(1).some((row) => codex.has(row.pid)))
  const ownApps = owned.length ? await deps.apps(owned.map((server) => server.pid), names) : new Map<number, string>()
  const daemon = (server: RunningProcess | undefined): boolean => server !== undefined && !ownApps.has(server.pid)
  const clients = servers.some(daemon) ? await clientsIn(asks.filter((_, i) => daemon(servers[i])), rows, codex, deps)
    : new Map<ServedAsk, Client[]>()
  const clientApps = clients.size
    ? await deps.apps([...new Set([...clients.values()].flatMap((found) => found.map(({ pid }) => pid)))], names)
    : new Map<number, string>()
  // Only a lone TUI: of several, one in a multiplexer and its app would still be a guess at which is the client.
  const lone = [...new Set([...clients.values()].flatMap((found) =>
    found.length === 1 && !clientApps.has(found[0]!.pid) ? [found[0]!.pid] : []))]
  const nestedAt = await nestedPlaces(lone, names, deps)
  const servedClient = (pid: number): ServedClient => {
    const generation = byPid.get(pid)?.generation
    return generation === undefined ? { pid } : { pid, generation }
  }
  return asks.map((ask, i) => {
    if (!daemon(servers[i])) return undefined
    const found = clients.get(ask) ?? []
    const apps = new Set(found.map(({ pid }) => clientApps.get(pid)))
    const app = apps.size === 1 ? [...apps][0] : undefined
    if (!app) {
      const tui = found.length === 1 ? found[0]!.pid : undefined
      const place = tui === undefined ? undefined : nestedAt.get(tui)
      // The multiplexer's client is the tab, and the TUI is beside it: either gone, so is the place (observed.ts tick).
      return place ? { ...place, clients: [servedClient(tui!)] } : {}
    }
    // Several TUIs in one app: that app holds whichever is the client, but which one it is stays unknown, so neither a
    // tab nor a process is given and a tap only brings the app forward (Ken's VM, 2026-11-27, #4663 step 10).
    if (found.length > 1) return { client: { app }, clients: found.map(({ pid }) => servedClient(pid)) }
    const { pid, tty: name } = found[0]!
    const tty = name === undefined ? undefined : `/dev/${name}`
    return { client: tty && clientTtyForm(deps.platform)?.test(tty) ? { app, tty, pid } : { app, pid } }
  })
}

/** Where the person sees each of these TUIs that runs in the person's tmux or herdr, as the open scan places a session
 *  it found nested: only one whose place names an app. A maker read that fails tells none. */
async function nestedPlaces(
  pids: readonly number[], rows: readonly ProcessName[], deps: CodexServedDeps,
): Promise<Map<number, Served>> {
  const placed = new Map<number, Served>()
  const nested = deps.nested
  if (!pids.length || !deps.madeBy || !nested) return placed
  const made = await deps.madeBy(pids, rows).catch(() => new Map<number, Omit<Nested, 'pid' | 'rows'>>())
  // No `fresh`: a daemon's session is asked once a start, as the scan's is.
  await Promise.all([...made].map(async ([pid, maker]) => {
    const { host } = maker
    if (host !== 'tmux' && host !== 'herdr') return
    const { app, tty, pid: at, pane }: NestedPlace = await nested({ ...maker, pid, rows }) ?? {}
    if (!app) return
    placed.set(pid, { client: { app, ...(tty !== undefined ? { tty } : {}), ...(at !== undefined ? { pid: at } : {}) },
      nest: host, ...(pane ? { pane } : {}) })
  }))
  return placed
}

function daemonArgs(args: string): boolean {
  return MANAGED_DAEMON.test(args) || (APP_SERVER.test(args) && UNIX_LISTEN.test(args))
}

/** A Codex TUI and its terminal as ps names it (none on Windows). */
type Client = { pid: number; tty?: string }

/** Each ask's Codex TUIs on a terminal in its folder, with that terminal as ps names it (none on Windows); an ask with
 *  none, or one whose terminal could not be read, is left out, and every ask when a TUI's folder could not be read. */
async function clientsIn(
  asks: readonly ServedAsk[], rows: readonly RunningProcess[], codex: ReadonlySet<number>, deps: CodexServedDeps,
): Promise<Map<ServedAsk, Client[]>> {
  const found = new Map<ServedAsk, Client[]>()
  const tuis = new Set(rows.filter((row) => codex.has(row.pid) && !codexServer(row)).map((row) => row.pid))
  const candidates = rows.filter((row) => tuis.has(row.pid) && !tuis.has(row.ppid)).map((row) => row.pid)
  if (!candidates.length || candidates.length > MAX_CLIENTS) return found
  const cwds = await deps.cwds(candidates)
  // A TUI whose folder could not be read (another user's, an elevated one on Windows) may be a second one in any
  // session's folder: no ask is told then.
  if (candidates.some((pid) => !cwds.has(pid))) return found
  // Each TUI's terminal once, whatever the asks in its folder: the scan asks for each of its sessions at once.
  const ttys = new Map<number, Promise<{ pid: number; tty: string | undefined | null }>>()
  const ttyOf = (pid: number) =>
    ttys.get(pid) ?? ttys.set(pid, deps.tty(pid).then((tty) => ({ pid, tty }), () => ({ pid, tty: null }))).get(pid)!
  for (const ask of asks) {
    if (ask.cwd === undefined) continue
    const folder = await deps.folder(ask.cwd)
    const inFolder = candidates.filter((pid) => cwds.get(pid) === folder)
    // Windows names no terminal, so nothing tells a TUI from a `codex exec` or Harness's `codex queue` there: every Codex
    // in the folder counts. The session's own TUI is among them, so all in one app is that TUI's app, and one in another
    // app, or whose parents name none, leaves the client unknown.
    if (deps.platform === 'win32') {
      if (inFolder.length) found.set(ask, inFolder.map((pid) => ({ pid })))
      continue
    }
    const terminals = await Promise.all(inFolder.map(ttyOf))
    // A terminal that could not be read may be a second client's: nothing is told then.
    if (terminals.some(({ tty }) => tty === null)) continue
    const onTerminal = terminals.filter((t): t is { pid: number; tty: string } => typeof t.tty === 'string')
    if (onTerminal.length) found.set(ask, onTerminal)
  }
  return found
}

/** The lookup over this machine (ObservedDeps.served), on every platform: Windows reads each TUI's folder through
 *  harness-pty and counts every TUI as on a terminal. [nesting] is the scan's lookup by process (devices.ts), none where
 *  the scan learns no app. */
export function servedLookup(
  platform: NodeJS.Platform, nesting: Pick<CodexServedDeps, 'madeBy' | 'nested'> = {},
): (asks: readonly ServedAsk[]) => Promise<(Served | undefined)[]> {
  const deps: CodexServedDeps = {
    platform, processes: listProcesses, cwds: processCwds, tty: readTtyName, apps: learnApps, folder: folderKey, ...nesting,
  }
  return (asks) => codexServed(asks, deps)
}
