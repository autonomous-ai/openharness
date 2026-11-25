/**
 * A Rex server of the test's own (docs/specs/2026-11-25-dial-rex.md), never the person's: `rex server run --restore=false`
 * with a home of its own, a short alias of the daemon's throwaway home. A Unix socket's path holds about 104 bytes, and
 * `<home>/Library/Application Support/rex/server.sock` under the daemon's home is longer, so the server's socket is
 * under the alias. The daemon is told that address (REX_SERVER, which `rex` reads as its default server); the person's
 * daemon has none and reaches its home's.
 *
 * The daemon's `rex` is the Rex Server app's, linked where the Rex app installs it under the daemon's home (rex.ts
 * REX_BIN), so the devices find it as they do on a person's Mac. Each block runs the suite's hooked fake engine with the
 * daemon's environment, its home included (a fake engine refuses settings outside the test's root), and Rex's own
 * variables but REX_SERVER: the alias's socket is not the daemon's home's, and the hook, which sends REX_SESSION only
 * for its home's own server, reads an unset REX_SERVER as that server (hook/notify.mjs onOwnRexServer, whose comparison
 * hookNotify.spec.ts covers).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { REX_BIN } from '../../src/cable/hosts/rex.js'
import { type IsolatedDaemon, until } from './daemon.js'

const run = promisify(execFile)

/** The installed Rex Server app's `rex`, on macOS, under the person's own home (vitest.setup.ts gives the worker a
 *  throwaway HOME); null to skip. */
export const rexBinary: string | null = (() => {
  const path = join(userInfo().homedir, REX_BIN)
  return process.platform === 'darwin' && existsSync(path) ? path : null
})()

/** A value for a shell script's single quotes. */
const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export class PrivateRex {
  private constructor(
    private readonly d: IsolatedDaemon,
    private readonly folder: string,
    private readonly home: string,
    private readonly server: ChildProcess,
    readonly session: string,
    readonly shell: string,
  ) {}

  /** Before the daemon starts: the link to `rex` under its home, the short alias of that home, and the server's address
   *  in the daemon's environment. */
  static prepare(d: IsolatedDaemon): { folder: string; home: string } {
    const linked = join(d.env.HOME!, REX_BIN)
    mkdirSync(dirname(linked), { recursive: true })
    symlinkSync(rexBinary!, linked)
    const folder = mkdtempSync('/tmp/rx-')
    const home = join(folder, 'h')
    symlinkSync(d.env.HOME!, home)
    d.env.REX_SERVER = PrivateRex.address(home)
    return { folder, home }
  }

  /** Once the daemon runs: the server, and a session holding one shell block, focused. */
  static async start(d: IsolatedDaemon, { folder, home }: { folder: string; home: string }): Promise<PrivateRex> {
    const env = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: d.env.TMPDIR }
    const server = spawn(rexBinary!, ['server', 'run', '--restore=false'], { env, stdio: 'ignore' })
    const rex = (args: string[]) => run(rexBinary!, ['--autostart=false', ...args], { env, timeout: 10_000 })
    await until('the private Rex server', async () => (await rex(['ls']).then(() => true, () => false)) || undefined, 20_000, 100)
    const { stdout } = await rex(['new', 'e2e', '--json', '--', '/bin/sh'])
    const session = (JSON.parse(stdout) as { session_id: string }).session_id
    const blocks = JSON.parse((await rex(['block', 'ls', '-s', session, '--json'])).stdout) as { blocks: Array<{ block_id: string }> }
    return new PrivateRex(d, folder, home, server, session, blocks.blocks[0].block_id)
  }

  /** The address `rex` reaches this server by: the daemon's REX_SERVER. */
  static address(home: string): string {
    return `unix://${encodeURI(join(home, 'Library', 'Application Support', 'rex', 'server.sock'))}`
  }

  get serverAddress(): string { return PrivateRex.address(this.home) }

  private rex(args: string[]): Promise<{ stdout: string }> {
    return run(rexBinary!, ['--autostart=false', ...args], { env: { HOME: this.home, PATH: '/usr/bin:/bin' }, timeout: 10_000 })
  }

  /** The suite's hooked fake Claude Code in a block of its own, in a window of its own, in [folder] under the projects,
   *  focus left where it was. Its environment is the daemon's, and Rex's own variables; its block's id. */
  async agent(folder: string): Promise<string> {
    const cwd = join(this.d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const script = join(this.folder, `${folder}.sh`)
    const own = Object.entries(this.d.env).filter(([name, value]) => value !== undefined
      && name !== 'TERM_PROGRAM' && !name.startsWith('REX_'))
    writeFileSync(script, ['#!/bin/sh', ...own.map(([name, value]) => `export ${name}=${quoted(value!)}`),
      'unset REX_SERVER', `exec ${quoted(this.d.env.CLAUDE_PATH!)}`, ''].join('\n'), { mode: 0o700 })
    const { stdout } = await this.rex(['run', '-s', this.session, '--focus=false', '--label', folder, '-c', cwd, '--shell', 'none',
      '--json', '--', '/bin/sh', script])
    return (JSON.parse(stdout) as { block_ids: string[] }).block_ids[0]
  }

  /** The block the session shows: its active window's focused block. */
  async focused(): Promise<string> {
    const inspected = JSON.parse((await this.rex(['session', 'inspect', this.session, '--json'])).stdout) as { session?: { active_window_id?: string } } & { active_window_id?: string }
    const active = inspected.session?.active_window_id ?? inspected.active_window_id
    const windows = JSON.parse((await this.rex(['window', 'ls', '-s', this.session, '--json'])).stdout) as { windows: Array<{ window_id: string; focused_block_id: string }> }
    return windows.windows.find((w) => w.window_id === active)!.focused_block_id
  }

  async focus(block: string): Promise<void> {
    await this.rex(['block', 'focus', '-s', this.session, block])
  }

  async screen(block: string): Promise<string> {
    return (await this.rex(['capture', '-s', this.session, '-b', block, '--trim'])).stdout
  }

  async close(block: string): Promise<void> {
    await this.rex(['block', 'close', '-s', this.session, block])
  }

  async stop(): Promise<void> {
    await this.rex(['server', 'stop']).catch(() => undefined)
    this.server.kill()
    rmSync(this.folder, { recursive: true, force: true })
  }
}
