/**
 * An agent in a herdr pane whose client runs in a kitty window is on kitty's page, and a rest while kitty is in front
 * focuses the client's kitty window, then the agent's herdr pane (docs/plans/2026-11-21-dial-linux-followups-design.md
 * § 2), on the real daemon: herdr's client attached to a herdr server of the test's own (harness/herdrServer.ts) runs in
 * the first window of a kitty of the test's own (harness/kittyWindow.ts), with remote control on for its socket alone,
 * on an X11 desk of the test's own (harness/x11Desk.ts), another tab of that kitty active, and the suite's hooked fake
 * Claude Code in a herdr pane. The server is started with that window's KITTY_WINDOW_ID and KITTY_LISTEN_ON, as one the
 * client started there keeps them, so the agent's hooks name kitty's socket. A fake dial on the desk lists it, and the
 * test writes the `front` lines on the stdin of the real `harness hardware watch --json`, as Harness Device does. No
 * `herdr` or `kitten` the daemon runs reaches the developer's, and the daemon's process table hides every herdr outside
 * the test's tree (ownHerdrsOnly).
 *
 * Skipped where herdr (or the cc that builds its agent), kitty or the X11 programs are not installed, and off Linux;
 * CI's `e2e (dial hosts)` job installs them, and there a missing one fails the file (harness/dialHosts.ts).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { APP_BUNDLES } from '../src/cable/hosts/hostDetect.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage } from './harness/fakeDial.js'
import { herdrBinary, ownHerdrsOnly, PrivateHerdr } from './harness/herdrServer.js'
import { InOrca } from './harness/inOrca.js'
import { KittyWindows, kittyInstalled } from './harness/kittyWindow.js'
import { X11Desk } from './harness/x11Desk.js'

const execFileAsync = promisify(execFile)

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
/** kitty in front as Harness Device names it on Linux: its exe name (frontApp.ts). */
const KITTY_FRONT = 'kitty'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** The daemon's lines that start with [prefix], each from its `[device]` on. */
const lines = (d: IsolatedDaemon, prefix: string): string[] =>
  d.log().split('\n').filter((line) => line.includes(prefix)).map((line) => line.slice(line.indexOf('[device]')))
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => lines(d, line).includes(line), 30_000, 50)

describe.skipIf(!herdrBinary || !kittyInstalled)("herdr's client in kitty", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let herdr: PrivateHerdr | undefined
  let x11: X11Desk | undefined
  let kitty: KittyWindows | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    // kitty first, then the X11 desk it draws on and herdr: its window holds the client, and the daemon's close sweeps
    // what names its root.
    await kitty?.stop()
    await x11?.stop()
    await herdr?.stop()
    await desk?.close()
    await daemon?.close()
    kitty = undefined
    x11 = undefined
    herdr = undefined
    desk = undefined
    daemon = undefined
  })

  /**
   * A daemon of its own whose process table holds no herdr but the test's, a dial that holds one app's ring shown its
   * first list, a herdr server started with the kitty's variables, herdr's client in that kitty's first window and
   * another tab of it active, then the hooked agent in a herdr pane, started once the client is attached, so its first
   * lookup finds it.
   */
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    ownHerdrsOnly(d)
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    const x = await X11Desk.start(d)
    x11 = x
    const windows = new KittyWindows(d, x)
    kitty = windows
    const server = await PrivateHerdr.start(d, { env: { KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: windows.nextListenOn } })
    herdr = server
    const client = await server.client((argv, env) => windows.run(argv, env))
    // Another tab of the client's kitty, which a new tab makes the active one.
    await windows.tab(client)
    expect(await windows.activeTab(client)).toBe(false)
    const agent = await server.hooked('api')
    await said(d, '[device] herdr client · found')
    await dial.next((m) => m.t === 'agent' && m.id === agent.id && m.host === 'herdr', 45_000, 'the agent listed')
    // herdr focuses only an agent it has seen, and its detection lags the hook by a moment (herdr 0.9.5).
    await until('herdr to see the agent', async () => {
      const read = await server.rpc('agent.get', { target: agent.pane }).catch(() => undefined)
      return (read?.agent as { agent_status?: string } | undefined)?.agent_status === 'idle'
    }, 30_000, 100)
    expect(await server.focused()).not.toBe(agent.pane)
    return { d, dial, herdr: server, windows, client, agent }
  }

  /** `harness hardware watch --json` as Harness Device runs it, under the daemon's environment only, [front] in front
   *  from its first line. */
  const watch = (d: IsolatedDaemon, front: string) => {
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'],
      { cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'] })
    children.push(child)
    const write = (bundle: string): void => { child.stdin!.write(`${JSON.stringify({ front: bundle })}\n`) }
    write(front)
    return { front: write }
  }

  /** The daemon's rest lines, each from its `[device]` on. */
  const swipes = (d: IsolatedDaemon): string[] => lines(d, '[device] swipe ·')

  it("lists the agent on kitty's page, one row, and on no herdr page", async () => {
    const { dial, agent } = await fresh()
    const apps = (m: DialMessage) => m.apps as Array<{ id: string; count: number }>
    const frame = await until("kitty's page holding the agent", () => {
      const last = dial.messages.filter((m) => m.t === 'apps').at(-1)
      return last && apps(last).some((a) => a.id === 'kitty' && a.count === 1) ? last : undefined
    }, 45_000, 100)
    expect(apps(frame).filter((a) => a.count > 0)).toEqual([expect.objectContaining({ id: 'kitty', count: 1 })])
    // Its ring's list, as the dial was last sent it: the agent once, and nothing else.
    const begin = dial.messages.map((m) => m.t).lastIndexOf('agents.begin')
    const end = dial.messages.map((m) => m.t).lastIndexOf('agents.end')
    expect(end).toBeGreaterThan(begin)
    expect(dial.messages.slice(begin, end).filter((m) => m.t === 'agent').map((m) => m.id)).toEqual([agent.id])
  })

  it("with kitty in front a rest focuses the client's window, then the agent's herdr pane", async () => {
    const { d, dial, herdr, windows, client, agent } = await fresh()
    watch(d, KITTY_FRONT)
    // A rest before the watch's front line lands shows nothing: the dial rests on the agent again every 2 s until one
    // is shown.
    const before = swipes(d).filter((line) => line === '[device] swipe · ok').length
    let sent = 0
    await until('a rest shown', () => {
      if (swipes(d).filter((line) => line === '[device] swipe · ok').length > before) return true
      if (Date.now() - sent >= 2_000) {
        dial.send({ t: 'focus', agentId: agent.id })
        sent = Date.now()
      }
      return undefined
    }, 60_000, 50)
    expect(await windows.activeTab(client)).toBe(true)
    expect(await windows.active(client)).toBe(true)
    await until("the agent's pane focused in herdr", async () => await herdr.focused() === agent.pane, 30_000, 100)

    // No folder, session, pane, tty, socket or config folder of the case's in the daemon's log.
    const tty = (await execFileAsync('/bin/ps', ['-o', 'tty=', '-p', String(client.pid)])).stdout.trim()
    expect(tty).toMatch(/^pts\/[0-9]+$/)
    for (const secret of [join(d.projectsDir, 'api'), agent.sessionId, agent.pane, tty, client.listenOn!,
      join(d.env.HOME!, '.config', 'herdr')]) {
      expect(d.log()).not.toContain(secret)
    }
  })

  it('with another app in front a rest moves neither the window nor the herdr pane', async () => {
    const { d, dial, herdr, windows, client, agent } = await fresh()
    // Orca in front, with an agent of its own: the dial, holding kitty's ring, turns to Orca's once Orca settled there,
    // so the front line has landed.
    const orca = new InOrca(d, 'o', children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}` })
    const since = dial.messages.length
    await orca.hook('SessionStart', { source: 'startup' })
    watch(d, APP_BUNDLES.orca)
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca', 45_000, "Orca's ring", since)
    // A turn to the agent, then to Orca's: Orca's agent rests and its rest ends with a line. Had the agent's turn waited
    // to rest, the turn after it would have ended that rest first, superseded.
    const before = swipes(d).length
    dial.send({ t: 'focus', agentId: agent.id })
    dial.send({ t: 'focus', agentId: orca.id })
    await until("the rest on Orca's agent ended",
      () => swipes(d).slice(before).some((line) => line !== '[device] swipe · superseded'), 30_000, 50)
    expect(swipes(d).slice(before)).not.toContain('[device] swipe · superseded')
    expect(d.log()).not.toContain('cable: dropped dial focus')
    expect(await windows.activeTab(client)).toBe(false)
    expect(await herdr.focused()).not.toBe(agent.pane)
  })
})
