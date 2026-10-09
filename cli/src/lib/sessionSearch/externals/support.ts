/**
 * What every provider reads with: bounded file reads, a scan's memo, and the machine's processes.
 * Each system call here is small, read-only, and has a timeout.
 */

import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { isHarnessSession, paneOwnerFormat } from '../../harnessSessionLabel.js'
import { processRows } from '../../tmux.js'
import { tmuxFeatures } from '../../tmuxVersion.js'
import { type ProcessView, type RunningProcess, type ScanContext, UNSETTLED } from './types.js'
import { externalReadFailed } from '../evidence.js'

/** A folder's entries, or none when it is missing or unreadable. */
export async function entries(dir: string): Promise<Dirent[]> {
  return readdir(dir, { withFileTypes: true }).catch(error => { externalReadFailed(error, 'folder'); return [] })
}

/** Up to [bytes] from the start of a file; '' when it cannot be read. */
export async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r').catch(error => { externalReadFailed(error, 'file'); return null })
  if (!handle) return ''
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Up to [bytes] from the end of a file; '' when it cannot be read. */
export async function readTail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r').catch(error => { externalReadFailed(error, 'file'); return null })
  if (!handle) return ''
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** A file's first line, whole, when it fits in [bytes]; null otherwise. */
export async function firstLine(path: string, bytes: number): Promise<string | null> {
  const text = await readHead(path, bytes)
  const newline = text.indexOf('\n')
  return newline < 0 ? null : text.slice(0, newline)
}

/** A file's text, or '' when it is missing or unreadable. */
export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(error => { externalReadFailed(error, 'file'); return '' })
}

/** A JSON file's value, or null when it is missing, unreadable or being written. */
export async function readJson(path: string): Promise<unknown> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (value === null) externalReadFailed(new Error('null document'), 'record')
    return value
  } catch (error) {
    externalReadFailed(error, 'record')
    return null
  }
}

/** One JSON line's value, or null. */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** A file's size and change time, the fingerprint a memo is keyed on; null when it is not a file. */
export async function fileStamp(path: string): Promise<{ stamp: string; mtime: number } | null> {
  const info = await stat(path).catch(error => { externalReadFailed(error, 'file metadata'); return null })
  if (!info?.isFile()) return null
  return { stamp: `${info.size}:${info.mtimeMs}`, mtime: Math.floor(info.mtimeMs) }
}

/** An object's field when it is a non-empty string, else ''. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A record, when [value] is one. */
export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An absolute folder, as a session records it. */
export function absoluteFolder(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('/') ? value : null
}

/** Epoch ms from seconds, milliseconds, microseconds or an ISO string; null for anything else. */
export function epochMs(value: unknown): number | null {
  if (typeof value === 'string') {
    if (/^\d+(?:\.\d+)?$/.test(value)) return epochMs(Number(value))
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  if (value < 1e11) return Math.round(value * 1000)
  if (value < 1e14) return Math.round(value)
  if (value < 1e17) return Math.round(value / 1000)
  return Math.round(value / 1e6)
}

/** Whether [path] is [dir] or inside it. */
export function within(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface ScanMemo {
  context(): ScanContext
  /** Forgets whatever this scan did not ask for again. */
  prune(): void
}

/**
 * A scan's memory between scans: each key's last value, kept while its fingerprint holds. A first
 * scan reads everything once; later ones read only what changed.
 */
export function scanMemo(options: { excluded: readonly string[]; paceEvery?: number } = { excluded: [] }): ScanMemo {
  const kept = new Map<string, { fingerprint: string; value: unknown; settled?: boolean }>()
  let touched = new Set<string>()
  let reads = 0
  const every = options.paceEvery ?? 64
  return {
    context: () => ({
      memo: async <T>(key: string, fingerprint: string, read: () => Promise<T>): Promise<T> => {
        touched.add(key)
        const found = kept.get(key)
        if (found && found.fingerprint === fingerprint) return found.value as T
        const value = await read()
        kept.set(key, { fingerprint, value })
        return value
      },
      head: async <T>(key: string, stamp: string, read: () => Promise<T | null | typeof UNSETTLED>): Promise<T | null> => {
        touched.add(key)
        const found = kept.get(key)
        if (found && (found.settled || found.fingerprint === stamp)) return found.value as T | null
        const value = await read()
        const settled = value !== UNSETTLED
        kept.set(key, { fingerprint: stamp, value: settled ? value : null, settled })
        return settled ? value : null
      },
      excluded: (cwd) => options.excluded.some((dir) => within(dir, cwd)),
      pace: async () => {
        if (++reads % every === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      },
    }),
    prune: () => {
      for (const key of [...kept.keys()]) if (!touched.has(key)) kept.delete(key)
      touched = new Set()
    },
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

type Run = (command: string, args: readonly string[], timeout: number) => Promise<string | null>

/** A command's output; what it printed even when it exits non-zero (lsof does, for a gone pid). */
export const run: Run = (command, args, timeout) => new Promise((resolve) => {
  execFile(command, [...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    // lsof's documented empty match is exit 1 with no diagnostic. Timeouts, truncation and errors
    // remain unknown even if they produced a partial list; display callers retain their old answer.
    if (error && !(command === 'lsof' && Number(error.code) === 1 && !stderr)) externalReadFailed(error, 'process files')
    resolve(error && !stdout ? null : String(stdout))
  })
})

/** `lsof -F pn` output as files by pid. */
export function parseLsof(stdout: string): Map<number, string[]> {
  const files = new Map<number, string[]>()
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1)) || 0
      if (pid && !files.has(pid)) files.set(pid, [])
    } else if (pid && line.startsWith('n')) {
      files.get(pid)!.push(line.slice(1))
    }
  }
  return files
}

/** `ps -o pid=,tty=` output as each process's terminal (`/dev/ttys003`), or null for none. */
export function parseTtys(stdout: string): Map<number, string | null> {
  const ttys = new Map<number, string | null>()
  for (const line of stdout.split('\n')) {
    const [pid, tty] = line.trim().split(/\s+/)
    if (!pid) continue
    ttys.set(Number(pid), tty && !tty.startsWith('?') ? `/dev/${tty}` : null)
  }
  return ttys
}

/** The machine's processes, as the daemon's own process scan reads them (it repairs rewritten rows);
 *  none when `ps` could not be read. */
export async function listProcesses(read: typeof processRows = processRows): Promise<RunningProcess[]> {
  const rows = await read()
  if (!rows) externalReadFailed(new Error('process table unavailable'), 'process table')
  return (rows ?? []).map((row) => {
    const started = Date.parse(row.startMarker)
    return { pid: row.pid, ppid: row.parentPid, executable: row.executable, args: row.args,
      ...(Number.isFinite(started) ? { started } : {}),
      ...(row.startTicks !== undefined ? { generation: `linux:${row.startTicks}` }
        : Number.isFinite(started) ? { generation: `ps:${started}` } : {}) }
  })
}

/**
 * Each of [pids]' working folder. Linux says it in /proc; macOS only through lsof, asked once for every pid
 * (`-a -d cwd`: that one descriptor) under the same timeout and output bound as its open files. A pid whose
 * folder cannot be read (gone, another user's) is left out: unknown, which admission reads as "may hold any".
 */
export async function processCwds(
  pids: readonly number[],
  exec: Run = run,
  os: NodeJS.Platform = process.platform,
  link: (path: string) => Promise<string> = readlink,
): Promise<Map<number, string>> {
  const cwds = new Map<number, string>()
  if (!pids.length) return cwds
  if (os === 'linux') {
    await Promise.all(pids.map(async (pid) => {
      const cwd = await link(`/proc/${pid}/cwd`).catch(() => null)
      if (cwd) cwds.set(pid, cwd)
    }))
    return cwds
  }
  for (const [pid, files] of parseLsof(await exec('lsof', ['-n', '-P', '-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], 3_000) ?? '')) {
    if (files[0]) cwds.set(pid, files[0])
  }
  return cwds
}

/**
 * A folder as one key whichever way it was spelled: a trailing slash, `..`, or a link (macOS's /tmp is
 * /private/tmp, and lsof reports the resolved one). A folder that cannot be resolved keeps its spelling.
 */
export async function folderKey(path: string): Promise<string> {
  const absolute = resolve(path)
  return realpath(absolute).catch(() => absolute)
}

/**
 * The git store a folder's repository shares with all its worktrees, read from disk without running git: the
 * first `.git` above it, a folder (the store itself) or a worktree's `gitdir:` file, whose
 * `<store>/worktrees/<name>` names the store two levels up. Null outside a repository. The walk stops at the
 * folder holding the homes, so a stray `.git` there cannot make every project one.
 */
export async function gitCommonDir(folder: string, stop: string = dirname(homedir())): Promise<string | null> {
  const ceiling = await folderKey(stop)
  let dir = await folderKey(folder)
  for (let depth = 0; depth < 128 && dir !== ceiling; depth++) {
    const dotgit = join(dir, '.git')
    const found = await stat(dotgit).catch(() => null)
    if (found?.isDirectory()) return folderKey(dotgit)
    if (found?.isFile()) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotgit, 'utf8').catch(() => ''))?.[1]
      if (!named) return null
      const gitdir = resolve(dir, named)
      return folderKey(/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitdir) ? dirname(dirname(gitdir)) : gitdir)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Whether a process working in [a] might list a conversation of [b] in its own picker: Claude Code's `/resume`
 * lists its own folder's, and newer versions its repository's worktrees too, so the same folder or one git
 * store. Never a folder merely above or below: a TUI left open in the home folder is common, and counting
 * every folder below it would hold every adoption on the machine again, the bug this check replaced.
 */
export async function sameProject(a: string, b: string, stop?: string): Promise<boolean> {
  const [x, y] = await Promise.all([folderKey(a), folderKey(b)])
  if (x === y) return true
  const [left, right] = await Promise.all([gitCommonDir(x, stop), gitCommonDir(y, stop)])
  return left !== null && left === right
}

/** The machine's processes, looked at once per view: the list is read on first use and kept. */
export function processView(
  exec: Run = run,
  alive: (pid: number) => boolean = processAlive,
  list: () => Promise<RunningProcess[]> = listProcesses,
  cwds: (pids: readonly number[]) => Promise<Map<number, string>> = (pids) => processCwds(pids, exec),
): ProcessView {
  let listed: Promise<RunningProcess[]> | null = null
  return {
    list: () => (listed ??= list()),
    openFiles: async (pids) => pids.length
      ? parseLsof(await exec('lsof', ['-n', '-P', '-Fpn', '-a', '-p', pids.join(',')], 3_000) ?? '')
      : new Map(),
    openFilesOf: async (commands) => commands.length
      ? parseLsof(await exec('lsof', ['-n', '-P', '-Fpn', ...commands.flatMap((name) => ['-c', name])], 3_000) ?? '')
      : new Map(),
    cwds,
    alive,
  }
}

/** Each of [pids]' terminal, or null for a process with none (an app, a server). */
export async function processTtys(pids: readonly number[], exec: Run = run): Promise<Map<number, string | null>> {
  if (!pids.length) return new Map()
  return parseTtys(await exec('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')], 3_000) ?? '')
}

type Ask = (command: string, args: readonly string[], timeout: number) => Promise<{ stdout: string; failed: boolean; stderr: string }>

const ask: Ask = (command, args, timeout) => new Promise((resolve) => {
  execFile(command, [...args], { timeout }, (error, stdout, stderr) => {
    resolve({ stdout: String(stdout), failed: !!error, stderr: String(stderr) })
  })
})

/**
 * The terminals of Harness's own panes: the ones a daemon tagged (`HARNESS_OWNER_OPTION`), in whatever
 * session the person has moved them into, and any in a tmux session named `harness-…`. A process there
 * is one of Harness's agents — any daemon's — whatever its session looks like while the daemon is still
 * binding it, and a take-over never stops it. None when no tmux server is running; null when tmux could
 * not be asked (a timeout): then nobody can say.
 */
export async function harnessTtys(
  exec: Ask = ask,
  // Before tmux 3.0 the tag is not a pane option (`paneOwnerFormat`).
  paneOptions?: boolean,
): Promise<Set<string> | null> {
  const format = `#{pane_tty}\t#{session_name}\t${paneOwnerFormat(paneOptions ?? (await tmuxFeatures()).paneOptions)}`
  const { stdout, failed, stderr } = await exec('tmux', ['list-panes', '-a', '-F', format], 3_000)
  if (failed && !/no server running|error connecting to .*\(No such file or directory\)/i.test(stderr)) return null
  const ttys = new Set<string>()
  for (const line of stdout.split('\n')) {
    const [tty, session, tag] = line.split('\t')
    if (tty && (tag || (session && isHarnessSession(session)))) ttys.add(tty)
  }
  return ttys
}
