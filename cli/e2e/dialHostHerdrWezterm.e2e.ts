/**
 * An agent in a herdr pane whose client runs in a WezTerm pane is on WezTerm's page, and a rest while WezTerm is in
 * front activates the client's WezTerm pane and tab, then focuses the agent's herdr pane
 * (docs/plans/2026-11-21-dial-linux-followups-design.md § 2), on the real daemon: herdr's client attached to a herdr
 * server of the test's own (harness/herdrServer.ts) runs in a pane of a WezTerm mux server of the test's own
 * (harness/weztermMux.ts), another tab of its window active, and the suite's hooked fake Claude Code in a herdr pane. A
 * fake dial on the desk lists it, and the test writes the `front` lines on the stdin of the real
 * `harness hardware watch --json`, as Harness Device does. No `herdr` or `wezterm` the daemon runs reaches the
 * developer's, and the daemon's process table hides every herdr outside the test's tree (ownHerdrsOnly).
 *
 * Skipped where herdr (or the cc that builds its agent) or WezTerm is not installed; CI's `e2e (dial hosts)` job
 * installs both, and there a missing one fails the file (harness/dialHosts.ts).
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
import { PrivateWezterm, weztermBinary } from './harness/weztermMux.js'

const execFileAsync = promisify(execFile)

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
/** WezTerm in front as Harness Device names it: its bundle id on macOS, its GUI's exe name on Linux (frontApp.ts). */
const WEZTERM_FRONT = process.platform === 'darwin' ? APP_BUNDLES.wezterm : 'wezterm-gui'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** The daemon's lines that start with [prefix], each from its `[device]` on. */
const lines = (d: IsolatedDaemon, prefix: string): string[] =>
  d.log().split('\n').filter((line) => line.includes(prefix)).map((line) => line.slice(line.indexOf('[device]')))
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => lines(d, line).includes(line), 30_000, 50)

describe.skipIf(!herdrBinary || !weztermBinary)("herdr's client in WezTerm", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let herdr: PrivateHerdr | undefined
  let wezterm: PrivateWezterm | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    // WezTerm first, then herdr: its panes hold the client and the daemon's engine, and the daemon's close sweeps what
    // names its root.
    await wezterm?.stop()
    await herdr?.stop()
    await desk?.close()
    await daemon?.close()
    wezterm = undefined
    herdr = undefined
    desk = undefined
    daemon = undefined
  })

  /**
   * A daemon of its own whose process table holds no herdr but the test's, a dial that holds one app's ring shown its
   * first list, a herdr server and a WezTerm mux server of the test's own, herdr's client in a WezTerm pane and another
   * tab of that window active, then the hooked agent in a herdr pane, started once the client is attached, so its first
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
    const server = await PrivateHerdr.start(d)
    herdr = server
    const mux = await PrivateWezterm.start(d)
    wezterm = mux
    // The client's process is its pane's session leader: the shell that execs herdr.
    const client = await server.client(async (argv, env) => {
      const pane = await mux.run(argv, env)
      const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pid=,sid=', '-t', pane.tty.replace(/^\/dev\//, '')])
      const leader = stdout.split('\n').map((row) => row.trim().split(/\s+/)).find(([pid, sid]) => pid && pid === sid)
      if (!leader) throw new Error(`no session leader on WezTerm's pane ${pane.pane}`)
      return { ...pane, pid: Number(leader[0]) }
    })
    // Another tab of the client's window, which a new tab makes the active one.
    const other = (await mux.cli('spawn', '--pane-id', client.pane, '--', '/bin/cat')).trim()
    expect(await mux.activeTab(other)).toBe(true)
    expect(await mux.activeTab(client.pane)).toBe(false)
    const agent = await server.hooked('api')
    await said(d, '[device] herdr client · found')
    await dial.next((m) => m.t === 'agent' && m.id === agent.id && m.host === 'herdr', 45_000, 'the agent listed')
    // herdr focuses only an agent it has seen, and its detection lags the hook by a moment (herdr 0.9.5).
    await until('herdr to see the agent', async () => {
      const read = await server.rpc('agent.get', { target: agent.pane }).catch(() => undefined)
      return (read?.agent as { agent_status?: string } | undefined)?.agent_status === 'idle'
    }, 30_000, 100)
    expect(await server.focused()).not.toBe(agent.pane)
    return { d, dial, herdr: server, mux, client, agent }
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

  it("lists the agent on WezTerm's page, one row, and on no herdr page", async () => {
    const { dial, agent } = await fresh()
    const apps = (m: DialMessage) => m.apps as Array<{ id: string; count: number }>
    const frame = await until("WezTerm's page holding the agent", () => {
      const last = dial.messages.filter((m) => m.t === 'apps').at(-1)
      return last && apps(last).some((a) => a.id === 'wezterm' && a.count === 1) ? last : undefined
    }, 45_000, 100)
    expect(apps(frame).filter((a) => a.count > 0)).toEqual([expect.objectContaining({ id: 'wezterm', count: 1 })])
    // Its ring's list, as the dial was last sent it: the agent once, and nothing else.
    const begin = dial.messages.map((m) => m.t).lastIndexOf('agents.begin')
    const end = dial.messages.map((m) => m.t).lastIndexOf('agents.end')
    expect(end).toBeGreaterThan(begin)
    expect(dial.messages.slice(begin, end).filter((m) => m.t === 'agent').map((m) => m.id)).toEqual([agent.id])
  })

  it("with WezTerm in front a rest activates the client's pane and tab, then focuses the agent's herdr pane", async () => {
    const { d, dial, herdr, mux, client, agent } = await fresh()
    watch(d, WEZTERM_FRONT)
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
    expect(await mux.activeTab(client.pane)).toBe(true)
    expect(await mux.active(client.pane)).toBe(true)
    await until("the agent's pane focused in herdr", async () => await herdr.focused() === agent.pane, 30_000, 100)

    // No folder, session, pane, tty or config folder of the case's in the daemon's log: a tty by its name alone too.
    for (const secret of [join(d.projectsDir, 'api'), agent.sessionId, agent.pane, client.tty.slice('/dev/'.length), join(d.env.HOME!, '.config', 'herdr')]) {
      expect(d.log()).not.toContain(secret)
    }
  })

  it('with another app in front a rest moves neither the tab nor the herdr pane', async () => {
    const { d, dial, herdr, mux, client, agent } = await fresh()
    // Orca in front, with an agent of its own: the dial, holding WezTerm's ring, turns to Orca's once Orca settled
    // there, so the front line has landed.
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
    expect(await mux.activeTab(client.pane)).toBe(false)
    expect(await herdr.focused()).not.toBe(agent.pane)
  })
})
