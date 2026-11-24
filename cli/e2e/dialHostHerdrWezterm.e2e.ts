/**
 * An agent in a herdr pane whose client runs in a WezTerm pane is on herdr's page (Diego, 2026-11-23:
 * docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md), and a rest while WezTerm is in front activates the client's
 * WezTerm pane and tab, then focuses the agent's herdr pane (docs/plans/2026-11-21-dial-linux-followups-design.md § 2),
 * on the real daemon: herdr's client attached to a herdr server of the test's own (harness/herdrServer.ts) runs in a pane
 * of a WezTerm mux server of the test's own (harness/weztermMux.ts), another tab of its window active, and the suite's
 * hooked fake Claude Code in a herdr pane. A fake dial on the desk lists it, and the test writes the `front` lines on the
 * stdin of the real `harness hardware watch --json`, as Harness Device does. No `herdr` or `wezterm` the daemon runs
 * reaches the developer's, and the daemon's process table hides every herdr outside the test's tree (ownHerdrsOnly).
 *
 * The same agent found by the open scan, idle since before the devices started, is on herdr's page too
 * (docs/plans/2026-11-22-dial-iterm2-tmux-herdr-design.md): its client found from herdr's server, and placed at its herdr
 * pane by herdr's own row of it, by its session when the row names one, else by the pane whose shell is its parent, so a
 * rest focuses that pane and herdr's row folds into it, one row.
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
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
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
  /** What the case's daemon must not log: its folder, session, pane, tty, sockets, handles and config folder. */
  const unsaid: string[] = []
  afterEach(async () => {
    const log = daemon?.log() ?? ''
    const leaked = unsaid.splice(0).filter((secret) => log.includes(secret))
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
    expect(leaked).toEqual([])
  })

  /**
   * A daemon of its own whose process table holds no herdr but the test's, a dial that holds one app's ring shown its
   * first list, a herdr server and a WezTerm mux server of the test's own, herdr's client in a WezTerm pane and another
   * tab of that window active, then the hooked agent in a herdr pane, started once the client is attached, so its first
   * lookup finds it.
   *
   * With [found], the dial is plugged only once the agent ran a turn and herdr sees it idle: its hooks ran while no
   * devices process ran, so they reached nobody, and the scan the dial's attach runs finds it, as Diego's idle agents
   * were found after the devices started again (2026-11-22). `session`: herdr's row of it names its session, as herdr's
   * Claude Code integration tells it (RECORDED_HERDR byReport).
   */
  const fresh = async (found?: 'session' | 'no session') => {
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
    const plug = async (): Promise<FakeDial> => {
      const plugged = await desk!.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
      await plugged.next((m) => m.t === 'agents.end', 45_000, 'the first list')
      return plugged
    }
    let dial = found ? undefined : await plug()
    const server = await PrivateHerdr.start(d)
    herdr = server
    const mux = await PrivateWezterm.start(d)
    wezterm = mux
    // The client's process is the one on its pane's tty whose parent is the mux server: the shell that execs herdr, told
    // by its parent as macOS's ps has no `sid` to tell a session leader by.
    const client = await server.client(async (argv, env) => {
      const pane = await mux.run(argv, env)
      const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pid=,ppid=', '-t', pane.tty.replace(/^\/dev\//, '')])
      const own = stdout.split('\n').map((row) => row.trim().split(/\s+/)).find(([pid, ppid]) => pid && ppid === String(mux.pid))
      if (!own) throw new Error(`no process of the mux server's on WezTerm's pane ${pane.pane}`)
      return { ...pane, pid: Number(own[0]) }
    })
    // Another tab of the client's window, which a new tab makes the active one.
    const other = (await mux.cli('spawn', '--pane-id', client.pane, '--', '/bin/cat')).trim()
    expect(await mux.activeTab(other)).toBe(true)
    expect(await mux.activeTab(client.pane)).toBe(false)
    const agent = await server.hooked('api')
    const pid = Number(d.hookLog().match(new RegExp(`claude pid=(\\d+) SessionStart\\(startup\\) session=${agent.sessionId} ran`))![1])
    const { stdout: tty } = await execFileAsync('/bin/ps', ['-o', 'tty=', '-p', String(pid)])
    // A tty by its name alone too.
    unsaid.push(join(d.projectsDir, 'api'), agent.sessionId, agent.pane, client.tty.slice('/dev/'.length), tty.trim(),
      join(d.env.HOME!, 'wezterm', 'sock'), join(d.env.HOME!, '.config', 'herdr'))
    if (dial) {
      await said(d, '[device] herdr client · found')
      await dial.next((m) => m.t === 'agent' && m.id === agent.id && m.host === 'herdr', 45_000, 'the agent listed')
    } else {
      // A turn, so its conversation is on disk: the scan lists only a session its transcript holds.
      await server.type(agent.pane, 'before the dial')
      await until('its Stop hook to run',
        () => new RegExp(`claude pid=${pid} Stop\\S* session=${agent.sessionId} ran`).test(d.hookLog()), 30_000, 100)
    }
    // herdr focuses only an agent it has seen, and its detection lags the hook by a moment (herdr 0.9.5).
    await until('herdr to see the agent', async () => {
      const read = await server.rpc('agent.get', { target: agent.pane }).catch(() => undefined)
      return (read?.agent as { agent_status?: string } | undefined)?.agent_status === 'idle'
    }, 30_000, 100)
    if (found === 'session') {
      // As the integration's SessionStart hook sends it: herdr adds it to the row its detection found.
      await server.rpc('pane.report_agent_session',
        { pane_id: agent.pane, source: 'herdr:claude', agent: 'claude', agent_session_id: agent.sessionId })
      await until('herdr to list the agent with its session', async () => {
        const { agents } = await server.rpc('agent.list') as { agents: Array<{ pane_id: string; agent_session?: { value?: string } }> }
        return agents.some((row) => row.pane_id === agent.pane && row.agent_session?.value === agent.sessionId)
      }, 30_000, 100)
    }
    dial ??= await plug()
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

  /** WezTerm in front, then a rest on the agent every 2 s until [done]: a rest before the watch's front line lands shows
   *  nothing, and one before herdr's list places the scan's copy at its herdr pane focuses none. */
  const restUntil = async (d: IsolatedDaemon, dial: FakeDial, agentId: string, what: string,
    done: () => boolean | Promise<boolean>): Promise<void> => {
    watch(d, WEZTERM_FRONT)
    let sent = 0
    await until(what, async () => {
      if (await done()) return true
      if (Date.now() - sent >= 2_000) {
        dial.send({ t: 'focus', agentId })
        sent = Date.now()
      }
      return undefined
    }, 60_000, 50)
  }
  /** Rests on the agent until one is shown. */
  const restShown = (d: IsolatedDaemon, dial: FakeDial, agentId: string): Promise<void> => {
    const oks = () => swipes(d).filter((line) => line === '[device] swipe · ok').length
    const before = oks()
    return restUntil(d, dial, agentId, 'a rest shown', () => oks() > before)
  }

  /** The pages of an apps frame that hold an agent, each `<app> <count>`. */
  const held = (m: DialMessage): string[] =>
    (m.apps as Array<{ id: string; count: number }>).filter((a) => a.count > 0).map((a) => `${a.id} ${a.count}`).sort()
  /** Until the dial's latest apps frame holds these pages and no other. */
  const pages = (dial: FakeDial, ...want: string[]) => until(`the pages ${want.join(', ')}`, () => {
    const last = dial.messages.filter((m) => m.t === 'apps').at(-1)
    return last && held(last).join() === want.join() ? true : undefined
  }, 45_000, 100)
  /** Its ring's list, as the dial was last sent it. */
  const ring = (dial: FakeDial): unknown[] => {
    const begin = dial.messages.map((m) => m.t).lastIndexOf('agents.begin')
    const end = dial.messages.map((m) => m.t).lastIndexOf('agents.end')
    expect(end).toBeGreaterThan(begin)
    return dial.messages.slice(begin, end).filter((m) => m.t === 'agent').map((m) => m.id)
  }
  /** The open scan's line once its lookup placed the one session it found. */
  const scanPlaced = (d: IsolatedDaemon) => until("the scan's lookup to place the agent",
    () => /\[observed\] scan · 1 found · .* · 1 nested placed/.test(d.log()), 45_000, 100)

  it("lists the agent on herdr's page, one row, and on no other page", async () => {
    const { dial, agent } = await fresh()
    await pages(dial, 'herdr 1')
    // The agent once, and nothing else.
    expect(ring(dial)).toEqual([agent.id])
  })

  it("with WezTerm in front a rest activates the client's pane and tab, then focuses the agent's herdr pane", async () => {
    const { d, dial, herdr, mux, client, agent } = await fresh()
    await restShown(d, dial, agent.id)
    expect(await mux.activeTab(client.pane)).toBe(true)
    expect(await mux.active(client.pane)).toBe(true)
    await until("the agent's pane focused in herdr", async () => await herdr.focused() === agent.pane, 30_000, 100)
  })

  it("found by the scan, with herdr's row of its session: one row on herdr's page; a rest with WezTerm in front activates the client's pane and tab, then focuses the agent's herdr pane", async () => {
    const { d, dial, herdr, mux, client, agent } = await fresh('session')
    await restUntil(d, dial, agent.id, "the agent's pane focused in herdr", async () => await herdr.focused() === agent.pane)
    expect(await mux.activeTab(client.pane)).toBe(true)
    expect(await mux.active(client.pane)).toBe(true)
    await scanPlaced(d)
    // herdr's row folds into the scan's copy by its session.
    await pages(dial, 'herdr 1')
    expect(ring(dial)).toEqual([agent.id])
  })

  it("found by the scan, with no session in herdr's row: one row on herdr's page; a rest with WezTerm in front activates the client's pane and tab, then focuses the agent's herdr pane", async () => {
    const { d, dial, herdr, mux, client, agent } = await fresh('no session')
    await restUntil(d, dial, agent.id, "the agent's pane focused in herdr", async () => await herdr.focused() === agent.pane)
    expect(await mux.activeTab(client.pane)).toBe(true)
    expect(await mux.active(client.pane)).toBe(true)
    await scanPlaced(d)
    // herdr's row folds into the scan's copy by the pane whose shell is the agent's parent.
    await pages(dial, 'herdr 1')
    expect(ring(dial)).toEqual([agent.id])
  })

  it('with another app in front a rest moves neither the tab nor the herdr pane', async () => {
    const { d, dial, herdr, mux, client, agent } = await fresh()
    // Orca in front, with an agent of its own: the dial, holding herdr's ring, turns to Orca's once Orca settled
    // there, so the front line has landed.
    const handle = `term_${randomUUID()}`
    unsaid.push(handle)
    const orca = new InOrca(d, 'o', children, { ORCA_TERMINAL_HANDLE: handle })
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
