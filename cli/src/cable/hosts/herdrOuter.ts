/**
 * Where the person sees an agent in a pane of their own herdr (docs/plans/2026-11-19-dial-herdr-in-terminal-app-design.md):
 * in the app that holds the herdr client they used last, at that client's tty. Diego's Terminal tab B ran `herdr`
 * (2026-11-19), and the pane's own hints could not say so: a pane inherits the bundle id and TERM_PROGRAM the server
 * started with, and its tty is herdr's own pty, which no tab holds. herdr's API lists no clients (protocol 19), so a
 * client is found as a herdr process connected to the server's client socket.
 *
 * Only what that needs is read: process names and parents (the table), the unix-socket rows lsof gives for herdr's own
 * processes, their ttys (ps), and a tty's access time (stat), which moves when the person types into it. Never another
 * process's environment or argv: those hold secrets. Every value read is outside text, held to its form, and lsof and ps
 * run with no shell.
 */
import { stat } from 'node:fs/promises'
import { HERDR_PANE } from './herdrClient.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { OuterLookup } from './outer.js'
import { parentChain, scannedApps, type ProcessName } from './scannedApp.js'
import { TAB_TTY } from './tabs.js'
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

export interface HerdrOuterDeps {
  run: OrcaDeps['run']
  /** The machine's processes, as the open scan reads them; it rejects when the table cannot be read. */
  processes(): Promise<readonly ProcessName[]>
  log(line: string): void
  now(): number
  platform: NodeJS.Platform
  roots: readonly string[]
  bundleId(bundle: string): Promise<string | undefined>
  /** A tty's access time (ttyAtime); nothing when it cannot be read. */
  atime(tty: string): Promise<number | undefined>
}

/** The app that holds the herdr client showing an agent's pane, and that client's tty when it names a tab. */
interface ClientPlace { app?: string; tty?: string }
/** The step of a lookup that could not be read, as its line names it: the process table, the sockets, the ttys, the
 *  clients' app. */
type NotRead = 'processes' | 'sockets' | 'ttys' | 'app'

/** A file's access time, nothing when it cannot be read. Never rejects. */
export async function ttyAtime(tty: string): Promise<number | undefined> {
  return (await stat(tty).catch(() => undefined))?.atimeMs
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

/**
 * Where the person sees an agent in a pane of their own herdr's default session: in the app holding the herdr client
 * they used last, at that client's tty. Nothing at once off macOS, when the hints name no herdr pane in form or the
 * caller is no pid; else the client's place, `{}` when none is found. Never rejects.
 */
export function createHerdrOuter(deps: HerdrOuterDeps): OuterLookup {
  // By pane and caller, as tmux's: a lookup in flight is shared past its 5 s, so an lsof that hangs to its timeout runs
  // no second one.
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
      return TAB_TTY.test(tty) ? deps.atime(tty).catch(() => undefined) : undefined
    }))
    let last = 0
    // The pids ascend: on a tie the later one, the higher pid, wins.
    for (let at = 1; at < pids.length; at++) if ((times[at] ?? -Infinity) >= (times[last] ?? -Infinity)) last = at
    return pids[last]
  }

  /** `{}` when no herdr server is among the caller's parents, or none of its clients (or itself, run with
   *  `--no-session`) is on a tty in a listed app; the step that could not be read, when one could not. */
  async function placeOf(pid: number): Promise<ClientPlace | NotRead> {
    // One read of the table serves the server's, the clients' and their apps' walks.
    const rows = await deps.processes().catch(() => undefined)
    if (!rows) return 'processes'
    const server = parentChain(pid, new Map(rows.map((p) => [p.pid, p]))).find(isHerdr)?.pid
    if (server === undefined) return {}
    const others = rows.filter((p) => p.pid !== server && isHerdr(p)).map((p) => p.pid)
      .sort((a, b) => a - b).slice(-HERDR_CLIENTS_A_LOOKUP)
    // herdr's `--no-session` runs the panes under the client itself, on its tab's tty, with no client socket: with no
    // other herdr, or none connected, the server is the one candidate.
    let candidates = [server]
    if (others.length) {
      const sockets = await output(deps.run, '/usr/sbin/lsof', ['-a', '-U', '-p', [server, ...others].join(','), '-F', 'pdn'])
      if (sockets === undefined) return 'sockets'
      const connected = connectedOf(sockets, server, new Set(others))
      if (connected.size) candidates = others.filter((other) => connected.has(other))
    }
    const ttys = await output(deps.run, '/bin/ps', ['-o', 'pid=,tty=', '-p', candidates.join(',')])
    if (ttys === undefined) return 'ttys'
    const ttyOf = new Map<number, string>()
    for (const line of ttys.split('\n')) {
      const row = PID_TTY.exec(line)
      if (row && candidates.includes(Number(row[1]))) ttyOf.set(Number(row[1]), `/dev/${row[2]}`)
    }
    // A candidate ps does not list has gone. The server counts only on a tab's tty: a detached one has none.
    const left = candidates.filter((p) => ttyOf.has(p) && (p !== server || TAB_TTY.test(ttyOf.get(p) ?? '')))
    if (!left.length) return {}
    // A client inside tmux or Herdr's terminal has parents that end at a detached server or holder: no app, dropped.
    const apps = await scannedApps(left, { platform: deps.platform, roots: deps.roots, processes: async () => rows, bundleId: deps.bundleId })
    const shown = left.filter((p) => apps.has(p))
    if (!shown.length) return {}
    const client = await usedLast(shown, ttyOf)
    const app = apps.get(client)
    const tty = ttyOf.get(client)
    // A tty out of form names no tab.
    return tty && TAB_TTY.test(tty) ? { app, tty } : { app }
  }

  async function lookUp(pid: number): Promise<ClientPlace> {
    // Every other step answers its own word: what is left to throw is the app scan.
    const place = await placeOf(pid).catch((): NotRead => 'app')
    if (typeof place === 'string') {
      deps.log(`[device] herdr client · not read · ${place}`)
      return {}
    }
    deps.log(`[device] herdr client · ${place.app ? 'found' : 'none'}`)
    return place
  }

  return (hints, pid) => {
    const id = hints.HERDR_PANE_ID
    if (deps.platform !== 'darwin' || !id) return undefined
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
    const ask = { at: now, answer: lookUp(pid), settled: false }
    void ask.answer.then(() => { ask.settled = true })
    asked.set(key, ask)
    return ask.answer
  }
}
