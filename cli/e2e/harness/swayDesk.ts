/**
 * A sway desktop of the test's own (docs/plans/2026-11-19-dial-linux-design.md § 2.3), never the developer's: headless,
 * rendered in memory, with no input devices, and its sockets in a runtime folder under the daemon's root. Its windows
 * are foot terminals the test starts on that sway's Wayland socket with the daemon's environment, so the suite's fake
 * engine run in one runs the daemon's hooks, and foot is the process whose window holds it.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { IsolatedDaemon, until } from './daemon.js'
import { dialHost } from './dialHosts.js'
import { forgetGroup, leaderGone, watchGroup } from './reaper.js'

const run = promisify(execFile)

/** sun_path's room, its last byte the terminator: a longer socket path fails to bind. */
const SOCKET_ROOM = 103
/** The longest name sway gives its socket: `sway-ipc.<uid>.<pid>.sock`, each number at its most digits. */
const LONGEST_SOCKET = 'sway-ipc.4294967295.4194304.sock'

const onLinux = (name: string) => process.platform === 'linux' ? resolveBinaryOnPath(name) : null
const sway = dialHost('sway', onLinux('sway'))
const swaymsg = dialHost('swaymsg', onLinux('swaymsg'))
const foot = dialHost('foot', onLinux('foot'))
/** Whether sway, swaymsg and foot are installed. False to skip, but on a dial-hosts run (dialHosts.ts). */
export const swayInstalled = sway !== null && swaymsg !== null && foot !== null

interface SwayNode { pid?: unknown; focused?: unknown; nodes?: unknown; floating_nodes?: unknown }

/** The node [test] picks in a `get_tree` answer, walking tiled and floating children alike. */
function find(node: SwayNode, test: (node: SwayNode) => boolean): SwayNode | undefined {
  if (test(node)) return node
  for (const children of [node.nodes, node.floating_nodes]) {
    if (!Array.isArray(children)) continue
    for (const child of children as SwayNode[]) {
      const found = find(child, test)
      if (found) return found
    }
  }
  return undefined
}

export class PrivateSway {
  private readonly windows: ChildProcess[] = []

  private constructor(private readonly d: IsolatedDaemon, private readonly server: ChildProcess,
    private readonly logFile: string, readonly runtimeDir: string, readonly socket: string, private readonly display: string) {}

  static async start(d: IsolatedDaemon): Promise<PrivateSway> {
    if (!swayInstalled) throw new Error('sway, swaymsg or foot is not installed')
    const runtimeDir = join(d.root, 'xdg')
    if (Buffer.byteLength(join(runtimeDir, LONGEST_SOCKET)) > SOCKET_ROOM) {
      throw new Error(`sway's socket under ${runtimeDir} could be over ${SOCKET_ROOM} bytes: run with TMPDIR=/tmp`)
    }
    // As a login's runtime folder is: its own account's alone.
    await mkdir(runtimeDir, { recursive: true })
    await chmod(runtimeDir, 0o700)
    // No bar, no key bindings and no XWayland: the default config's would start programs the test does not end.
    const config = join(d.root, 'sway.conf')
    await writeFile(config, 'xwayland disable\n')
    const logFile = join(d.root, 'sway.log')
    const log = openSync(logFile, 'a')
    const server = spawn(sway!, ['-c', config], {
      cwd: d.env.HOME,
      env: { ...d.env, XDG_RUNTIME_DIR: runtimeDir, WLR_BACKENDS: 'headless', WLR_RENDERER: 'pixman', WLR_LIBINPUT_NO_DEVICES: '1' },
      stdio: ['ignore', log, log], ...ownProcessGroup(),
    })
    closeSync(log)
    // Ended by the worker's reaper should the worker go before `stop`.
    watchGroup(server.pid!)
    server.once('exit', () => leaderGone(server.pid!))
    // A sway that exits will never answer: the wait ends at once and says so.
    let exited: string | undefined
    server.once('exit', (code, signal) => { exited = String(code ?? signal) })
    const socket = join(runtimeDir, `sway-ipc.${process.getuid!()}.${server.pid}.sock`)
    const answers = () => run(swaymsg!, ['-s', socket, '-t', 'get_version'], { timeout: 10_000 }).then(() => true, () => false)
    let display: string | undefined
    try {
      await until('the private sway to answer', async () => {
        if (exited !== undefined) return true
        display = readdirSync(runtimeDir).find((name) => /^wayland-[0-9]+$/.test(name))
        return display !== undefined && existsSync(socket) && await answers()
      }, 20_000, 100)
      if (exited !== undefined) throw new Error(`the private sway exited (${exited}) before it answered:\n${readFileSync(logFile, 'utf8')}`)
    } catch (error) {
      await PrivateSway.end(server)
      throw error
    }
    return new PrivateSway(d, server, logFile, runtimeDir, socket, display!)
  }

  /** What sway wrote. */
  log(): string {
    try { return readFileSync(this.logFile, 'utf8') } catch { return '' }
  }

  /** The suite's fake Claude Code in a new foot window, in <projectsDir>/<folder>: foot's pid, which its node carries. */
  async terminal(folder: string): Promise<number> {
    const cwd = join(this.d.projectsDir, folder)
    await mkdir(cwd, { recursive: true })
    return this.window([this.d.env.CLAUDE_PATH!], cwd)
  }

  /** A shell in a new foot window, which sway focuses as it maps it: foot's pid. */
  shell(): Promise<number> {
    return this.window(['/bin/sh'], this.d.env.HOME!)
  }

  /** The pid of the focused window's node, or null when no window has focus. */
  async focused(): Promise<number | null> {
    const pid = find(await this.tree(), (node) => node.focused === true)?.pid
    return typeof pid === 'number' ? pid : null
  }

  async stop(): Promise<void> {
    for (const child of [...this.windows, this.server]) await PrivateSway.end(child)
  }

  private async tree(): Promise<SwayNode> {
    const { stdout } = await run(swaymsg!, ['-s', this.socket, '-t', 'get_tree'], { timeout: 10_000 })
    return JSON.parse(stdout) as SwayNode
  }

  private async window(command: string[], cwd: string): Promise<number> {
    const child = spawn(foot!, command, {
      cwd, env: { ...this.d.env, XDG_RUNTIME_DIR: this.runtimeDir, WAYLAND_DISPLAY: this.display },
      stdio: 'ignore', ...ownProcessGroup(),
    })
    this.windows.push(child)
    watchGroup(child.pid!)
    child.once('exit', () => leaderGone(child.pid!))
    const pid = child.pid!
    await until(`foot ${pid}'s window`, async () =>
      child.exitCode !== null || find(await this.tree(), (node) => node.pid === pid) !== undefined, 20_000, 100)
    if (child.exitCode !== null) throw new Error(`foot exited (${child.exitCode}) before its window was mapped`)
    return pid
  }

  private static async end(child: ChildProcess): Promise<void> {
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => IsolatedDaemon.killGroup(child), 10_000)
    await exited
    clearTimeout(timer)
    IsolatedDaemon.killGroup(child)
    forgetGroup(child.pid!)
  }
}
