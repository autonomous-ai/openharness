/**
 * A Zellij session of the test's own (docs/plans/2026-11-19-dial-linux-design.md § 3.2), never the developer's: started
 * in the background with no client (`zellij attach --create-background`), its socket folder, config and cache under the
 * daemon's throwaway home, and the daemon's own `zellij` a wrapper pinned to that socket folder. Its panes start with the
 * daemon's environment, so the suite's fake engine run in one runs the daemon's hooks, and Zellij gives it its own
 * ZELLIJ_SESSION_NAME and ZELLIJ_PANE_ID.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { type IsolatedDaemon, until } from './daemon.js'
import { dialHost } from './dialHosts.js'

const run = promisify(execFile)

/** The room Zellij gives its socket's path (RECORDED_ZELLIJ.sessionNameRule): a longer one is refused. */
const SOCKET_ROOM = 107
const SESSION = 'harness-e2e'

/** The installed `zellij`. Null to skip, but on a dial-hosts run (dialHosts.ts); Windows has no Zellij dial yet. */
export const zellijBinary: string | null = dialHost('zellij', process.platform === 'win32' ? null : resolveBinaryOnPath('zellij'))

interface ZellijPane { id: number; is_plugin: boolean; is_focused: boolean }

export class PrivateZellij {
  private constructor(private readonly d: IsolatedDaemon, private readonly env: NodeJS.ProcessEnv,
    private readonly socket: string, private readonly ranFile: string, readonly shell: string) {}

  static async start(d: IsolatedDaemon): Promise<PrivateZellij> {
    if (!zellijBinary) throw new Error('Zellij is not installed')
    const folder = join(d.env.HOME!, 'zellij')
    const sockets = join(folder, 'sockets')
    const socket = join(sockets, 'contract_version_1', SESSION)
    if (Buffer.byteLength(socket) > SOCKET_ROOM) {
      throw new Error(`Zellij's socket ${socket} would be over ${SOCKET_ROOM} bytes: run with TMPDIR=/tmp`)
    }
    const config = join(folder, 'config.kdl')
    const layout = join(folder, 'shell.kdl')
    const ranFile = join(folder, 'ran')
    await mkdir(folder, { recursive: true })
    // A first run floats release notes and a tip over the panes, and a killed session is kept to be resurrected: neither.
    await writeFile(config, 'show_release_notes false\nshow_startup_tips false\nsession_serialization false\n')
    // A shell, the focused pane; no tab or status bar.
    await writeFile(layout, 'layout {\n  pane command="/bin/sh"\n}\n')
    // The daemon's bin is first on its PATH: its `zellij` reaches this session's server alone. Each of its actions is
    // noted by name once it has run (`ran`), never its words.
    await writeFile(join(dirname(d.env.CLAUDE_PATH!), 'zellij'), `#!/bin/sh
ZELLIJ_SOCKET_DIR='${sockets}' ZELLIJ_CONFIG_FILE='${config}' '${zellijBinary}' "$@"
status=$?
[ "$3" = action ] && echo "$4" >> '${ranFile}'
exit $status
`, { mode: 0o755 })
    const env = { ...d.env, ZELLIJ_SOCKET_DIR: sockets, ZELLIJ_CONFIG_FILE: config }
    // The server leaves the command that started it for a session of its own. Should the worker go before `stop`, the
    // reaper ends it with every process that names the daemon's root, as the server's command line does (its socket).
    await run(zellijBinary, ['--layout', layout, 'attach', '--create-background', SESSION], { cwd: d.env.HOME, env, timeout: 10_000 })
    try {
      // A pane opened before the layout's shell is there is lost: the session is ready once the shell is listed.
      const shell = await until("the private Zellij's shell",
        async () => (await listPanes(env)).find((pane) => !pane.is_plugin)?.id.toString(), 20_000, 100)
      return new PrivateZellij(d, env, socket, ranFile, shell)
    } catch (error) {
      await run(zellijBinary, ['kill-session', SESSION], { env, timeout: 10_000 }).catch(() => undefined)
      throw error
    }
  }

  /** The suite's fake Claude Code in a new pane beside the shell, in <projectsDir>/<folder>: its pane id. The shell
   *  keeps the focus. */
  async agent(folder: string): Promise<string> {
    const cwd = join(this.d.projectsDir, folder)
    await mkdir(cwd, { recursive: true })
    const created = (await this.action('new-pane', '--cwd', cwd, '--', this.d.env.CLAUDE_PATH!)).trim()
    const id = /^terminal_([0-9]+)$/.exec(created)?.[1]
    if (!id) throw new Error(`zellij new-pane answered ${JSON.stringify(created)}`)
    return id
  }

  /**
   * How many times the daemon's `zellij` has run [action] to its end. In a session with no client, a `zellij action`
   * of the test's running beside `focus-pane-id` counts as one: Zellij 0.44 then lists both the old and the new pane as
   * focused, for good. So the test reads the focus only once the daemon's action has run.
   */
  ran(action: string): number {
    try {
      return readFileSync(this.ranFile, 'utf8').split('\n').filter((line) => line === action).length
    } catch {
      return 0
    }
  }

  /** The id of the session's focused terminal pane, or null when none is. */
  async focused(): Promise<string | null> {
    return (await listPanes(this.env)).find((pane) => !pane.is_plugin && pane.is_focused)?.id.toString() ?? null
  }

  /** What the pane shows. */
  screen(paneId: string): Promise<string> {
    return this.action('dump-screen', '--pane-id', paneId)
  }

  /** Closes the pane, which ends what runs in it, once Zellij no longer lists it. */
  async close(paneId: string): Promise<void> {
    await this.action('close-pane', '--pane-id', paneId)
    await until(`pane ${paneId} closed`,
      async () => !(await listPanes(this.env)).some((pane) => !pane.is_plugin && String(pane.id) === paneId), 20_000, 100)
  }

  async stop(): Promise<void> {
    await run(zellijBinary!, ['kill-session', SESSION], { env: this.env, timeout: 10_000 }).catch(() => undefined)
    await until("the private Zellij's server gone", () => !existsSync(this.socket), 20_000, 100)
  }

  private async action(...args: string[]): Promise<string> {
    const { stdout } = await run(zellijBinary!, ['--session', SESSION, 'action', ...args], { env: this.env, timeout: 10_000 })
    return stdout
  }
}

async function listPanes(env: NodeJS.ProcessEnv): Promise<ZellijPane[]> {
  const { stdout } = await run(zellijBinary!, ['--session', SESSION, 'action', 'list-panes', '--json'], { env, timeout: 10_000 })
  return JSON.parse(stdout) as ZellijPane[]
}
