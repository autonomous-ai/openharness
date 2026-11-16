/**
 * A herdr server of the test's own (docs/specs/2026-11-16-device-herdr.md), never the developer's: its config folder is
 * under the daemon's throwaway home, its update and manifest checks are off, so it calls no other computer, and the
 * daemon's own `herdr` is a wrapper pinned to it. The daemon under test inherits no `XDG_*` (testing/daemonEnvironment.ts),
 * so it finds this server's socket under its home, as the herdr client works it out.
 *
 * Its agent is a C program named `claude`: herdr tells an agent by its process name, and a copied `/bin/cat` under that
 * name is killed by macOS. It prints `fake> `, then `GOT[<line>]` for each line it reads.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { IsolatedDaemon, until } from './daemon.js'
import { forgetGroup, leaderGone, watchGroup } from './reaper.js'

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
  private constructor(private readonly d: IsolatedDaemon, private readonly server: ChildProcess, readonly socket: string) {}

  static async start(d: IsolatedDaemon): Promise<PrivateHerdr> {
    if (!herdrBinary) throw new Error('herdr is not installed')
    const config = join(d.env.HOME!, '.config')
    const socket = join(config, 'herdr', 'herdr.sock')
    if (Buffer.byteLength(socket) > SOCKET_ROOM) {
      throw new Error(`herdr's socket ${socket} would be over ${SOCKET_ROOM} bytes: run with TMPDIR=/tmp`)
    }
    await mkdir(join(config, 'herdr'), { recursive: true })
    await writeFile(join(config, 'herdr', 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n')
    // The daemon's bin is first on its PATH: its `herdr agent focus` reaches this server alone, whatever herdr reads
    // its home from.
    await writeFile(join(dirname(d.env.CLAUDE_PATH!), 'herdr'),
      `#!/bin/sh\nXDG_CONFIG_HOME='${config}' exec '${herdrBinary}' "$@"\n`, { mode: 0o755 })
    const server = spawn(herdrBinary, ['server'], {
      cwd: d.env.HOME, env: { ...d.env, XDG_CONFIG_HOME: config }, stdio: 'ignore', ...ownProcessGroup(),
    })
    // Ended by the worker's reaper should the worker go before `stop`.
    watchGroup(server.pid!)
    server.once('exit', () => leaderGone(server.pid!))
    const herdr = new PrivateHerdr(d, server, socket)
    try {
      await until('the private herdr to answer', () => existsSync(socket) && herdr.rpc('workspace.list'), 20_000, 100)
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
