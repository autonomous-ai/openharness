/**
 * Claude Code started outside Harness, as a terminal app starts it (the end-to-end suite's fake engine): no tmux pane,
 * no Harness pane, and the app it runs in named by the hints a test gives it (hook/notify.mjs HOST_HINTS) and, when a
 * test asks, by a fake of that app above it, as the open scan reads its parents (src/cable/hosts/scannedApp.ts).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { until, type IsolatedDaemon } from './daemon.js'

const execFileAsync = promisify(execFile)

/**
 * A terminal app's tab: a fresh pseudo-terminal with the engine as its child (pty.fork + exec, as ptyRoundTrip.py), and
 * the test as the person at the keyboard. Prints the engine's pid first, on stderr.
 *
 * With `--jobs` before the engine's command, the engine's session holds a second process, as a shell's other job, and
 * `jobs <pid>` of it is printed on stderr too: on SIGUSR1 it takes the terminal's foreground for a group of its own, so
 * the engine is a background job (Outside.background).
 */
const PTY = `
import os, pty, select, signal, sys
jobs = sys.argv[1] == '--jobs'
argv = sys.argv[2:] if jobs else sys.argv[1:]
said = os.dup(2) if jobs else -1    # the helper's own stderr: the child's is the pseudo-terminal
pid, fd = pty.fork()
if pid == 0:
    if jobs:
        if os.fork() == 0:
            # A second process of the engine's session, as a shell's other job: only a member of the session may
            # move its terminal's foreground group, and the engine, which leads the session, cannot leave its group.
            signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR1})
            os.write(said, b'jobs %d\\n' % os.getpid())
            os.close(said)
            signal.sigwait({signal.SIGUSR1})
            signal.signal(signal.SIGTTOU, signal.SIG_IGN)   # a background group calling tcsetpgrp is stopped otherwise
            os.setpgid(0, 0)
            os.tcsetpgrp(0, os.getpgrp())
            signal.pause()                                  # it ends with the session: SIGHUP when the engine goes
            os._exit(0)
        os.close(said)
    os.execvp(argv[0], argv)
sys.stderr.write('%d\\n' % pid)
sys.stderr.flush()
inputs = [fd, sys.stdin.fileno()]
while True:
    ready, _, _ = select.select(inputs, [], [])
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            os.write(fd, data)
        else:
            inputs = [fd]
`

/** The apps a test can start a tab under: the bundle and id macOS names, the executable Linux names. */
const FAKE_APPS = {
  ghostty: { bundle: 'Ghostty', id: 'com.mitchellh.ghostty', exe: 'ghostty' },
  vscode: { bundle: 'Visual Studio Code', id: 'com.microsoft.VSCode', exe: 'code' },
} as const
export type FakeApp = keyof typeof FAKE_APPS

/**
 * What the fake app runs: the command it is given (the tab's pseudo-terminal, or a shell that runs it) on its own stdio,
 * gone when it goes. Node 24 names its main thread MainThread, which on Linux is the process's task name, the `comm` the
 * scan reads: the fake takes back the name it was started under, as the app it fakes keeps its own. macOS's `comm` is the
 * path it was started from, which no name moves.
 */
const UNDER_APP = `
if (process.platform === 'linux') process.title = require('node:path').basename(process.argv0)
const tab = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit' })
tab.on('exit', (code) => process.exit(code ?? 1))
`

/**
 * [app]'s executable, made once under the throwaway root: Node under the app's name, which is all `ps` shows of it.
 * On macOS a bundle under the daemon's home's Applications folder, one of the folders the scan reads bundles in; it
 * is never one of the developer's.
 */
function fakeApp(d: IsolatedDaemon, app: FakeApp): string {
  const { bundle, id, exe } = FAKE_APPS[app]
  const contents = join(d.env.HOME!, 'Applications', `${bundle}.app`, 'Contents')
  const path = process.platform === 'darwin' ? join(contents, 'MacOS', exe) : join(d.root, 'apps', exe)
  if (existsSync(path)) return path
  mkdirSync(dirname(path), { recursive: true })
  if (process.platform === 'darwin') {
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>
`)
  }
  symlinkSync(process.execPath, path)
  return path
}

/** Claude Code in a terminal app outside Harness: no tmux pane, no Harness pane. */
export class Outside {
  /** [home]: the config folder it was started in, when not the daemon's own. */
  private constructor(private readonly tab: ChildProcess, readonly pid: number, readonly sessionId: string, readonly folder: string,
    private readonly home?: string,
    /** With `shell`, the shell's pid: the one a terminal app reports for its tab. */
    readonly shellPid?: number,
    /** With `jobs`, the pid of the other job in the engine's session (PTY). */
    private readonly jobPid?: number) {}

  /** The dial's id for it. */
  get id(): string { return observedAgentId('claude', this.sessionId) }

  /**
   * With [app], the tab runs under a fake of it: the engine's parents are the pseudo-terminal, the app, the test. With
   * `shell`, a real `/bin/sh` sits between the app and the pseudo-terminal, as the shell a terminal app starts for its tab.
   * With `jobs`, another job shares the engine's terminal, and background() hands it the foreground.
   */
  static async start(d: IsolatedDaemon, folder: string, hints: Record<string, string>, app?: FakeApp,
    { shell = false, jobs = false } = {}): Promise<Outside> {
    const { tab, pid, shellPid, jobPid } = await Outside.open(d, folder, hints, app, shell, jobs)
    // Its conversation, as its SessionStart hook named it once that hook had run.
    const started = new RegExp(`claude pid=${pid} SessionStart\\(startup\\) session=(\\S+) ran`)
    const sessionId = await until(`${folder} to run its SessionStart hook`, () => d.hookLog().match(started)?.[1], 30_000, 100)
    return new Outside(tab, pid, sessionId, folder, undefined, shellPid, jobPid)
  }

  /**
   * In a config folder of its own, [home] as CLAUDE_CONFIG_DIR, as Orca starts an account's Claude Code. Harness put no
   * hooks there, so no hook names its conversation: the process record it writes in that home does.
   */
  static async startIn(d: IsolatedDaemon, folder: string, home: string, hints: Record<string, string>): Promise<Outside> {
    const { tab, pid } = await Outside.open(d, folder, { ...hints, CLAUDE_CONFIG_DIR: home })
    const record = join(home, 'sessions', `${pid}.json`)
    const sessionId = await until(`${folder} to write its process record`, () => {
      try { return (JSON.parse(readFileSync(record, 'utf8')) as { sessionId?: string }).sessionId } catch { return undefined }
    }, 30_000, 100)
    return new Outside(tab, pid, sessionId, folder, home)
  }

  /** The tab, once it said the engine's pid (and with [shell], the shell's first; with [jobs], its other job's). */
  private static async open(d: IsolatedDaemon, folder: string, hints: Record<string, string>, app?: FakeApp, shell = false,
    jobs = false): Promise<{ tab: ChildProcess; pid: number; shellPid?: number; jobPid?: number }> {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    // d.env carries none of the developer's host hints (testing/daemonEnvironment.ts): only [hints] name the app.
    const env: NodeJS.ProcessEnv = { ...d.env, TERM: 'xterm-256color' }
    // The shell prints its pid first. The tab is not its last command, so it cannot replace itself with the tab: it stays
    // the tab's parent, as a person's shell does.
    const tabCommand = ['python3', '-c', PTY, ...(jobs ? ['--jobs'] : []), d.env.CLAUDE_PATH!]
    const command = shell ? ['/bin/sh', '-c', 'echo $$ >&2; "$@"; exit $?', 'sh', ...tabCommand] : tabCommand
    const [file, ...args] = app ? [fakeApp(d, app), '-e', UNDER_APP, ...command] : command
    const tab = spawn(file, args, { cwd, env: { ...env, ...hints }, stdio: ['pipe', 'pipe', 'pipe'] })
    tab.stdout!.resume()
    // The other job's line and the engine's pid come from two processes, in either order.
    const { pids, jobPid } = await new Promise<{ pids: number[]; jobPid?: number }>((resolve, reject) => {
      let said = ''
      tab.stderr!.on('data', (chunk: Buffer) => {
        said += chunk.toString('utf8')
        const lines = said.split('\n').slice(0, -1)
        const job = lines.find((line) => line.startsWith('jobs '))
        const pids = lines.filter((line) => line !== job).map(Number)
        if (pids.length >= (shell ? 2 : 1) && (!jobs || job)) resolve({ pids, jobPid: job ? Number(job.slice('jobs '.length)) : undefined })
      })
      tab.once('exit', (code) => reject(new Error(`the terminal tab exited (${code}): ${said}`)))
    })
    const [shellPid, pid] = shell ? pids : [undefined, pids[0]]
    return { tab, pid, shellPid, jobPid }
  }

  /** Typed at its prompt, then Enter, as a person does. */
  type(text: string): void {
    this.tab.stdin!.write(text)
    this.tab.stdin!.write('\r')
  }

  /** Its process record (fakeEngine.mjs announceProcess), in the config folder it runs in, which nothing rewrites later. */
  private record(d: IsolatedDaemon): string {
    return join(this.home ?? dirname(d.env.CLAUDE_PROJECTS_DIR!), 'sessions', `${this.pid}.json`)
  }

  /** Until its process record says it is idle, as Claude Code's says once a turn and its Stop hooks are over. */
  async idle(d: IsolatedDaemon): Promise<void> {
    await until(`${this.folder} to be idle in its record`, () => {
      try { return (JSON.parse(readFileSync(this.record(d), 'utf8')) as { status?: unknown }).status === 'idle' || null } catch { return null }
    }, 30_000, 100)
  }

  /**
   * Named as Claude Code names a session in its own process record: [fields].nameSource `user` for a name the person
   * gave it, `derived` for one Claude Code made up; the Claude app's record has `entrypoint: 'claude-desktop'` and no
   * nameSource. Once the engine is idle, as it writes its record again only at its next prompt, so this write never
   * races its own; written beside it and renamed over, so the daemon never reads half.
   */
  async named(d: IsolatedDaemon, name: string, fields: { nameSource?: 'user' | 'derived'; entrypoint?: string }): Promise<void> {
    await this.idle(d)
    const record = this.record(d)
    const row = JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>
    writeFileSync(`${record}.tmp`, JSON.stringify({ ...row, name, ...fields }))
    renameSync(`${record}.tmp`, record)
  }

  /** Whether its hook for [event] has run since the engine started, as the engine noted it. */
  ran(d: IsolatedDaemon, event: string, times = 1): boolean {
    const line = new RegExp(`claude pid=${this.pid} ${event}\\S* session=${this.sessionId} ran`, 'g')
    return (d.hookLog().match(line)?.length ?? 0) >= times
  }

  /**
   * With `jobs`: the engine leaves its terminal's foreground, as a job a shell stopped or put in the background. Resolves
   * once `ps -o pgid=,tpgid=` of the engine shows another group in front.
   */
  async background(): Promise<void> {
    if (this.jobPid === undefined) throw new Error(`${this.folder} was started without jobs`)
    process.kill(this.jobPid, 'SIGUSR1')
    await until(`${this.folder}'s engine in the background`, async () => {
      const { stdout } = await execFileAsync('ps', ['-o', 'pgid=,tpgid=', '-p', String(this.pid)])
      const [pgid, tpgid] = stdout.trim().split(/\s+/).map(Number)
      return tpgid > 0 && pgid !== tpgid
    }, 10_000, 50)
  }

  /** The process gone at once, with no hook: a crash, a closed terminal. */
  kill(): void {
    try {
      // A backgrounded engine that touched its terminal may be stopped (SIGTTIN, SIGTTOU): continued, as a shell
      // continues a stopped job it kills.
      process.kill(this.pid, 'SIGCONT')
      process.kill(this.pid, 'SIGKILL')
    } catch { /* already gone */ }
  }

  async close(): Promise<void> {
    this.kill()
    const job = this.jobPid
    if (job !== undefined) {
      // The other job holds the terminal open, so the tab's helper reads on while it lives. It goes with the engine's
      // session (SIGHUP) as a rule; killed here should it not, and waited for, so nothing of the test outlives it.
      try { process.kill(job, 'SIGKILL') } catch { /* already gone */ }
      await until(`${this.folder}'s other job gone`, () => {
        try { process.kill(job, 0) } catch { return true }
        return false
      }, 10_000, 50)
    }
    if (this.tab.exitCode !== null || this.tab.signalCode !== null) return
    const exited = new Promise<void>((done) => this.tab.once('exit', () => done()))
    this.tab.kill('SIGKILL')
    await exited
  }
}
