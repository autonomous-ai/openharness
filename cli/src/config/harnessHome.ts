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
  logs: 'state',
  runtime: 'state',
  'hook-routes': 'state',
  s: 'state',
  run: 'state',
  'shell-requests': 'state',
  pty: 'state',
  uninstalling: 'state',
  flasher: 'state',
} as const satisfies Record<string, HarnessRootKind>

export type HarnessEntry = keyof typeof HARNESS_ENTRIES

// A parameter, not node:path's own join, so one platform can build (and test) the other's paths.
const joinFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix).join

const homeFolder = (home: string, platform: NodeJS.Platform) => joinFor(platform)(home, HARNESS_HOME_NAME)

// Both kinds share ~/.harness today. Giving each its own folder changes this record, and also harnessPathText below
// (its `/.harness/` text) and lib/uninstall/removal.ts, which refuses a root not named HARNESS_HOME_NAME.
const ROOTS: Record<HarnessRootKind, typeof homeFolder> = { data: homeFolder, state: homeFolder }

export function harnessRoot(kind: HarnessRootKind, home = homedir(), platform = process.platform): string {
  return ROOTS[kind](home, platform)
}

/** The distinct roots, the data root first: today one. Whatever works on the whole tree goes through every one. */
export function harnessRoots(home = homedir(), platform = process.platform): string[] {
  return [...new Set([harnessRoot('data', home, platform), harnessRoot('state', home, platform)])]
}

export function harnessPath(entry: HarnessEntry, home = homedir(), platform = process.platform): string {
  return joinFor(platform)(harnessRoot(HARNESS_ENTRIES[entry], home, platform), entry)
}

/** `<home>/.harness/<entry>` as text, the home as written, nothing normalized: shell text and messages keep their bytes. */
export function harnessPathText(entry: HarnessEntry, home = '$HOME'): string {
  return `${home}/${HARNESS_HOME_NAME}/${entry}`
}
