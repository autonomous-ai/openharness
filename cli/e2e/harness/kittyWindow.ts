/**
 * kitty windows of the test's own (docs/plans/2026-11-19-dial-linux-design.md § 3.3), never the developer's: each kitty
 * draws on the test's X11 desk (x11Desk.ts) with Mesa's software renderer, reads only a config the test wrote, and
 * listens, when it listens at all, on a socket under the daemon's root. Its first window runs the suite's hooked fake
 * Claude Code with the daemon's environment, so the engine runs the daemon's hooks with kitty's KITTY_WINDOW_ID and
 * KITTY_LISTEN_ON. Each kitty leads a process group of its own, ended by the worker's reaper should the worker go before
 * `stop`.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { IsolatedDaemon, until } from './daemon.js'
import { dialHost } from './dialHosts.js'
import { forgetGroup, leaderGone, watchGroup } from './reaper.js'
import { x11Installed, type X11Desk } from './x11Desk.js'

const run = promisify(execFile)

/** The adapter speaks to a socket path of at most this many characters after `unix:` (cable/hosts/kitty.ts). */
const SOCKET_ROOM = 59

// Linux's alone, as the X11 desk it draws on. Null to skip, but on a dial-hosts run (dialHosts.ts).
const onLinux = (name: string) => dialHost(name, process.platform === 'linux' ? resolveBinaryOnPath(name) : null)
const BIN = { kitty: onLinux('kitty'), kitten: onLinux('kitten') }
export const kittyInstalled = x11Installed && BIN.kitty !== null && BIN.kitten !== null

/** One kitty and its first window, the agent's: KITTY_WINDOW_ID 1. */
export interface KittyAgent {
  /** `unix:<path>` when kitty listens, as KITTY_LISTEN_ON says. */
  listenOn?: string
  window: number
  /** The engine's session, from its SessionStart hook. */
  sessionId: string
}

interface Window { id: number; is_active: boolean }

export class KittyWindows {
  private readonly kitties: ChildProcess[] = []

  constructor(private readonly d: IsolatedDaemon, private readonly x11: X11Desk) {
    if (!kittyInstalled) throw new Error('kitty, kitten or the X11 desk is not installed')
  }

  /** The suite's fake Claude Code in a new kitty, in <projectsDir>/<folder>. With [listen], kitty's remote control is on
   *  for its socket alone (`allow_remote_control socket-only`) and it listens under the daemon's root; without, it is
   *  off, kitty's default, and kitty makes no socket. */
  async agent(folder: string, listen: boolean): Promise<KittyAgent> {
    const cwd = join(this.d.projectsDir, folder)
    const own = join(this.d.root, 'kitty', String(this.kitties.length + 1))
    await mkdir(cwd, { recursive: true })
    await mkdir(own, { recursive: true })
    const config = join(own, 'kitty.conf')
    await writeFile(config, listen ? 'allow_remote_control socket-only\n' : '')
    // `--listen-on` is taken as it is; a `listen_on` in kitty.conf would gain `-<kitty's pid>` (RECORDED_KITTY.envFromConf).
    const socket = join(own, 's')
    if (listen && socket.length > SOCKET_ROOM) throw new Error(`kitty's socket ${socket} would be over ${SOCKET_ROOM} characters: run with TMPDIR=/tmp`)
    const listenOn = listen ? `unix:${socket}` : undefined
    const started = this.started()
    const kitty = spawn(BIN.kitty!, ['--config', config, ...(listenOn ? ['--listen-on', listenOn] : []), '--directory', cwd,
      this.d.env.CLAUDE_PATH!], {
      cwd,
      // kitty needs OpenGL 3.3, which Xvfb has only through Mesa's software renderer (RECORDED_KITTY.how).
      env: { ...this.d.env, DISPLAY: this.x11.display, LIBGL_ALWAYS_SOFTWARE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'], ...ownProcessGroup(),
    })
    let errors = ''
    kitty.stderr!.on('data', (chunk) => { errors = `${errors}${chunk}`.slice(-2_000) })
    let exited: string | undefined
    kitty.once('exit', (code, signal) => { exited = String(code ?? signal) })
    watchGroup(kitty.pid!)
    kitty.once('exit', () => leaderGone(kitty.pid!))
    this.kitties.push(kitty)
    // Up once the engine in its window ran its SessionStart hook. A kitty that cannot draw exits at once: the wait ends
    // then, with what it said.
    await until('the fake Claude Code in kitty', () => exited !== undefined || this.started().length > started.length, 30_000, 100)
    if (exited !== undefined) throw new Error(`kitty exited (${exited}):\n${errors}`)
    return { listenOn, window: 1, sessionId: this.started()[started.length] }
  }

  /** The sessions whose SessionStart hook ran, in order. */
  private started(): string[] {
    return [...this.d.hookLog().matchAll(/claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/g)].map((found) => found[1])
  }

  /** A shell beside the agent's window, in its tab, which kitty makes the tab's active window: its id. */
  async beside(agent: KittyAgent): Promise<number> {
    return Number((await this.remote(agent, 'launch', '--type=window', '/bin/sh')).trim())
  }

  /** Whether the window is its tab's active one. */
  async active(agent: KittyAgent, window = agent.window): Promise<boolean> {
    return (await this.windows(agent)).some((found) => found.id === window && found.is_active)
  }

  /** What the agent's window shows. */
  async text(agent: KittyAgent): Promise<string> {
    return this.remote(agent, 'get-text', '--match', `id:${agent.window}`)
  }

  async stop(): Promise<void> {
    for (const kitty of this.kitties.splice(0).reverse()) {
      const exited = kitty.exitCode !== null || kitty.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((done) => kitty.once('exit', () => done()))
      kitty.kill('SIGTERM')
      const timer = setTimeout(() => IsolatedDaemon.killGroup(kitty), 10_000)
      await exited
      clearTimeout(timer)
      IsolatedDaemon.killGroup(kitty)
      forgetGroup(kitty.pid!)
    }
  }

  /** Every window of the kitty, from `kitten @ ls`. */
  private async windows(agent: KittyAgent): Promise<Window[]> {
    const osWindows = JSON.parse(await this.remote(agent, 'ls')) as Array<{ tabs: Array<{ windows: Window[] }> }>
    return osWindows.flatMap((osWindow) => osWindow.tabs.flatMap((tab) => tab.windows))
  }

  private async remote(agent: KittyAgent, ...args: string[]): Promise<string> {
    if (!agent.listenOn) throw new Error('this kitty does not listen')
    return (await run(BIN.kitten!, ['@', '--to', agent.listenOn, ...args], { env: this.d.env, timeout: 10_000 })).stdout
  }
}
