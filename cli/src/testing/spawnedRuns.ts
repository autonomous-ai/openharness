/**
 * Processes a test starts, and the guarantee that none of them outlives it.
 *
 * Why: src/cliCommand.spec.ts ran `harness start` through tsx and waited for it to exit. When a run
 * did not exit (a start that booted a daemon instead of refusing), the test timed out, nothing killed
 * the run, and the next one did the same: twelve `cli.ts start` processes were found orphaned nine hours
 * later, one spinning a CPU core at 98%. Killing the direct child was never enough either: tsx runs the
 * CLI in a child of its own, and a dev-mode start becomes the daemon, with children of its own.
 *
 * So every run starts as the leader of a process group of its own (`detached`), and teardown ends the
 * whole group: SIGTERM, then SIGKILL for whatever is still there. It also ends what left the group:
 * descendants that were still linked to a run when teardown looked, the daemon a run's pid file names
 * and what descends from it, and a tmux server under the run's throwaway root (tmux daemonizes into a
 * session of its own). What teardown had to end is reported: a run the test expected to finish that
 * left a process behind is a leak, and the caller fails the test with it.
 *
 * Of the machine's processes, each one's pid, parent and group alone are read (processTable): a test's own are
 * found as a tree from its own (processTree), and only they are asked anything more, by pid. The person's own
 * processes run on the same computer (PM, 2026-11-23).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Run {
  readonly child: ChildProcess
  /** The process group: the run's own pid, since it leads one. */
  readonly pgid: number
  /** The throwaway root it runs under; its pid file and tmux socket are found there. */
  readonly root: string
  readonly label: string
  /** When it was started, ms. */
  readonly started: number
  /** Settles when the run's own process has exited, with its status. */
  readonly exited: Promise<number | null>
  stdout: string
  stderr: string
}

export interface ProcessRow { pid: number; ppid: number; pgid: number }
/** A process of the test's own tree, with its command line. */
export interface NamedRow extends ProcessRow { command: string }

/** Every process on the machine, by its pid, its parent and its group alone (the same columns on macOS and Linux). */
export function processTable(): ProcessRow[] {
  const text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }] : []
  })
}

/**
 * [roots] and what descends from them in [table], in the table's order: each one's children, and every member of a
 * group one of them leads, which stays the test's once its parent is gone and launchd has it. Never pid 1.
 */
export function processTree(table: readonly ProcessRow[], roots: Iterable<number>): ProcessRow[] {
  const tree = new Set([...roots].filter((pid) => pid > 1))
  for (let grew = true; grew;) {
    grew = false
    const leaders = new Set(table.filter((row) => tree.has(row.pid) && row.pid === row.pgid).map((row) => row.pid))
    for (const row of table) {
      if (row.pid > 1 && !tree.has(row.pid) && (tree.has(row.ppid) || leaders.has(row.pgid))) { tree.add(row.pid); grew = true }
    }
  }
  return table.filter((row) => tree.has(row.pid))
}

/** [field] of each of [pids] still running, by pid, as `ps -p` prints it: never of a process not asked of. */
function psOf(pids: readonly number[], field: 'command' | 'comm' | 'lstart'): Map<number, string> {
  if (pids.length === 0) return new Map()
  // It exits 1 once none of them runs: what it printed is read whatever its status. C's dates, so every read prints a
  // start alike and Date reads it.
  const listed = spawnSync('ps', ['-ww', '-o', `pid=,${field}=`, '-p', pids.join(',')],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 })
  return new Map(String(listed.stdout ?? '').split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line)
    return match ? [[Number(match[1]), match[2]!] as const] : []
  }))
}

/** The command line of each of [pids], processes of the test's own tree. */
export const commandLines = (pids: readonly number[]): Map<number, string> => psOf(pids, 'command')
/** The path each of [pids], processes of the test's own tree, was started from (macOS's `comm`; Linux's is its name). */
export const comms = (pids: readonly number[]): Map<number, string> => psOf(pids, 'comm')
/** When each of [pids] started, to the second: what tells a process the test saw from one given its pid later. */
export const startTimes = (pids: readonly number[]): Map<number, string> => psOf(pids, 'lstart')

/** [roots]'s tree now (processTree), each process with its command line; one gone meanwhile is left out. */
export function namedTree(roots: Iterable<number>, table: readonly ProcessRow[] = processTable()): NamedRow[] {
  const tree = processTree(table, roots)
  const commands = commandLines(tree.map((row) => row.pid))
  return tree.flatMap((row) => {
    const command = commands.get(row.pid)
    return command === undefined ? [] : [{ ...row, command }]
  })
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `pid <n> <its command line>`, for a report, of the test's own [rows]. */
const described = (rows: readonly ProcessRow[]): string[] => {
  const commands = commandLines(rows.map((row) => row.pid))
  return rows.map((row) => `pid ${row.pid} ${(commands.get(row.pid) ?? '').slice(0, 160)}`)
}

export class SpawnedRuns {
  private readonly runs: Run[] = []
  /** Runs the test ended or left running on purpose: what teardown finds of them is not a leak. */
  private readonly expected = new Set<Run>()

  /** Start `node [argv]` as the leader of a new process group, under [root]. */
  start(root: string, argv: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; label?: string } = {}): Run {
    const started = Date.now()
    const child = spawn(process.execPath, argv, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const run: Run = {
      child, pgid: child.pid ?? -1, root, label: options.label ?? argv.join(' ').slice(0, 120), started,
      exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
      stdout: '', stderr: '',
    }
    child.stdout?.on('data', (chunk: Buffer) => { run.stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { run.stderr += chunk.toString() })
    child.once('error', () => { /* reported through `exited` never settling: teardown still ends the group */ })
    this.runs.push(run)
    return run
  }

  /**
   * Start a run and wait for it to finish and close its output, at most [ms]. One that has not by then
   * is ended, group and all, and reported as `timedOut`: a hang is a failing assertion here, never a
   * process left for the machine.
   */
  async complete(root: string, argv: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; label?: string; ms?: number } = {}) {
    const run = this.start(root, argv, options)
    const closed = new Promise<number | null>((resolve) => run.child.once('close', (code) => resolve(code)))
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), options.ms ?? 15_000) })
    const outcome = await Promise.race([closed, deadline])
    clearTimeout(timer)
    if (outcome === 'timeout') {
      await this.end(run)
      return { status: null, stdout: run.stdout, stderr: run.stderr, timedOut: true, run }
    }
    return { status: outcome, stdout: run.stdout, stderr: run.stderr, timedOut: false, run }
  }

  /** The processes that belong to [run] now: its group, the daemon its pid file names, and what descends from them. */
  belonging(run: Run, table: ProcessRow[] = processTable()): ProcessRow[] {
    const roots = groupIsOurs(run, table) ? table.filter((row) => row.pgid === run.pgid).map((row) => row.pid) : []
    const daemon = daemonOf(run, table)
    if (daemon !== undefined) roots.push(daemon)
    const spared = new Set([process.pid, process.ppid, 1])
    return processTree(table, roots).filter((row) => !spared.has(row.pid))
  }

  /** End [run] now, everything that belongs to it, and count nothing of it as a leak. */
  async end(run: Run): Promise<void> {
    this.expected.add(run)
    await this.terminate([run])
  }

  /**
   * Teardown: end every run and what belongs to it. Returns what was found alive of runs the test did
   * not end itself (`leftBehind`), and anything that would not die (`survivors`).
   */
  async endAll(): Promise<{ leftBehind: string[]; survivors: string[] }> {
    const runs = this.runs.splice(0)
    const table = processTable()
    const leftBehind = runs.filter((run) => !this.expected.has(run)).flatMap((run) => [
      ...described(this.belonging(run, table)).map((row) => `${run.label}: ${row}`),
      ...(tmuxServerRunning(run.root) ? [`${run.label}: a tmux server under ${run.root}`] : []),
    ])
    const survivors = await this.terminate(runs, table)
    for (const run of runs) this.expected.delete(run)
    return { leftBehind, survivors }
  }

  /** SIGKILL every group, at once and synchronously: for a worker on its way out. */
  killAllSync(): void {
    for (const run of this.runs) if (!exited(run)) { try { process.kill(-run.pgid, 'SIGKILL') } catch { /* gone */ } }
  }

  private async terminate(runs: Run[], table: ProcessRow[] = processTable()): Promise<string[]> {
    const rows = runs.flatMap((run) => this.belonging(run, table))
    const groups = runs.filter((run) => groupIsOurs(run, table))
    const signal = (name: NodeJS.Signals) => {
      for (const run of groups) { try { process.kill(-run.pgid, name) } catch { /* group empty */ } }
      for (const row of rows) { try { process.kill(row.pid, name) } catch { /* gone */ } }
    }
    signal('SIGTERM')
    const gone = async (ms: number) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline && rows.some((row) => alive(row.pid))) await sleep(50)
    }
    await gone(3_000)
    signal('SIGKILL')
    await gone(3_000)
    // A tmux server daemonizes into a session of its own; it is found by the socket under the root.
    for (const run of runs) killTmuxServer(run.root)
    return described(rows.filter((row) => alive(row.pid)))
  }
}

const exited = (run: Run): boolean => run.child.exitCode !== null || run.child.signalCode !== null

/**
 * Whether the run's process group number still names its group. While any process is in a group, no
 * new process can be given that number; once the run's own process has exited, a process with its pid
 * is a stranger leading a group of its own, and the run's group is empty.
 */
function groupIsOurs(run: Run, table: ProcessRow[]): boolean {
  return run.pgid > 1 && !(exited(run) && table.some((row) => row.pid === run.pgid))
}

function readPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null
  } catch { return null }
}

/**
 * The daemon [run]'s pid file names, when the file was written in the run's time, while that pid is still the process
 * it was written for: started no sooner than the run, to the second `ps` gives, and no later than the file was written.
 * A file a test wrote before the run names a process of its own, and a pid file can outlive its process, the number
 * somebody else's by then: of that process its start time alone is read.
 */
function daemonOf(run: Run, table: readonly ProcessRow[]): number | undefined {
  const file = join(run.root, 'data', 'adapter.pid')
  const written = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Number.NaN
  const pid = readPid(file)
  if (!(written >= run.started) || pid === null || !table.some((row) => row.pid === pid)) return undefined
  const started = Date.parse(startTimes([pid]).get(pid) ?? '')
  return started >= Math.floor(run.started / 1000) * 1000 && started <= written ? pid : undefined
}

/** The socket a tmux server started by a run would listen on: the run's TMUX_TMPDIR is its root. */
const tmuxSocket = (root: string) => join(root, `tmux-${process.getuid?.() ?? 0}`, 'default')

function tmuxServerRunning(root: string): boolean {
  if (!existsSync(tmuxSocket(root))) return false
  try { execFileSync('tmux', ['-S', tmuxSocket(root), 'list-sessions'], { stdio: 'ignore', timeout: 5_000 }); return true } catch { return false }
}

/** Stop a tmux server whose socket is under [root], if a run started one. */
function killTmuxServer(root: string): void {
  if (!existsSync(tmuxSocket(root))) return
  try { execFileSync('tmux', ['-S', tmuxSocket(root), 'kill-server'], { stdio: 'ignore', timeout: 5_000 }) } catch { /* not running */ }
}
