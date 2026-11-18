import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** The folder in the account's home that holds every Harness file: `~/.harness`. */
export const HARNESS_HOME_NAME = '.harness'

/** Data: identity, sign-in, installed programs, what the person made. State: logs, runtime binaries, markers, sockets, routes. */
export type HarnessRootKind = 'data' | 'state'

/** Every top-level entry under the home folder, and its root (docs/plans/2026-11-18-harness-paths-design.md). */
export const HARNESS_ENTRIES = {
  auth: 'data',
  'computer-id': 'data',
  cli: 'data',
  connections: 'data',
  'agent-messages': 'data',
  bin: 'data',
  dsh: 'data',
  'claude-profiles': 'data',
  'desktop-app-v2': 'data',
  'viewer-app-v2': 'data',
  tui: 'data',
  devices: 'data',
  lessons: 'data',
  'grid-fleet': 'data',
  community: 'data',
  'orca-plugin': 'data',
  memory: 'data',
  logs: 'state',
  runtime: 'state',
  'hook-routes': 'state',
  s: 'state',
  run: 'state',
  'shell-requests': 'state',
  pty: 'state',
  uninstalling: 'state',
  flasher: 'state',
  monitor: 'state',
} as const satisfies Record<string, HarnessRootKind>

export type HarnessEntry = keyof typeof HARNESS_ENTRIES

/**
 * The file in the data root that makes it Harness's (content `1\n`, mode 0600). Only the move's commit, a fresh install
 * and a start on a fresh computer write it, so a folder anything else made there switches nothing.
 */
export const HARNESS_ROOT_MARKER = '.harness-root'

/** What the rule reads of this computer: the XDG variables, whether ~/.harness exists, and whether the marker is a file. */
export interface HomeLook { env: Readonly<Record<string, string | undefined>>; exists(path: string): boolean; isFile(path: string): boolean }

/** A regular file, through a link as the installers' `test -f` looks; a folder, or nothing, is none. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether [dataRoot] holds Harness's marker, a file: a folder of its name is no marker. */
export function holdsMarker(dataRoot: string, isFile: HomeLook['isFile'] = isRegularFile): boolean {
  return isFile(posix.join(dataRoot, HARNESS_ROOT_MARKER))
}

/** This computer, under [env]. Read at each call, never cached: a move is followed by the next process that resolves its paths. */
export const thisComputer = (env: HomeLook['env'] = process.env): HomeLook => ({ env, exists: existsSync, isFile: isRegularFile })

// A parameter, not node:path's own join, so one platform can build (and test) the other's paths.
const joinFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix).join

/** The two XDG places for [home], whether or not Harness uses them. A variable that is unset, empty or not absolute is ignored. */
export function xdgRoots(home: string, env: HomeLook['env']): { data: string; state: string } {
  const base = (name: string, ...fallback: string[]): string => {
    const value = env[name]
    return value && posix.isAbsolute(value) ? value : posix.join(home, ...fallback)
  }
  return { data: posix.join(base('XDG_DATA_HOME', '.local', 'share'), 'harness'), state: posix.join(base('XDG_STATE_HOME', '.local', 'state'), 'harness') }
}

/** `<home>/.harness`, whatever the rule says: where Harness kept everything before. */
export function legacyHarnessHome(home = homedir(), platform = process.platform): string {
  return joinFor(platform)(home, HARNESS_HOME_NAME)
}

export function legacyHarnessPath(entry: HarnessEntry, home = homedir(), platform = process.platform): string {
  return joinFor(platform)(legacyHarnessHome(home, platform), entry)
}

/**
 * Both roots, from one look. Off Linux, `~/.harness`. On Linux, the XDG roots once their data root holds the marker
 * (moved, or a fresh install), else `~/.harness` while it exists (not moved yet), else the XDG roots (a fresh install).
 */
function roots(home: string, platform: NodeJS.Platform, look: HomeLook): Record<HarnessRootKind, string> {
  const legacy = legacyHarnessHome(home, platform)
  if (platform !== 'linux') return { data: legacy, state: legacy }
  const xdg = xdgRoots(home, look.env)
  return !holdsMarker(xdg.data, look.isFile) && look.exists(legacy) ? { data: legacy, state: legacy } : xdg
}

export function harnessRoot(kind: HarnessRootKind, home = homedir(), platform = process.platform, look = thisComputer()): string {
  return roots(home, platform, look)[kind]
}

/** The distinct roots, the data root first. Whatever works on the whole tree goes through every one. */
export function harnessRoots(home = homedir(), platform = process.platform, look = thisComputer()): string[] {
  return [...new Set(Object.values(roots(home, platform, look)))]
}

export function harnessPath(entry: HarnessEntry, home = homedir(), platform = process.platform, look = thisComputer()): string {
  return joinFor(platform)(harnessRoot(HARNESS_ENTRIES[entry], home, platform, look), entry)
}

// Shell text puts these between double quotes, where only these four are special.
const forDoubleQuotes = (text: string): string => text.replace(/[\\"$`]/g, '\\$&')

/**
 * `<home>/<the root's place in it>/<entry>` as text, the home as written, nothing normalized: shell text and messages keep
 * their bytes. A root outside the home is written out. [home] is the text to write for the home (`$HOME`); [realHome] the
 * folder the rule is run for.
 */
export function harnessPathText(entry: HarnessEntry, home = '$HOME', platform = process.platform, look = thisComputer(), realHome = homedir()): string {
  // Off Linux the root is always the home's .harness: today's text, whatever separator the platform's paths use.
  if (platform !== 'linux') return `${home}/${HARNESS_HOME_NAME}/${entry}`
  const root = harnessRoot(HARNESS_ENTRIES[entry], realHome, platform, look)
  const inHome = posix.join(realHome, '/')
  return `${root.startsWith(inHome) ? `${home}/${forDoubleQuotes(root.slice(inHome.length))}` : forDoubleQuotes(root)}/${entry}`
}
