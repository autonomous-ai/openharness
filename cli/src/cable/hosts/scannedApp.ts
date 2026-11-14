// Which app a session the open scan found runs in, from its parent processes' executables alone
// (docs/specs/2026-11-14-dial-app-filter.md, "The scan learns the app where that is cheap"). Nothing else of a process is
// read: its environment holds secrets, and its name is outside text (a process can write a prompt there), so a name is
// matched against the tables and dropped, never kept, logged or sent.

import { homedir } from 'node:os'
import { listProcesses, run } from '../../lib/sessionSearch/externals/support.js'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { frontAppId } from './frontApp.js'
import { APP_IDS, UNKNOWN_APP } from './hostDetect.js'

/** All the walk reads of a process: no command line to hand on. */
export type ProcessName = Pick<RunningProcess, 'pid' | 'ppid' | 'executable'>

export const WALK_PARENTS = 16
export const BUNDLES_A_PASS = 16
export const BUNDLE_ID_TIMEOUT_MS = 1_000
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

/** A bundle's id from its Info.plist, XML or binary; none for anything that is not one. */
export async function readBundleId(bundle: string, exec: typeof run = run): Promise<string | undefined> {
  const out = await exec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${bundle}/Contents/Info.plist`],
    BUNDLE_ID_TIMEOUT_MS).catch(() => null)
  const id = out?.trim()
  return id && BUNDLE_ID.test(id) ? id : undefined
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
  const walks = pids.map((pid) => [pid, walk(pid, table)] as const)
  if (deps.platform === 'linux') {
    for (const [pid, names] of walks) {
      const app = names.map(frontAppId).find(listed)
      if (app) apps.set(pid, app)
    }
    return apps
  }
  const bundles = walks.map(([pid, names]) => [pid, names.flatMap((name) => bundleOf(name, deps.roots) ?? [])] as const)
  // Each bundle once a pass, all together, and a bounded number of them: a bundle past that names nothing.
  const read = [...new Set(bundles.flatMap(([, of]) => of))].slice(0, BUNDLES_A_PASS)
  const ids = new Map(await Promise.all(read.map(async (bundle) => [bundle, await deps.bundleId(bundle).catch(() => undefined)] as const)))
  for (const [pid, of] of bundles) {
    const app = of.flatMap((bundle) => ids.get(bundle) ?? []).map(frontAppId).find(listed)
    if (app) apps.set(pid, app)
  }
  return apps
}

/** The executables of a process and up to WALK_PARENTS of its parents, nearest first. */
function walk(pid: number, table: ReadonlyMap<number, ProcessName>): string[] {
  const names: string[] = []
  const passed = new Set<number>()
  let p = table.get(pid)
  while (p && !passed.has(p.pid) && names.length <= WALK_PARENTS) {
    passed.add(p.pid)
    names.push(p.executable)
    // launchd and init hold every orphan: their own name says nothing of a session.
    p = p.ppid > 1 ? table.get(p.ppid) : undefined
  }
  return names
}

/** The app each of these processes runs in, read from this machine. */
export function learnApps(pids: readonly number[]): Promise<Map<number, string>> {
  return scannedApps(pids, { platform: process.platform, roots: appRoots(homedir()), processes: listProcesses, bundleId: readBundleId })
}
