/**
 * An X11 desktop of the test's own (docs/plans/2026-11-19-dial-linux-design.md § 2.3), never the developer's: an Xvfb on
 * the lowest display no other server holds, its cookie in the daemon's throwaway home, openbox as its EWMH window
 * manager, and xterms running the suite's hooked fake Claude Code or a command of the test's. Each program leads a
 * process group of its own, ended by the worker's reaper should the worker go before `stop`.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'
import { IsolatedDaemon, until } from './daemon.js'
import { dialHost } from './dialHosts.js'
import { forgetGroup, leaderGone, watchGroup } from './reaper.js'

const run = promisify(execFile)

// The raise is Linux's alone: elsewhere none is looked for. Null to skip, but on a dial-hosts run (dialHosts.ts).
const onLinux = (name: string) => dialHost(name, process.platform === 'linux' ? resolveBinaryOnPath(name) : null)
const BIN = { xvfb: onLinux('Xvfb'), openbox: onLinux('openbox'), wmctrl: onLinux('wmctrl'), xterm: onLinux('xterm'), xprop: onLinux('xprop') }
export const x11Installed = Object.values(BIN).every((found) => found !== null)
const X11_SOCKETS = '/tmp/.X11-unix'

/** One MIT-MAGIC-COOKIE-1 entry in Xauthority's layout, every part but the family length-prefixed, big-endian. The
 *  wild family with no address and no display number matches any display, so it is written before Xvfb picks one. */
function cookieEntry(): Buffer {
  const part = (bytes: Buffer) => {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(bytes.length)
    return Buffer.concat([length, bytes])
  }
  return Buffer.concat([Buffer.from([0xff, 0xff]), part(Buffer.alloc(0)), part(Buffer.alloc(0)),
    part(Buffer.from('MIT-MAGIC-COOKIE-1')), part(randomBytes(16))])
}

export class X11Desk {
  private readonly children: ChildProcess[] = []
  /** `:<n>`, once Xvfb took a display. */
  display = ''

  private constructor(private readonly d: IsolatedDaemon, readonly xauthority: string) {}

  // Each client finds the cookie in ~/.Xauthority, the daemon's home: DISPLAY is all it needs.
  private get env(): NodeJS.ProcessEnv {
    return { ...this.d.env, DISPLAY: this.display }
  }

  static async start(d: IsolatedDaemon): Promise<X11Desk> {
    if (!x11Installed) throw new Error('Xvfb, openbox, wmctrl, xterm or xprop is not installed')
    const xauthority = join(d.env.HOME!, '.Xauthority')
    await writeFile(xauthority, cookieEntry(), { mode: 0o600 })
    // Every daemon's bin holds a wmctrl that refuses (daemon.ts): this desk's runs the real one.
    const wmctrl = join(dirname(d.env.CLAUDE_PATH!), 'wmctrl')
    await rm(wmctrl, { force: true })
    await symlink(BIN.wmctrl!, wmctrl)
    // -displayfd: Xvfb takes the lowest free display and writes its number once it accepts clients. -noreset: no
    // client's leaving makes it start over.
    const server = spawn(BIN.xvfb!, ['-displayfd', '3', '-auth', xauthority, '-nolisten', 'tcp', '-noreset', '-screen', '0', '1280x800x24'], {
      cwd: d.root, env: d.env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'], ...ownProcessGroup(),
    })
    let number = ''
    let errors = ''
    ;(server.stdio[3] as Readable).on('data', (chunk) => { number += chunk })
    server.stderr!.on('data', (chunk) => { errors = `${errors}${chunk}`.slice(-2_000) })
    let exited: string | undefined
    server.once('exit', (code, signal) => { exited = String(code ?? signal) })
    const desk = new X11Desk(d, xauthority)
    desk.own(server)
    try {
      await until('Xvfb to say its display', () => exited !== undefined || /^[0-9]+\n/.test(number), 20_000, 50)
      if (exited !== undefined) throw new Error(`Xvfb exited (${exited}) before it took a display:\n${errors}`)
      desk.display = `:${number.trim()}`
      desk.own(spawn(BIN.openbox!, [], { cwd: d.env.HOME, env: desk.env, stdio: 'ignore', ...ownProcessGroup() }))
      await until('openbox to manage the display', () => desk.x(BIN.wmctrl!, '-m').then(() => true, () => false), 20_000, 100)
      return desk
    } catch (error) {
      await desk.stop()
      throw error
    }
  }

  /** [argv] (the suite's fake Claude Code by default) under [env] (the daemon's), in an xterm of its own, in
   *  <projectsDir>/<folder>: its process's pid and the window's id. */
  async terminal(folder: string, argv: string[] = [this.d.env.CLAUDE_PATH!], env: NodeJS.ProcessEnv = this.d.env):
    Promise<{ pid: number; window: number }> {
    const cwd = join(this.d.projectsDir, folder)
    await mkdir(cwd, { recursive: true })
    const xterm = this.own(spawn(BIN.xterm!, ['-e', ...argv], { cwd, env: { ...env, DISPLAY: this.display }, stdio: 'ignore', ...ownProcessGroup() }))
    // xterm runs the command as its own child.
    const pid = await until(`${argv[0]} in its xterm`, async () => {
      const { stdout } = await run('pgrep', ['-P', String(xterm.pid)]).catch(() => ({ stdout: '' }))
      return Number(stdout.trim().split('\n')[0]) || null
    }, 20_000, 100)
    const window = await until("its xterm's window", async () => {
      const listed = await this.x(BIN.wmctrl!, '-lpx').catch(() => '')
      // `<id> <desktop> <pid> …`: xterm names its own pid on its window.
      const row = listed.split('\n').map((line) => /^(0x[0-9a-f]+)\s+-?[0-9]+\s+([0-9]+)\s/.exec(line))
        .find((found) => found !== null && Number(found[2]) === xterm.pid)
      return row ? Number.parseInt(row[1], 16) : null
    }, 20_000, 100)
    return { pid, window }
  }

  /** Whether an X server of root's or this account's holds a display below this desk's: a daemon given no DISPLAY takes
   *  the lowest such (cable/hosts/linuxDesktop.ts), which would be that server, the developer's own, not this desk. */
  serverBelow(): boolean {
    const own = Number(this.display.slice(1))
    const uid = process.getuid!()
    return readdirSync(X11_SOCKETS).some((name) => {
      const number = /^X(0|[1-9][0-9]*)$/.exec(name)?.[1]
      const seen = number === undefined || Number(number) >= own ? undefined : lstatSync(join(X11_SOCKETS, name), { throwIfNoEntry: false })
      return !!seen?.isSocket() && (seen.uid === uid || seen.uid === 0)
    })
  }

  /** The window `_NET_ACTIVE_WINDOW` names, as a number: xprop prints it without wmctrl's leading zeros. */
  async active(): Promise<number | null> {
    const id = /window id # (0x[0-9a-f]+)/.exec(await this.x(BIN.xprop!, '-root', '_NET_ACTIVE_WINDOW'))?.[1]
    return id === undefined ? null : Number.parseInt(id, 16)
  }

  async stop(): Promise<void> {
    // The xterms first, then openbox, then the server they all draw on.
    for (const child of this.children.splice(0).reverse()) {
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

  private own(child: ChildProcess): ChildProcess {
    watchGroup(child.pid!)
    child.once('exit', () => leaderGone(child.pid!))
    this.children.push(child)
    return child
  }

  private async x(file: string, ...args: string[]): Promise<string> {
    return (await run(file, args, { env: this.env, timeout: 10_000 })).stdout
  }
}
