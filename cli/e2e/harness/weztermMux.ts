/**
 * A WezTerm mux server of the test's own (docs/plans/2026-11-19-dial-linux-design.md § 1.5), never the developer's: it
 * runs headless, its config and socket are under the daemon's throwaway home, and the daemon's own `wezterm` is a
 * wrapper pinned to that socket. Its panes start with the daemon's environment, so the suite's fake engine run in one
 * runs the daemon's hooks, and WezTerm gives it its own WEZTERM_PANE.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { IsolatedDaemon, until } from './daemon.js'
import { dialHost } from './dialHosts.js'
import { forgetGroup, leaderGone, watchGroup } from './reaper.js'

const run = promisify(execFile)

/** sun_path's room, its last byte the terminator: a longer socket path fails to bind. */
const SOCKET_ROOM = 103
const APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'

/** The installed `wezterm` with its `wezterm-mux-server` beside it, as both WezTerm's packages and its Mac app ship
 *  them. Null to skip, but on a dial-hosts run (dialHosts.ts). */
export const weztermBinary: string | null = dialHost('wezterm', (() => {
  if (process.platform === 'win32') return null
  const wezterm = resolveBinaryOnPath('wezterm') ?? (process.platform === 'darwin' && existsSync(APP_WEZTERM) ? APP_WEZTERM : null)
  return wezterm && existsSync(join(dirname(wezterm), 'wezterm-mux-server')) ? wezterm : null
})())

export class PrivateWezterm {
  private constructor(private readonly d: IsolatedDaemon, private readonly server: ChildProcess,
    private readonly env: NodeJS.ProcessEnv) {}

  static async start(d: IsolatedDaemon): Promise<PrivateWezterm> {
    if (!weztermBinary) throw new Error('WezTerm is not installed')
    const folder = join(d.env.HOME!, 'wezterm')
    const socket = join(folder, 'sock')
    if (Buffer.byteLength(socket) > SOCKET_ROOM) {
      throw new Error(`WezTerm's socket ${socket} would be over ${SOCKET_ROOM} bytes: run with TMPDIR=/tmp`)
    }
    const config = join(folder, 'wezterm.lua')
    await mkdir(folder, { recursive: true })
    await writeFile(config, `return { unix_domains = { { name = 'harness-e2e', socket_path = '${socket}' } } }\n`)
    // The daemon's bin is first on its PATH: its `wezterm cli` reaches this server alone, and never starts one of its
    // own, which would outlive the test.
    await writeFile(join(dirname(d.env.CLAUDE_PATH!), 'wezterm'), `#!/bin/sh
if [ "$1" = cli ]; then shift; set -- cli --no-auto-start "$@"; fi
WEZTERM_CONFIG_FILE='${config}' WEZTERM_UNIX_SOCKET='${socket}' exec '${weztermBinary}' "$@"
`, { mode: 0o755 })
    const env = { ...d.env, WEZTERM_CONFIG_FILE: config }
    const server = spawn(join(dirname(weztermBinary), 'wezterm-mux-server'), [], {
      cwd: d.env.HOME, env, stdio: 'ignore', ...ownProcessGroup(),
    })
    // Ended by the worker's reaper should the worker go before `stop`.
    watchGroup(server.pid!)
    server.once('exit', () => leaderGone(server.pid!))
    // A server that exits will never answer: the wait ends at once and says so.
    let exited: string | undefined
    server.once('exit', (code, signal) => { exited = String(code ?? signal) })
    const wezterm = new PrivateWezterm(d, server, { ...env, WEZTERM_UNIX_SOCKET: socket })
    try {
      await until('the private WezTerm to answer',
        async () => exited !== undefined || (existsSync(socket) && await wezterm.cli('list').then(() => true, () => false)), 20_000, 100)
      if (exited !== undefined) throw new Error(`the private WezTerm exited (${exited}) before it answered`)
    } catch (error) {
      await wezterm.stop()
      throw error
    }
    return wezterm
  }

  /** `wezterm cli` against this server alone: its output. */
  async cli(...args: string[]): Promise<string> {
    const { stdout } = await run(weztermBinary!, ['cli', '--no-auto-start', ...args], { env: this.env, timeout: 10_000 })
    return stdout
  }

  /** The suite's fake Claude Code in a new window's pane, in <projectsDir>/<folder>: its pane id. */
  async spawn(folder: string): Promise<string> {
    const cwd = join(this.d.projectsDir, folder)
    await mkdir(cwd, { recursive: true })
    return (await this.cli('spawn', '--new-window', '--cwd', cwd, '--', this.d.env.CLAUDE_PATH!)).trim()
  }

  /** A shell beside the pane, in its tab, and the tab's active pane: its id. */
  async split(paneId: string): Promise<string> {
    const shell = (await this.cli('split-pane', '--pane-id', paneId, '--', '/bin/sh')).trim()
    await this.cli('activate-pane', '--pane-id', shell)
    return shell
  }

  /** Whether the pane is its tab's active one. */
  async active(paneId: string): Promise<boolean> {
    const panes = JSON.parse(await this.cli('list', '--format', 'json')) as Array<{ pane_id: number; is_active: boolean }>
    return panes.some((pane) => String(pane.pane_id) === paneId && pane.is_active)
  }

  async text(paneId: string): Promise<string> {
    return this.cli('get-text', '--pane-id', paneId)
  }

  async stop(): Promise<void> {
    const server = this.server
    const exited = server.exitCode !== null || server.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((done) => server.once('exit', () => done()))
    server.kill('SIGTERM')
    const timer = setTimeout(() => IsolatedDaemon.killGroup(server), 10_000)
    await exited
    clearTimeout(timer)
    IsolatedDaemon.killGroup(server)
    forgetGroup(server.pid!)
  }
}
