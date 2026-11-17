/**
 * Claude Code started outside Harness, as a terminal app starts it (the end-to-end suite's fake engine): no tmux pane,
 * no Harness pane, and the app it runs in named by the hints a test gives it (hook/notify.mjs HOST_HINTS) and, when a
 * test asks, by a fake of that app above it, as the open scan reads its parents (src/cable/hosts/scannedApp.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { until, type IsolatedDaemon } from './daemon.js'

/**
 * A terminal app's tab: a fresh pseudo-terminal with the engine as its child (pty.fork + exec, as ptyRoundTrip.py), and
 * the test as the person at the keyboard. Prints the engine's pid first, on stderr.
 */
const PTY = `
import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
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
 * What the fake app runs: the tab's pseudo-terminal on its own stdio, gone when it goes. Node 24 names its main thread
 * MainThread, which on Linux is the process's task name, the `comm` the scan reads: the fake takes back the name it was
 * started under, as the app it fakes keeps its own. macOS's `comm` is the path it was started from, which no name moves.
 */
const UNDER_APP = `
if (process.platform === 'linux') process.title = require('node:path').basename(process.argv0)
const tab = require('node:child_process').spawn('python3', ['-c', ...process.argv.slice(1)], { stdio: 'inherit' })
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
    private readonly home?: string) {}

  /** The dial's id for it. */
  get id(): string { return observedAgentId('claude', this.sessionId) }

  /** With [app], the tab runs under a fake of it: the engine's parents are the pseudo-terminal, the app, the test. */
  static async start(d: IsolatedDaemon, folder: string, hints: Record<string, string>, app?: FakeApp): Promise<Outside> {
    const { tab, pid } = await Outside.open(d, folder, hints, app)
    // Its conversation, as its SessionStart hook named it once that hook had run.
    const started = new RegExp(`claude pid=${pid} SessionStart\\(startup\\) session=(\\S+) ran`)
    const sessionId = await until(`${folder} to run its SessionStart hook`, () => d.hookLog().match(started)?.[1], 30_000, 100)
    return new Outside(tab, pid, sessionId, folder)
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

  /** The tab, once it said the engine's pid. */
  private static async open(d: IsolatedDaemon, folder: string, hints: Record<string, string>, app?: FakeApp): Promise<{ tab: ChildProcess; pid: number }> {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    // d.env carries none of the developer's host hints (testing/daemonEnvironment.ts): only [hints] name the app.
    const env: NodeJS.ProcessEnv = { ...d.env, TERM: 'xterm-256color' }
    const [command, args] = app ? [fakeApp(d, app), ['-e', UNDER_APP, PTY, d.env.CLAUDE_PATH!]] : ['python3', ['-c', PTY, d.env.CLAUDE_PATH!]]
    const tab = spawn(command, args, { cwd, env: { ...env, ...hints }, stdio: ['pipe', 'pipe', 'pipe'] })
    tab.stdout!.resume()
    const pid = await new Promise<number>((resolve, reject) => {
      let said = ''
      tab.stderr!.on('data', (chunk: Buffer) => {
        said += chunk.toString('utf8')
        if (said.includes('\n')) resolve(Number(said.split('\n')[0]))
      })
      tab.once('exit', (code) => reject(new Error(`the terminal tab exited (${code}): ${said}`)))
    })
    return { tab, pid }
  }

  /** Typed at its prompt, then Enter, as a person does. */
  type(text: string): void {
    this.tab.stdin!.write(text)
    this.tab.stdin!.write('\r')
  }

  /**
   * Named as Claude Code names a session in its own process record: [nameSource] `user` for a name the person gave it,
   * `derived` for one Claude Code made up. The record is the one the engine wrote as it started (fakeEngine.mjs
   * announceProcess) in the config folder it runs in, which nothing rewrites later; written beside it and renamed over,
   * so the daemon never reads half.
   */
  named(d: IsolatedDaemon, name: string, nameSource: 'user' | 'derived'): void {
    const record = join(this.home ?? dirname(d.env.CLAUDE_PROJECTS_DIR!), 'sessions', `${this.pid}.json`)
    const row = JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>
    writeFileSync(`${record}.tmp`, JSON.stringify({ ...row, name, nameSource }))
    renameSync(`${record}.tmp`, record)
  }

  /** Whether its hook for [event] has run since the engine started, as the engine noted it. */
  ran(d: IsolatedDaemon, event: string, times = 1): boolean {
    const line = new RegExp(`claude pid=${this.pid} ${event}\\S* session=${this.sessionId} ran`, 'g')
    return (d.hookLog().match(line)?.length ?? 0) >= times
  }

  /** The process gone at once, with no hook: a crash, a closed terminal. */
  kill(): void {
    try { process.kill(this.pid, 'SIGKILL') } catch { /* already gone */ }
  }

  async close(): Promise<void> {
    this.kill()
    if (this.tab.exitCode !== null || this.tab.signalCode !== null) return
    const exited = new Promise<void>((done) => this.tab.once('exit', () => done()))
    this.tab.kill('SIGKILL')
    await exited
  }
}
