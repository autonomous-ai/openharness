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
import { lstat, opendir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { descriptorPaths } from '../engines/kit/nativeDescriptors.js'
import { psEnv } from './childLocale.js'
import { errorKind } from './log.js'
import { linuxProcessStat } from './nativeProcessControl.js'
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

// Each outcome already said of a listing, by its key: once per process, forgotten all at once past the bound.
const said = new Set<string>()

export function clearHeldHomes(): void {
  kept.clear()
  said.clear()
}

type Outcome = 'lsof failed' | 'lsof timed out' | 'too many descriptors' | 'pid changed' | 'unreadable' | 'unmappable' | 'bad pid' | 'two homes'

/** Why a listing gave no home, in fixed words, never a path, a name or a content; the log names it by its code, the
 *  same words as a token (`errorKind`: `Unlisted LSOF_FAILED`). */
class Unlisted extends Error {
  readonly code: string
  constructor(outcome: Outcome) {
    super(outcome)
    this.code = outcome.toUpperCase().replaceAll(' ', '_')
  }
}

/** The paths in `lsof -Fn` output, by process: each `n` line that starts with `/`, in the section its `p` line opens.
 *  Throws when the output is cut (no last newline), when a process asked of has no section or one not asked of has
 *  one, and when one names over 4,096 descriptors (an `f` line each). */
export function lsofPaths(output: string, pids: readonly number[]): Map<number, string[]> {
  if (!output.endsWith('\n')) throw new Unlisted('lsof failed')
  const listed = new Map<number, string[]>()
  let paths: string[] | undefined
  let descriptors = 0
  for (const line of output.slice(0, -1).split('\n')) {
    if (line.startsWith('p')) {
      const pid = pids.find((asked) => line === `p${asked}`)
      if (pid === undefined || listed.has(pid)) throw new Unlisted('lsof failed')
      listed.set(pid, paths = [])
      descriptors = 0
    } else if (!paths) throw new Unlisted('lsof failed')
    else if (line.startsWith('f') && ++descriptors > DESCRIPTORS_MOST) throw new Unlisted('too many descriptors')
    else if (line.startsWith('n/')) paths.push(line.slice(1))
  }
  if (!pids.every((pid) => listed.has(pid))) throw new Unlisted('lsof failed')
  return listed
}

// When the process at `pid` started, in ticks since boot (ProcessIdentity.startTicks); null once none is there.
const startTicks = (pid: number, proc: string): Promise<number | null> =>
  readFile(join(proc, String(pid), 'stat'), 'utf8').then((text) => linuxProcessStat(text, pid).startTicks).catch(() => null)

// The folders one process's open files name, at the daemon's path of them. Throws when it cannot be listed.
async function linuxFolders(identity: ProcessIdentity, file: RegExp, proc: string): Promise<string[]> {
  // The selected process may have ended since the discovery pass and its pid gone to another: the same start before
  // and after the listing says every file listed was the selected process's.
  if (await startTicks(identity.pid, proc) !== identity.startTicks) throw new Unlisted('pid changed')
  const fd = join(proc, String(identity.pid), 'fd')
  const names: string[] = []
  try {
    for await (const entry of await opendir(fd)) {
      names.push(entry.name)
      if (names.length > DESCRIPTORS_MOST) break
    }
  } catch {
    throw new Unlisted('unreadable')
  }
  if (names.length > DESCRIPTORS_MOST) throw new Unlisted('too many descriptors')
  const folders: string[] = []
  for (const name of names) {
    // A descriptor closed between the two reads says nothing.
    const path = await readlink(join(fd, name)).catch(() => null)
    const folder = path === null ? undefined : file.exec(path)?.[1]
    if (folder) folders.push(folder)
  }
  const view = await processView(identity, 'linux', proc)
  if (await startTicks(identity.pid, proc) !== identity.startTicks) throw new Unlisted('pid changed')
  if (view.state === 'unreadable') throw new Unlisted('unreadable')
  if (view.state === 'same') return folders
  // A store with no path here is still a home the process holds: dropped, it would leave the other one picked.
  const mapped = folders.map((folder) => view.toHost(folder))
  if (!mapped.every((folder) => folder !== null)) throw new Unlisted('unmappable')
  return mapped
}

// The kernel names a held file by its real path, which never has a `..` segment: one that does was decoded from a name.
const STEPS_OUT = /(?:^|\/)\.\.(?:\/|$)/

// lsof escapes a name's bytes above ASCII (`\xc3\xa0`) and leaves a backslash as it is, so a path may be spelled two
// ways (descriptorPaths), and a name holding `\x2f` decodes to a path of someone's choosing. The one spelling on disk
// is the file, and it must match; with two or none on disk, the descriptor says nothing, as does a name too long to be
// a path. A spelling is only looked up (lstat), never opened, and one with a `..` segment is not even that: it is no
// file the kernel names, and its lookup could land anywhere (`/net`'s automounts among them).
async function spelledFolder(path: string, file: RegExp): Promise<string | undefined> {
  let spellings: string[]
  try {
    spellings = descriptorPaths(path).filter((spelling) => !STEPS_OUT.test(spelling))
  } catch {
    return undefined
  }
  if (!spellings.some((spelling) => file.test(spelling))) return undefined
  const onDisk = (await Promise.all(spellings.map((spelling) => lstat(spelling).then(() => [spelling], () => [])))).flat()
  return onDisk.length === 1 ? file.exec(onDisk[0])?.[1] : undefined
}

// One lsof lists every process, not one each: its start is most of a listing's cost. It exits non-zero when any of them
// cannot be listed.
async function darwinFolders(pids: readonly number[], file: RegExp): Promise<string[]> {
  // Unlike on Linux, nothing checks the pid is still the selected process: its start is `ps lstart`, one more spawn a
  // listing. macOS hands out pids in turn up to 99,999 before it reuses one, and the pass selected it just before.
  // `-n -P`: no host or port names looked up. `-w`: a file system lsof cannot stat is a warning, and the process's own
  // files are listed regardless (engines/kit/nativeDescriptors.ts).
  // The output's bound is a process's own, as when each had a listing: past it, it has too many descriptors.
  const output = await new Promise<string>((resolve, reject) => {
    probeExecFile(execFile)('lsof', ['-n', '-P', '-w', '-p', pids.join(','), '-Fn'],
      { timeout: 2_000, maxBuffer: pids.length << 20, env: psEnv(process.env) },
      (error, stdout, _stderr, outcome) => error
        ? reject(new Unlisted(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'too many descriptors'
          : outcome?.timedOut || error.killed ? 'lsof timed out' : 'lsof failed'))
        : resolve(stdout))
  })
  const folders: string[] = []
  for (const paths of lsofPaths(output, pids).values()) {
    for (const path of paths) {
      const folder = await spelledFolder(path, file)
      if (folder) folders.push(folder)
    }
  }
  return folders
}

// Where a process's open files can be listed.
type Listable = 'linux' | 'darwin'

// The folders every listed process's files name. Throws when one of them cannot be listed.
async function heldFolders(listed: readonly ProcessIdentity[], file: RegExp, platform: Listable, proc: string): Promise<string[]> {
  // A pid goes into lsof's command line and a path under /proc: only a positive whole number may.
  if (!listed.every(({ pid }) => Number.isSafeInteger(pid) && pid > 0)) throw new Unlisted('bad pid')
  if (platform === 'darwin') return darwinFolders(listed.map(({ pid }) => pid), file)
  const folders: string[] = []
  for (const identity of listed) folders.push(...await linuxFolders(identity, file, proc))
  return folders
}

// Exactly one folder among every listed process's files is the answer: two are no answer, whichever process holds
// which, and so is one process that cannot be listed. Undefined: none holds such a file yet.
async function listedHome(listed: readonly ProcessIdentity[], file: RegExp, platform: Listable, proc: string): Promise<string | undefined> {
  const folders = new Set(await heldFolders(listed, file, platform, proc))
  if (folders.size > 1) throw new Unlisted('two homes')
  const [home] = folders
  return home
}

// One line for each outcome of each process's listings, however often it is listed.
function say(key: string, pid: number, outcome: string): void {
  const id = `${key}\u0000${outcome}`
  if (said.has(id)) return
  if (said.size >= KEPT_MOST) said.clear()
  said.add(id)
  console.warn(`[held-files] pid ${pid}: ${outcome}`)
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
 * where two of them are (cli/AGENTS.md, Protect the core). A `file` with a `g` or `y` flag throws.
 */
export async function heldHome(
  selected: ProcessIdentity,
  file: RegExp,
  children: () => readonly ProcessIdentity[] = () => [],
  options: { platform?: NodeJS.Platform; proc?: string; now?: () => number } = {},
): Promise<string | undefined> {
  // Either flag makes `exec` start where its last match ended, and a path would be skipped.
  if (file.global || file.sticky) throw new TypeError('a held-file pattern has a g or y flag')
  // A wait is timed by a clock that setting the wall clock does not move.
  const { platform = process.platform, proc = '/proc', now = () => performance.now() } = options
  if (platform !== 'linux' && platform !== 'darwin') return undefined
  const key = `${selected.pid}\u0000${selected.startMarker}\u0000${selected.executable}\u0000${file.source}`
  const before = kept.get(key)
  if (before && 'home' in before) return before.home
  const at = now()
  if (before && at - before.at < before.wait) return undefined
  let home: string | undefined
  try {
    // The bound is the reader's own, whatever its caller gives: one listing reads one process to five.
    home = await listedHome([selected, ...children().slice(0, ENGINE_CHILDREN_MOST)], file, platform, proc)
  } catch (error) {
    if (!(error instanceof Unlisted)) throw error
    say(key, selected.pid, errorKind(error))
  }
  if (!kept.has(key) && kept.size >= KEPT_MOST) kept.clear()
  kept.set(key, home !== undefined ? { home }
    : { at, wait: before ? Math.min(before.wait * 2, HELD_RETRY_MS.most) : HELD_RETRY_MS.first })
  return home
}
