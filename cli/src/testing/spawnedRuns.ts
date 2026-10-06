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
 * descendants that were still linked to a run when teardown looked, the daemon a run's pid file names,
 * and a tmux server under the run's throwaway root (tmux daemonizes into a session of its own). What
 * teardown had to end is reported: a run the test expected to finish that left a process behind is a
 * leak, and the caller fails the test with it.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Run {
  readonly child: ChildProcess
  /** The process group: the run's own pid, since it leads one. */
  readonly pgid: number
  /** The throwaway root it runs under; its pid file and tmux socket are found there. */
  readonly root: string
  readonly label: string
  /** Settles when the run's own process has exited, with its status. */
  readonly exited: Promise<number | null>
  stdout: string
  stderr: string
}

export interface ProcessRow { pid: number; ppid: number; pgid: number; command: string }

/** Every process on the machine, as `ps` lists them (the same columns on macOS and Linux). */
export function processTable(): ProcessRow[] {
  const text = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : []
  })
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class SpawnedRuns {
  private readonly runs: Run[] = []
  /** Runs the test ended or left running on purpose: what teardown finds of them is not a leak. */
  private readonly expected = new Set<Run>()

  /**
   * [isDaemon] says whether the process a run's pid file names is the daemon that run started (the
   * CLI's own command line, for src/cliCommand.spec.ts): a pid file can outlive its process, and the
   * number can be somebody else's by then.
   */
  constructor(private readonly isDaemon: (command: string, run: Run) => boolean = () => false) {}

  /** Start `node [argv]` as the leader of a new process group, under [root]. */
  start(root: string, argv: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; label?: string } = {}): Run {
    const child = spawn(process.execPath, argv, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const run: Run = {
      child, pgid: child.pid ?? -1, root, label: options.label ?? argv.join(' ').slice(0, 120),
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

  /** The processes that belong to [run] now: its group, its linked descendants, its daemon, its orphans. */
  belonging(run: Run, table: ProcessRow[] = processTable()): ProcessRow[] {
    const found = new Map<number, ProcessRow>()
    const leaderGone = exited(run)
    if (groupIsOurs(run, table)) {
      for (const row of table) if (row.pgid === run.pgid) found.set(row.pid, row)
      // Descendants that left the group (a detached spawn, setsid) while their parent was still there.
      for (let grew = true; grew;) {
        grew = false
        for (const row of table) {
          if (!found.has(row.pid) && ((!leaderGone && row.ppid === run.pgid) || found.has(row.ppid))) { found.set(row.pid, row); grew = true }
        }
      }
    }
    // The daemon the run started, by the pid file it wrote, once nothing links it to the run any more.
    const pid = readPid(join(run.root, 'data', 'adapter.pid'))
    const daemon = pid ? table.find((row) => row.pid === pid) : undefined
    if (daemon && this.isDaemon(daemon.command, run)) found.set(daemon.pid, daemon)
    // An orphan that names the run's throwaway root on its command line, whatever its group and parent
    // now. The roots are unique temporary folders, so this never reaches another test's processes.
    for (const row of table) if (row.command.includes(run.root)) found.set(row.pid, row)
    found.delete(process.pid)
    found.delete(process.ppid)
    found.delete(1)
    return [...found.values()]
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
      ...this.belonging(run, table).map((row) => `${run.label}: pid ${row.pid} ${row.command.slice(0, 160)}`),
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
    return rows.filter((row) => alive(row.pid)).map((row) => `pid ${row.pid} ${row.command.slice(0, 160)}`)
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
