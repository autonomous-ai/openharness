/**
 * Ending everything a Git Bash run started, on Windows: a setup or doctor stopped at its timeout, or a viewer stopped
 * (dsh/shell.ts).
 *
 * Windows' own tree is not enough. Git Bash's runtime (MSYS2, a Cygwin) starts a program as a fork and then an exec,
 * and the program it execs is a new Windows process whose parent is the fork, which then exits: in Windows' table the
 * program's parent is a process that has gone, so a walk down Windows' parent links (treeKill.ts) never reaches it.
 * On the manual Windows workflow a `sleep` a script started was still running after the stop (run 40769937293, review
 * of #2025). Git Bash's own records keep the link: `/proc/<pid>/ppid` is its parent in Git Bash's numbering, which an
 * exec keeps, and `/proc/<pid>/winpid` is its Windows pid.
 *
 * So a helper in the same Git Bash lists the run's tree from those records, and each process listed, with what it
 * started natively, is ended from one read of Windows' table taken before anything is. Only a pid that table shows,
 * started no earlier than the launcher, is ended: Windows reuses pids, and one Git Bash listed may since name another,
 * older process. Without the helper's list (it failed, or did not finish) the launcher's Windows tree alone is ended,
 * as before, and the log says so.
 */
import { spawn } from 'node:child_process'
import type { ProcessRow } from '../processTable.js'
import { endProcessTree, processTreeKillDeps, windowsStartTime, type TreeKillDeps, type TreeKillOutcome } from './treeKill.js'

export interface GitBashTreeDeps extends TreeKillDeps {
  /** The Windows pids of the Git Bash tree under the Git Bash processes among [near], nearest first; null when that
   *  could not be read. */
  msysTree(near: number[]): Promise<number[] | null>
  log?: (line: string) => void
}

/** How long the helper may take: it reads two small files per Git Bash process. */
export const MSYS_TREE_TIMEOUT_MS = 10_000

/**
 * $1: the Windows pids to start from, space-separated; $2: Git Bash's /proc. Breadth first, one pass over /proc per
 * generation, with the shell's own `read` (a fork costs tens of milliseconds there). Bash 3 compatible, as a test runs
 * it with macOS's bash.
 */
const MSYS_TREE_SCRIPT = [
  'want=" $1 "; proc=$2; found=" "',
  'for p in "$proc"/[0-9]*; do',
  '  w=; read -r w 2>/dev/null < "$p/winpid"',
  '  [ -n "$w" ] && case "$want" in *" $w "*) found="$found${p##*/} " ;; esac',
  'done',
  'frontier=$found',
  'while [ -n "${frontier// /}" ]; do',
  '  next=" "',
  '  for p in "$proc"/[0-9]*; do',
  '    q=${p##*/}',
  '    case "$found" in *" $q "*) continue ;; esac',
  '    pp=; read -r pp 2>/dev/null < "$p/ppid"',
  '    [ -n "$pp" ] && case "$frontier" in *" $pp "*) next="$next$q "; found="$found$q " ;; esac',
  '  done',
  '  frontier=$next',
  'done',
  'for q in $found; do w=; read -r w 2>/dev/null < "$proc/$q/winpid"; [ -n "$w" ] && echo "$w"; done',
  'exit 0',
].join('\n')

/** Run the helper in [bash], the same Git Bash the run used: only its own runtime's /proc lists the run's processes. */
export function msysTree(bash: string, near: number[], proc = '/proc', timeoutMs = MSYS_TREE_TIMEOUT_MS): Promise<number[] | null> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (value: number[] | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => { helper.kill('SIGKILL'); done(null) }, timeoutMs)
    timer.unref?.()
    const helper = spawn(bash, ['--norc', '--noprofile', '-c', MSYS_TREE_SCRIPT, 'msys-tree', near.join(' '), proc], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    helper.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    helper.once('error', () => done(null))
    helper.once('close', (code) => {
      if (code !== 0) { done(null); return }
      done(out.split(/\r?\n/).filter((line) => /^\d+$/.test(line)).map(Number))
    })
  })
}

/**
 * End the Git Bash run whose launcher is [pid]: every process of its Git Bash tree and what each started, the furthest
 * first, then the launcher's own Windows tree. Never rejects. The outcome is the launcher's.
 */
export async function endGitBashTree(pid: number, deps: GitBashTreeDeps): Promise<TreeKillOutcome> {
  let rows: ProcessRow[] | null
  try {
    rows = await deps.rows()
  } catch {
    rows = null
  }
  // One read, before anything is ended: ending a process first would hide what it started.
  const snapshot: TreeKillDeps = { ...deps, rows: async () => rows }
  const root = rows?.find((row) => row.pid === pid)
  const rootStart = root ? windowsStartTime(root.startMarker) : null
  if (!rows || rootStart === null) return endProcessTree(pid, snapshot)
  const inRun = (row: ProcessRow | undefined): boolean => {
    const started = row ? windowsStartTime(row.startMarker) : null
    return started !== null && started >= rootStart
  }
  // The launcher (Git for Windows' bin\bash.exe) starts the real bash; either may be the Git Bash process.
  const near = [pid, ...rows.filter((row) => row.parentPid === pid && inRun(row)).map((row) => row.pid)]
  const listed = await deps.msysTree(near)
  if (listed === null) deps.log?.(`[dsh] could not list Git Bash's processes under pid ${pid}; ending its Windows tree only`)
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const members = (listed ?? []).filter((member) => member !== pid && member !== deps.self && inRun(byPid.get(member)))
  for (const member of members.reverse()) await endProcessTree(member, snapshot)
  return endProcessTree(pid, snapshot)
}

/** This computer's: the pty host's table, TerminateProcess, and the helper in [bash] (none without Git Bash). */
export function gitBashTreeDeps(bash: string | null): GitBashTreeDeps {
  return {
    ...processTreeKillDeps(null),
    msysTree: bash ? (near) => msysTree(bash, near) : async () => [],
    log: (line) => console.warn(line),
  }
}
