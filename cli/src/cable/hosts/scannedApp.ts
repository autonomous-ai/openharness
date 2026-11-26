// Which app a session the open scan found runs in, from its parent processes' executables alone
// (docs/specs/2026-11-14-dial-app-filter.md, "The scan learns the app where that is cheap"), and which host made the
// pseudo-terminal a hook's caller runs on (ptyMaker; windowsPtyMaker on Windows, which names no terminal). Nothing else
// of a process is read but the terminal it runs on: its environment holds secrets, and its name is outside text (a
// process can write a prompt there), so a name is matched against the tables and dropped, never kept, logged or sent.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, win32 } from 'node:path'
import { patientExec } from '../../lib/patientExec.js'
import { processRows } from '../../lib/processTable.js'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { windowsStartTime } from '../../lib/windows/treeKill.js'
import { frontAppId } from './frontApp.js'
import { APP_IDS, UNKNOWN_APP } from './hostDetect.js'

/** All the walk reads of a process: no command line to hand on. */
export type ProcessName = Pick<RunningProcess, 'pid' | 'ppid' | 'executable'>
/** A process and the terminal it runs on (readTtyName); none on none. */
export type PtyProcess = ProcessName & { tty?: string }

export const WALK_PARENTS = 16
export const BUNDLES_A_PASS = 16
export const BUNDLE_ID_TIMEOUT_MS = 1_000
/** plutil prints the id alone, at most 128 characters: more is no bundle id. */
const BUNDLE_ID_MAX_BYTES = 1024
// The daemon's own table read has the same bounds; this one took 42 ms for 862 processes on an M1 Pro, and 1 MiB holds
// that many rows at the longest name macOS prints (MAXPATHLEN).
export const PS_TIMEOUT_MS = 3_000
export const PS_MAX_BYTES = 1024 * 1024
// One process's terminal: 2.4 ms on macOS, and a name of a few characters.
const TTY_TIMEOUT_MS = 1_000
const TTY_MAX_BYTES = 256
const MAX_PATH = 1024
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,128}$/
const CONTROL = /[\u0000-\u001f\u007f]/

/** The folders macOS asks no permission to read: a bundle in Desktop, Documents, Downloads, another volume or an app's
 *  container could ask, so it is not read. */
export function appRoots(home: string): string[] {
  return ['/Applications/', '/System/Applications/', `${home}/Applications/`, `${home}/Library/Application Support/`]
}

/** The outermost `.app` folder of an executable's path, when the path is a plain one under one of `roots`. */
export function bundleOf(executable: string, roots: readonly string[]): string | undefined {
  if (!executable.startsWith('/') || executable.length > MAX_PATH || CONTROL.test(executable)) return undefined
  const parts = executable.split('/')
  if (parts.some((part) => part === '.' || part === '..')) return undefined
  const at = parts.findIndex((part) => part.endsWith('.app'))
  if (at < 0) return undefined
  const bundle = parts.slice(0, at + 1).join('/')
  return roots.some((root) => bundle.startsWith(root)) ? bundle : undefined
}

/** A command's whole output; null when it failed, ran past `timeout` or printed past `maxBuffer`. */
export type Exec = (command: string, args: readonly string[], options: { timeout: number; maxBuffer: number }) => Promise<string | null>

// A held event loop must not turn the timeout into an empty table, or a bundle with no id (patientExec.ts).
const patient = patientExec(execFile)
export const execText: Exec = (command, args, options) => new Promise((resolve) => {
  patient(command, args, options, (error, stdout) => resolve(error ? null : stdout))
})

/** A bundle's id from its Info.plist, XML or binary; none for anything that is not one. */
export async function readBundleId(bundle: string, exec: Exec = execText): Promise<string | undefined> {
  const out = await exec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${bundle}/Contents/Info.plist`],
    { timeout: BUNDLE_ID_TIMEOUT_MS, maxBuffer: BUNDLE_ID_MAX_BYTES }).catch(() => null)
  const id = out?.trim()
  return id && BUNDLE_ID.test(id) ? id : undefined
}

/** `ps -axo pid=,ppid=,comm=` rows; a line that is no row is passed over. */
export function parseProcessNames(stdout: string): ProcessName[] {
  const rows: ProcessName[] = []
  for (const line of stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line)
    if (row) rows.push({ pid: Number(row[1]), ppid: Number(row[2]), executable: row[3] })
  }
  return rows
}

/** Each process's pid, parent and name, `comm` last: before another column macOS cuts it to 16 characters (`-ww` does
 *  not help), which leaves no `.app` in an app's path. On Linux it is the task's name either way. No tty: that column
 *  made every read three times as slow on macOS (27 ms to 82 ms, 638 processes); readTtyName reads one process's. */
export async function readProcessNames(exec: Exec = execText): Promise<ProcessName[]> {
  const rows = parseProcessNames(await exec('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES }) ?? '')
  // `ps` lists itself at the least: no row is a read that failed. The error names nothing it printed: a name is outside text.
  if (!rows.length) throw new Error('process table not read')
  return rows
}

/** The terminal one process runs on, as ps names it (`ttys004`, `pts/2`); none on none (`??` on macOS, `?` on Linux).
 *  One pid a run: on macOS a `ps -p` of two or more took 53 ms, of one 2.4 ms. It rejects when ps failed, as it does
 *  for a process gone, saying nothing of the process. */
export async function readTtyName(pid: number, exec: Exec = execText): Promise<string | undefined> {
  const out = await exec('ps', ['-o', 'tty=', '-p', String(pid)], { timeout: TTY_TIMEOUT_MS, maxBuffer: TTY_MAX_BYTES })
  if (out === null) throw new Error('tty not read')
  const tty = out.trim()
  return /^\?*$/.test(tty) ? undefined : tty
}

export interface ScannedAppDeps {
  platform: NodeJS.Platform
  roots: readonly string[]
  /** On Windows with each process's start, which ends a walk at a reused pid (parentChain). */
  processes(): Promise<readonly WindowsProcess[]>
  bundleId(bundle: string): Promise<string | undefined>
  /** The home whose iTerm2 folders hold iTerm2's server; homedir() when absent. */
  home?: string
}

const ITERM_SERVER = /^iTermServer-[0-9][0-9A-Za-z.-]{0,31}$/

/** Whether a process is iTerm2's server, by its path or its name alone. iTerm2 copies the server out of its bundle to
 *  `iTermServer-<version>` in one of these folders and forks every shell from it; the copy outlives iTerm2 when it
 *  relaunches with its sessions kept, under launchd then (iTerm2's iTermServerDeleter.swift). So a tab may have no
 *  `.app` among its parents. Unmeasured: the form comes from iTerm2's source. */
function isItermServer(executable: string, home: string): boolean {
  const at = executable.lastIndexOf('/')
  const folder = executable.slice(0, at + 1)
  return ITERM_SERVER.test(executable.slice(at + 1))
    && (folder === '' || folder === `${home}/Library/Application Support/iTerm2/` || folder === `${home}/.iterm2/`)
}

/** A step of a macOS walk: a bundle whose id names its app, or the app a fixed row names. */
type Step = { bundle: string } | { app: string }

/** A listed app, never the unknown one: the scan does not answer "Other", it leaves the session to its first hook. */
const listed = (app: string): boolean => app !== UNKNOWN_APP && APP_IDS.includes(app)

/** Whether the scan learns a session's app, and its tmux, herdr or Zellij pane, from `ps`, its parents' names and their
 *  terminals. Not on Windows, which has no `ps` and names no terminal: there the walk reads the PTY host's table for the
 *  app alone (windowsPtyMaker), and an agent in a multiplexer waits for its first hook. */
export const scanLearnsApps = (platform: NodeJS.Platform): boolean => platform === 'darwin' || platform === 'linux'

/** Each pid's app, from the nearest of it and its parents that names one; on Windows from its pseudo-console's maker
 *  alone (windowsPtyMaker), since a parent past it is not the app the agent's terminal is in. A pid nothing named is
 *  left out. */
export async function scannedApps(pids: readonly number[], deps: ScannedAppDeps): Promise<Map<number, string>> {
  const apps = new Map<number, string>()
  if ((!scanLearnsApps(deps.platform) && deps.platform !== 'win32') || !pids.length) return apps
  // One picture of the machine: a parent's id is never matched against a process that took it a moment later.
  const rows = await deps.processes()
  const table = new Map(rows.map((p) => [p.pid, p]))
  if (deps.platform === 'win32') {
    for (const pid of pids) {
      const maker = windowsPtyMaker(pid, rows)
      const app = maker && windowsAppOf(table.get(maker.pid)!.executable)
      if (app) apps.set(pid, app)
    }
    return apps
  }
  const walks = pids.map((pid) => [pid, parentChain(pid, table).map((p) => p.executable)] as const)
  if (deps.platform === 'linux') {
    for (const [pid, names] of walks) {
      const app = names.map(frontAppId).find(listed)
      if (app) apps.set(pid, app)
    }
    return apps
  }
  const home = deps.home ?? homedir()
  // A walk ends at its first fixed row, which answers it: a bundle past that would spend a read and a slot of the pass.
  const steps = walks.map(([pid, names]) => {
    const of: Step[] = []
    for (const name of names) {
      if (isItermServer(name, home)) {
        of.push({ app: 'iterm' })
        break
      }
      const bundle = bundleOf(name, deps.roots)
      if (bundle) of.push({ bundle })
    }
    return [pid, of] as const
  })
  // Each bundle once a pass, all together, and a bounded number of them: a bundle past that is not read.
  const read = [...new Set(steps.flatMap(([, of]) => of.flatMap((step) => ('bundle' in step ? [step.bundle] : []))))].slice(0, BUNDLES_A_PASS)
  const ids = new Map(await Promise.all(read.map(async (bundle) => [bundle, await deps.bundleId(bundle).catch(() => undefined)] as const)))
  for (const [pid, of] of steps) {
    const app = nearestApp(of, ids)
    if (app) apps.set(pid, app)
  }
  return apps
}

/** The nearest listed app of a walk's steps. A bundle with no id (not read this pass, or unreadable) ends the walk
 *  with none: it may be the session's own app, and an outer one would be a guess. One read but no table lists is
 *  passed over: a helper or an engine of its own. */
function nearestApp(steps: readonly Step[], ids: ReadonlyMap<string, string | undefined>): string | undefined {
  for (const step of steps) {
    if ('app' in step) return step.app
    const id = ids.get(step.bundle)
    if (!id) return undefined
    const app = frontAppId(id)
    if (listed(app)) return app
  }
  return undefined
}

/** A process and up to WALK_PARENTS of its parents, nearest first, from one read of the table: a pid the table does not
 *  hold starts none. A parent that started after its child ends it: Windows hands a freed pid to the next process and
 *  never reparents, so that is another process on the old pid (lib/callerPane.ts). The open scan reads their names, a
 *  tap on a tmux pane their ids (tmux.ts), ptyMaker their terminals, and the VS Code match their pids. */
export function parentChain<P extends Pick<ProcessName, 'pid' | 'ppid'> & { startMarker?: string }>(pid: number, table: ReadonlyMap<number, P>): P[] {
  const chain: P[] = []
  const passed = new Set<number>()
  let p = table.get(pid)
  while (p && !passed.has(p.pid) && chain.length <= WALK_PARENTS) {
    passed.add(p.pid)
    chain.push(p)
    // launchd and init hold every orphan: they are no session's own.
    const parent = p.ppid > 1 ? table.get(p.ppid) : undefined
    p = parent && !startedAfter(parent, p) ? parent : undefined
  }
  return chain
}

/** Whether [parent] started after [child], by their Windows start markers (`w:<FILETIME>`); false when either has none. */
function startedAfter(parent: { startMarker?: string }, child: { startMarker?: string }): boolean {
  const theirs = windowsStartTime(parent.startMarker ?? '')
  const mine = windowsStartTime(child.startMarker ?? '')
  return theirs !== null && mine !== null && theirs > mine
}

/** The hosts whose panes the dial reaches, by the name of the process that makes a pane's pseudo-terminal: a terminal's
 *  own (WezTerm's GUI, or its mux server, which Linux cuts to 15 characters) or a multiplexer's server (tmux's names
 *  itself so on Linux). macOS names each by its path. herdr's server, a child of its first client on no terminal
 *  (RECORDED_HERDR), names itself `herdr`, as its client does, which made the panes before herdr 0.9.0 (`--no-session`).
 *  Orca's terminal host, per RECORDED_ORCA: `Orca Agents` on macOS, the daemon that renames itself `orca-agents` on
 *  Linux (.deb and AppImage), and the app itself, `orca-ide`, when the daemon could not start. Orca from before its
 *  terminal host, and a Linux daemon whose rename failed (`node`), are not covered. */
const PTY_HOSTS: Readonly<Record<string, string>> = {
  'wezterm-gui': 'wezterm',
  'wezterm-mux-server': 'wezterm',
  'wezterm-mux-ser': 'wezterm',
  kitty: 'kitty',
  zellij: 'zellij',
  tmux: 'tmux',
  'tmux: server': 'tmux',
  herdr: 'herdr',
  'Orca Agents': 'orca',
  'orca-agents': 'orca',
  'orca-ide': 'orca',
}

/** The process that made a pseudo-terminal, and its host when PTY_HOSTS lists it. */
export interface PtyMaker { pid: number; host?: string }

/**
 * The process that made the pseudo-terminal a process runs on: of it and its parents (parentChain), the first on another
 * terminal or on none. Its environment cannot say: a terminal, an editor or a multiplexer started from a host's pane
 * keeps that pane's variables. None when the process runs on no terminal or the walk ends first. Its name is matched
 * and dropped, never kept.
 */
export function ptyMaker(pid: number, rows: readonly PtyProcess[]): PtyMaker | undefined {
  const [own, ...parents] = parentChain(pid, new Map(rows.map((p) => [p.pid, p])))
  if (own?.tty === undefined) return undefined
  const maker = parents.find((p) => p.tty !== own.tty)
  if (!maker) return undefined
  const host = ptyHostOf(maker.executable)
  return host ? { pid: maker.pid, host } : { pid: maker.pid }
}

/** Rex's server, which makes every block's pseudo-terminal (docs/specs/2026-11-25-dial-rex.md, the spike): `rex` in the
 *  Rex Server app the Rex app installs. By its path alone: a bare `rex` is too common a name to trust. */
const REX_SERVER = '/Rex Server.app/Contents/MacOS/rex'

/** The host PTY_HOSTS names for a process's name; none for any other. */
function ptyHostOf(executable: string): string | undefined {
  if (executable.endsWith(REX_SERVER)) return 'rex'
  const name = basename(executable)
  return Object.hasOwn(PTY_HOSTS, name) ? PTY_HOSTS[name] : undefined
}

/** ptyMaker over [rows], which hold no terminal: the caller's and its parents' are read one at a time ([tty],
 *  readTtyName), up to the first on another terminal or none, past which ptyMaker never looks. */
export async function readPtyMaker(
  pid: number, rows: readonly ProcessName[], tty: (pid: number) => Promise<string | undefined>,
): Promise<PtyMaker | undefined> {
  const read: PtyProcess[] = []
  for (const p of parentChain(pid, new Map(rows.map((r) => [r.pid, r])))) {
    const on = await tty(p.pid)
    read.push(on === undefined ? p : { ...p, tty: on })
    if (on === undefined || on !== read[0].tty) break
  }
  return ptyMaker(pid, read)
}

/** readPtyMaker's host alone. */
export async function readPtyOwner(
  pid: number, rows: readonly ProcessName[], tty: (pid: number) => Promise<string | undefined>,
): Promise<string | undefined> {
  return (await readPtyMaker(pid, rows, tty))?.host
}

/** A row of the PTY host's Windows table: its `w:<FILETIME>` start ends a walk at a reused pid (parentChain). */
export type WindowsProcess = ProcessName & { startMarker?: string }

/** The hosts whose panes the dial reaches on Windows, by the maker's image name (windowsName). Apart from PTY_HOSTS:
 *  Orca's terminal host runs under the app's own image there (Electron run as Node keeps it), while on macOS the app's
 *  `Orca` is not its terminal host, so one table for both would name a host macOS does not have. */
const WINDOWS_PTY_HOSTS: Readonly<Record<string, string>> = {
  orca: 'orca',
  herdr: 'herdr',
  'wezterm-gui': 'wezterm',
  'wezterm-mux-server': 'wezterm',
}

/** The shells between a pane's maker and its agent, and an agent's tool's: Codex runs PowerShell, Claude Code bash. */
const WINDOWS_SHELLS = new Set(['pwsh', 'powershell', 'bash', 'sh'])
/** How a script is started: an npm shim runs Codex as `cmd` → `node` → `codex.exe`, Volta's `codex.exe` as `cmd /C`. */
const WINDOWS_SCRIPT_SHELL = 'cmd'
const WINDOWS_LAUNCHER = 'node'

/** A Windows image name as the tables hold it: Windows matches names with no case, and `.exe` says nothing. */
export const windowsName = (executable: string): string => win32.basename(executable).replace(/\.exe$/i, '').toLowerCase()

/**
 * The process that made the pseudo-console a Windows process runs on, and its host when WINDOWS_PTY_HOSTS lists it
 * (herdr's maker is its server). Windows names no terminal, but the program that makes
 * a pseudo-console starts its shell as its own child (ConPTY), so the maker is the caller's nearest parent that is no
 * shell, launcher or shim of the caller's own name (a Scoop or Volta `claude.exe` starting the real one). A shim or
 * launcher starts the caller itself or through `cmd`: Node or one of the caller's name above any other shell is
 * another agent that ran the caller from its own tool (Codex run by Codex, `claude -p` from Claude Code's shell tool,
 * Claude Code from npm being Node), and the caller is on its terminal or pipes, not the pane's: then none. Any other
 * parent is the maker, with no host when WINDOWS_PTY_HOSTS does not list it; none too when the caller is not in [rows]
 * or the walk finds shells alone. Its name is matched and dropped, never kept.
 */
export function windowsPtyMaker(pid: number, rows: readonly WindowsProcess[]): PtyMaker | undefined {
  const [own, ...parents] = parentChain(pid, new Map(rows.map((p) => [p.pid, p])))
  if (!own) return undefined
  const ownName = windowsName(own.executable)
  let shelled = false
  for (const parent of parents) {
    const name = windowsName(parent.executable)
    if (name === WINDOWS_SCRIPT_SHELL || ((name === WINDOWS_LAUNCHER || name === ownName) && !shelled)) continue
    if (WINDOWS_SHELLS.has(name)) {
      shelled = true
      continue
    }
    if (name === WINDOWS_LAUNCHER || name === ownName) return undefined
    return Object.hasOwn(WINDOWS_PTY_HOSTS, name) ? { pid: parent.pid, host: WINDOWS_PTY_HOSTS[name] } : { pid: parent.pid }
  }
  return undefined
}

/** windowsPtyMaker's host alone. */
export function windowsPtyOwner(pid: number, rows: readonly WindowsProcess[]): string | undefined {
  return windowsPtyMaker(pid, rows)?.host
}

/** The listed app a Windows maker's image names (frontAppId, which takes Orca's `orca.exe` only with its `.exe`). Never
 *  the Claude app: its window's `claude.exe` is Claude Code's own image too, so such a maker is an agent that ran this
 *  one from its shell tool (Codex from Claude Code's), not the app. */
function windowsAppOf(executable: string): string | undefined {
  const app = frontAppId(`${windowsName(executable)}.exe`)
  return listed(app) && app !== 'claude' ? app : undefined
}

/** The table [list] reads, each row cut to its pid, parent, image name and start: the PTY host's rows carry the
 *  command line too, which is outside text and can carry a secret, so no lookup holds it. That reader answers an empty
 *  table for one it could not read, and a table read lists its reader at the least, so no row is a failed read; the
 *  error names nothing. */
export async function readWindowsProcesses(list: () => Promise<readonly WindowsProcess[]>): Promise<WindowsProcess[]> {
  const rows = await list()
  if (!rows.length) throw new Error('process table not read')
  return rows.map(({ pid, ppid, executable, startMarker }) =>
    (startMarker === undefined ? { pid, ppid, executable } : { pid, ppid, executable, startMarker }))
}

/** windowsPtyOwner over the table [list] reads (readWindowsProcesses). */
export async function readWindowsPtyOwner(pid: number, list: () => Promise<readonly WindowsProcess[]>): Promise<string | undefined> {
  return windowsPtyOwner(pid, await readWindowsProcesses(list))
}

/** A session a multiplexer made: its host as PTY_HOSTS names it, the maker's pid, and the session's own terminal
 *  (readTtyName's `ttys004`, `pts/2`), which is the multiplexer pane's. */
export interface MadeBy { host: string; maker: number; tty: string }

/**
 * The sessions of [pids] whose terminal one of [hosts] made, from the look's one table ([rows]). Diego's report of
 * 2026-11-22: an agent in tmux or herdr inside iTerm2, found by the scan, sat on Other's page. A session with none of
 * [hosts] among its parents reads no terminal: its maker cannot be one of them, and most sessions are plain tabs. One
 * pid at a time, so a look of many sessions never runs their `ps` reads at once. A pid whose read fails (the process
 * gone since the table) is left out; it never rejects.
 */
export async function readMadeBy(
  pids: readonly number[], rows: readonly ProcessName[], tty: (pid: number) => Promise<string | undefined>, hosts: readonly string[],
): Promise<Map<number, MadeBy>> {
  const made = new Map<number, MadeBy>()
  const table = new Map(rows.map((r) => [r.pid, r]))
  for (const pid of pids) {
    const [, ...parents] = parentChain(pid, table)
    if (!parents.some((p) => hosts.includes(ptyHostOf(p.executable) ?? ''))) continue
    let own: string | undefined
    const keepOwn = async (at: number): Promise<string | undefined> => {
      const on = await tty(at)
      if (at === pid) own = on
      return on
    }
    const maker = await readPtyMaker(pid, rows, keepOwn).catch(() => undefined)
    if (maker?.host && own && hosts.includes(maker.host)) made.set(pid, { host: maker.host, maker: maker.pid, tty: own })
  }
  return made
}

/** The app each of these processes runs in, read from this machine; from [rows] when the look has read its table. On
 *  Windows, which has no `ps`, from the PTY host's table [windowsRows] cut to four columns (readWindowsProcesses). */
export function learnApps(
  pids: readonly number[], rows?: readonly ProcessName[], exec: Exec = execText, platform: NodeJS.Platform = process.platform,
  windowsRows: typeof processRows = processRows,
): Promise<Map<number, string>> {
  // Each row's four columns are taken by name, so its command line is never copied (the scan's files spec).
  const windows = async (): Promise<WindowsProcess[]> => ((await windowsRows()) ?? [])
    .map(({ pid, parentPid, executable, startMarker }) => ({ pid, ppid: parentPid, executable, startMarker }))
  const read = (): Promise<readonly WindowsProcess[]> => (platform === 'win32' ? readWindowsProcesses(windows) : readProcessNames(exec))
  return scannedApps(pids, {
    platform, roots: appRoots(homedir()), processes: () => (rows ? Promise.resolve(rows) : read()), bundleId: readBundleId,
  })
}
