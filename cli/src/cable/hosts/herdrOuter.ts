/**
 * Where the person sees an agent in a pane of their own herdr (docs/plans/2026-11-19-dial-herdr-in-terminal-app-design.md):
 * in the app that holds the herdr client they used last, at that client's tty. Diego's Terminal tab B ran `herdr`
 * (2026-11-19), and the pane's own hints could not say so: a pane inherits the bundle id and TERM_PROGRAM the server
 * started with, and its tty is herdr's own pty, which no tab holds. herdr's API lists no clients (protocol 19), so a
 * client is found as a herdr process connected to the server's client socket.
 *
 * Only what that needs is read: process names and parents (the table), the terminals of the caller and its parents up to
 * the server, the unix-socket rows lsof gives for herdr's own processes (macOS) or Linux's socket table (ss) with the
 * socket links among herdr's own processes' descriptors, their ttys (ps), and a tty's access time (stat), which moves
 * when the person types into it. Never another process's environment or argv: those hold secrets. Every value read is
 * outside text, held to its form, and lsof, ss and ps run with no shell.
 */
import { opendir, readlink, stat } from 'node:fs/promises'
import { HERDR_PANE } from './herdrClient.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { OuterLookup } from './outer.js'
import { readPtyMaker, scannedApps, type ProcessName } from './scannedApp.js'
import { clientTtyForm } from './tabs.js'
import { OUTER_EVERY_MS, PID } from './tmux.js'

/** The herdr processes besides the server a lookup asks of at most: the highest pids, the newest. */
export const HERDR_CLIENTS_A_LOOKUP = 16
/** The out-of-form pane ids said skipped, each said once: past this many the oldest goes. */
export const SKIPPED_IDS_KEPT = 64
/** The socket herdr's clients connect to; `herdr.sock` is its API's, which a `herdr agent …` command uses. */
const CLIENT_SOCKET = '/herdr-client.sock'
/** A unix socket's kernel address, as lsof prints a descriptor's own (`d`) and its peer's (`n->`). */
const SOCKET_ADDRESS = /^0x[0-9a-f]{1,16}$/
/** One `ps -o pid=,tty=` row. */
const PID_TTY = /^\s*([1-9][0-9]{0,9})\s+(\S+)\s*$/
/** The descriptors of one process read at most: a herdr server holds a few for each pane and client. */
export const FDS_A_PROCESS = 1024
/** A descriptor's link to a socket, with the socket's inode. */
const SOCKET_LINK = /^socket:\[([0-9]{1,20})\]$/
/** One `ss -xn` row of a connected unix stream socket: its local address (a bound path, which may hold spaces, or `*`)
 *  and inode, its peer's address (ss names no peer's path: `*`) and inode, then an empty Process column. */
const SS_ROW = /^u_str\s+ESTAB\s+[0-9]+\s+[0-9]+\s+(\S.*?)\s+([0-9]{1,20})\s+\*\s+([0-9]{1,20})\s*$/

export interface HerdrOuterDeps {
  run: OrcaDeps['run']
  /** The machine's processes, as the open scan reads them; it rejects when the table cannot be read. */
  processes(): Promise<readonly ProcessName[]>
  /** The terminal one process runs on (scannedApp.ts readTtyName); it rejects when it could not be read. */
  tty(pid: number): Promise<string | undefined>
  log(line: string): void
  now(): number
  platform: NodeJS.Platform
  roots: readonly string[]
  bundleId(bundle: string): Promise<string | undefined>
  /** A tty's access time (ttyAtime); nothing when it cannot be read. */
  atime(tty: string): Promise<number | undefined>
  /** Where Linux's `ss` is. */
  onPath: OrcaDeps['onPath']
  /** The socket inodes among a process's descriptors (procSockets); nothing when they cannot be read. */
  sockets(pid: number): Promise<readonly string[] | undefined>
  /** The person's tmux's and Zellij's lookups, asked of a client in no app's window: one inside their pane. */
  inner: OuterLookup
}

/** The app that holds the herdr client showing an agent's pane, that client's tty when it names a tab, and its process,
 *  which kitty's tabs find the client's window by and Linux's raise brings; or, with no app, the process
 *  to raise alone. */
interface ClientPlace { app?: string; tty?: string; pid?: number }
/** The step of a lookup that could not be read, as its line names it: the process table, the sockets, the ttys, the
 *  clients' app. */
type NotRead = 'processes' | 'sockets' | 'ttys' | 'app'

/** A file's access time, nothing when it cannot be read. Never rejects. */
export async function ttyAtime(tty: string): Promise<number | undefined> {
  return (await stat(tty).catch(() => undefined))?.atimeMs
}

/** The socket inodes among a process's descriptors (/proc/<pid>/fd links that read socket:[<inode>]), each once, at
 *  most FDS_A_PROCESS read; none when the folder cannot be read (the process gone, or another account's). [proc] is
 *  /proc, or a test's folder standing in for it. Never rejects. */
export async function procSockets(pid: number, proc = '/proc'): Promise<readonly string[] | undefined> {
  const folder = `${proc}/${pid}/fd`
  const fds: string[] = []
  try {
    for await (const fd of await opendir(folder)) {
      fds.push(fd.name)
      if (fds.length === FDS_A_PROCESS) break
    }
  } catch {
    return undefined
  }
  // A descriptor closed since the folder was read has no link: passed over.
  const links = await Promise.all(fds.map((fd) => readlink(`${folder}/${fd}`).catch(() => '')))
  return [...new Set(links.flatMap((link) => SOCKET_LINK.exec(link)?.[1] ?? []))]
}

/** The process is herdr itself, by its executable's name exactly: `herdr-dev` or a `herdr.app` is not. */
const isHerdr = (p: ProcessName): boolean => p.executable.split('/').pop() === 'herdr'

/** A run's stdout whatever its exit code: lsof and ps exit 1 when a pid in their list has gone, with the rest of their
 *  output intact. Nothing when it printed nothing, timed out or did not start. */
async function output(run: HerdrOuterDeps['run'], file: string, args: string[]): Promise<string | undefined> {
  const said = await run(file, args, RUN_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' }))
  return said.code === null || !said.stdout.trim() ? undefined : said.stdout
}

/** Which of [asked] are connected to the server's client socket: one of their descriptors' peers is the address of a
 *  descriptor of the server's named …/herdr-client.sock. lsof -F pdn prints a `p` line a process, an `f` line a
 *  descriptor, then its `d` and its `n`; any other line is passed over. A connection the other way round (the server's
 *  peer one of theirs) or to another server's socket makes no client. */
function connectedOf(stdout: string, server: number, asked: ReadonlySet<number>): Set<number> {
  const serving = new Set<string>()
  const peers: Array<[pid: number, address: string]> = []
  let pid: number | undefined
  let address: string | undefined
  for (const line of stdout.split('\n')) {
    const value = line.slice(1)
    if (line[0] === 'p') {
      pid = PID.test(value) ? Number(value) : undefined
      address = undefined
    } else if (line[0] === 'f') {
      address = undefined
    } else if (line[0] === 'd') {
      address = SOCKET_ADDRESS.test(value) ? value : undefined
    } else if (line[0] === 'n' && pid !== undefined) {
      if (pid === server) {
        if (address && value.endsWith(CLIENT_SOCKET)) serving.add(address)
      } else if (asked.has(pid) && value.startsWith('->') && SOCKET_ADDRESS.test(value.slice(2))) {
        peers.push([pid, value.slice(2)])
      }
    }
  }
  return new Set(peers.filter(([, peer]) => serving.has(peer)).map(([client]) => client))
}

/** The peers' inodes of the connections the server accepted on its client socket: the `ss -xn` rows whose local path
 *  ends in …/herdr-client.sock and whose local inode is one of the server's ([served]). A client's own socket is
 *  unnamed, and a named session's server accepts on a socket of its own. A row out of form is passed over. */
function acceptedPeers(stdout: string, served: ReadonlySet<string>): Set<string> {
  const peers = new Set<string>()
  for (const line of stdout.split('\n')) {
    const row = SS_ROW.exec(line)
    if (row && row[1].endsWith(CLIENT_SOCKET) && served.has(row[2])) peers.add(row[3])
  }
  return peers
}

/**
 * Where the person sees an agent in a pane of their own herdr: in the app holding the herdr client they used last, at
 * that client's tty, or the app holding the client of the person's tmux or Zellij that client runs in. Nothing at once
 * on Windows, when the hints name no herdr pane in form or the caller is no pid; else the client's place, its process
 * alone when no app holds it, `{}` when no client is found. Never rejects.
 */
export function createHerdrOuter(deps: HerdrOuterDeps): OuterLookup {
  // Windows has no `ps` to read a client's tty with, and no form for one.
  const form = clientTtyForm(deps.platform)
  if (!form) return () => undefined
  const isClientTty = (tty: string): boolean => form.test(tty)
  // By pane and caller, as tmux's: a lookup in flight is shared past its 5 s, so an lsof or ss that hangs to its timeout
  // runs no second one.
  const asked = new Map<string, { at: number; answer: Promise<ClientPlace>; settled: boolean }>()
  const skipped = new Set<string>()

  /** A herdr pane id the lookup cannot take is said, once an id: a lookup that answers nothing otherwise leaves the
   *  agent off its app's page with no line to say why. The line names no id: it is outside text. */
  function skip(id: string): void {
    if (skipped.has(id)) return
    if (skipped.size === SKIPPED_IDS_KEPT) skipped.delete(skipped.values().next().value!)
    skipped.add(id)
    deps.log('[device] herdr client · skipped · pane-id')
  }

  /** Of the candidates (ascending pids), the one whose tty was typed into last: a tty's access time moves when the person
   *  types into it, as `w`'s idle time does (macOS, 2026-11-19). One whose time cannot be read (a tty out of form, a stat
   *  that failed) ranks below every one whose time was read; among equals the higher pid (PM, 2026-11-19). */
  async function usedLast(pids: readonly number[], ttyOf: ReadonlyMap<number, string>): Promise<number> {
    if (pids.length === 1) return pids[0]
    const times = await Promise.all(pids.map((pid) => {
      const tty = ttyOf.get(pid) ?? ''
      return isClientTty(tty) ? deps.atime(tty).catch(() => undefined) : undefined
    }))
    let last = 0
    // The pids ascend: on a tie the later one, the higher pid, wins.
    for (let at = 1; at < pids.length; at++) if ((times[at] ?? -Infinity) >= (times[last] ?? -Infinity)) last = at
    return pids[last]
  }

  /** macOS: which of [others] are connected to the server's client socket, from lsof's unix-socket rows of herdr's own
   *  processes. Nothing when lsof could not be read. */
  async function lsofClients(server: number, others: readonly number[]): Promise<Set<number> | undefined> {
    const sockets = await output(deps.run, '/usr/sbin/lsof', ['-a', '-U', '-p', [server, ...others].join(','), '-F', 'pdn'])
    return sockets === undefined ? undefined : connectedOf(sockets, server, new Set(others))
  }

  /** Linux: which of [others] hold the peer of a connection the server accepted on its client socket, from `ss -xn` and
   *  the socket inodes of herdr's own processes' descriptors: `ss -p` would read every process of the account. A process
   *  whose descriptors cannot be read is left out. Nothing when ss or the server's descriptors could not be read. */
  async function ssClients(server: number, others: readonly number[]): Promise<Set<number> | undefined> {
    const ss = deps.onPath('ss')
    if (!ss) return undefined
    const [rows, served, held] = await Promise.all([
      output(deps.run, ss, ['-xn']), deps.sockets(server), Promise.all(others.map((pid) => deps.sockets(pid))),
    ])
    if (rows === undefined || served === undefined) return undefined
    const peers = acceptedPeers(rows, new Set(served))
    return new Set(others.filter((_, at) => held[at]?.some((inode) => peers.has(inode))))
  }

  /** `{}` when no herdr server made the caller's terminal or none of its clients (or itself, run with `--no-session`) is
   *  on a tty; the client's process alone when none is in a listed app or a multiplexer's pane that is; the step that
   *  could not be read, when one could not. */
  async function placeOf(hints: Readonly<Record<string, string>>, pid: number): Promise<ClientPlace | NotRead> {
    // One read of the table serves the server's, the clients' and their apps' walks.
    const rows = await deps.processes().catch(() => undefined)
    if (!rows) return 'processes'
    // The server is the herdr that made the caller's terminal, not the nearest among its parents: a terminal started
    // from a herdr pane has that server among its parents too, and keeps the pane's variables, yet its agents are in no
    // herdr client. The table holds no terminal: the caller's and its parents' are read.
    const maker = await readPtyMaker(pid, rows, deps.tty).catch(() => null)
    if (maker === null) return 'processes'
    if (maker?.host !== 'herdr') return {}
    const server = maker.pid
    const others = rows.filter((p) => p.pid !== server && isHerdr(p)).map((p) => p.pid)
      .sort((a, b) => a - b).slice(-HERDR_CLIENTS_A_LOOKUP)
    // herdr before 0.9.0 ran the panes under the client itself with `--no-session`, on its tab's tty, with no client
    // socket: with no other herdr, or none connected, the server is the one candidate.
    let candidates = [server]
    if (others.length) {
      const connected = await (deps.platform === 'linux' ? ssClients : lsofClients)(server, others)
      if (connected === undefined) return 'sockets'
      if (connected.size) candidates = others.filter((other) => connected.has(other))
    }
    const ttys = await output(deps.run, '/bin/ps', ['-o', 'pid=,tty=', '-p', candidates.join(',')])
    if (ttys === undefined) return 'ttys'
    const ttyOf = new Map<number, string>()
    for (const line of ttys.split('\n')) {
      const row = PID_TTY.exec(line)
      if (row && candidates.includes(Number(row[1]))) ttyOf.set(Number(row[1]), `/dev/${row[2]}`)
    }
    // A candidate ps does not list has gone. The server counts only on a client's tty: a detached one has none.
    const left = candidates.filter((p) => ttyOf.has(p) && (p !== server || isClientTty(ttyOf.get(p) ?? '')))
    if (!left.length) return {}
    // A client inside tmux, Zellij or Herdr's terminal has parents that end at a detached server or holder: no app.
    const apps = await scannedApps(left, { platform: deps.platform, roots: deps.roots, processes: async () => rows, bundleId: deps.bundleId })
    const shown = left.filter((p) => apps.has(p))
    if (!shown.length) {
      const client = await usedLast(left, ttyOf)
      // The agent's hints are what herdr's server inherited as it started: a server started in the person's tmux or
      // Zellij pane is placed by that multiplexer's client. A client attached later from another pane is not: its
      // environment is not read.
      const inner = await deps.inner(hints, client)
      // In no multiplexer, or one in no listed app (a terminal with no page): the client's process alone, so Linux's
      // raise brings its window.
      return inner?.app ? inner : { pid: client }
    }
    const client = await usedLast(shown, ttyOf)
    const app = apps.get(client)
    const tty = ttyOf.get(client)
    // A tty out of form names no tab.
    return tty && isClientTty(tty) ? { app, tty, pid: client } : { app, pid: client }
  }

  async function lookUp(hints: Readonly<Record<string, string>>, pid: number): Promise<ClientPlace> {
    // Every other step answers its own word: what is left to throw is the app scan.
    const place = await placeOf(hints, pid).catch((): NotRead => 'app')
    if (typeof place === 'string') {
      deps.log(`[device] herdr client · not read · ${place}`)
      return {}
    }
    deps.log(`[device] herdr client · ${place.app ? 'found' : 'none'}`)
    return place
  }

  return (hints, pid) => {
    const id = hints.HERDR_PANE_ID
    if (!id) return undefined
    if (!HERDR_PANE.test(id)) {
      skip(id)
      return undefined
    }
    if (!PID.test(String(pid))) return undefined
    const now = deps.now()
    // Only panes asked in the last 5 s, or still in flight, are kept.
    for (const [key, ask] of asked) if (ask.settled && now - ask.at >= OUTER_EVERY_MS) asked.delete(key)
    const key = `${id}:${pid}`
    const last = asked.get(key)
    if (last) return last.answer
    const ask = { at: now, answer: lookUp(hints, pid), settled: false }
    void ask.answer.then(() => { ask.settled = true })
    asked.set(key, ask)
    return ask.answer
  }
}
