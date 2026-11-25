// Tier A's iTerm2 (iterm.ts) on a fake world: the processes its tabs and splits run as, what the watch's tabs stream
// records of each select the devices write, and what each step tells the devices' listener. Every folder is a temp one.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, DevicesPort } from '../../../../core/api.js'
import type { ObservedEvent } from '../../../../core/observedHook.js'
import type { DevicesDeps, startDevices } from '../../../../services/devices.js'
import { REFUSED, type ListenerStream } from '../../../../services/devicesListener.js'
import { claudeSessions, itermSession, scenario as made } from '../../catalog.js'
import type { Scenario, Seen, SessionKey, StepOf } from '../../types.js'
import { installClock } from '../clock.js'
import { machine } from '../machine.js'
import { World, type TierAWorld } from '../world.js'
import { itermSteps, labelOf, openTabs, selectedTab, tabShell } from './iterm.js'
import { agentPid, running, sessionsSteps, shellOf } from './sessions.js'

const roots: string[] = []
const worlds: World[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const world of worlds.splice(0)) world.remove()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** a in w1's tab 0; b in tab 1, and c in tab 1's split 1. Made at each case, from the catalog's builder. */
const tabs = (): Scenario => ({
  id: 'T1', app: 'iterm', title: 'Eval tabs', dims: ['D1'], platforms: ['darwin'], tiers: ['a'], heldOut: false, steps: [],
  checks: [], probes: [], sessions: [itermSession('a'), itermSession('b', { tab: 1 }), itermSession('c', { tab: 1, split: 1 })],
})
const ITERM = '/Applications/iTerm.app/Contents/MacOS/iTerm2'

/** A world whose listener records each tabs stream opened and each tab report, and refuses what the test says it does. */
function fakeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'dial-eval-iterm-'))
  roots.push(root)
  machine.reset()
  machine.itermHome = root
  const of = tabs()
  const told: ObservedEvent[] = []
  const opened: Array<{ message: Record<string, unknown>; stream: ListenerStream }> = []
  const reports: Array<Record<string, unknown>> = []
  const refuse = { open: false, tab: false }
  const streams: NonNullable<Seen['streams']> = []
  const world = {
    scenario: of, platform: 'darwin', machine, streams,
    // The hooks are told nothing back, and the mod's poll is never answered.
    ports: { devices: { observed: (event: ObservedEvent) => { told.push(event); return true }, inboxPoll: () => new Promise(() => {}),
      inboxGone: () => {} } },
    folders: { claudeProjects: join(root, 'projects'), codexSessions: join(root, 'codex', 'sessions'),
      cursorProjects: join(root, 'cursor', 'projects'), codexHomes: join(root, 'codex-homes') },
    listener: {
      tabs: { maxBytes: 64, perSecond: 1, open: (message: Record<string, unknown>, stream: ListenerStream) => {
        opened.push({ message, stream })
        return refuse.open ? REFUSED : undefined
      } },
      tab: { maxBytes: 128, perSecond: 8, handle: (message: Record<string, unknown>) => {
        reports.push(message)
        return refuse.tab ? REFUSED : undefined
      } },
    },
    session: (key: SessionKey) => of.sessions.find((s) => s.key === key)!,
    deliver: () => {},
  } as unknown as TierAWorld
  const start = async (...keys: SessionKey[]) => {
    for (const session of keys) await sessionsSteps.hook(world, { kind: 'hook', session, event: 'start' })
  }
  const step = <K extends keyof typeof itermSteps>(kind: K, more: Omit<StepOf<K>, 'kind'>) =>
    (itermSteps[kind] as (w: TierAWorld, s: StepOf<K>) => Promise<void>)(world, { kind, ...more } as StepOf<K>)
  /** A process of the machine, by pid. */
  const at = (pid: number) => machine.processes.get(pid)!
  /** The tty a session's agent runs on, as the devices read it. */
  const ttyOf = (key: SessionKey) => `/dev/${at(agentPid(world, key)!).tty!}`
  /** The record without its times. */
  const lines = () => streams.map(({ window, line }) => ({ window, line }))
  return { root, world, told, opened, reports, refuse, start, step, at, ttyOf, lines }
}

describe("tier A's iTerm2", () => {
  it("a tab's agent runs under its shell, under login, under iTerm2's server, under iTerm2, all on the tab's tty", async () => {
    const w = fakeWorld()
    await w.start('a')
    const agent = w.at(agentPid(w.world, 'a')!)
    const shell = w.at(agent.ppid)
    const login = w.at(shell.ppid)
    const server = w.at(login.ppid)
    const iterm = w.at(server.ppid)
    expect([agent, shell, login, server, iterm].map((p) => p.executable)).toEqual(['claude', '/bin/zsh', '/usr/bin/login',
      join(w.root, 'Library', 'Application Support', 'iTerm2', 'iTermServer-3.6.6'), ITERM])
    expect(shellOf(w.world, 'a')).toBe(shell.pid)
    expect(agent.tty).toMatch(/^ttys\d{3}$/)
    expect([shell.tty, login.tty, server.tty, iterm.tty, iterm.ppid]).toEqual([agent.tty, agent.tty, undefined, undefined, 1])
    // iTerm2's bundle has its id, and no process of it carries an app id: the walk of its parents names the app.
    expect(machine.bundleIds.get('/Applications/iTerm.app')).toBe('com.googlecode.iterm2')
    expect([agent, shell, login, server, iterm].map((p) => p.app)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(labelOf(w.world, w.ttyOf('a'))).toBe('w1.0.0')
  })

  it('a split is a shell of its own on a tty of its own in the same tab', async () => {
    const w = fakeWorld()
    await w.start('b', 'c')
    const [b, c] = [w.at(shellOf(w.world, 'b')!), w.at(shellOf(w.world, 'c')!)]
    expect(c.pid).not.toBe(b.pid)
    expect(c.tty).not.toBe(b.tty)
    // Each split's login is the one server's child.
    expect(w.at(c.ppid).ppid).toBe(w.at(b.ppid).ppid)
    expect([labelOf(w.world, w.ttyOf('b')), labelOf(w.world, w.ttyOf('c'))]).toEqual(['w1.1.0', 'w1.1.1'])
  })

  it('iterm.tab and iterm.split open an empty shell, which the session started there runs under', async () => {
    const w = fakeWorld()
    await w.step('iterm.tab', { window: 'w1', tab: 1 })
    await w.step('iterm.split', { window: 'w1', tab: 1, split: 1 })
    const shells = [...machine.processes.values()].filter((p) => p.executable === '/bin/zsh').map((p) => p.pid)
    expect(shells).toHaveLength(2)
    await w.start('b', 'c')
    expect([shellOf(w.world, 'b'), shellOf(w.world, 'c')]).toEqual(shells)
    expect(tabShell(w.world, { window: 'w1', tab: 1, split: 1 }).pid).toBe(shells[1])
  })

  it("openTabs opens the devices' tabs stream, and each select they write is recorded naming its tab by label, other for a tty "
    + 'no tab holds', async () => {
    const w = fakeWorld()
    await w.start('a', 'b')
    openTabs(w.world)
    expect(w.opened.map((o) => o.message)).toEqual([{ type: 'tabs' }])
    const { stream } = w.opened[0]!
    expect(stream.write({ app: 'iterm', tty: w.ttyOf('b'), raise: true })).toBe(true)
    expect(stream.write({ app: 'iterm', tty: w.ttyOf('a') })).toBe(true)
    expect(stream.write({ app: 'iterm', tty: '/dev/ttys999' })).toBe(true)
    expect(w.lines()).toEqual([
      { window: 'tabs', line: { type: 'tabs' } },
      { window: 'tabs', line: { app: 'iterm', tab: 'w1.1.0', raise: true } },
      { window: 'tabs', line: { app: 'iterm', tab: 'w1.0.0' } },
      { window: 'tabs', line: { app: 'iterm', tab: 'other' } },
    ])
  })

  it('a refused tabs stream throws', async () => {
    const w = fakeWorld()
    w.refuse.open = true
    expect(() => openTabs(w.world)).toThrow("the devices' listener refused the watch's tabs stream")
  })

  it('iterm.select tells the listener {type: tab, app: iterm, tty: /dev/ttysNNN} and records it by label', async () => {
    const w = fakeWorld()
    await w.start('a', 'b')
    expect(selectedTab(w.world)).toBeUndefined()
    await w.step('iterm.select', { window: 'w1', tab: 1 })
    expect(w.ttyOf('b')).toMatch(/^\/dev\/ttys\d{3}$/)
    expect(w.reports).toEqual([{ type: 'tab', app: 'iterm', tty: w.ttyOf('b') }])
    expect(w.lines()).toEqual([{ window: 'tabs', line: { type: 'tab', app: 'iterm', tab: 'w1.1.0' } }])
    expect(selectedTab(w.world)).toEqual({ window: 'w1', tab: 1, split: 0 })
    // A tab that is not open is the scenario's mistake: nothing is told.
    await expect(w.step('iterm.select', { window: 'w1', tab: 2 })).rejects.toThrow('no tab w1.2.0 is open')
    expect(w.reports).toHaveLength(1)
  })

  it('a refused tab report throws', async () => {
    const w = fakeWorld()
    await w.start('b')
    w.refuse.tab = true
    await expect(w.step('iterm.select', { window: 'w1', tab: 1 })).rejects.toThrow("the devices' listener refused a tab")
  })

  it('iterm.closeTab ends its shells and all under them, with no hook', async () => {
    const w = fakeWorld()
    await w.start('a', 'b', 'c')
    const [aTty, bTty, cTty] = ['a', 'b', 'c'].map((key) => w.at(shellOf(w.world, key)!).tty)
    // c's agent sent its end hook, and runs on until its terminal goes.
    await sessionsSteps.hook(w.world, { kind: 'hook', session: 'c', event: 'end' })
    await w.step('iterm.tab', { window: 'w1', tab: 2 })
    const on = (tty: string | undefined) => [...machine.processes.values()].filter((p) => p.tty === tty).map((p) => p.executable)
    expect(on(cTty)).toEqual(['/usr/bin/login', '/bin/zsh', 'claude'])
    const told = w.told.length
    await w.step('iterm.closeTab', { window: 'w1', tab: 1 })
    expect(w.told).toHaveLength(told)
    expect([running(w.world, 'b'), on(bTty), on(cTty)]).toEqual([false, [], []])
    // The other tabs run on, an empty one's shell too, and so do iTerm2 and its server.
    expect(running(w.world, 'a')).toBe(true)
    expect(on(aTty)).toEqual(['/usr/bin/login', '/bin/zsh', 'claude'])
    expect(on(tabShell(w.world, { window: 'w1', tab: 2 }).tty)).toEqual(['/usr/bin/login', '/bin/zsh'])
    expect([...machine.processes.values()].filter((p) => p.tty === undefined).map((p) => p.executable))
      .toEqual([ITERM, join(w.root, 'Library', 'Application Support', 'iTerm2', 'iTermServer-3.6.6')])
    // Its tabs are gone: their ttys name none, closing it again is the scenario's mistake, and it opens again on a new tty.
    expect(labelOf(w.world, `/dev/${bTty!}`)).toBeUndefined()
    await expect(w.step('iterm.closeTab', { window: 'w1', tab: 1 })).rejects.toThrow('no tab w1.1 is open')
    expect(tabShell(w.world, { window: 'w1', tab: 1 }).tty).not.toBe(bTty)
  })

  it("iterm.relaunch ends iTerm2's process and leaves its server under launchd with every shell running", async () => {
    const w = fakeWorld()
    await w.start('a', 'b')
    const before = [...machine.processes.values()]
    const iterm = before.find((p) => p.executable === ITERM)!
    const server = before.find((p) => p.ppid === iterm.pid)!
    const told = w.told.length
    await w.step('iterm.relaunch', {})
    expect(machine.processes.has(iterm.pid)).toBe(false)
    expect(w.at(server.pid).ppid).toBe(1)
    expect([...machine.processes.values()].map((p) => p.pid)).toEqual(before.filter((p) => p !== iterm).map((p) => p.pid))
    expect([running(w.world, 'a'), running(w.world, 'b'), w.told.length]).toEqual([true, true, told])
  })
})

describe("tier A's world on iTerm2's machine", () => {
  /** A world on darwin, and what it handed the devices, its start recording them in place of the devices. */
  function worldOn(of: Scenario) {
    installClock()
    machine.reset()
    let deps: DevicesDeps | undefined
    const start = ((_core: CoreApi, _ports: unknown, handed: DevicesDeps) => {
      deps = handed
      return {}
    }) as unknown as typeof startDevices
    const world = new World(of, 'darwin', start)
    worlds.push(world)
    return { world, deps: deps! }
  }

  it("the devices read a tab's tty as /dev/ttysNNN and the table's as ttysNNN", async () => {
    const { world, deps } = worldOn(tabs())
    // iTerm2's server is in the world's own home: its root.
    expect(machine.itermHome).toBe(dirname(world.codexHome.home))
    const { pid, tty } = tabShell(world, { window: 'w1', tab: 0 })
    expect(tty).toMatch(/^ttys\d{3}$/)
    expect(machine.processes.get(pid)!.tty).toBe(tty)
    expect(await deps.tty!(pid)).toBe(`/dev/${tty}`)
    // iTerm2's server, its login's parent, runs on no tty: it has none.
    const server = machine.processes.get(machine.processes.get(pid)!.ppid)!.ppid
    expect(machine.processes.get(server)!.tty).toBeUndefined()
    expect(await deps.tty!(server)).toBeUndefined()
  })

  it("after a restart the tabs stream is open on the new devices' handler", async () => {
    installClock()
    machine.reset()
    // Each start's devices open their own tabs handler, which keeps the streams it is handed.
    const streams: ListenerStream[][] = []
    const start = ((_core: CoreApi, ports: CorePorts, deps: DevicesDeps) => {
      const held: ListenerStream[] = []
      streams.push(held)
      void deps.listen!({ tabs: { maxBytes: 64, perSecond: 1, open: (_message, stream) => { held.push(stream) } } }, () => {})
      ports.devices = { stop: async () => {} } as unknown as DevicesPort
      return {}
    }) as unknown as typeof startDevices
    const world = new World(tabs(), 'darwin', start)
    worlds.push(world)
    const { tty } = tabShell(world, { window: 'w1', tab: 1 })
    openTabs(world)
    await world.restartDevices()
    openTabs(world)
    expect(streams.map((held) => held.length)).toEqual([1, 1])
    // A select the new devices write is recorded by its tab.
    expect(streams[1]![0]!.write({ app: 'iterm', tty: `/dev/${tty}`, raise: true })).toBe(true)
    expect(world.streams.map(({ window, line }) => ({ window, line }))).toEqual([
      { window: 'tabs', line: { type: 'tabs' } },
      { window: 'tabs', line: { type: 'tabs' } },
      { window: 'tabs', line: { app: 'iterm', tab: 'w1.1.0', raise: true } },
    ])
  })

  it('another app\'s world has no iTerm2 home', () => {
    worldOn(made({ id: 'T2', app: 'claude', title: 'Eval world', dims: ['D1'], steps: [], checks: [], probes: [],
      sessions: claudeSessions(['a']) }))
    expect(machine.itermHome).toBeUndefined()
  })

  it('a tmux or herdr command the devices ran is recorded with each pane the models opened named by its session, pane:other '
    + 'for another', async () => {
    const { world, deps } = worldOn(tabs())
    world.panes.set('%1', 'b')
    world.panes.set('w1:p2', 'c')
    await deps.orca!.run('/opt/eval/bin/tmux', ['select-window', '-t', '%1', ';', 'select-pane', '-t', '%1'], 1_000)
    await deps.orca!.run('/opt/eval/bin/herdr', ['agent', 'focus', 'w1:p2'], 1_000)
    await deps.orca!.run('/opt/eval/bin/tmux', ['switch-client', '-c', '/dev/ttys004', '-t', '%7'], 1_000)
    expect(world.seen([]).commands.map((c) => c.argv)).toEqual([
      ['/opt/eval/bin/tmux', 'select-window', '-t', 'pane:b', ';', 'select-pane', '-t', 'pane:b'],
      ['/opt/eval/bin/herdr', 'agent', 'focus', 'pane:c'],
      ['/opt/eval/bin/tmux', 'switch-client', '-c', '/dev/ttys004', '-t', 'pane:other'],
    ])
  })
})
