/**
 * Where an engine works, from the path of a file its process holds open (decision 8 of
 * docs/plans/2026-11-15-process-env-secrets-design.md; PM, 2026-11-15).
 *
 * The daemon does not read another process's environment, so a Codex or a Hermes with no Harness hook names its home
 * only through the store it keeps open. What is read: the path of each open descriptor (`readlink` of
 * `/proc/<pid>/fd/<n>` on Linux, the `n` lines of `lsof -Fn` on macOS) of the engine process the discovery pass
 * selected and of its direct children that are the same engine's binary (processTable.ts `engineChildren`), five
 * processes at most. On macOS, the spellings of a path that matches are looked up (`lstat`), to tell which one is the
 * file. What never is: a file through its descriptor or its path, any other field of a descriptor, any other process,
 * anything on Windows. A path that does not match the caller's pattern is dropped where it is read: never returned,
 * kept or logged.
 */

import { execFile } from 'node:child_process'
import { lstat, opendir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { descriptorPaths } from '../engines/kit/nativeDescriptors.js'
import { psEnv } from './childLocale.js'
import { probeExecFile } from './offThreadExec.js'
import { processView } from './processMounts.js'
import type { ProcessIdentity } from './terminalTypes.js'

/** How long a process that held no such file is left alone: 5 s after the first listing, then twice as long each
 *  time, up to a minute. An engine opens its store at its start or its first prompt, and one listing a minute is what
 *  reading its environment cost (lib/processEnv.ts, deleted 2026-11). */
export const HELD_RETRY_MS = { first: 5_000, most: 60_000 } as const

/** The most direct children of one launcher whose open files are listed. npm's Codex 0.169.0 has two (the spike of
 *  2026-11-15); the bound keeps one listing to five processes whatever a launcher starts (decision 8). The reader's
 *  own, which processTable.ts `engineChildren` follows: kept here so this file needs nothing of the process table,
 *  which loads engine discovery's tables at its own load and so cannot be loaded by engines/discoveries.ts. */
export const ENGINE_CHILDREN_MOST = 4

// One listing's work is bounded: a process with more descriptors cannot be listed, and no home is taken from part
// of its files.
const DESCRIPTORS_MOST = 4_096
const KEPT_MOST = 256

// A process keeps its home for its life, so an answer is kept as long as the module lives; no answer is kept with the
// time it was asked and the wait before the next listing. A pid is reused: the start marker and executable make the
// key this process's.
type Kept = { home: string } | { at: number; wait: number }
const kept = new Map<string, Kept>()

export function clearHeldHomes(): void {
  kept.clear()
}

/** The paths in `lsof -Fn` output: each `n` line that starts with `/`. Null when the output is cut (no last newline)
 *  or has over 4,096 lines. */
export function lsofPaths(output: string): string[] | null {
  if (!output.endsWith('\n')) return null
  const lines = output.slice(0, -1).split('\n')
  if (lines.length > DESCRIPTORS_MOST) return null
  return lines.filter((line) => line.startsWith('n/')).map((line) => line.slice(1))
}

// The folders one process's open files name, at the daemon's path of them. Null: it cannot be listed.
async function linuxFolders(identity: ProcessIdentity, file: RegExp, proc: string): Promise<string[] | null> {
  const fd = join(proc, String(identity.pid), 'fd')
  const names: string[] = []
  try {
    for await (const entry of await opendir(fd)) {
      if (names.length === DESCRIPTORS_MOST) return null
      names.push(entry.name)
    }
  } catch {
    return null
  }
  const folders: string[] = []
  for (const name of names) {
    // A descriptor closed between the two reads says nothing.
    const path = await readlink(join(fd, name)).catch(() => null)
    const folder = path === null ? undefined : file.exec(path)?.[1]
    if (folder) folders.push(folder)
  }
  const view = await processView(identity, 'linux', proc)
  if (view.state === 'unreadable') return null
  if (view.state === 'same') return folders
  // A store with no path here is still a home the process holds: dropped, it would leave the other one picked.
  const mapped = folders.map((folder) => view.toHost(folder))
  return mapped.every((folder) => folder !== null) ? mapped : null
}

// lsof escapes a name's bytes above ASCII (`\xc3\xa0`) and leaves a backslash as it is, so a path may be spelled two
// ways (descriptorPaths), and a name holding `\x2f` decodes to a path of someone's choosing. The one spelling on disk
// is the file, and it must match; with two or none on disk, the descriptor says nothing, as does a name too long to be
// a path. A spelling is only looked up (lstat), never opened.
async function spelledFolder(path: string, file: RegExp): Promise<string | undefined> {
  let spellings: string[]
  try {
    spellings = descriptorPaths(path)
  } catch {
    return undefined
  }
  if (!spellings.some((spelling) => file.test(spelling))) return undefined
  const onDisk = (await Promise.all(spellings.map((spelling) => lstat(spelling).then(() => [spelling], () => [])))).flat()
  return onDisk.length === 1 ? file.exec(onDisk[0])?.[1] : undefined
}

// The kernel names a held file by its real path, which never has a `..` segment: one that does was decoded from a name.
const STEPS_OUT = /(?:^|\/)\.\.(?:\/|$)/

async function darwinFolders(pid: number, file: RegExp): Promise<string[] | null> {
  // `-n -P`: no host or port names looked up. `-w`: a file system lsof cannot stat is a warning, and the process's own
  // files are listed regardless (engines/kit/nativeDescriptors.ts).
  const paths = await new Promise<string[] | null>((resolve) => {
    probeExecFile(execFile)('lsof', ['-n', '-P', '-w', '-p', String(pid), '-Fn'], { timeout: 2_000, maxBuffer: 1 << 20, env: psEnv(process.env) },
      (error, stdout) => resolve(error ? null : lsofPaths(stdout)))
  })
  if (!paths) return null
  const folders: string[] = []
  for (const path of paths) {
    const folder = await spelledFolder(path, file)
    if (folder) folders.push(folder)
  }
  return folders
}

// Exactly one folder among every listed process's files is the answer: two are no answer, whichever process holds
// which, and so is one process that cannot be listed.
async function listedHome(listed: readonly ProcessIdentity[], file: RegExp, platform: NodeJS.Platform, proc: string): Promise<string | undefined> {
  const folders = new Set<string>()
  for (const identity of listed) {
    const held = platform === 'linux' ? await linuxFolders(identity, file, proc)
      : platform === 'darwin' ? await darwinFolders(identity.pid, file)
        : null
    if (!held) return undefined
    for (const folder of held) folders.add(folder)
  }
  const [home] = folders
  return folders.size === 1 && !STEPS_OUT.test(home) ? home : undefined
}

/**
 * The folder a file `selected` holds open says it works in, at the daemon's path of it: the first group of `file`,
 * tried against the whole path of each open descriptor of `selected` and of the processes `children()` names (a
 * launcher's direct children that are the same engine's binary, ENGINE_CHILDREN_MOST at most; no other process is
 * ever listed). Undefined when no path matches, when two name different folders, in one process or across them (no
 * home is ever picked from two), when a process cannot be listed (Windows, another account's process, one that is
 * gone) or when a sandbox's folder has no path in the daemon's view. Only paths are read (`readlink` of
 * `/proc/<pid>/fd/<n>`, the `n` lines of `lsof -Fn`), never a file through its descriptor, and a path that does not
 * match is dropped here: the daemon does not read another process's environment, and reads no more of its files than
 * where two of them are (cli/AGENTS.md, Protect the core). `file` has no `g` or `y` flag.
 */
export async function heldHome(
  selected: ProcessIdentity,
  file: RegExp,
  children: () => readonly ProcessIdentity[] = () => [],
  options: { platform?: NodeJS.Platform; proc?: string; now?: () => number } = {},
): Promise<string | undefined> {
  const { platform = process.platform, proc = '/proc', now = Date.now } = options
  const key = `${selected.pid}\u0000${selected.startMarker}\u0000${selected.executable}\u0000${file.source}`
  const before = kept.get(key)
  if (before && 'home' in before) return before.home
  const at = now()
  if (before && at - before.at < before.wait) return undefined
  // The bound is the reader's own, whatever its caller gives: one listing reads one process to five.
  const home = await listedHome([selected, ...children().slice(0, ENGINE_CHILDREN_MOST)], file, platform, proc)
  if (!kept.has(key) && kept.size >= KEPT_MOST) kept.clear()
  kept.set(key, home !== undefined ? { home }
    : { at, wait: before ? Math.min(before.wait * 2, HELD_RETRY_MS.most) : HELD_RETRY_MS.first })
  return home
}
