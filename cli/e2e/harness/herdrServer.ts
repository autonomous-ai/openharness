/**
 * A herdr server of the test's own (docs/specs/2026-11-16-device-herdr.md), never the developer's: its config folder is
 * under the daemon's throwaway home, its update and manifest checks are off, so it calls no other computer, and the
 * daemon's own `herdr` is a wrapper pinned to it. The daemon under test inherits no `XDG_*` (testing/daemonEnvironment.ts),
 * so it finds this server's socket under its home, as the herdr client works it out.
 *
 * Its agent is a C program named `claude`: herdr tells an agent by its process name, and a copied `/bin/cat` under that
 * name is killed by macOS. It prints `fake> `, then `GOT[<line>]` for each line it reads.
 *
 * Its client, in a fake terminal app's tab, is pinned to this server by its config folder: never the developer's herdr.
 * `ownHerdrsOnly` keeps the daemon's herdr lookup off the developer's herdr, which may run on the Mac the tests run on.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { writeExecutable } from '../../src/testing/executableFixture.js'
import { IsolatedDaemon, until } from './daemon.js'
import { tabUnder, type FakeApp } from './outsideAgent.js'
import { forgetGroup, leaderGone, watchGroup } from './reaper.js'

const execFileAsync = promisify(execFile)

/** sun_path's room, its last byte the terminator: a longer socket path fails to bind. */
const SOCKET_ROOM = 103

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
 *  (`userInfo().homedir`: the suite's HOME is a throwaway one). Null when there is none, or no `cc`: the file is
 *  then skipped. */
export const herdrBinary: string | null = (() => {
  if (process.platform === 'win32' || !resolveBinaryOnPath('cc')) return null
  const installed = join(userInfo().homedir, '.local', 'bin', 'herdr')
  return resolveBinaryOnPath('herdr') ?? (existsSync(installed) ? installed : null)
})()

export class PrivateHerdr {
  private constructor(private readonly d: IsolatedDaemon, private readonly server: ChildProcess, private readonly config: string,
    readonly socket: string) {}

  /** The server's process. */
  get pid(): number { return this.server.pid! }

  /** herdr installed for the daemon, and not running: its config, and the daemon's `herdr` on its PATH, as the devices
   *  look for it at each dial attach. Its config folder. */
  static async install(d: IsolatedDaemon): Promise<string> {
    if (!herdrBinary) throw new Error('herdr is not installed')
    const config = join(d.env.HOME!, '.config')
    // Beside its socket herdr binds herdr-client.sock, the longer, and exits when it does not fit.
    const client = join(config, 'herdr', 'herdr-client.sock')
    if (Buffer.byteLength(client) > SOCKET_ROOM) {
      throw new Error(`herdr's socket ${client} would be over ${SOCKET_ROOM} bytes: run with TMPDIR=/tmp`)
    }
    await mkdir(join(config, 'herdr'), { recursive: true })
    await writeFile(join(config, 'herdr', 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n')
    // The daemon's bin is first on its PATH: its `herdr agent focus` reaches this server alone, whatever herdr reads
    // its home from.
    await writeFile(join(dirname(d.env.CLAUDE_PATH!), 'herdr'),
      `#!/bin/sh\nXDG_CONFIG_HOME='${config}' exec '${herdrBinary}' "$@"\n`, { mode: 0o755 })
    return config
  }

  static async start(d: IsolatedDaemon): Promise<PrivateHerdr> {
    const config = await PrivateHerdr.install(d)
    const socket = join(config, 'herdr', 'herdr.sock')
    const server = spawn(herdrBinary!, ['server'], {
      cwd: d.env.HOME, env: { ...d.env, XDG_CONFIG_HOME: config }, stdio: 'ignore', ...ownProcessGroup(),
    })
    // Ended by the worker's reaper should the worker go before `stop`.
    watchGroup(server.pid!)
    server.once('exit', () => leaderGone(server.pid!))
    // A server that exits will never answer: the wait ends at once and says so.
    let exited: string | undefined
    server.once('exit', (code, signal) => { exited = String(code ?? signal) })
    const herdr = new PrivateHerdr(d, server, config, socket)
    try {
      await until('the private herdr to answer',
        async () => exited !== undefined || (existsSync(socket) && await herdr.rpc('workspace.list')), 20_000, 100)
      if (exited !== undefined) throw new Error(`the private herdr exited (${exited}) before it answered`)
      // A plain workspace in front, so that an agent's pane is never the focused one.
      await herdr.rpc('workspace.create', { focus: true })
    } catch (error) {
      await herdr.stop()
      throw error
    }
    return herdr
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

  /** A workspace in <projectsDir>/<folder>, not focused: its pane id. The pane holds its shell. */
  async pane(folder: string): Promise<string> {
    const cwd = join(this.d.projectsDir, folder)
    await mkdir(cwd, { recursive: true })
    const created = await this.rpc('workspace.create', { cwd })
    return (created.root_pane as { pane_id: string }).pane_id
  }

  /**
   * herdr's client attached to this server from a tab of a fake [app], as a person's runs in a terminal app: `herdr`
   * itself is the tab's process, given a size first, which a pseudo-terminal lacks and the client draws to. Its pid and
   * its tab's tty. Attached once the server holds one more `herdr-client.sock` connection than before it started.
   */
  async tabClient(app: FakeApp): Promise<{ pid: number; tty: string; close(): Promise<void> }> {
    const before = await this.clientConnections()
    const tab = await tabUnder(this.d, app, ['/bin/sh', '-c', 'stty rows 40 columns 120 && exec "$0"', herdrBinary!],
      { ...this.d.env, XDG_CONFIG_HOME: this.config, TERM: 'xterm-256color' })
    try {
      await until('the herdr client to attach', async () => await this.clientConnections() > before, 20_000, 100)
      const { stdout } = await execFileAsync('/bin/ps', ['-o', 'tty=', '-p', String(tab.pid)])
      return { pid: tab.pid, tty: `/dev/${stdout.trim()}`, close: () => tab.close() }
    } catch (error) {
      await tab.close()
      throw error
    }
  }

  /** The server's `herdr-client.sock` descriptors. lsof exits 1 with none, its output intact. */
  private async clientConnections(): Promise<number> {
    const listed = await execFileAsync('/usr/sbin/lsof', ['-a', '-U', '-p', String(this.pid), '-F', 'n'])
      .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
    return listed.stdout.split('\n').filter((line) => line.startsWith('n') && line.endsWith('/herdr-client.sock')).length
  }

  /** The suite's fake Claude Code started in a new pane's shell, so its hook runs with herdr's own HERDR_PANE_ID. */
  async hooked(folder: string): Promise<{ pane: string; sessionId: string; id: string }> {
    const pane = await this.pane(folder)
    await until(`the shell in ${folder}`, async () => /\S/.test(await this.screen(pane)), 20_000, 100)
    // Its own SessionStart: the first after the log's length before it was typed.
    const from = this.d.hookLog().length
    await this.type(pane, '"$CLAUDE_PATH"')
    const sessionId = await until(`${folder}'s SessionStart hook to run`,
      () => this.d.hookLog().slice(from).match(/claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/)?.[1], 30_000, 100)
    return { pane, sessionId, id: observedAgentId('claude', sessionId) }
  }

  /** A line typed into the pane, then Enter. */
  async type(paneId: string, line: string): Promise<void> {
    await this.rpc('pane.send_text', { pane_id: paneId, text: `${line}\n` })
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
    // Typed once the shell has drawn its prompt, so the line is not lost to its start.
    await until(`the shell in ${folder}`, async () => /\S/.test(await this.screen(pane)), 20_000, 100)
    await this.type(pane, agent)
    // Its prompt, as herdr reads a screen: each line's trailing space cut.
    await until(`the fake agent in ${folder}`, async () => (await this.screen(pane)).includes('fake>'), 20_000, 100)
    await this.report(pane, state)
    return pane
  }

  async screen(paneId: string): Promise<string> {
    const read = await this.rpc('pane.read', { pane_id: paneId, source: 'visible' })
    return (read.read as { text: string }).text
  }

  async stop(): Promise<void> {
    const server = this.server
    const exited = server.exitCode !== null || server.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((done) => server.once('exit', () => done()))
    await this.rpc('server.stop').catch(() => { /* already gone */ })
    const timer = setTimeout(() => IsolatedDaemon.killGroup(server), 10_000)
    await exited
    clearTimeout(timer)
    IsolatedDaemon.killGroup(server)
    forgetGroup(server.pid!)
  }
}

/**
 * The daemon's process table holds no herdr but the test's: a herdr of the developer's runs on the Mac that runs the tests,
 * and the daemon's herdr lookup must never read it (PM, 2026-11-19). A `ps` first on the daemon's PATH, admitted before
 * the daemon runs it, as the harness's `lsof` (harness/daemon.ts). Only the table read `readProcessNames` makes
 * (`ps -axo pid=,ppid=,comm=`, cable/hosts/scannedApp.ts) is touched, the herdr lookup's and every other walk's of the
 * devices alike: each row whose name is `herdr` and whose parents do not reach [root] (the worker) goes, and is noted
 * kept or dropped. Every other `ps` is the system's. It exits with ps's status, never awk's. Called after
 * `IsolatedDaemon.create`, before `start`.
 */
export function ownHerdrsOnly(d: IsolatedDaemon, root: number = process.pid): { kept(): number[]; dropped(): number[] } {
  const log = join(d.root, 'ps-herdr.log')
  writeExecutable(join(dirname(d.env.CLAUDE_PATH!), 'ps'), `#!/bin/sh
if [ $# -ne 2 ] || [ "$1" != -axo ] || [ "$2" != pid=,ppid=,comm= ]; then exec /bin/ps "$@"; fi
exec 4>&1
status=$({ { /bin/ps "$@" 3>&- 4>&-; echo $? >&3; } | awk -v root=${root} -v noted='${log}' '
{
  line[NR] = $0
  if (match($0, /^ *[0-9]+ +[0-9]+ +/)) {
    pid[NR] = $1; parent[$1] = $2
    name = substr($0, RLENGTH + 1); sub(/ +$/, "", name)
    n = split(name, part, "/"); herdr[NR] = part[n] == "herdr"
  }
}
END {
  for (i = 1; i <= NR; i++) {
    if (herdr[i]) {
      p = pid[i]; ours = 0
      for (step = 0; step < 64 && p != "" && p != 0; step++) { if (p == root) { ours = 1; break }; p = parent[p] }
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
