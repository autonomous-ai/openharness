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
 * A terminal app's tab: a fresh pseudo-terminal with the command as its child (pty.fork + exec, as ptyRoundTrip.py), and
 * the test as the person at the keyboard. Prints the child's pid first, on stderr.
 *
 * With `--say` before the command, the child's fd 3 is the helper's own stderr, where a shell in the tab says its
 * engine's pid (SHELL).
 */
const PTY = `
import os, pty, select, sys
say = sys.argv[1] == '--say'
argv = sys.argv[2:] if say else sys.argv[1:]
said = os.dup(2) if say else -1    # the helper's own stderr: the child's is the pseudo-terminal
pid, fd = pty.fork()
if pid == 0:
    if say:
        os.dup2(said, 3)
        os.set_inheritable(3, True)    # a dup2 onto itself leaves it closed on exec
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

/**
 * The shell a terminal app starts in its tab, run as `/bin/sh -i -c SHELL sh <engine>`: interactive, as a person's, so it
 * has job control. The engine is its foreground job, in a group of its own that holds the terminal's foreground, and it
 * says the engine's pid on fd 3 (PTY's `--say`). Ctrl+Z stops the engine and the shell takes the terminal back; like a
 * person's shell it stays after its engine, reading its terminal, until the terminal goes.
 */
const SHELL = `/bin/sh -c 'echo "engine $$" >&3; exec "$@" 3>&-' sh "$@"
while read -r _; do :; done`

/** The apps a test can start a tab under: the bundle and id macOS names, the executable Linux names. */
const FAKE_APPS = {
  ghostty: { bundle: 'Ghostty', id: 'com.mitchellh.ghostty', exe: 'ghostty' },
  vscode: { bundle: 'Visual Studio Code', id: 'com.microsoft.VSCode', exe: 'code' },
  cursor: { bundle: 'Cursor', id: 'com.todesktop.230313mzl4w4u92', exe: 'cursor' },
} as const
export type FakeApp = keyof typeof FAKE_APPS

/**
 * What the fake app runs: the command it is given (the tab's pseudo-terminal) on its own stdio,
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
    readonly shellPid?: number) {}

  /** The dial's id for it. */
  get id(): string { return observedAgentId('claude', this.sessionId) }

  /**
   * With [app], the tab runs under a fake of it: the engine's parents are the pseudo-terminal, the app, the test. With
   * `shell`, a real `/bin/sh` runs in the pseudo-terminal and the engine is its foreground job (SHELL), as the shell a
   * terminal app starts for its tab.
   */
  static async start(d: IsolatedDaemon, folder: string, hints: Record<string, string>, app?: FakeApp,
    { shell = false } = {}): Promise<Outside> {
    const { tab, pid, shellPid } = await Outside.open(d, folder, hints, app, shell)
    // Its conversation, as its SessionStart hook named it once that hook had run.
    const started = new RegExp(`claude pid=${pid} SessionStart\\(startup\\) session=(\\S+) ran`)
    const sessionId = await until(`${folder} to run its SessionStart hook`, () => d.hookLog().match(started)?.[1], 30_000, 100)
    return new Outside(tab, pid, sessionId, folder, undefined, shellPid)
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

  /** The tab, once it said the engine's pid (and with [shell], the shell's). */
  private static async open(d: IsolatedDaemon, folder: string, hints: Record<string, string>, app?: FakeApp, shell = false):
    Promise<{ tab: ChildProcess; pid: number; shellPid?: number }> {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    // d.env carries none of the developer's host hints (testing/daemonEnvironment.ts): only [hints] name the app.
    const env: NodeJS.ProcessEnv = { ...d.env, TERM: 'xterm-256color' }
    const shellCommand = shell ? ['--say', '/bin/sh', '-i', '-c', SHELL, 'sh'] : []
    const command = ['python3', '-c', PTY, ...shellCommand, d.env.CLAUDE_PATH!]
    const [file, ...args] = app ? [fakeApp(d, app), '-e', UNDER_APP, ...command] : command
    const tab = spawn(file, args, { cwd, env: { ...env, ...hints }, stdio: ['pipe', 'pipe', 'pipe'] })
    tab.stdout!.resume()
    // The tab's child's pid and, with a shell, the engine's line come from two processes, in either order.
    const { child, engine } = await new Promise<{ child: number; engine?: number }>((resolve, reject) => {
      let said = ''
      tab.stderr!.on('data', (chunk: Buffer) => {
        said += chunk.toString('utf8')
        const lines = said.split('\n').slice(0, -1)
        const engine = lines.find((line) => line.startsWith('engine '))
        const child = lines.find((line) => line !== engine)
        if (child && (!shell || engine)) resolve({ child: Number(child), engine: engine ? Number(engine.slice('engine '.length)) : undefined })
      })
      tab.once('exit', (code) => reject(new Error(`the terminal tab exited (${code}): ${said}`)))
    })
    return shell ? { tab, pid: engine!, shellPid: child } : { tab, pid: child }
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
   * With `shell`: Ctrl+Z, as a person types it, and the engine leaves its terminal's foreground, a job its shell stopped.
   * Resolves once `ps -o pgid=,tpgid=` of the engine shows another group in front.
   */
  async background(): Promise<void> {
    if (this.shellPid === undefined) throw new Error(`${this.folder} was started without a shell`)
    this.tab.stdin!.write('\x1a')
    await until(`${this.folder}'s engine in the background`, async () => {
      const { stdout } = await execFileAsync('ps', ['-o', 'pgid=,tpgid=', '-p', String(this.pid)])
      const [pgid, tpgid] = stdout.trim().split(/\s+/).map(Number)
      return tpgid > 0 && pgid !== tpgid
    }, 10_000, 50)
  }

  /** The process gone at once, with no hook: a crash, a closed terminal. */
  kill(): void {
    try {
      // A suspended engine is stopped: continued, as a shell continues a stopped job it kills.
      process.kill(this.pid, 'SIGCONT')
      process.kill(this.pid, 'SIGKILL')
    } catch { /* already gone */ }
  }

  async close(): Promise<void> {
    this.kill()
    const shell = this.shellPid
    try {
      if (shell !== undefined) {
        // The shell stays after its engine and holds the terminal open, so the tab's helper reads on while it lives:
        // killed, and waited for, gone once the helper, its parent, ends with the terminal, so nothing of the test
        // outlives it.
        try { process.kill(shell, 'SIGKILL') } catch { /* already gone */ }
        await until(`${this.folder}'s shell gone`, () => {
          try { process.kill(shell, 0) } catch { return true }
          return false
        }, 10_000, 50)
      }
    } finally {
      // The tab goes too when the wait failed: the failure is reported, and the tab never outlives the test.
      if (this.tab.exitCode === null && this.tab.signalCode === null) {
        const exited = new Promise<void>((done) => this.tab.once('exit', () => done()))
        this.tab.kill('SIGKILL')
        await exited
      }
    }
  }
}
