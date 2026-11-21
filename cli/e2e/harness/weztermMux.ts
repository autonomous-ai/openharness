/**
 * A WezTerm mux server of the test's own (docs/plans/2026-11-19-dial-linux-design.md § 1.5), never the developer's: it
 * runs headless, its config and socket are under the daemon's throwaway home, and the daemon's own `wezterm` is a
 * wrapper pinned to that socket. Its panes start with the daemon's environment, so the suite's fake engine run in one
 * runs the daemon's hooks, and WezTerm gives it its own WEZTERM_PANE.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

/** The server's config: its domain, and at each load each window's active tab written to <folder>/tabs as
 *  `<window> <tab>` rows under the [read] number. Only the server loads it: `cli` loads the plain one. Its first load
 *  comes before the mux is up, and a config that fails would lose the domain: the read is under `pcall`. */
const serverConfig = (folder: string, domains: string, read: number) => `local wezterm = require 'wezterm'
pcall(function()
  local rows = { '${read}' }
  for _, window in ipairs(wezterm.mux.all_windows()) do
    table.insert(rows, window:window_id() .. ' ' .. window:active_tab():tab_id())
  end
  local file = io.open('${join(folder, 'tabs')}', 'w')
  file:write(table.concat(rows, '\\n'))
  file:close()
end)
return ${domains}
`

/** What this harness reads of a pane in `cli list --format json`. */
type Pane = { pane_id: number; tab_id: number; window_id: number; is_active: boolean; tty_name?: string }

export class PrivateWezterm {
  private reads = 0

  private constructor(private readonly d: IsolatedDaemon, private readonly server: ChildProcess,
    private readonly env: NodeJS.ProcessEnv, private readonly folder: string, private readonly domains: string) {}

  /** [env]: variables its panes inherit, as a WezTerm started from another app's pane keeps that pane's. */
  static async start(d: IsolatedDaemon, env: NodeJS.ProcessEnv = {}): Promise<PrivateWezterm> {
    if (!weztermBinary) throw new Error('WezTerm is not installed')
    const folder = join(d.env.HOME!, 'wezterm')
    const socket = join(folder, 'sock')
    if (Buffer.byteLength(socket) > SOCKET_ROOM) {
      throw new Error(`WezTerm's socket ${socket} would be over ${SOCKET_ROOM} bytes: run with TMPDIR=/tmp`)
    }
    const config = join(folder, 'wezterm.lua')
    const domains = `{ unix_domains = { { name = 'harness-e2e', socket_path = '${socket}' } } }`
    await mkdir(folder, { recursive: true })
    await writeFile(config, `return ${domains}\n`)
    await writeFile(join(folder, 'server.lua'), serverConfig(folder, domains, 0))
    // The daemon's bin is first on its PATH: its `wezterm cli` reaches this server alone.
    await writeFile(join(dirname(d.env.CLAUDE_PATH!), 'wezterm'), `#!/bin/sh
WEZTERM_CONFIG_FILE='${config}' WEZTERM_UNIX_SOCKET='${socket}' exec '${weztermBinary}' "$@"
`, { mode: 0o755 })
    const panes = { ...d.env, ...env }
    const server = spawn(join(dirname(weztermBinary), 'wezterm-mux-server'), [], {
      cwd: d.env.HOME, env: { ...panes, WEZTERM_CONFIG_FILE: join(folder, 'server.lua') }, stdio: 'ignore',
      ...ownProcessGroup(),
    })
    // Ended by the worker's reaper should the worker go before `stop`.
    watchGroup(server.pid!)
    server.once('exit', () => leaderGone(server.pid!))
    // A server that exits will never answer: the wait ends at once and says so.
    let exited: string | undefined
    server.once('exit', (code, signal) => { exited = String(code ?? signal) })
    // A pane starts with the environment of the `cli spawn` that asked for it, not the server's: `cli` carries [env].
    const wezterm = new PrivateWezterm(d, server,
      { ...panes, WEZTERM_CONFIG_FILE: config, WEZTERM_UNIX_SOCKET: socket }, folder, domains)
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
    return this.cliWith({}, args)
  }

  private async cliWith(env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
    const { stdout } = await run(weztermBinary!, ['cli', '--no-auto-start', ...args],
      { env: { ...this.env, ...env }, timeout: 10_000 })
    return stdout
  }

  /** The suite's fake Claude Code in a new window's pane, in <projectsDir>/<folder>: its pane id. */
  async spawn(folder: string): Promise<string> {
    const cwd = join(this.d.projectsDir, folder)
    await mkdir(cwd, { recursive: true })
    return (await this.cli('spawn', '--new-window', '--cwd', cwd, '--', this.d.env.CLAUDE_PATH!)).trim()
  }

  /** [argv] in a new window's pane, with [env] over the server's: the pane's id and its tty, as `cli list` names it. */
  async run(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<{ pane: string; tty: string }> {
    const pane = (await this.cliWith(env, ['spawn', '--new-window', '--', ...argv])).trim()
    const tty = (await this.panes()).find((p) => String(p.pane_id) === pane)?.tty_name
    if (!tty) throw new Error(`WezTerm's pane ${pane} has no tty in its list`)
    return { pane, tty }
  }

  /** A shell beside the pane, in its tab, and the tab's active pane: its id. */
  async split(paneId: string): Promise<string> {
    const shell = (await this.cli('split-pane', '--pane-id', paneId, '--', '/bin/sh')).trim()
    await this.cli('activate-pane', '--pane-id', shell)
    return shell
  }

  /** Whether the pane is its tab's active one. */
  async active(paneId: string): Promise<boolean> {
    return (await this.panes()).some((pane) => String(pane.pane_id) === paneId && pane.is_active)
  }

  /** Whether the pane's tab is its window's active one. `cli list` does not say, so the server says it as it loads its
   *  config again, which a new read number in the config makes it do. */
  async activeTab(paneId: string): Promise<boolean> {
    const pane = (await this.panes()).find((p) => String(p.pane_id) === paneId)
    if (!pane) throw new Error(`WezTerm has no pane ${paneId}`)
    const read = ++this.reads
    await writeFile(join(this.folder, 'server.lua'), serverConfig(this.folder, this.domains, read))
    const tabs = await until(`WezTerm's active tabs, read ${read}`, async () => {
      const [said, ...rows] = (await readFile(join(this.folder, 'tabs'), 'utf8').catch(() => '')).split('\n')
      return said === String(read) ? rows : null
    }, 10_000, 50)
    return tabs.includes(`${pane.window_id} ${pane.tab_id}`)
  }

  private async panes(): Promise<Pane[]> {
    return JSON.parse(await this.cli('list', '--format', 'json')) as Pane[]
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
