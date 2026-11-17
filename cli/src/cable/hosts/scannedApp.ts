// Which app a session the open scan found runs in, from its parent processes' executables alone
// (docs/specs/2026-11-14-dial-app-filter.md, "The scan learns the app where that is cheap"). Nothing else of a process is
// read: its environment holds secrets, and its name is outside text (a process can write a prompt there), so a name is
// matched against the tables and dropped, never kept, logged or sent.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { patientExec } from '../../lib/patientExec.js'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { frontAppId } from './frontApp.js'
import { APP_IDS, UNKNOWN_APP } from './hostDetect.js'

/** All the walk reads of a process: no command line to hand on. */
export type ProcessName = Pick<RunningProcess, 'pid' | 'ppid' | 'executable'>

export const WALK_PARENTS = 16
export const BUNDLES_A_PASS = 16
export const BUNDLE_ID_TIMEOUT_MS = 1_000
/** plutil prints the id alone, at most 128 characters: more is no bundle id. */
const BUNDLE_ID_MAX_BYTES = 1024
// The daemon's own table read has the same bounds; this one took 42 ms for 862 processes on an M1 Pro, and 1 MiB holds
// that many rows at the longest name macOS prints (MAXPATHLEN).
export const PS_TIMEOUT_MS = 3_000
export const PS_MAX_BYTES = 1024 * 1024
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
 *  not help), which leaves no `.app` in an app's path. On Linux it is the task's name either way. */
export async function readProcessNames(exec: Exec = execText): Promise<ProcessName[]> {
  const rows = parseProcessNames(await exec('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES }) ?? '')
  // `ps` lists itself at the least: no row is a read that failed. The error names nothing it printed: a name is outside text.
  if (!rows.length) throw new Error('process table not read')
  return rows
}

export interface ScannedAppDeps {
  platform: NodeJS.Platform
  roots: readonly string[]
  processes(): Promise<readonly ProcessName[]>
  bundleId(bundle: string): Promise<string | undefined>
}

/** A listed app, never the unknown one: the scan does not answer "Other", it leaves the session to its first hook. */
const listed = (app: string): boolean => app !== UNKNOWN_APP && APP_IDS.includes(app)

/** Each pid's app, from the nearest of it and its parents that names one; a pid nothing named is left out. */
export async function scannedApps(pids: readonly number[], deps: ScannedAppDeps): Promise<Map<number, string>> {
  const apps = new Map<number, string>()
  // Windows waits for the first hook: a dead parent's pid can be another process's there.
  if ((deps.platform !== 'darwin' && deps.platform !== 'linux') || !pids.length) return apps
  // One picture of the machine: a parent's id is never matched against a process that took it a moment later.
  const table = new Map((await deps.processes()).map((p) => [p.pid, p]))
  const walks = pids.map((pid) => [pid, parentChain(pid, table).map((p) => p.executable)] as const)
  if (deps.platform === 'linux') {
    for (const [pid, names] of walks) {
      const app = names.map(frontAppId).find(listed)
      if (app) apps.set(pid, app)
    }
    return apps
  }
  const bundles = walks.map(([pid, names]) => [pid, names.flatMap((name) => bundleOf(name, deps.roots) ?? [])] as const)
  // Each bundle once a pass, all together, and a bounded number of them: a bundle past that is not read.
  const read = [...new Set(bundles.flatMap(([, of]) => of))].slice(0, BUNDLES_A_PASS)
  const ids = new Map(await Promise.all(read.map(async (bundle) => [bundle, await deps.bundleId(bundle).catch(() => undefined)] as const)))
  for (const [pid, of] of bundles) {
    const app = nearestApp(of, ids)
    if (app) apps.set(pid, app)
  }
  return apps
}

/** The nearest listed app of a walk's bundles. A bundle with no id (not read this pass, or unreadable) ends the walk
 *  with none: it may be the session's own app, and an outer one would be a guess. One read but no table lists is
 *  passed over: a helper or an engine of its own. */
function nearestApp(bundles: readonly string[], ids: ReadonlyMap<string, string | undefined>): string | undefined {
  for (const bundle of bundles) {
    const id = ids.get(bundle)
    if (!id) return undefined
    const app = frontAppId(id)
    if (listed(app)) return app
  }
  return undefined
}

/** A process and up to WALK_PARENTS of its parents, nearest first, from one read of the table: a pid the table does not
 *  hold starts none. The open scan reads their names, a tap on a tmux pane their ids (tmux.ts). */
export function parentChain<P extends Pick<ProcessName, 'pid' | 'ppid'>>(pid: number, table: ReadonlyMap<number, P>): P[] {
  const chain: P[] = []
  const passed = new Set<number>()
  let p = table.get(pid)
  while (p && !passed.has(p.pid) && chain.length <= WALK_PARENTS) {
    passed.add(p.pid)
    chain.push(p)
    // launchd and init hold every orphan: they are no session's own.
    p = p.ppid > 1 ? table.get(p.ppid) : undefined
  }
  return chain
}

/** The app each of these processes runs in, read from this machine. */
export function learnApps(pids: readonly number[], exec: Exec = execText): Promise<Map<number, string>> {
  return scannedApps(pids, {
    platform: process.platform, roots: appRoots(homedir()), processes: () => readProcessNames(exec), bundleId: readBundleId,
  })
}
