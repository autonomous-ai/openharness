/**
 * Claude Code started outside Harness, as a terminal app starts it (the end-to-end suite's fake engine): no tmux pane,
 * no Harness pane, and the app it runs in named by the hints a test gives it (hook/notify.mjs HOST_HINTS) and, when a
 * test asks, by a fake of that app above it, as the open scan reads its parents (src/cable/hosts/scannedApp.ts).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { startTimes } from '../../src/testing/spawnedRuns.js'
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
  'terminal-app': { bundle: 'Terminal', id: 'com.apple.Terminal', exe: 'Terminal' },
  // The Claude app, whose Code sessions run Claude Code under it.
  'claude-app': { bundle: 'Claude', id: 'com.anthropic.claudefordesktop', exe: 'claude-desktop' },
  // Its tabs run under its server (underApp). macOS only.
  iterm: { bundle: 'iTerm', id: 'com.googlecode.iterm2', exe: 'iTerm2' },
} as const
/**
 * iTerm2's server: its copy in iTerm2's folder of the daemon's home, with no bundle, forking every tab
 * (cable/hosts/scannedApp.ts isItermServer). macOS only. As `iterm-server`, it runs as it does once iTerm2 relaunched
 * with its sessions kept (Diego's report of 2026-11-22): a tab tabUnder opens under it is launchd's child, as that copy
 * is; Outside's engine runs under it as the test's child. Under the fake `iterm`, it is that app's child, one per tab.
 */
export function itermServerPath(d: IsolatedDaemon): string {
  return join(d.env.HOME!, 'Library', 'Application Support', 'iTerm2', 'iTermServer-3.6.6')
}
export type FakeApp = keyof typeof FAKE_APPS | 'iterm-server'

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
  if (app === 'iterm-server') {
    if (process.platform !== 'darwin') throw new Error("iTerm2's server is faked on macOS only")
    const path = itermServerPath(d)
    if (existsSync(path)) return path
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(process.execPath, path)
    return path
  }
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

/**
 * What runs a command under a fake [app]: the app, and under iTerm2 its server between them, which says its pid
 * (SAYS_SERVER) and becomes the server, the app's child: once the app ended (relaunchIterm) the server is launchd's,
 * and only its pid reaches it.
 */
function underApp(d: IsolatedDaemon, app: FakeApp): string[] {
  const under = [fakeApp(d, app), '-e', UNDER_APP]
  return app === 'iterm' ? [...under, '/bin/sh', '-c', SAYS_SERVER, 'sh', fakeApp(d, 'iterm-server'), '-e', UNDER_APP] : under
}

/** The shell a person's Terminal runs an app from (`code .`): it waits for the app, which it does not exec. */
const LAUNCHED = '"$@"; exit $?'
/** A command an app runs with no terminal: it says its pid, as the pseudo-terminal's helper says its child's, then
 *  becomes the command, whose parent is the app. */
const SAYS_PID = 'echo $$ >&2; exec "$@"'
/** iTerm2's server as the fake iTerm2 starts it: it says its pid, apart from the tab's, then becomes the server. */
const SAYS_SERVER = 'echo "server $$" >&2; exec "$@"'
/** The line a tab's helper (PTY), or SAYS_PID, says its command's pid on: the pid alone. */
const PID_LINE = /^\d+$/

/** A command in a tab of its own (openTab), the shell it runs in there when it has one, the fake iTerm2's process when
 *  the tab's outermost app is iTerm2 (relaunchIterm), and when each of them started, read as the tab said their pids:
 *  what a kill of any checks first (signalOwn). */
export interface Tab {
  readonly process: ChildProcess; readonly pid: number; readonly shellPid?: number; readonly appPid?: number
  readonly started: ReadonlyMap<number, string>
}
/** The app a tab is in, whether its command runs in a shell, the app that app was started from, and whether it has a
 *  terminal (openTab). */
export interface TabOptions { app?: FakeApp; shell?: boolean; launchedFrom?: FakeApp; terminal?: boolean }

/**
 * A tab running [command] on a pseudo-terminal of its own (PTY), in [cwd] under [env] alone, under a fake [app] when one
 * is given. With `shell`, a real `/bin/sh` runs in the pseudo-terminal and the command is its foreground job (SHELL), as
 * the shell a terminal app starts for its tab. With `launchedFrom`, the app was started from a shell in a fake of that
 * app, as `code .` in Terminal starts it, so `ps` reads Terminal → shell → app → shell → command. With `terminal: false`,
 * the command is a process of the app's own with no terminal, as Cursor runs its agent: in a session of its own, so it
 * holds no terminal of the test's either. Resolves once the tab said the command's pid (and with `shell`, the shell's).
 */
export async function openTab(d: IsolatedDaemon, cwd: string, env: NodeJS.ProcessEnv, command: readonly string[],
  { app, shell = false, launchedFrom, terminal = true }: TabOptions = {}): Promise<Tab> {
  if (shell && !terminal) throw new Error('a shell runs in a terminal')
  const shellCommand = shell ? ['--say', '/bin/sh', '-i', '-c', SHELL, 'sh'] : []
  const inTab = terminal ? ['python3', '-c', PTY, ...shellCommand, ...command] : ['/bin/sh', '-c', SAYS_PID, 'sh', ...command]
  const inApp = app ? [...underApp(d, app), ...inTab] : inTab
  const [file, ...args] = launchedFrom ? [...underApp(d, launchedFrom), '/bin/sh', '-c', LAUNCHED, 'sh', ...inApp] : inApp
  const tab = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !terminal })
  const appPid = (launchedFrom ?? app) === 'iterm' ? tab.pid : undefined
  tab.stdout!.resume()
  // The tab's child's pid and, with a shell, the engine's line come from two processes, in either order; iTerm2's
  // server's too, which it says before it becomes the server and starts what says the child's.
  const { child, engine, servers } = await new Promise<{ child: number; engine?: number; servers: number[] }>((resolve, reject) => {
    let said = ''
    tab.stderr!.on('data', (chunk: Buffer) => {
      said += chunk.toString('utf8')
      const lines = said.split('\n').slice(0, -1)
      const engine = lines.find((line) => line.startsWith('engine '))
      const child = lines.find((line) => PID_LINE.test(line))
      const servers = lines.flatMap((line) => line.startsWith('server ') ? [Number(line.slice('server '.length))] : [])
      if (child && (!shell || engine)) resolve({ child: Number(child), engine: engine ? Number(engine.slice('engine '.length)) : undefined, servers })
    })
    tab.once('exit', (code) => reject(new Error(`the terminal tab exited (${code}): ${said}`)))
  })
  // Noted for the close's sweep and the reaper: the fake iTerm2's server is launchd's once that app ends, and the tab's
  // own process once the worker does.
  for (const pid of [tab.pid!, ...servers]) d.own(pid)
  const started = startTimes([child, ...(engine === undefined ? [] : [engine]), ...(appPid === undefined ? [] : [appPid])])
  return shell ? { process: tab, pid: engine!, shellPid: child, appPid, started } : { process: tab, pid: child, appPid, started }
}

/** A tab's keys typed after the process they go in through ended (typeInto). */
export class NoKeys extends Error {
  constructor() {
    super('the tab takes no keys: the process its keys go in through has ended')
    this.name = 'NoKeys'
  }
}

/**
 * [text] keyed into a tab through the stdin of [tab], its outermost process, which the tab's pseudo-terminal's helper
 * reads. Node closes that stdin as the process ends, the fake iTerm2's at relaunchIterm among them, and keys written
 * after would be lost without a word: they throw NoKeys instead.
 */
export function typeInto(tab: ChildProcess, text: string): void {
  if (tab.exitCode !== null || tab.signalCode !== null) throw new NoKeys()
  tab.stdin!.write(text)
}

/** Whether no process has [pid]. */
export function gone(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return true }
  return false
}

/** Whether [pid] runs as the process that started when [started] says (startTimes, read as the test started it): not
 *  once another process has its pid, nor when its start was never read. */
function runsAsItself(pid: number, started: ReadonlyMap<number, string>): boolean {
  const start = started.get(pid)
  return start !== undefined && startTimes([pid]).get(pid) === start
}

/** Whether [pid]'s process, as [started] says it started, is gone: a process given its pid since is not it. */
function goneOwn(pid: number, started: ReadonlyMap<number, string>): boolean {
  return gone(pid) || !runsAsItself(pid, started)
}

/** [signals] sent to [pid] in turn while it runs as itself (runsAsItself): never to one given its pid since. */
function signalOwn(pid: number, started: ReadonlyMap<number, string>, ...signals: NodeJS.Signals[]): void {
  if (!runsAsItself(pid, started)) return
  try {
    for (const signal of signals) process.kill(pid, signal)
  } catch { /* already gone */ }
}

/** The process gone at once, with no hook: a crash, a closed terminal. A suspended engine is stopped: continued first,
 *  as a shell continues a stopped job it kills. */
function killNow(pid: number, started: ReadonlyMap<number, string>): void {
  signalOwn(pid, started, 'SIGCONT', 'SIGKILL')
}

/** The tab's command killed, then its shell, and the tab: nothing of it outlives the test. [what] names it in a failure. */
export async function closeTab(tab: Tab, what: string): Promise<void> {
  killNow(tab.pid, tab.started)
  const shell = tab.shellPid
  try {
    if (shell !== undefined) {
      // The shell stays after its engine and holds the terminal open, so the tab's helper reads on while it lives:
      // killed, and waited for, gone once the helper, its parent, ends with the terminal, so nothing of the test
      // outlives it.
      signalOwn(shell, tab.started, 'SIGKILL')
      await until(`${what}'s shell gone`, () => gone(shell), 10_000, 50)
    }
  } finally {
    // The tab goes too when the wait failed: the failure is reported, and the tab never outlives the test.
    if (tab.process.exitCode === null && tab.process.signalCode === null) {
      const exited = new Promise<void>((done) => tab.process.once('exit', () => done()))
      tab.process.kill('SIGKILL')
      await exited
    }
  }
}

/** The tab gone at once, with no wait: its command, its shell and the tab killed, as the driver's last resort ends what
 *  it cannot wait for. The pseudo-terminal's helper ends with its terminal. */
export function killTab(tab: Tab): void {
  killNow(tab.pid, tab.started)
  if (tab.shellPid !== undefined) killNow(tab.shellPid, tab.started)
  tab.process.kill('SIGKILL')
}

/**
 * A tab of a fake [app] running [argv] on a pseudo-terminal of its own (PTY), under [env] alone: its parents are the
 * pseudo-terminal's helper, the app, the test; under the fake iTerm2, the helper, iTerm2's server, the app, the test
 * ([appPid] the app's process, relaunchIterm); under `iterm-server`, the helper, the server, launchd. [pid] is the
 * command's own process. [type] keys [text] into the tab's pseudo-terminal, as the person at its keyboard; under
 * `iterm-server` there is none, as the tab's helper is started in the background with no input. Closed, the command is
 * killed and the tab waited for, so nothing of it outlives the test.
 */
export async function tabUnder(d: IsolatedDaemon, app: FakeApp, argv: readonly string[], env: NodeJS.ProcessEnv):
  Promise<{ pid: number; appPid?: number; started: ReadonlyMap<number, string>; type?(text: string): void; close(): Promise<void> }> {
  if (app === 'iterm-server') return tabUnderItermServer(d, argv, env)
  const [file, ...args] = [...underApp(d, app), 'python3', '-c', PTY, ...argv]
  const tab = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  tab.stdout!.resume()
  const exited = new Promise<void>((done) => tab.once('exit', () => done()))
  const iterm = app === 'iterm'
  // The helper's line and iTerm2's server's come from two processes, in either order.
  const { pid, server } = await new Promise<{ pid: number; server?: number }>((resolve, reject) => {
    let said = ''
    tab.stderr!.on('data', (chunk: Buffer) => {
      said += chunk.toString('utf8')
      const lines = said.split('\n').slice(0, -1)
      const server = lines.find((line) => line.startsWith('server '))
      const child = lines.find((line) => PID_LINE.test(line))
      if (child && (!iterm || server)) resolve({ pid: Number(child), server: server ? Number(server.slice('server '.length)) : undefined })
    })
    tab.once('exit', (code) => reject(new Error(`the terminal tab exited (${code}): ${said}`)))
  })
  // Noted for the close's sweep and the reaper: the fake iTerm2's server is launchd's once that app ends (relaunchIterm),
  // and the app once the worker does.
  for (const noted of [tab.pid!, ...(server === undefined ? [] : [server])]) d.own(noted)
  const started = startTimes([pid, ...(server === undefined ? [] : [server]), ...(iterm ? [tab.pid!] : [])])
  return {
    pid,
    ...(iterm ? { appPid: tab.pid } : {}),
    started,
    // The app's stdin is its helper's, which writes it to the pseudo-terminal.
    type: (text) => typeInto(tab, text),
    async close() {
      signalOwn(pid, started, 'SIGKILL')
      // The helper ends with its pseudo-terminal, then iTerm2's server, then the app; one that does not is killed. The
      // server, launchd's once the app ended, is waited for by its pid.
      const timer = setTimeout(() => {
        tab.kill('SIGKILL')
        if (server !== undefined) killNow(server, started)
      }, 5_000)
      try {
        await exited
        if (server !== undefined) await until("iTerm2's server gone", () => goneOwn(server, started), 10_000, 50)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** The fake iTerm2 ends while it runs as itself, [started] read as the tab opened; its server and tab run on under
 *  launchd, as iTerm2 relaunched keeping its sessions. */
export async function relaunchIterm(tab: { appPid?: number; started: ReadonlyMap<number, string> }): Promise<void> {
  const app = tab.appPid
  if (app === undefined) throw new Error('not a tab of the fake iTerm2')
  signalOwn(app, tab.started, 'SIGKILL')
  // Its server is launchd's from then on.
  await until('the fake iTerm2 gone', () => goneOwn(app, tab.started), 10_000, 50)
}

/** tabUnder's tab under iTerm2's server, which a /bin/sh starts, says the pid of, and leaves at once: launchd adopts it
 *  (ppid 1). Resolved once that /bin/sh is gone. */
async function tabUnderItermServer(d: IsolatedDaemon, argv: readonly string[], env: NodeJS.ProcessEnv):
  Promise<{ pid: number; started: ReadonlyMap<number, string>; close(): Promise<void> }> {
  const tab = spawn('/bin/sh', ['-c', '"$@" & echo "server $!" >&2', 'sh', fakeApp(d, 'iterm-server'), '-e', UNDER_APP,
    'python3', '-c', PTY, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  tab.stdout!.resume()
  const left = new Promise<void>((done) => tab.once('exit', () => done()))
  // Held by the server and the helper, so closed once both are gone.
  let closed = false
  tab.stderr!.once('close', () => { closed = true })
  const { pid, server } = await new Promise<{ pid: number; server: number }>((resolve, reject) => {
    let said = ''
    tab.stderr!.on('data', (chunk: Buffer) => {
      said += chunk.toString('utf8')
      const lines = said.split('\n').slice(0, -1)
      const server = lines.find((line) => line.startsWith('server '))
      const child = lines.find((line) => line !== server)
      if (server && child) resolve({ pid: Number(child), server: Number(server.slice('server '.length)) })
    })
    tab.stderr!.once('close', () => reject(new Error(`the terminal tab exited: ${said}`)))
  })
  // launchd's from its start: only the note keeps it the test's for the close's sweep and the reaper.
  d.own(server)
  const started = startTimes([pid, server])
  await left
  return {
    pid,
    started,
    async close() {
      signalOwn(pid, started, 'SIGKILL')
      // launchd's child, not the test's: killed by its pid while it runs as itself, and gone once no signal reaches it
      // and the helper ended.
      signalOwn(server, started, 'SIGKILL')
      await until("iTerm2's server and its tab gone", () => goneOwn(server, started) && closed, 10_000, 50)
    },
  }
}

/**
 * An agent's own process that runs its hooks as its CLI runs them (codexOutside.ts, cursorOutside.ts): each line it is
 * handed, `{command, cwd, env, input}`, run through a shell, and answered with `{code, stderr}` once it ends. Named by its
 * first argument when there is one: Linux knows a process by that name (its comm), as it knows the ChatGPT app's. Given a
 * socket's path as its second, for one in a tab (hookTab), its hooks come and go on that socket instead of its stdin and
 * stdout.
 */
export const HOOK_RUNNER = `const { spawn } = require('node:child_process')
if (process.argv[1]) process.title = process.argv[1]
const channel = process.argv[2] ? require('node:net').connect(process.argv[2]) : undefined
const answers = channel ?? process.stdout
require('node:readline').createInterface({ input: channel ?? process.stdin }).on('line', (line) => {
  const { command, cwd, env, input } = JSON.parse(line)
  const hook = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  hook.stderr.on('data', (chunk) => { stderr += chunk })
  hook.on('close', (code) => answers.write(JSON.stringify({ code, stderr }) + '\\n'))
  hook.stdin.end(input)
})`
/** For a hook runner in a tab to reach its socket. */
const CONNECT_MS = 30_000
/** Each tab's socket a name of its own in the daemon's root. */
let channels = 0

/** One hook run by an agent's own process: its exit code and what it wrote on stderr. */
export type HookRun = (command: string, env: NodeJS.ProcessEnv, input: string) => Promise<{ code: number | null; stderr: string }>

/**
 * Each hook handed to a hook runner (HOOK_RUNNER) on [requests], run in [cwd], and its answer read on [answers]. One at a
 * time: the runner answers in the order its hooks end, so a hook asked while another runs waits for it, and two never
 * take each other's answers. A hook whose runner ended first fails, naming [what].
 */
export function hookRuns(answers: NodeJS.ReadableStream, requests: NodeJS.WritableStream, cwd: string, what: string): HookRun {
  const lines = createInterface({ input: answers })
  let ended = false
  lines.once('close', () => { ended = true })
  // A line written as the runner ends fails with EPIPE: its end is the failure already.
  requests.on('error', () => {})
  const ask: HookRun = (command, env, input) => new Promise((resolve, reject) => {
    const gone = (): void => {
      lines.off('line', answered)
      reject(new Error(`${what} ended before its hook did`))
    }
    const answered = (line: string): void => {
      lines.off('close', gone)
      resolve(JSON.parse(line) as { code: number | null; stderr: string })
    }
    if (ended) return gone()
    lines.once('line', answered)
    lines.once('close', gone)
    requests.write(`${JSON.stringify({ command, cwd, env, input })}\n`)
  })
  let last: Promise<unknown> = Promise.resolve()
  return (command, env, input) => {
    const run = last.then(() => ask(command, env, input))
    last = run.catch(() => {})
    return run
  }
}

/**
 * A hook runner (HOOK_RUNNER) in a tab of its own (openTab) in [cwd], under [env] alone, as [how] says: its stdio are its
 * terminal, or the app's, so its hooks come and go on a socket in the daemon's root. Resolves once it reached that socket;
 * [what] names it in a failure. Closed as any tab is (closeTab).
 */
export async function hookTab(d: IsolatedDaemon, cwd: string, env: NodeJS.ProcessEnv, how: TabOptions, what: string):
  Promise<{ tab: Tab; run: HookRun }> {
  const path = join(d.root, `hooks-${++channels}.sock`)
  const server = createServer()
  let socket: Socket | undefined
  server.once('connection', (connected) => { socket = connected })
  await new Promise<void>((listening, failed) => server.once('error', failed).listen(path, listening))
  let tab: Tab | undefined
  try {
    tab = await openTab(d, cwd, env, [process.execPath, '-e', HOOK_RUNNER, '', path], how)
    const connected = await until(`${what} on its socket`, () => socket, CONNECT_MS, 50)
    return { tab, run: hookRuns(connected, connected, cwd, what) }
  } catch (error) {
    if (tab) await closeTab(tab, what)
    throw error
  } finally {
    server.close()
  }
}

/** Claude Code in a terminal app outside Harness: no tmux pane, no Harness pane. */
export class Outside {
  /** [home]: the config folder it was started in, when not the daemon's own. */
  private constructor(private readonly tab: Tab, readonly sessionId: string, readonly folder: string, private readonly home?: string) {}

  get pid(): number { return this.tab.pid }
  /** With `shell`, the shell's pid: the one a terminal app reports for its tab. */
  get shellPid(): number | undefined { return this.tab.shellPid }
  /** Under the fake iTerm2, its process (relaunchIterm). */
  get appPid(): number | undefined { return this.tab.appPid }
  /** When its tab's processes started (Tab): what relaunchIterm checks the app's pid by. */
  get started(): ReadonlyMap<number, string> { return this.tab.started }

  /** The dial's id for it. */
  get id(): string { return observedAgentId('claude', this.sessionId) }

  /**
   * With [app], the tab runs under a fake of it: the engine's parents are the pseudo-terminal, the app, the test. With
   * `shell`, a real `/bin/sh` runs in the pseudo-terminal and the engine is its foreground job (SHELL), as the shell a
   * terminal app starts for its tab. With `resume`, it goes on in that conversation (`--resume <id>`), as the Claude app
   * starts one of its sessions again. With `launchedFrom`, the app was started from a shell in Terminal (openTab).
   */
  static async start(d: IsolatedDaemon, folder: string, hints: Record<string, string>, app?: FakeApp,
    { shell = false, resume, launchedFrom }: { shell?: boolean; resume?: string; launchedFrom?: 'terminal-app' } = {}): Promise<Outside> {
    const tab = await Outside.open(d, folder, hints, { app, shell, launchedFrom }, resume === undefined ? [] : ['--resume', resume])
    // Its conversation, as its SessionStart hook named it once that hook had run.
    const started = new RegExp(`claude pid=${tab.pid} SessionStart\\(${resume === undefined ? 'startup' : 'resume'}\\) session=(\\S+) ran`)
    const sessionId = await until(`${folder} to run its SessionStart hook`, () => d.hookLog().match(started)?.[1], 30_000, 100)
    return new Outside(tab, sessionId, folder)
  }

  /**
   * In a config folder of its own, [home] as CLAUDE_CONFIG_DIR, as Orca starts an account's Claude Code. Harness put no
   * hooks there, so no hook names its conversation: the process record it writes in that home does.
   */
  static async startIn(d: IsolatedDaemon, folder: string, home: string, hints: Record<string, string>): Promise<Outside> {
    const tab = await Outside.open(d, folder, { ...hints, CLAUDE_CONFIG_DIR: home })
    const record = join(home, 'sessions', `${tab.pid}.json`)
    const sessionId = await until(`${folder} to write its process record`, () => {
      try { return (JSON.parse(readFileSync(record, 'utf8')) as { sessionId?: string }).sessionId } catch { return undefined }
    }, 30_000, 100)
    return new Outside(tab, sessionId, folder, home)
  }

  /** The engine's tab, in its folder under the projects. [engineArgs] go to the engine. */
  private static open(d: IsolatedDaemon, folder: string, hints: Record<string, string>, how: TabOptions = {},
    engineArgs: readonly string[] = []): Promise<Tab> {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    // d.env carries none of the developer's host hints (testing/daemonEnvironment.ts): only [hints] name the app.
    return openTab(d, cwd, { ...d.env, TERM: 'xterm-256color', ...hints }, [d.env.CLAUDE_PATH!, ...engineArgs], how)
  }

  /** Typed at its prompt, then Enter, as a person does. */
  type(text: string): void {
    typeInto(this.tab.process, `${text}\r`)
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

  /** Whether its hook for [event] has run [times] since the engine started, or since the hook log was [from] long, as the
   *  engine noted it. */
  ran(d: IsolatedDaemon, event: string, times = 1, from = 0): boolean {
    const line = new RegExp(`claude pid=${this.pid} ${event}\\S* session=${this.sessionId} ran`, 'g')
    return (d.hookLog().slice(from).match(line)?.length ?? 0) >= times
  }

  /**
   * With `shell`: Ctrl+Z, as a person types it, and the engine leaves its terminal's foreground, a job its shell stopped.
   * Resolves once `ps -o pgid=,tpgid=` of the engine shows another group in front.
   */
  async background(): Promise<void> {
    if (this.shellPid === undefined) throw new Error(`${this.folder} was started without a shell`)
    typeInto(this.tab.process, '\x1a')
    await until(`${this.folder}'s engine in the background`, async () => {
      const { stdout } = await execFileAsync('ps', ['-o', 'pgid=,tpgid=', '-p', String(this.pid)])
      const [pgid, tpgid] = stdout.trim().split(/\s+/).map(Number)
      return tpgid > 0 && pgid !== tpgid
    }, 10_000, 50)
  }

  /** The process gone at once, with no hook: a crash, a closed terminal. */
  kill(): void {
    killNow(this.pid, this.tab.started)
  }

  /** Its whole tab gone at once (killTab): the engine, its shell and the tab, with no hook. */
  killTab(): void {
    killTab(this.tab)
  }

  close(): Promise<void> {
    return closeTab(this.tab, this.folder)
  }
}
