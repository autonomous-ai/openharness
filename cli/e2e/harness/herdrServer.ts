/**
 * A herdr server of the test's own (docs/specs/2026-11-16-device-herdr.md), never the developer's: its config folder is
 * under the daemon's throwaway home, its update and manifest checks are off, so it calls no other computer, and the
 * daemon's own `herdr` is a wrapper pinned to it that notes the devices' `herdr agent` runs (runLog.ts). The daemon under
 * test inherits no `XDG_*` (testing/daemonEnvironment.ts), so it finds this server's socket under its home, as the herdr
 * client works it out.
 *
 * Its agent is a C program named `claude`: herdr tells an agent by its process name, and a copied `/bin/cat` under that
 * name is killed by macOS. It prints `fake> `, then `GOT[<line>]` for each line it reads.
 *
 * Its client, in a terminal of the test's (a fake app's tab, a WezTerm pane, an xterm), is pinned to this server by its
 * config folder: never the developer's herdr.
 * `ownHerdrsOnly` keeps the daemon's herdr lookup off the developer's herdr, which may run on the Mac the tests run on.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { writeExecutable } from '../../src/testing/executableFixture.js'
import { RECORDED_HERDR } from '../../src/testing/recordedHerdr.js'
import { comms, processTable, processTree } from '../../src/testing/spawnedRuns.js'
import { type IsolatedDaemon, until } from './daemon.js'
import { dialHost } from './dialHosts.js'
import { gone, itermServerPath, tabUnder, type FakeApp } from './outsideAgent.js'
import { forgetGroup, leaderGone, watchGroup } from './reaper.js'
import { recordingWrapper, runsFolder } from './runLog.js'

const execFileAsync = promisify(execFile)

/** Panes opened, at most, to bring a workspace's pane ids to a letter: herdr counts them from p1 in base 32, `pA` the
 *  tenth. */
const MAX_OPENS = 16

/** How long a line typed into a new pane's shell may go unrun before it is typed again: the fake Claude Code runs its
 *  start hook within a second of it. */
const RETYPE_MS = 2_000

/** sun_path's room, its last byte the terminator: a longer socket path fails to bind. */
const SOCKET_ROOM = 103

/** The server's socket, under its [config] folder. */
const socketIn = (config: string): string => join(config, 'herdr', 'herdr.sock')

const FAKE_AGENT = `#include <stdio.h>
#include <string.h>
int main(void) {
  char line[4096];
  setvbuf(stdout, NULL, _IONBF, 0);
  printf("fake> ");
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\\r\\n")] = 0;
    printf("GOT[%s]\\nfake> ", line);
  }
  return 0;
}
`

/** The installed herdr: on the worker's PATH, else ~/.local/bin/herdr of the account that runs the tests
 *  (`userInfo().homedir`: the suite's HOME is a throwaway one). Null when there is none, or no `cc` to build its agent:
 *  the file is then skipped, but on a dial-hosts run (dialHosts.ts), which names the one missing. */
export const herdrBinary: string | null = dialHost('herdr', (() => {
  if (process.platform === 'win32' || !dialHost('cc', resolveBinaryOnPath('cc'))) return null
  const installed = join(userInfo().homedir, '.local', 'bin', 'herdr')
  return resolveBinaryOnPath('herdr') ?? (existsSync(installed) ? installed : null)
})())

/** herdr's server, the leader of a process group of its own (ownProcessGroup, or the session its first client starts it
 *  in): its pid; how it ended (its code or signal; `gone` for one its client started), undefined while it runs; and
 *  whether another process has its pid now. */
interface ServerProcess { readonly pid: number; ended(): string | undefined; reused(): boolean }

/** A terminal's tab running herdr's client: the client's pid, the tab's tty, the fake iTerm2's process in an iTerm2
 *  tab, and when the tab's processes started (outsideAgent.ts tabUnder). */
export interface HerdrTab { pid: number; tty: string; appPid?: number; started: ReadonlyMap<number, string>; close(): Promise<void> }

/** herdr's client as a person runs it in a terminal: given a size first, which a bare pseudo-terminal lacks and the
 *  client draws to. */
const clientArgv = (): string[] => ['/bin/sh', '-c', 'stty rows 40 columns 120 && exec "$0"', herdrBinary!]
/** The client's environment: the daemon's, [env] beside it, pinned to the server under [config]. */
const clientEnv = (d: IsolatedDaemon, config: string, env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  ({ ...d.env, ...env, XDG_CONFIG_HOME: config, TERM: 'xterm-256color' })

/** For `ps` to read one process: one that hangs blocks no stop. */
const PS_MS = 5_000

/** [field] of [pid]'s process; undefined once no process has it (ps exits 1). A ps that fails otherwise, on its timeout
 *  among them, tells nothing: it throws. */
function psField(pid: number, field: 'lstart' | 'comm'): string | undefined {
  try {
    return execFileSync('/bin/ps', ['-o', `${field}=`, '-p', String(pid)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PS_MS }).trim() || undefined
  } catch (error) {
    if ((error as { status?: number | null }).status === 1) return undefined
    throw error
  }
}

/** What tells a process of the test's from one given its pid later: when it started and the path it was started from,
 *  never its argv. */
export interface Identity { readonly started: string; readonly path: string }

/** [pid]'s identity, read while it is the test's; undefined once no process has it. Throws as psField does. */
export function identityOf(pid: number): Identity | undefined {
  const started = psField(pid, 'lstart')
  const path = started === undefined ? undefined : psField(pid, 'comm')
  return started === undefined || path === undefined ? undefined : { started, path }
}

/** Whether [pid] is the process [identity] names now, `gone` once no process has it. Its start is read first: the path
 *  of a process that started at another time, someone else's, is never read. Throws as psField does. */
function isNow(pid: number, identity: Identity): boolean | 'gone' {
  const started = psField(pid, 'lstart')
  if (started === undefined) return 'gone'
  if (started !== identity.started) return false
  const path = psField(pid, 'comm')
  return path === undefined ? 'gone' : path === identity.path
}

/** herdr's server as its first client started it (startIn), not this worker's child: ended once no process has its pid,
 *  and that pid another process's once one other than [identity] (identityOf, read as it started) has it, or once its
 *  identity cannot be read: nothing is killed on a guess. */
export function clientStarted(pid: number, identity: Identity | undefined): ServerProcess {
  return {
    pid,
    ended: () => (gone(pid) ? 'gone' : undefined),
    reused: () => {
      try {
        return identity === undefined ? psField(pid, 'lstart') !== undefined : isNow(pid, identity) === false
      } catch {
        return true
      }
    },
  }
}

/** [pid] killed while it is the process [identity] names (identityOf, read while it was the test's), never one given its
 *  pid after it ended, nor one whose identity was never read or cannot be read now. */
export function killOwn(pid: number, identity: Identity | undefined): void {
  try {
    if (identity === undefined || isNow(pid, identity) !== true) return
  } catch {
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

/** [server]'s group killed, unless another process took its pid. One whose leader is gone is still the server's: no
 *  process is given the pid of a group that is still there. */
export function killGroup(server: ServerProcess): void {
  if (server.reused()) return
  try { process.kill(-server.pid, 'SIGKILL') } catch { /* none left */ }
}

/**
 * Whether a line typed into a pane's shell was lost, so it is typed again: [screen], herdr's read of the pane, does not
 * show it whole. A shell that shows it whole was only slow to run it, and a second copy would reach the program it
 * starts. herdr wraps a long line and cuts each line's trailing space: spaces and line ends are not compared.
 */
export function launchLost(screen: string, line: string): boolean {
  const flat = (text: string): string => text.replace(/\s+/g, '')
  return !flat(screen).includes(flat(line))
}

/** [parent]'s child named [name]: [parent]'s children from each process's pid and parent, then the path each of them
 *  alone was started from, by its pid; never pgrep, which reads every process's name. Undefined while it has none. */
export async function childNamed(parent: number, name: string): Promise<number | undefined> {
  const children = processTable().filter((row) => row.ppid === parent).map((row) => row.pid)
  const paths = comms(children)
  return children.find((pid) => basename(paths.get(pid) ?? '') === name)
}

/** A tab of a fake [app] running [argv] under [env] (tabUnder), with its tty; closed should that not be read. */
async function ttyTab(d: IsolatedDaemon, app: FakeApp, argv: readonly string[], env: NodeJS.ProcessEnv): Promise<HerdrTab> {
  const tab = await tabUnder(d, app, argv, env)
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'tty=', '-p', String(tab.pid)])
    return { ...tab, tty: `/dev/${stdout.trim()}` }
  } catch (error) {
    await tab.close()
    throw error
  }
}

/** Whether a server takes a connection on [socket]: a killed one's socket file is left behind and refuses it, and no
 *  socket file is no server. No deadline: the kernel answers a Unix socket's connect itself, at once, whatever the server
 *  is doing. */
function answers(socket: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const connection = createConnection({ path: socket })
    connection.on('connect', () => {
      connection.destroy()
      resolve(true)
    })
    connection.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false)
      else reject(error)
    })
  })
}

export class PrivateHerdr {
  /** With `lettered`, the root pane of the workspace whose splits are its panes. */
  private lettered?: string

  /** [tab]: the tab whose client started the server (startIn). */
  private constructor(private readonly d: IsolatedDaemon, private readonly server: ServerProcess, private readonly config: string,
    readonly socket: string, readonly tab?: HerdrTab, private readonly clientIdentity?: Identity) {}

  /** The server's process. */
  get pid(): number { return this.server.pid }

  /** herdr installed for the daemon, and not running: its config, and the daemon's `herdr` on its PATH, as the devices
   *  look for it at each dial attach. Its config folder. */
  static async install(d: IsolatedDaemon): Promise<string> {
    if (!herdrBinary) throw new Error('herdr, or the cc that builds its agent, is not installed')
    const config = join(d.env.HOME!, '.config')
    // Beside its socket herdr binds herdr-client.sock, the longer, and exits when it does not fit.
    const client = join(config, 'herdr', 'herdr-client.sock')
    if (Buffer.byteLength(client) > SOCKET_ROOM) {
      throw new Error(`herdr's socket ${client} would be over ${SOCKET_ROOM} bytes: run with TMPDIR=/tmp`)
    }
    await mkdir(join(config, 'herdr'), { recursive: true })
    await writeFile(join(config, 'herdr', 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n')
    // The daemon's bin is first on its PATH: its `herdr agent focus` reaches this server alone, whatever herdr reads
    // its home from, by a launcher pinned to it, and the wrapper in front of that notes the run (runLog.ts).
    const runs = runsFolder(d.binDir, 'herdr')
    const pinned = join(runs, 'herdr')
    await mkdir(runs, { recursive: true })
    writeExecutable(pinned, `#!/bin/sh\nXDG_CONFIG_HOME='${config}' exec '${herdrBinary}' "$@"\n`)
    writeExecutable(join(d.binDir, 'herdr'), recordingWrapper(pinned, runs, ['agent']))
    return config
  }

  /**
   * The layout herdr saved in its [config] folder gone (`install`'s): herdr 0.9.5 writes `herdr/session.json` and
   * `herdr/session-snapshots/` as it stops and a server started later restores their workspaces and panes, so a scenario
   * on the same daemon met the panes of the one before (iTerm2's I14 and I15 failed in a full run and passed alone).
   * Not `herdr/session-history.json`, the panes' screen text: herdr writes it only with `[experimental] pane_history`,
   * which `install`'s config leaves off, and uses it only with the `session.json` it was written beside.
   * Refused while a server answers on its socket: it would write them again. Its config stays.
   */
  static async forget(config: string): Promise<void> {
    const socket = socketIn(config)
    if (await answers(socket)) throw new Error(`herdr still runs on ${socket}: its layout is written again as it stops`)
    const herdr = join(config, 'herdr')
    await rm(join(herdr, 'session.json'), { force: true })
    await rm(join(herdr, 'session-snapshots'), { recursive: true, force: true })
  }

  /**
   * With `lettered`, its panes are splits of one workspace whose ids carry a letter (`w2:pB` on), as a person's herdr
   * that has run a while: a fresh server's are digits alone. [env] is what the server inherits beside the daemon's, as
   * one started from a kitty window keeps that window's variables. Its panes keep only some: herdr 0.9.5 strips `TMUX`,
   * `TMUX_PANE`, `ZELLIJ`, `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID`, `KITTY_WINDOW_ID` and `WEZTERM_PANE` from them.
   */
  static async start(d: IsolatedDaemon, { lettered = false, env = {} }: { lettered?: boolean; env?: NodeJS.ProcessEnv } = {}):
    Promise<PrivateHerdr> {
    const config = await PrivateHerdr.install(d)
    const server = spawn(herdrBinary!, ['server'], {
      cwd: d.env.HOME, env: { ...d.env, ...env, XDG_CONFIG_HOME: config }, stdio: 'ignore', ...ownProcessGroup(),
    })
    // Ended by the worker's reaper should the worker go before `stop`, and by the daemon's close should it go unstopped.
    watchGroup(server.pid!)
    d.own(server.pid!)
    let exited: string | undefined
    server.once('exit', (code, signal) => {
      leaderGone(server.pid!)
      exited = String(code ?? signal)
    })
    const herdr = new PrivateHerdr(d, { pid: server.pid!, ended: () => exited, reused: () => exited !== undefined && !gone(server.pid!) },
      config, socketIn(config))
    await herdr.ready(lettered)
    return herdr
  }

  /**
   * herdr's server started by its first client, run in a tab of [app] (tabUnder), as a person starts herdr in a terminal:
   * the server is that client's child (RECORDED_HERDR's client A), so a walk from its panes meets the app before this
   * worker: under the fake iTerm2, its server and bundle. [env] as start's. Stopped, its tab is closed too.
   */
  static async startIn(d: IsolatedDaemon, app: FakeApp, { env = {} }: { env?: NodeJS.ProcessEnv } = {}):
    Promise<PrivateHerdr & { tab: HerdrTab }> {
    const config = await PrivateHerdr.install(d)
    const tab = await ttyTab(d, app, clientArgv(), clientEnv(d, config, env))
    const pid = await until('the herdr client to start its server', () => childNamed(tab.pid, 'herdr'), 20_000, 100)
      .catch(async (error: unknown) => {
        await tab.close()
        throw error
      })
    // Ended by the worker's reaper should the worker go before `stop`: it leads the session its client started it in. And
    // by the daemon's close should it go unstopped: launchd's once its client ends, only the note keeps it the test's.
    watchGroup(pid)
    d.own(pid)
    // Each read now, while both are this test's: the client has run herdr since it started its server.
    let identities: { server?: Identity; client?: Identity }
    try {
      identities = { server: identityOf(pid), client: identityOf(tab.pid) }
    } catch (error) {
      await tab.close()
      throw error
    }
    const herdr = new PrivateHerdr(d, clientStarted(pid, identities.server), config, socketIn(config), tab, identities.client)
    await herdr.ready(false)
    try {
      await until('the herdr client to attach', async () => await herdr.clientConnections() > 0, 20_000, 100)
    } catch (error) {
      await herdr.stop()
      throw error
    }
    return herdr as PrivateHerdr & { tab: HerdrTab }
  }

  /** Until the server answers, then a plain workspace in front, so that an agent's pane is never the focused one, and
   *  with [lettered] the lettered workspace (toLetters). Stopped should any of it fail. */
  private async ready(lettered: boolean): Promise<void> {
    try {
      // A server that exits will never answer: the wait ends at once and says so.
      await until('the private herdr to answer',
        async () => this.server.ended() !== undefined || (existsSync(this.socket) && await this.rpc('workspace.list')), 20_000, 100)
      const ended = this.server.ended()
      if (ended !== undefined) throw new Error(`the private herdr exited (${ended}) before it answered`)
      await this.rpc('workspace.create', { focus: true })
      if (lettered) await this.toLetters()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  /** One connection a request, as herdr takes them: the test's own few lines, not the product's client. */
  rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const connection = createConnection({ path: this.socket })
      let read = ''
      const deadline = setTimeout(() => {
        connection.destroy()
        reject(new Error(`herdr gave no answer to ${method}`))
      }, 10_000)
      connection.on('connect', () => connection.write(`${JSON.stringify({ id: method, method, params })}\n`))
      connection.on('error', (error) => {
        clearTimeout(deadline)
        reject(error)
      })
      connection.on('data', (chunk: Buffer) => {
        read += chunk.toString('utf8')
        const newline = read.indexOf('\n')
        if (newline === -1) return
        clearTimeout(deadline)
        connection.destroy()
        const answer = JSON.parse(read.slice(0, newline)) as { result?: Record<string, unknown>; error?: { code: string } }
        if (answer.result) resolve(answer.result)
        else reject(new Error(`herdr refused ${method}: ${answer.error?.code}`))
      })
    })
  }

  /** A workspace of its own whose next pane id carries a letter: panes opened and closed in it until one did, as herdr
   *  never gives an id twice. */
  private async toLetters(): Promise<void> {
    const root = ((await this.rpc('workspace.create')).root_pane as { pane_id: string }).pane_id
    for (let opened = 0; opened < MAX_OPENS; opened++) {
      const pane = await this.split(root)
      await this.rpc('pane.close', { pane_id: pane })
      if (/:p[0-9A-Z]*[A-Z]/.test(pane)) {
        this.lettered = root
        return
      }
    }
    throw new Error(`no pane id with a letter in ${MAX_OPENS} panes`)
  }

  private async split(target: string, cwd?: string): Promise<string> {
    const split = await this.rpc('pane.split', { target_pane_id: target, direction: 'right', ...(cwd ? { cwd } : {}) })
    return (split.pane as { pane_id: string }).pane_id
  }

  /** A pane in <projectsDir>/<folder>, not focused: its pane id. The pane holds its shell. A workspace of its own, or
   *  with `lettered` a split of the lettered one. */
  async pane(folder: string): Promise<string> {
    const cwd = join(this.d.projectsDir, folder)
    await mkdir(cwd, { recursive: true })
    if (this.lettered) return this.split(this.lettered, cwd)
    const created = await this.rpc('workspace.create', { cwd })
    return (created.root_pane as { pane_id: string }).pane_id
  }

  /**
   * herdr's client attached to this server from a terminal [start] opens running [argv] under [env], as a person's runs
   * in a terminal app: `herdr` itself is the terminal's process, given a size first, which a bare pseudo-terminal lacks
   * and the client draws to. What [start] gave, once the server holds one more `herdr-client.sock` connection than
   * before it started; closed, when it has a `close`, should the client not attach.
   */
  async client<T extends { pid: number; close?(): Promise<void> }>(
    start: (argv: string[], env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const before = await this.clientConnections()
    const started = await start(clientArgv(), clientEnv(this.d, this.config))
    try {
      await until('the herdr client to attach', async () => await this.clientConnections() > before, 20_000, 100)
    } catch (error) {
      await started.close?.()
      throw error
    }
    return started
  }

  /** herdr's client in a tab of a fake [app]: its pid and its tab's tty. */
  tabClient(app: FakeApp): Promise<HerdrTab> {
    return this.client((argv, env) => ttyTab(this.d, app, argv, env))
  }

  /**
   * The server's `herdr-client.sock` connections. On Linux the rows of `ss -xn` bound to that path whose socket is one
   * of the server's own descriptors (RECORDED_HERDR: an accepted connection carries the listening path, and `ss -xn`
   * lists no listening socket); on macOS its descriptors from lsof, which exits 1 with none, its output intact.
   */
  private async clientConnections(): Promise<number> {
    if (process.platform === 'linux') {
      const fds = `/proc/${this.pid}/fd`
      const own = new Set<string>()
      for (const fd of await readdir(fds)) {
        // A descriptor closed between the listing and its read is no connection.
        const inode = /^socket:\[(\d+)\]$/.exec(await readlink(join(fds, fd)).catch(() => ''))?.[1]
        if (inode) own.add(inode)
      }
      const { stdout } = await execFileAsync(RECORDED_HERDR.paths.ss, ['-xn'])
      return stdout.split('\n').filter((row) => {
        const [, , , , local, inode] = row.trim().split(/\s+/)
        return local?.endsWith('/herdr-client.sock') && own.has(inode)
      }).length
    }
    const listed = await execFileAsync('/usr/sbin/lsof', ['-a', '-U', '-p', String(this.pid), '-F', 'n'])
      .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
    return listed.stdout.split('\n').filter((line) => line.startsWith('n') && line.endsWith('/herdr-client.sock')).length
  }

  /** herdr's focused pane: the one its API says is focused, the focused pane of the workspace in front. */
  async focused(): Promise<string> {
    const panes = (await this.rpc('pane.list')).panes as Array<{ pane_id: string; focused: boolean }>
    const focused = panes.filter((pane) => pane.focused)
    if (focused.length !== 1) throw new Error(`herdr names ${focused.length} focused panes`)
    return focused[0].pane_id
  }

  /** The suite's fake Claude Code started in a new pane's shell, so its hook runs with herdr's own HERDR_PANE_ID; with
   *  [resume], going on in that conversation (`--resume <id>`), as after herdr started again; with [env] set on its
   *  command line, as a person types `NAME=value claude`. [pid]: its process. */
  async hooked(folder: string, { resume, env = {} }: { resume?: string; env?: Readonly<Record<string, string>> } = {}):
    Promise<{ pane: string; sessionId: string; id: string; pid: number }> {
    const pane = await this.pane(folder)
    // Its own SessionStart: the first after the log's length before it was typed.
    const from = this.d.hookLog().length
    const assigned = Object.entries(env).map(([name, value]) => `${name}='${value.replaceAll("'", "'\\''")}' `).join('')
    const started = new RegExp(`claude pid=(\\d+) SessionStart\\(${resume === undefined ? 'startup' : 'resume'}\\) session=(${resume ?? '\\S+'}) ran`)
    const [, pid, sessionId] = await this.launch(pane, folder, `${assigned}"$CLAUDE_PATH"${resume === undefined ? '' : ` --resume ${resume}`}`,
      `${folder}'s SessionStart hook to run`, () => started.exec(this.d.hookLog().slice(from)))
    return { pane, sessionId, id: observedAgentId('claude', sessionId), pid: Number(pid) }
  }

  /** A line typed into the pane, then Enter. */
  async type(paneId: string, line: string): Promise<void> {
    await this.rpc('pane.send_text', { pane_id: paneId, text: `${line}\n` })
  }

  /**
   * [line] typed into the new [pane]'s shell once it has drawn its prompt, until [ran] holds. The shell can lose a line
   * typed as it sets its terminal up, its prompt drawn (measured: in 1 of 30 panes it kept only the first letter): typed
   * again, the half line cleared first (Ctrl+U), while nothing it was typed runs, the shell holding the foreground, and
   * its screen does not show the line whole (launchLost).
   */
  private async launch<T>(pane: string, folder: string, line: string, what: string,
    ran: () => Promise<T | null | undefined | false> | T | null | undefined | false): Promise<T> {
    await until(`the shell in ${folder}`, async () => /\S/.test(await this.screen(pane)), 20_000, 100)
    await this.type(pane, line)
    let typed = Date.now()
    return until(what, async () => {
      const done = await ran()
      if (!done && Date.now() - typed >= RETYPE_MS && await this.shellInFront(pane) && launchLost(await this.screen(pane), line)) {
        await this.type(pane, `\x15${line}`)
        typed = Date.now()
      }
      return done
    }, 30_000, 100)
  }

  /** Whether the pane's shell holds its terminal's foreground, so no command typed into it runs. */
  private async shellInFront(pane: string): Promise<boolean> {
    const { process_info: info } = await this.rpc('pane.process_info', { pane_id: pane }) as
      { process_info: { shell_pid: number; foreground_process_group_id: number } }
    return info.foreground_process_group_id === info.shell_pid
  }

  /**
   * herdr's own Claude Code report of the pane's session, as its integration's SessionStart hook sends it
   * (RECORDED_HERDR.nested.byReport). Sent once herdr has found the pane's agent, as the report only adds to the row its
   * detection found and that detection lags the hook; resolved once the row names the session.
   */
  async reportSession(paneId: string, sessionId: string): Promise<void> {
    const row = async () => ((await this.rpc('agent.list')).agents as Array<{ pane_id: string; agent_session?: { value?: string } }>)
      .find((agent) => agent.pane_id === paneId)
    await until(`herdr to find the agent in ${paneId}`, row, 30_000, 100)
    await this.rpc('pane.report_agent_session', { pane_id: paneId, source: 'herdr:claude', agent: 'claude', agent_session_id: sessionId })
    await until(`herdr to list ${paneId} with its session`, async () => (await row())?.agent_session?.value === sessionId, 30_000, 100)
  }

  /** Tells herdr the pane holds a `claude` agent in that state. */
  async report(paneId: string, state: 'idle' | 'working' | 'blocked'): Promise<void> {
    await this.rpc('pane.report_agent', { pane_id: paneId, source: 'harness-e2e', agent: 'claude', state })
  }

  /** A pane with the fake agent running in it, reported to herdr: its pane id. */
  async agent(folder: string, state: 'idle' | 'working' | 'blocked'): Promise<string> {
    const agent = join(this.d.root, 'hb', 'claude')
    if (!existsSync(agent)) {
      await mkdir(dirname(agent), { recursive: true })
      await writeFile(`${agent}.c`, FAKE_AGENT)
      execFileSync('cc', ['-o', agent, `${agent}.c`])
    }
    const pane = await this.pane(folder)
    // Its prompt, as herdr reads a screen: each line's trailing space cut.
    await this.launch(pane, folder, agent, `the fake agent in ${folder}`, async () => (await this.screen(pane)).includes('fake>'))
    await this.report(pane, state)
    return pane
  }

  async screen(paneId: string): Promise<string> {
    const read = await this.rpc('pane.read', { pane_id: paneId, source: 'visible' })
    return (read.read as { text: string }).text
  }

  /** The server's group killed at once, then the client in its tab, the driver's last resort: each unless another
   *  process took its pid (killGroup, killOwn). */
  kill(): void {
    killGroup(this.server)
    if (this.tab) killOwn(this.tab.pid, this.clientIdentity)
  }

  /** The server stopped through its API, else killed with its group, then the tab whose client started it closed. */
  async stop(): Promise<void> {
    const server = this.server
    await this.rpc('server.stop').catch(() => { /* already gone */ })
    const ended = () => server.ended() !== undefined
    await until("the private herdr's server to stop", ended, 10_000, 50).catch(async () => {
      killGroup(server)
      await until("the private herdr's server to end", ended, 10_000, 50)
    })
    // What else its group holds goes with it.
    killGroup(server)
    forgetGroup(server.pid)
    await this.tab?.close()
  }
}

/** The pids of every process outside this worker's tree, the person's herdr among them, from each one's pid, parent and
 *  group alone: the daemon's table names which are herdrs (ownHerdrsOnly), and nothing more is read of any here. */
export function othersNow(): number[] {
  const table = processTable()
  const ours = new Set(processTree(table, [process.pid]).map((row) => row.pid))
  return table.filter((row) => !ours.has(row.pid)).map((row) => row.pid)
}

/**
 * The daemon's process table holds no herdr but the test's: a herdr of the developer's runs on the Mac that runs the tests,
 * and the daemon's herdr lookup must never read it (PM, 2026-11-19). A `ps` first on the daemon's PATH, admitted before
 * the daemon runs it, as the harness's `lsof` (harness/daemon.ts). Only the table read `readProcessNames` makes
 * (`ps -axo pid=,ppid=,comm=`, cable/hosts/scannedApp.ts) is touched, the herdr lookup's and every other walk's of the
 * devices alike: each row whose name is `herdr` and whose parents reach neither [root] (the worker) nor the fake iTerm2's
 * server in the daemon's home goes, and is noted kept or dropped. That server is matched by its whole path, which
 * nothing but the test starts a process as: it is in the daemon's throwaway root, and a daemon whose home is not is
 * refused. Once the fake iTerm2 relaunched, a herdr started in its tab is launchd's through that server
 * (outsideAgent.ts relaunchIterm), and still the test's. [ps] is the real one, a fake table in a spec: every other `ps`
 * runs it as it was. It exits with ps's status, never awk's. Called after `IsolatedDaemon.create`, before `start`.
 */
export function ownHerdrsOnly(d: IsolatedDaemon, root: number = process.pid, ps = '/bin/ps'): { kept(): number[]; dropped(): number[] } {
  const server = itermServerPath(d)
  if (!isAbsolute(server) || relative(d.root, server).startsWith('..')) {
    throw new Error(`the daemon's home ${d.env.HOME} is outside its root ${d.root}: its herdrs cannot be told from the person's`)
  }
  const log = join(d.root, 'ps-herdr.log')
  writeExecutable(join(dirname(d.env.CLAUDE_PATH!), 'ps'), `#!/bin/sh
if [ $# -ne 2 ] || [ "$1" != -axo ] || [ "$2" != pid=,ppid=,comm= ]; then exec '${ps}' "$@"; fi
exec 4>&1
status=$({ { '${ps}' "$@" 3>&- 4>&-; echo $? >&3; } | awk -v root=${root} -v server='${server}' -v noted='${log}' '
{
  line[NR] = $0
  if (match($0, /^ *[0-9]+ +[0-9]+ +/)) {
    pid[NR] = $1; parent[$1] = $2
    # Whole, as the server is matched: a trailing space is not its path.
    named[$1] = substr($0, RLENGTH + 1)
    name = named[$1]; sub(/ +$/, "", name)
    n = split(name, part, "/"); herdr[NR] = part[n] == "herdr"
  }
}
END {
  for (i = 1; i <= NR; i++) {
    if (herdr[i]) {
      p = pid[i]; ours = 0
      for (step = 0; step < 64 && p != "" && p != 0; step++) { if (p == root || named[p] == server) { ours = 1; break }; p = parent[p] }
      print (ours ? "kept " : "dropped ") pid[i] >> noted
      if (!ours) continue
    }
    print line[i]
  }
}' >&4 3>&- 4>&-; } 3>&1)
exit "$status"
`)
  const noted = (what: 'kept' | 'dropped'): number[] => existsSync(log)
    ? [...new Set(readFileSync(log, 'utf8').split('\n').flatMap((line) => line.startsWith(`${what} `) ? [Number(line.slice(what.length + 1))] : []))]
    : []
  return { kept: () => noted('kept'), dropped: () => noted('dropped') }
}
