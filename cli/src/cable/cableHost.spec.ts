// How the wheel's rows are composed: the local row, and the fleet's rows around it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DaemonCableHost, cableEventFor, cableStepFor, type CableHostWiring } from './cableHost.js'
import { FleetError, type FleetMachine, type MachineFleet } from './machineFleet.js'
import type { FleetRouting } from '../services/fleet.js'
import { ServiceUnavailableError } from '../core/serviceHost.js'
import type { RegisteredSession } from '../lib/registry.js'
import { WebSocketServer, type WebSocket } from 'ws'
import { DeviceFleet } from '../device/deviceFleet.js'
import { DeviceLink } from '../device/deviceLink.js'
import { HostRegistry } from './hosts/registry.js'
import { FRONT_SETTLE_MS } from './hosts/appFilter.js'
import type { HostAgent, HostSource, PaneSwitch, SendResult } from './hosts/types.js'
import type { CableAgent } from './cableSession.js'

// The voice router as it runs, watched: what it weighs, and the ranking it asks of the backend, leave this computer.
const router = vi.hoisted(() => ({ routed: [] as unknown[], ranked: [] as unknown[] }))
vi.mock('../lib/voiceRouter.js', async (original) => {
  const actual = await original<typeof import('../lib/voiceRouter.js')>()
  return { ...actual, routeVoiceTask: (...args: Parameters<typeof actual.routeVoiceTask>) => {
    router.routed.push(args)
    return actual.routeVoiceTask(...args)
  } }
})
vi.mock('../lib/routeApi.js', () => ({ rankAgents: async (options: unknown) => {
  router.ranked.push(options)
  return [{ agentId: 'h2', score: 0.9, reason: 'matched' }]
} }))

const AGENTS: Array<{ agentId: string; registeredAt: number; active: boolean; terminalAvailable: boolean; engine: string; lastHookAt?: number }> = []

function wiring(over: Partial<CableHostWiring> = {}): CableHostWiring {
  return {
    // The core's advertised agents and their names: what the router this host keeps for itself reads.
    sessions: () => AGENTS.filter((a) => a.terminalAvailable) as unknown as RegisteredSession[],
    displayName: (s) => s.agentId,
    machineName: () => 'MacbookPro.local',
    machineId: () => 'mine',
    computerId: () => 'abc-123',
    sendTurn: vi.fn(),
    stopTurn: vi.fn(),
    answer: vi.fn(),
    recent: () => [],
    recentAsks: () => [],
    log: vi.fn(),
    ...over,
  }
}

function fleetOf(machines: FleetMachine[]): MachineFleet {
  return {
    list: async () => ({ machines, source: 'backend' as const }),
    recentAsks: async () => [],
    online: async () => {},
    select: async () => {},
    release: vi.fn(),
    listAgents: async () => [],
    sendTurn: vi.fn(), stopTurn: vi.fn(), answer: vi.fn(), updateAgent: vi.fn(),
    listModels: async () => [],
    recentSummaries: async () => [],
    onEvent: () => () => {},
  }
}

const REMOTE: FleetMachine = { machineId: 'other', name: 'office-imac', state: 'ready', authMode: 'remote' }

it('reads the current window selection for each recording instead of caching it with the roster', () => {
  let focused: { machineId: string; agentId: string } | undefined
  const host = new DaemonCableHost(wiring({ appFocus: () => focused }))
  expect(host.appFocus()).toBeUndefined()
  focused = { machineId: 'other', agentId: 'a2' }
  expect(host.appFocus()).toEqual(focused)
  focused = { machineId: 'mine', agentId: 'a1' }
  expect(host.appFocus()).toEqual(focused)
  expect(new DaemonCableHost(wiring()).appFocus()).toBeUndefined()
})

describe('notification read receipts', () => {
  it('routes the exact occurrence to its machine without focusing or answering', () => {
    const w = wiring({ notificationRead: vi.fn(), opened: vi.fn(), focused: vi.fn() })
    const host = new DaemonCableHost(w)
    const item = { agentId: 'a', machineId: 'other', text: 'Same words.', question: true, readToken: 'turn-2' }
    host.setUnread([item])
    for (const [agent, token] of [['a', 'turn-1'], ['b', 'turn-2'], ['a', 'x'.repeat(64)], ['a', '']]) host.readNotification(agent, token)
    expect(w.notificationRead).not.toHaveBeenCalled()
    host.readNotification('a', 'turn-2'); host.readNotification('a', 'turn-2')
    expect(w.notificationRead).toHaveBeenCalledTimes(2)
    expect(w.notificationRead).toHaveBeenLastCalledWith('other', 'a', 'turn-2')
    expect(w.opened).not.toHaveBeenCalled(); expect(w.focused).not.toHaveBeenCalled(); expect(w.answer).not.toHaveBeenCalled()
    expect(host.listUnread()).toEqual([item]) // only the window confirms the clear
    host.setUnread([]); host.readNotification('a', 'turn-2')
    expect(w.notificationRead).toHaveBeenCalledTimes(2)
  })
})

/** The window, open on one tab that holds these panes in this order. */
function onTab(host: DaemonCableHost, agentIds: string[], id = 't1'): void {
  host.setSwarms({ active: id, swarms: [{ id, name: 'Tab', agentIds, panes: agentIds.length }], tiles: [] })
  host.setDesk(agentIds)
}

describe('DaemonCableHost.listMachines', () => {
  it('names the local row after the machine, and marks it local', async () => {
    // The row carries the machine's name; what identifies it as the cabled one is the `local` flag, which
    // the dial turns into the second line. Two facts, one field each.
    const host = new DaemonCableHost(wiring(), fleetOf([REMOTE]))
    const { machines } = await host.listMachines()
    expect(machines[0]).toMatchObject({ id: 'mine', name: 'MacbookPro.local', local: true, state: 'ready' })
  })

  it('puts the local row first and keeps the fleet’s rows after it', async () => {
    const host = new DaemonCableHost(wiring(), fleetOf([REMOTE]))
    const { machines } = await host.listMachines()
    expect(machines.map((m) => m.id)).toEqual(['mine', 'other'])
    expect(machines[1]).toMatchObject({ name: 'office-imac', local: false })
  })

  it('never lists this computer twice, and a rename on the account does not touch its label', async () => {
    // `GET /api/machines` contains this computer too. Letting that row through would put the same machine
    // on the wheel under two names, and the ✓ could only ever mark one of them.
    const dupe: FleetMachine = { machineId: 'mine', name: 'renamed-in-the-web-ui', state: 'offline', authMode: 'remote' }
    const host = new DaemonCableHost(wiring(), fleetOf([dupe, REMOTE]))
    const { machines } = await host.listMachines()
    expect(machines.map((m) => m.id)).toEqual(['mine', 'other'])
    expect(machines[0]).toMatchObject({ name: 'MacbookPro.local', state: 'ready' })
  })

  it('shows one row and says why when there is no fleet at all', async () => {
    const host = new DaemonCableHost(wiring())
    const { machines, source } = await host.listMachines()
    expect(source).toBe('signed-out')
    expect(machines).toHaveLength(1)
    expect(machines[0].local).toBe(true)
  })

  it('falls back to a placeholder id rather than an empty one', async () => {
    // A belt, not a mode: `harness start` refuses to run signed out and resolves the machineId before the
    // daemon spawns, so this should never happen. It is guarded because the alternative is silent — an
    // empty id renders a row that is tappable and can never be selected.
    const host = new DaemonCableHost(wiring({ machineId: () => '' }))
    const { machines } = await host.listMachines()
    expect(machines[0].id).toBe('cable:abc-123')
    expect(host.isLocalSelected()).toBe(true)
  })
})

describe('DaemonCableHost.listAgentsFlat', () => {
  const set = (rows: Array<{ agentId: string; registeredAt: number; active?: boolean; terminalAvailable?: boolean }>): void => {
    AGENTS.length = 0
    for (const r of rows) AGENTS.push({ engine: 'claude', active: true, terminalAvailable: true, ...r })
  }

  it('lists only terminal-available agents — including a dormant engine with a live pane', async () => {
    // Two surfaces reading one registry must not disagree about what is on it. A dead agent holding a tile
    // on the dial and nowhere else is a tile that cannot be driven and cannot be explained.
    set([
      { agentId: 'a', registeredAt: 1 },
      { agentId: 'b', registeredAt: 2, active: false },
      { agentId: 'stale', registeredAt: 3, terminalAvailable: false },
    ])
    const host = new DaemonCableHost(wiring())
    expect((await host.listAgentsFlat()).map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('orders oldest first', async () => {
    set([{ agentId: 'new', registeredAt: 30 }, { agentId: 'old', registeredAt: 10 }, { agentId: 'mid', registeredAt: 20 }])
    const host = new DaemonCableHost(wiring())
    expect((await host.listAgentsFlat()).map((a) => a.id)).toEqual(['old', 'mid', 'new'])
  })

  it('breaks a tie by id, so the order never falls through to insertion order', async () => {
    // Without the tie-break the winner is whichever the Map happens to hold first — which differs between
    // daemon runs, so the web, the app and the dial would each show a different order for one registry.
    set([{ agentId: 'zz', registeredAt: 5 }, { agentId: 'aa', registeredAt: 5 }])
    const host = new DaemonCableHost(wiring())
    expect((await host.listAgentsFlat()).map((a) => a.id)).toEqual(['aa', 'zz'])

    set([{ agentId: 'aa', registeredAt: 5 }, { agentId: 'zz', registeredAt: 5 }])
    expect((await new DaemonCableHost(wiring()).listAgentsFlat()).map((a) => a.id)).toEqual(['aa', 'zz'])
  })
})

describe('the cloud lane follows the CABLE, not the selection', () => {
  const remoteFleet = () => {
    const f = fleetOf([REMOTE])
    f.online = vi.fn(async () => {})
    f.select = vi.fn(async () => {})
    f.release = vi.fn()
    return f
  }

  it('drops the lane the moment the dial goes away', async () => {
    // Held on the dial's behalf and used by nothing else here. Keeping it open leaves the account showing
    // a device attached to a machine while the dial sits unplugged in a drawer, with that machine's cards
    // relayed to a screen that is not there.
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    await host.selectMachine('other')

    host.onDialGone()
    expect(fleet.release).toHaveBeenCalledWith(true)   // true = now, not after the linger
  })

  it('drops it even when the dial was on the local machine — cancelling a linger', () => {
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialGone()
    expect(fleet.release).toHaveBeenCalledWith(true)
  })

  it('opens the socket the moment the dial appears, whatever is selected', async () => {
    // The whole point: plugged in means online. The wheel's dots are live from that moment, instead of
    // waiting for the user to pick a machine that is not this computer.
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.online).toHaveBeenCalled()
  })

  it('announces the selected machine on attach — including the local one', async () => {
    // `DeviceBinding.activeMachineId` is what the web and the mobile app read to say where a dial is.
    // Skipping the local machine leaves it naming whatever was selected last, forever.
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.select).toHaveBeenCalledWith('mine')
  })

  it('announces a remote selection after a replug', async () => {
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    await host.selectMachine('other')
    ;(fleet.select as ReturnType<typeof vi.fn>).mockClear()

    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.select).toHaveBeenCalledWith('other')
  })

  it('announces nothing for the placeholder id — it is not a machineId', async () => {
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring({ machineId: () => '' }), fleet)
    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.online).toHaveBeenCalled()
    expect(fleet.select).not.toHaveBeenCalled()
  })

  it('survives a lane that will not reopen, instead of rejecting into the greeting', async () => {
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    await host.selectMachine('other')
    ;(fleet.select as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unreachable'))

    expect(() => host.onDialAttached()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))   // let the rejection land on its catch
  })
})

describe('DaemonCableHost.listAgentsFlat across machines, and the tab the dial gets', () => {
  /** A fleet whose remote agent lists are scripted per machine. */
  function crossFleet(byMachine: Record<string, Array<{ id: string; name: string }>>, machines = [REMOTE]): MachineFleet {
    const fleet = fleetOf(machines)
    fleet.listAgents = vi.fn(async (machineId: string) => (byMachine[machineId] ?? []) as never)
    fleet.sendTurn = vi.fn()
    fleet.stopTurn = vi.fn()
    fleet.recentSummaries = vi.fn(async () => [])
    return fleet
  }

  /** Two ticks: the first kicks the background refresh off, the second reads what it wrote. */
  async function settled(host: DaemonCableHost): Promise<Awaited<ReturnType<DaemonCableHost['listAgentsFlat']>>> {
    await host.listAgentsFlat()
    await new Promise((r) => setTimeout(r, 0))
    return host.listAgentsFlat()
  }

  it('puts this computer first and every other machine after it, in wheel order', async () => {
    // The order IS the contract: the dial swipes through it and the desktop app's rail reads top to
    // bottom in the same order, so the two surfaces can be compared by eye.
    AGENTS.length = 0
    AGENTS.push({ agentId: 'local-1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const second: FleetMachine = { machineId: 'third', name: 'studio', state: 'ready', authMode: 'remote' }
    const host = new DaemonCableHost(
      wiring(),
      crossFleet({ other: [{ id: 'r1', name: 'api' }], third: [{ id: 'r2', name: 'ui' }] }, [REMOTE, second]),
    )
    const agents = await settled(host)
    expect(agents.map((a) => a.id)).toEqual(['local-1', 'r1', 'r2'])
    expect(agents.map((a) => a.machine)).toEqual(['MacbookPro.local', 'office-imac', 'studio'])
    expect(agents.map((a) => a.machineId)).toEqual(['mine', 'other', 'third'])
  })

  it('lists a terminal beside the agents, and says it is one', async () => {
    // It used to be left out, on the reading that the dial drives agents and a shell has no turn to
    // drive. But the window draws a shell as a tile like any other, so leaving it out gave the dial
    // a desk with a hole in it — a pane the carousel could not walk to and could not explain. It is
    // listed now, and `engine` is how the tile knows to wear a prompt instead of a product mark and
    // to offer no Voice; the same row is reported as `claude` the moment one is typed into it.
    AGENTS.length = 0
    AGENTS.push({ agentId: 'term-1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'terminal' })
    AGENTS.push({ agentId: 'local-1', registeredAt: 2, active: true, terminalAvailable: true, engine: 'claude' })
    const host = new DaemonCableHost(wiring(), crossFleet({}, []))
    const agents = await settled(host)
    expect(agents.map((a) => a.id)).toEqual(['term-1', 'local-1'])
    expect(agents.map((a) => a.engine)).toEqual(['terminal', 'claude'])
    // …and the overview's number is not the list's length. The carousel carries the shell because it
    // is a tile; "N agents · all idle" counts work in flight, which a shell has none of.
    expect(host.agentTotal()).toBe(1)
  })

  it('keeps a machine\'s agents when the backend cannot be asked', async () => {
    // The failure this exists for, measured on the real dial: `unknown` means the backend could not be
    // reached — MachineListCache.degrade() marks EVERY machine with it in one go — and reading it as
    // "the machine is gone" emptied a remote machine off the carousel mid-session, silently, while the
    // window went on showing those agents.
    AGENTS.length = 0
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const host = new DaemonCableHost(wiring(), crossFleet({ other: [{ id: 'r1', name: 'api' }] }, machines))
    expect((await settled(host)).map((a) => a.id)).toEqual(['r1'])

    machines[0].state = 'unknown'
    // Well past REMOTE_GRACE_MS: this is not a grace period, it is a different question.
    vi.setSystemTime(Date.now() + 10 * 60_000)
    expect((await settled(host)).map((a) => a.id)).toEqual(['r1'])
    vi.useRealTimers()
  })

  it('drops them when the machine itself says it is offline, and says so', async () => {
    AGENTS.length = 0
    const log = vi.fn()
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const host = new DaemonCableHost(wiring({ log }), crossFleet({ other: [{ id: 'r1', name: 'api' }] }, machines))
    expect((await settled(host)).map((a) => a.id)).toEqual(['r1'])

    machines[0].state = 'offline'
    expect((await settled(host)).map((a) => a.id)).toEqual([])
    // An agent leaving the carousel is the one event that cannot be diagnosed from its absence.
    expect(log.mock.calls.flat().join('\n')).toContain('left the carousel')
  })

  it('holds a tile the window has open even when its machine goes offline', async () => {
    // The desk is the contract between the two screens. A hole in it makes a swipe skip a tile and an
    // agent chosen in the window have nowhere to land.
    AGENTS.length = 0
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const host = new DaemonCableHost(wiring(), crossFleet({ other: [{ id: 'r1', name: 'api' }] }, machines))
    await settled(host)
    onTab(host, ['r1'])

    machines[0].state = 'offline'
    const agents = await settled(host)
    expect(agents.map((a) => a.id)).toEqual(['r1'])
    // Under the name and machine it was last seen with, not a placeholder — and still on the dial's tab.
    expect(agents[0]).toMatchObject({ name: 'api', machineId: 'other', machine: 'office-imac' })
    expect((await host.listAgents()).map((a) => a.id)).toEqual(['r1'])
    expect(host.knows('r1')).toBe(true)
  })

  it('answers the RAIL\'s order flat, and the dial\'s tab separately, from one snapshot', async () => {
    // Two questions, two right answers, and they must not be confused for each other. The dial holds the
    // window's open tab, in tile order; ⌘K weighs "the first fifteen agents" against a list the person is
    // reading top to bottom in their rail. Serving the tab to ⌘K makes the fifteen it picks impossible to
    // predict from the screen — the tile someone happened to open last silently reorders what a typed
    // task is even compared against.
    AGENTS.length = 0
    AGENTS.push({ agentId: 'local-1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    AGENTS.push({ agentId: 'local-2', registeredAt: 2, active: true, terminalAvailable: true, engine: 'claude' })
    const host = new DaemonCableHost(wiring(), crossFleet({ other: [{ id: 'r1', name: 'api' }] }))
    await settled(host)
    // Two tiles, in an order the rail does not have: the remote agent first.
    onTab(host, ['r1', 'local-1'])

    // The rail: this computer's agents in their own order, then the other machine's.
    expect((await host.listAgentsFlat()).map((a) => a.id)).toEqual(['local-1', 'local-2', 'r1'])
    // The dial: the tab's two tiles in tile order, and local-2 — open nowhere — not at all.
    expect((await host.listAgents()).map((a) => a.id)).toEqual(['r1', 'local-1'])
    expect(host.agentTotal()).toBe(3)
  })

  it('sends the dial nothing with no window, and says so in the tab id', async () => {
    // A shut app is not an empty tab. Both send zero rows; the dial draws "Run OpenHarness" for one and
    // "Nothing on this tab" for the other, and `activeSwarm` is the only thing that tells them apart.
    AGENTS.length = 0
    for (const agentId of ['a1', 'a2']) {
      AGENTS.push({ agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    }
    const host = new DaemonCableHost(wiring())
    await settled(host)

    expect(await host.listAgents()).toEqual([])
    expect(host.activeSwarm()).toBe('')
    // The count still travels: the overview prints it without holding a row per agent.
    expect(host.agentTotal()).toBe(2)

    onTab(host, [], 'fresh')
    expect(await host.listAgents()).toEqual([])
    expect(host.activeSwarm()).toBe('fresh')

    host.setSwarms(null)
    host.setDesk([])
    expect(host.activeSwarm()).toBe('')
  })

  it('takes workspace identity and pane membership from one desktop announcement', async () => {
    AGENTS.length = 0
    for (const agentId of ['old-pane', 'new-pane'])
      AGENTS.push({ agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const host = new DaemonCableHost(wiring())
    onTab(host, ['old-pane'], 'old-tab')
    host.setDesk(['new-pane']) // app_panes arrives before its matching app_swarms.
    expect((await host.listAgents()).map(a => a.id)).toEqual(['old-pane'])
    host.setSwarms({ active: 'new-tab', tiles: [], swarms: [{ id: 'new-tab', name: 'New', agentIds: ['new-pane'], panes: 1 }] })
    const snapshot = await host.listAgentSnapshot()
    expect(snapshot.tab).toBe('new-tab')
    expect(snapshot.agents.map(a => a.id)).toEqual(['new-pane'])
    expect(snapshot.total).toBe(2)
    onTab(host, [], 'empty-tab')
    expect(snapshot.tab).toBe('new-tab')
    expect(snapshot.agents.map(a => a.id)).toEqual(['new-pane'])
    expect(await host.listAgentSnapshot()).toMatchObject({ tab: 'empty-tab', agents: [] })
  })

  it('names the machine, and routes an open, for an agent heard from before it was listed', async () => {
    // A remote machine's question can arrive before its agent list has ever been read. The card still has
    // to say where it came from, and a tap on it has to open — "ignored open for unknown agent" was a
    // question screen nobody could act on.
    AGENTS.length = 0
    const opened = vi.fn()
    const host = new DaemonCableHost(wiring({ opened }), crossFleet({ other: [] }))
    await settled(host)

    expect(host.describe('r9')).toBeUndefined()
    host.noteAgent('other', 'r9')
    expect(host.describe('r9')).toEqual({ name: '', engine: '', machine: 'office-imac' })
    host.openAgent('r9')
    expect(opened).toHaveBeenCalledWith('other', 'r9', undefined)
    // A question screen's own open says so, and the window hears it.
    host.openAgent('r9', 'question')
    expect(opened).toHaveBeenLastCalledWith('other', 'r9', 'question')
  })

  it('forks a local agent through the daemon and opens the fork in the window', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: 'a1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const opened = vi.fn()
    const forkAgent = vi.fn(async () => ({ ok: true as const, agentId: 'a1-fork' }))
    const host = new DaemonCableHost(wiring({ opened, forkAgent }))
    await settled(host)

    expect(await host.forkAgent('a1')).toEqual({ ok: true, agentId: 'a1-fork' })
    expect(forkAgent).toHaveBeenCalledWith('a1')
    // The new agent lands in the window on its machine — before any list has named it. Through
    // `forked` when the wiring has it (beside its source), else the plain `opened`.
    expect(opened).toHaveBeenCalledWith('mine', 'a1-fork')
    const forked = vi.fn()
    const host2 = new DaemonCableHost(wiring({ opened, forked, forkAgent }))
    await settled(host2)
    await host2.forkAgent('a1')
    expect(forked).toHaveBeenCalledWith('mine', 'a1-fork', 'a1')
    expect(host.describe('a1-fork')).toMatchObject({ machine: 'MacbookPro.local' })
  })

  it('forks a remote agent on its own machine, and reports the far end\'s refusal', async () => {
    AGENTS.length = 0
    const opened = vi.fn()
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] })
    fleet.forkAgent = vi.fn(async (_m: string, id: string) => { if (id === 'r1') return 'r1-fork'; throw new Error('r1 is in the middle of a turn') })
    const host = new DaemonCableHost(wiring({ opened }), fleet)
    await settled(host)

    expect(await host.forkAgent('r1')).toEqual({ ok: true, agentId: 'r1-fork' })
    expect(fleet.forkAgent).toHaveBeenCalledWith('other', 'r1')
    expect(opened).toHaveBeenCalledWith('other', 'r1-fork')
    expect(await host.forkAgent('ghost')).toMatchObject({ ok: false, error: 'AGENT_NOT_FOUND' })
  })

  it('describes an agent it has listed, for a card about one the dial does not hold', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: 'a1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'codex' })
    const host = new DaemonCableHost(wiring(), crossFleet({ other: [{ id: 'r1', name: 'api' }] }))
    await settled(host)
    onTab(host, ['a1'])

    // r1 is off the tab — the dial has no row for it — and the frame has to carry who it is.
    expect(host.describe('r1')).toEqual({ name: 'api', engine: '', machine: 'office-imac' })
    expect(host.describe('a1')).toMatchObject({ name: 'a1', engine: 'codex', machine: 'MacbookPro.local' })
    expect(host.describe('ghost')).toBeUndefined()
  })

  it('does not resurrect an agent that has no tile', async () => {
    // The memory is only a warrant for what the window is showing. An agent that was deleted must stay
    // deleted.
    AGENTS.length = 0
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const host = new DaemonCableHost(wiring(), crossFleet({ other: [{ id: 'r1', name: 'api' }] }, machines))
    await settled(host)

    machines[0].state = 'offline'
    expect((await settled(host)).map((a) => a.id)).toEqual([])
    expect(host.knows('r1')).toBe(false)
  })

  it('sends a turn to the agent’s OWN machine, not to the selected one', async () => {
    // The single worst outcome this feature can produce is a turn delivered to a different computer, so
    // the routing is asserted with the wheel deliberately pointed somewhere else.
    AGENTS.length = 0
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] })
    const host = new DaemonCableHost(wiring(), fleet)
    await settled(host)
    expect(host.isLocalSelected()).toBe(true)   // the wheel never moved

    host.sendTurn('r1', 'ship it')
    expect(fleet.sendTurn).toHaveBeenCalledWith('other', 'r1', 'ship it')
  })

  it('reports a dial focus with the machine that owns the agent', async () => {
    AGENTS.length = 0
    const focused = vi.fn()
    const host = new DaemonCableHost(
      wiring({ focused }),
      crossFleet({ other: [{ id: 'r1', name: 'api' }] }),
    )
    await settled(host)

    host.focus('r1')

    expect(focused).toHaveBeenCalledWith('other', 'r1')
  })

  it('steps focus along the tab, wrapping at both ends, with the same forward the dial uses', async () => {
    AGENTS.length = 0
    for (const agentId of ['a1', 'a2', 'a3']) {
      AGENTS.push({ agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    }
    const focused = vi.fn()
    const host = new DaemonCableHost(wiring({ focused }))
    await settled(host)
    // Tiles in the window's order, not registration order; a3 has no tile and is never stepped onto.
    onTab(host, ['a2', 'a1'])

    expect(await host.stepFocus('next', 'a2')).toEqual({ machineId: 'mine', agentId: 'a1' })
    expect(await host.stepFocus('next', 'a1')).toEqual({ machineId: 'mine', agentId: 'a2' })
    expect(await host.stepFocus('previous', 'a2')).toEqual({ machineId: 'mine', agentId: 'a1' })
    // Off the tab, or nothing focused: the walk starts at the first (next) or last (previous) tile.
    expect(await host.stepFocus('next', 'a3')).toMatchObject({ agentId: 'a2' })
    expect(await host.stepFocus('previous', undefined)).toMatchObject({ agentId: 'a1' })
    expect(focused.mock.calls.map((c) => c[1])).toEqual(['a1', 'a2', 'a1', 'a2', 'a1'])
  })

  it('steps onto a remote tile with that machine’s id, and reports an empty desk', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: 'a1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const focused = vi.fn()
    const host = new DaemonCableHost(wiring({ focused }), crossFleet({ other: [{ id: 'r1', name: 'api' }] }))
    await settled(host)
    onTab(host, ['a1', 'r1'])
    expect(await host.stepFocus('next', 'a1')).toEqual({ machineId: 'other', agentId: 'r1' })
    expect(focused).toHaveBeenLastCalledWith('other', 'r1')

    AGENTS.length = 0
    const empty = new DaemonCableHost(wiring({ focused }))
    await settled(empty)
    expect(await empty.stepFocus('next', undefined)).toBe('no_agents')
  })

  it('reports a focus with no edge, on or off the desk', async () => {
    // `edge` is gone with the arcs. It answered "which tile does this replace" for an agent the window
    // had none for, which the carousel could reach by walking past the end of the desk; it walks only
    // the desk now, so every focus it can raise is about a tile that already exists.
    AGENTS.length = 0
    for (const agentId of ['a1', 'a2', 'a3']) {
      AGENTS.push({ agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    }
    const focused = vi.fn()
    const host = new DaemonCableHost(wiring({ focused }))
    await settled(host)

    onTab(host, ['a2'])
    await host.listAgents()

    host.focus('a2')
    expect(focused).toHaveBeenLastCalledWith(expect.any(String), 'a2')
    // Even for one the dial does not hold — a notification can still name it, and the window opening it
    // is what puts it on the tab.
    host.focus('a3')
    expect(focused).toHaveBeenLastCalledWith(expect.any(String), 'a3')
  })

  it('holds the tab in tile order and nothing else', async () => {
    AGENTS.length = 0
    for (const agentId of ['a1', 'a2', 'a3', 'a4']) {
      AGENTS.push({ agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    }
    const host = new DaemonCableHost(wiring())
    await settled(host)

    onTab(host, ['a3', 'a1'])
    const listed = await host.listAgents()

    // Tile order — that is what the dial walks — and the two agents with no tile are not sent at all.
    // They used to ride along as "off-ring" for the overview's count and the switcher; the count is a
    // number now and the switcher is gone.
    expect(listed.map((a) => a.id)).toEqual(['a3', 'a1'])
    expect(host.agentTotal()).toBe(4)

    // A tile naming an id this daemon has never listed is skipped, not invented.
    onTab(host, ['a3', 'ghost'])
    expect((await host.listAgents()).map((a) => a.id)).toEqual(['a3'])
  })

  it('does not guess a machine for an unknown dial focus', async () => {
    AGENTS.length = 0
    const focused = vi.fn()
    const host = new DaemonCableHost(wiring({ focused }), crossFleet({ other: [] }))
    await settled(host)

    host.focus('missing-agent')

    expect(focused).not.toHaveBeenCalled()
  })

  it('keeps a local agent local even while another machine is selected', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: 'local-1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const sendTurn = vi.fn()
    const fleet = crossFleet({ other: [] })
    const host = new DaemonCableHost(wiring({ sendTurn }), fleet)
    await settled(host)
    await host.selectMachine('other')

    host.sendTurn('local-1', 'hello')
    expect(sendTurn).toHaveBeenCalledWith('local-1', 'hello')
    expect(fleet.sendTurn).not.toHaveBeenCalled()
  })

  it('drops a turn for an agent it has never listed rather than guessing a machine', async () => {
    // Falling back to the selected machine here is how a turn lands on the wrong computer. The local
    // wiring is the only safe default: it is the machine the cable can vouch for.
    AGENTS.length = 0
    const sendTurn = vi.fn()
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] })
    const host = new DaemonCableHost(wiring({ sendTurn }), fleet)
    await settled(host)
    await host.selectMachine('other')

    host.sendTurn('ghost', 'where does this go?')
    expect(fleet.sendTurn).not.toHaveBeenCalled()
    expect(sendTurn).toHaveBeenCalledWith('ghost', 'where does this go?')
  })

  it('holds a machine’s last good list through a failure instead of blanking its tiles', async () => {
    AGENTS.length = 0
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] })
    const host = new DaemonCableHost(wiring(), fleet)
    expect((await settled(host)).map((a) => a.id)).toEqual(['r1'])

    ;(fleet.listAgents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cloud blip'))
    // Date.now rather than fake timers: the refresh is paced by wall-clock comparisons, and faking the
    // whole timer wheel would also freeze the `setTimeout(0)` this test uses to let the refresh land.
    const real = Date.now
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => real() + 6_000)
    try {
      const agents = await settled(host)   // past the refresh cadence, well inside the grace period
      expect(agents.map((a) => a.id)).toEqual(['r1'])
    } finally {
      nowSpy.mockRestore()
    }
  })


  it('asks nothing of a machine that is not ready, and shows none of its agents', async () => {
    // An offline or unlinked machine costs a 15-second RPC timeout per round to learn nothing.
    AGENTS.length = 0
    const unlinked: FleetMachine = { machineId: 'other', name: 'office-imac', state: 'needs-link', authMode: 'remote' }
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] }, [unlinked])
    const host = new DaemonCableHost(wiring(), fleet)
    expect(await settled(host)).toEqual([])
    expect(fleet.listAgents).not.toHaveBeenCalled()
  })
})

describe('DaemonCableHost.listSwarms', () => {
  // The bug this pair exists for: a tab holding only a shell drives no agent, so it named none, and
  // the dial's switcher — which had nothing else to go on — dropped it. You could see that tab while
  // standing on it and never reach it again once you left (openharness#160).
  it('reports a tab that holds only a terminal as having a tile, not as empty', () => {
    const host = new DaemonCableHost(wiring(), fleetOf([]))
    host.setSwarms({
      active: 'work',
      swarms: [
        { id: 'work', name: 'harness-1', agentIds: ['a1'], panes: 1 },
        { id: 'shell', name: 'harness-2', agentIds: [], panes: 1 },
        { id: 'fresh', name: 'New Harness', agentIds: [], panes: 0 },
      ],
      tiles: [],
    })
    expect(host.listSwarms()).toEqual({
      selected: 'work',
      swarms: [
        { id: 'work', name: 'harness-1', agents: 1, agentIds: ['a1'], panes: 1 },
        // No agents and still a place to go: this is the row that used to disappear.
        { id: 'shell', name: 'harness-2', agents: 0, agentIds: [], panes: 1 },
        // Nothing on it at all — still nothing the dial can offer, which was always the intent.
        { id: 'fresh', name: 'New Harness', agents: 0, agentIds: [], panes: 0 },
      ],
      tiles: [],
    })
  })

  it('says nothing at all while no window is connected', () => {
    const host = new DaemonCableHost(wiring(), fleetOf([]))
    host.setSwarms(null)
    expect(host.listSwarms()).toEqual({ selected: '', swarms: [], tiles: [] })
  })
})

describe('the dial with no window: this computer\'s agents', () => {
  const sessions = () => [
    { agentId: 'h1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude', sessionId: 's-h1' },
    { agentId: 'h2', registeredAt: 2, active: true, terminalAvailable: true, engine: 'codex', sessionId: 's-h2' },
  ] as unknown as RegisteredSession[]
  const observedAgent = (over: Partial<HostAgent>): HostAgent => ({
    id: 'o', engine: 'claude', name: 'scratch', host: 'ghostty', app: 'ghostty', state: 'idle', lastActivityAt: 0, unseenDone: false, ...over,
  })
  const observed = (agents: HostAgent[]): HostSource => ({
    id: 'observed', list: () => agents,
    capabilities: () => ({ status: true, voice: false, focus: false, answer: false }),
  })

  it('no window and a registry: the rows of the ring with host and caps, and view machine', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    host.setRegistry(new HostRegistry([host.harness, observed([
      observedAgent({ id: 'o1', state: 'needs-you', lastActivityAt: 10 }),
      // The same Claude Code session as h1, heard before it moved into a Harness pane: shown once, as h1.
      observedAgent({ id: 'o2', sessionId: 's-h1', state: 'working' }),
    ])]))
    host.harness.noteCard('h2', 'processing')
    host.setSwarms(null)
    const local = { machineId: 'mine', machine: 'MacbookPro.local' }
    // In the registry's order: o1 waits on the person and h2 is mid-turn, and neither moves ahead.
    expect(await host.listAgentSnapshot()).toEqual({ tab: '', total: 3, view: 'machine', agents: [
      { id: 'h1', name: 'h1', engine: 'claude', ...local, host: 'harness', caps: 'sva' },
      { id: 'h2', name: 'h2', engine: 'codex', ...local, host: 'harness', caps: 'sva' },
      { id: 'o1', name: 'scratch', engine: 'claude', ...local, host: 'ghostty', caps: 's' },
    ] })
  })

  it('no window: a state change moves no agent, so the list the dial holds is not sent again', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    const o1 = observedAgent({ id: 'o1', lastActivityAt: 10 })
    host.setRegistry(new HostRegistry([host.harness, observed([o1])]))
    host.setSwarms(null)
    const before = await host.listAgentSnapshot()
    expect(before.agents.map((a) => a.id)).toEqual(['h1', 'h2', 'o1'])
    // Each of these moved its agent under the old order: a question, a turn, an answer not yet seen.
    Object.assign(o1, { state: 'needs-you', lastActivityAt: 99 })
    host.harness.noteCard('h2', 'processing')
    // The session sends a list only when these rows differ from the last it sent (CableSession.agentsKey).
    expect(await host.listAgentSnapshot()).toEqual(before)
    host.harness.noteCard('h2', 'done')
    Object.assign(o1, { state: 'working' })
    expect(await host.listAgentSnapshot()).toEqual(before)
  })

  it('no window: seventeen agents: sixteen rows, and total says seventeen', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    host.setRegistry(new HostRegistry([host.harness, observed(
      Array.from({ length: 15 }, (_, i) => observedAgent({ id: `o${i + 1}`, lastActivityAt: i + 1 })))]))
    host.setSwarms(null)
    const first = await host.listAgentSnapshot()
    expect(first.agents).toHaveLength(16)
    expect(first.total).toBe(17)
  })

  it('a window opened and shut leaves the ring as it was: what started meanwhile comes last', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    const outside = [observedAgent({ id: 'o1' })]
    host.setRegistry(new HostRegistry([host.harness, observed(outside)]))
    host.setSwarms(null)
    const listed = async () => (await host.listAgentSnapshot()).agents.map((a) => a.id)
    expect(await listed()).toEqual(['h1', 'h2', 'o1'])
    onTab(host, ['h2'])
    // Started while the tab was held, and already waiting on the person: the registry lists it before o1.
    outside.unshift(observedAgent({ id: 'o0', state: 'needs-you', lastActivityAt: 99 }))
    expect(await listed()).toEqual(['h2'])
    host.setSwarms(null)
    expect(await listed()).toEqual(['h1', 'h2', 'o1', 'o0'])
  })

  it('with a window and a registry: the tab, as today', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    host.setRegistry(new HostRegistry([host.harness, observed([observedAgent({ id: 'o1' })])]))
    onTab(host, ['h2'])
    expect(await host.listAgentSnapshot()).toStrictEqual({ tab: 't1', total: 2, agents: [
      { id: 'h2', name: 'h2', engine: 'codex', machineId: 'mine', machine: 'MacbookPro.local' },
    ] })
  })

  it('caps, host and seen come from the registry only with no window', async () => {
    const markSeen = vi.fn()
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    expect(host.capsOf('h1')).toBeUndefined()
    host.setRegistry(new HostRegistry([host.harness, { ...observed([observedAgent({ id: 'o1', host: 'orca' })]), markSeen }]))
    await host.listAgentSnapshot()
    expect([host.capsOf('h1'), host.hostOf('h1')]).toEqual(['sva', 'harness'])
    expect([host.capsOf('o1'), host.hostOf('o1')]).toEqual(['s', 'orca'])
    expect([host.capsOf('nobody'), host.hostOf('nobody')]).toEqual([undefined, undefined])
    host.markSeen('o1')
    expect(markSeen).toHaveBeenCalledWith('o1')
    host.harness.noteCard('h1', 'done')
    host.markSeen('h1')
    expect(host.harness.list().find((a) => a.id === 'h1')).toMatchObject({ state: 'done', unseenDone: false })
    // With a window the dial holds the tab, whose agents it may do everything with, as today.
    onTab(host, ['h1'])
    expect([host.capsOf('h1'), host.hostOf('h1')]).toEqual([undefined, undefined])
  })

  it('describes an agent the fleet never listed from the registry, so its summary and question carry a name', () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    host.setRegistry(new HostRegistry([host.harness, observed([observedAgent({ id: 'o1', engine: 'codex' })])]))
    expect(host.describe('o1')).toEqual({ name: 'scratch', engine: 'codex', machine: 'MacbookPro.local' })
    expect(host.describe('nobody')).toBeUndefined()
  })

  it('an agent outside Harness that takes voice is never one of the router\'s candidates', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    const outside = observedAgent({ id: 'outside-7f3c', name: 'secret-folder', host: 'orca', lastAnswer: 'the secret last answer' })
    host.setRegistry(new HostRegistry([host.harness, { ...observed([outside]),
      capabilities: () => ({ status: true, voice: true, focus: true, answer: false }) }]))
    host.setSwarms(null)
    const agents = (await host.listAgentSnapshot()).agents
    expect(agents.find((a) => a.id === outside.id)).toMatchObject({ caps: 'svf' })
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)) })
    router.routed.length = 0
    router.ranked.length = 0
    try {
      expect(await host.route('fix the login screen', agents)).toMatchObject({ agentId: 'h2' })
    } finally { vi.restoreAllMocks() }
    expect(router.ranked).toHaveLength(1)
    // Everything the router weighed, the backend's request and the router's own log lines.
    const left = JSON.stringify([router.routed, router.ranked, lines.filter((line) => line.startsWith('[voice-route]'))])
    expect(left).toContain('h1')
    for (const secret of [outside.id, outside.name, outside.lastAnswer!]) expect(left).not.toContain(secret)
  })

  it('no window and no registry: [] as today', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    expect(await host.listAgentSnapshot()).toStrictEqual({ agents: [], tab: '', total: 2 })
    host.setRegistry(new HostRegistry([host.harness]))
    host.setRegistry(null)
    expect(await host.listAgentSnapshot()).toStrictEqual({ agents: [], tab: '', total: 2 })
  })
})

describe('the dial that shows one app at a time', () => {
  const sessions = () => [
    { agentId: 'h1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude', sessionId: 's-h1' },
    { agentId: 'h2', registeredAt: 2, active: true, terminalAvailable: true, engine: 'codex', sessionId: 's-h2' },
  ] as unknown as RegisteredSession[]
  const agent = (id: string, app: string, over: Partial<HostAgent> = {}): HostAgent => ({
    id, engine: 'claude', name: id, host: app, app, state: 'idle', lastActivityAt: 0, unseenDone: false, ...over,
  })
  /** Ghostty 3, VS Code 2, listed mixed. */
  const five = (): HostAgent[] => [agent('g1', 'ghostty'), agent('g2', 'ghostty'), agent('v1', 'vscode'), agent('g3', 'ghostty'), agent('v2', 'vscode')]
  /** No window; these agents outside Harness, and no Harness agent unless `over` gives sessions. */
  function setup(agents: HostAgent[], over: Partial<CableHostWiring> = {}): DaemonCableHost {
    const host = new DaemonCableHost(wiring({ sessions: () => [], ...over }), fleetOf([]))
    host.setRegistry(new HostRegistry([host.harness, { id: 'observed', list: () => agents,
      capabilities: () => ({ status: true, voice: false, focus: false, answer: false }) }]))
    return host
  }
  const ids = (snapshot: { agents: CableAgent[] }): string[] => snapshot.agents.map((a) => a.id)
  const shown = async (host: DaemonCableHost): Promise<string | undefined> => (await host.listAgentSnapshot({ apps: true })).apps?.shown

  it('asked without apps it is the single ring; asked with, the shown app\'s', async () => {
    const host = setup(five())
    // Two dials on one computer, one that says appFilter and one that does not: each is answered its own list.
    const one = await host.listAgentSnapshot({ apps: true })
    expect(one).toMatchObject({ tab: '', total: 3, view: 'machine', apps: { shown: 'ghostty' } })
    expect(one.agents).toEqual(['g1', 'g2', 'g3'].map((id) =>
      ({ id, name: id, engine: 'claude', machineId: 'mine', machine: 'MacbookPro.local', host: 'ghostty', caps: 's' })))
    const all = await host.listAgentSnapshot()
    expect(ids(all)).toEqual(['g1', 'g2', 'v1', 'g3', 'v2'])
    expect(all.total).toBe(5)
    expect(all).not.toHaveProperty('apps')
  })

  it('the app list: fixed order, display names, count and waiting', async () => {
    const agents = [agent('g1', 'ghostty'), agent('v1', 'vscode', { state: 'needs-you' }), agent('g2', 'ghostty'), agent('v2', 'vscode'), agent('g3', 'ghostty')]
    const host = setup(agents)
    expect((await host.listAgentSnapshot({ apps: true })).apps?.apps).toEqual([
      { id: 'ghostty', name: 'Ghostty', count: 3, waiting: 0 },
      { id: 'vscode', name: 'VS Code', count: 2, waiting: 1 },
    ])
    // Listed first now, and still after the apps the dial already holds: the picker never reorders under the finger.
    agents.unshift(agent('c1', 'cursor'), agent('v3', 'vscode', { state: 'needs-you' }))
    expect((await host.listAgentSnapshot({ apps: true })).apps?.apps).toEqual([
      { id: 'ghostty', name: 'Ghostty', count: 3, waiting: 0 },
      { id: 'vscode', name: 'VS Code', count: 3, waiting: 2 },
      { id: 'cursor', name: 'Cursor', count: 1, waiting: 0 },
    ])
  })

  it('the unknown app is named Other and Apple\'s Terminal is named Terminal', async () => {
    const host = setup([agent('t1', 'terminal'), agent('a1', 'terminal-app'), agent('a2', 'terminal-app')])
    expect((await host.listAgentSnapshot({ apps: true })).apps).toEqual({ shown: 'terminal-app', apps: [
      { id: 'terminal', name: 'Other', count: 1, waiting: 0 },
      { id: 'terminal-app', name: 'Terminal', count: 2, waiting: 0 },
    ] })
  })

  it('the front is followed while a window is open: when it closes, the app that settled in front meanwhile is shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const host = setup(five())
      expect(await shown(host)).toBe('ghostty')
      onTab(host, [])
      host.front('vscode')
      vi.advanceTimersByTime(FRONT_SETTLE_MS)
      expect(await host.listAgentSnapshot({ apps: true })).not.toHaveProperty('apps')
      host.setSwarms(null)
      expect(await shown(host)).toBe('vscode')
    } finally { vi.useRealTimers() }
  })

  it('a pick switches the list and holds through a count change', async () => {
    const agents = five()
    const appSwitched = vi.fn()
    const host = setup(agents, { appSwitched })
    expect(await shown(host)).toBe('ghostty')
    expect(host.pickApp('vscode')).toBe('switched')
    const picked = await host.listAgentSnapshot({ apps: true })
    expect(picked).toMatchObject({ total: 2, apps: { shown: 'vscode' } })
    expect(ids(picked)).toEqual(['v1', 'v2'])
    agents.push(agent('g4', 'ghostty'), agent('g5', 'ghostty'))
    expect(ids(await host.listAgentSnapshot({ apps: true }))).toEqual(['v1', 'v2'])
    expect(appSwitched.mock.calls).toEqual([['pick']])
  })

  it('a pick of an app with no agents is ignored', async () => {
    const appSwitched = vi.fn()
    const host = setup(five(), { appSwitched })
    expect(await shown(host)).toBe('ghostty')
    expect(host.pickApp('cursor')).toBe('ignored')
    expect(await shown(host)).toBe('ghostty')
    expect(appSwitched).not.toHaveBeenCalled()
  })

  it('the app in front is shown 1 s later; appSwitched hears front once', async () => {
    const settles: Array<{ ms: number; run: () => void }> = []
    const appSwitched = vi.fn()
    const host = setup(five(), { appSwitched, appTimer: (ms, run) => { settles.push({ ms, run }); return () => {} } })
    expect(await shown(host)).toBe('ghostty')
    host.front('vscode')
    expect(settles.map((s) => s.ms)).toEqual([FRONT_SETTLE_MS])
    expect(await shown(host)).toBe('ghostty')
    settles[0].run()
    const after = await host.listAgentSnapshot({ apps: true })
    expect(after).toMatchObject({ total: 2, apps: { shown: 'vscode' } })
    expect(ids(after)).toEqual(['v1', 'v2'])
    expect(appSwitched.mock.calls).toEqual([['front']])
  })

  it('an app that settled in front with no agents is shown once its first agent starts there', async () => {
    const agents = [agent('g1', 'ghostty'), agent('g2', 'ghostty'), agent('g3', 'ghostty')]
    const settles: Array<() => void> = []
    const appSwitched = vi.fn()
    const host = setup(agents, { appSwitched, appTimer: (_ms, run) => { settles.push(run); return () => {} } })
    expect(await shown(host)).toBe('ghostty')
    host.front('vscode')
    settles[0]()
    expect(await shown(host)).toBe('ghostty')
    agents.push(agent('v1', 'vscode'))
    const after = await host.listAgentSnapshot({ apps: true })
    expect(after).toMatchObject({ total: 1, apps: { shown: 'vscode' } })
    expect(ids(after)).toEqual(['v1'])
    expect(appSwitched.mock.calls).toEqual([['front']])
  })

  it('settledApp is undefined until an app settles in front, then that app', () => {
    const settles: Array<() => void> = []
    const host = setup(five(), { appTimer: (_ms, run) => { settles.push(run); return () => {} } })
    expect(host.settledApp()).toBeUndefined()
    host.front('orca')
    expect(host.settledApp()).toBeUndefined()
    settles[0]()
    expect(host.settledApp()).toBe('orca')
  })

  it('a pick on the dial changes the shown app and not the settled one', async () => {
    const settles: Array<() => void> = []
    const host = setup([...five(), agent('o1', 'orca')], { appTimer: (_ms, run) => { settles.push(run); return () => {} } })
    expect(await shown(host)).toBe('ghostty')
    host.front('orca')
    settles[0]()
    expect(await shown(host)).toBe('orca')
    expect(host.pickApp('vscode')).toBe('switched')
    expect(host.settledApp()).toBe('orca')
    expect(await shown(host)).toBe('vscode')
  })

  it('settledApp follows the app in front with a window open too', () => {
    const settles: Array<() => void> = []
    const host = setup(five(), { sessions, appTimer: (_ms, run) => { settles.push(run); return () => {} } })
    onTab(host, ['h1'])
    host.front('vscode')
    settles[0]()
    expect(host.settledApp()).toBe('vscode')
  })

  it('appSettled reaches the wiring each time an app settles, after appSwitched, with a window open too', async () => {
    const settles: Array<() => void> = []
    const told: string[] = []
    const host = setup(five(), {
      sessions,
      appSwitched: (cause) => { told.push(cause) },
      appSettled: (app) => { told.push(`settled ${app}`) },
      appTimer: (_ms, run) => { settles.push(run); return () => {} },
    })
    expect(await shown(host)).toBe('ghostty')
    host.front('vscode')
    settles[0]()
    host.front('none')
    settles[1]()
    expect(told).toEqual(['front', 'settled vscode', 'settled none'])
    onTab(host, ['h1'])
    host.front('cursor')
    expect(told).toHaveLength(3)
    settles[2]()
    expect(told.slice(3)).toEqual(['settled cursor'])
  })

  it('latestFront is the app last reported, with a window open too', () => {
    const settles: Array<() => void> = []
    const host = setup(five(), { sessions, appTimer: (_ms, run) => { settles.push(run); return () => {} } })
    expect(host.latestFront()).toBeUndefined()
    host.front('claude')
    expect(host.latestFront()).toBe('claude')
    expect(host.settledApp()).toBeUndefined()
    onTab(host, ['h1'])
    host.front('orca')
    expect(host.latestFront()).toBe('orca')
  })

  it('localFollowed reaches the wiring', () => {
    const localFollowed = vi.fn()
    const host = setup(five(), { localFollowed })
    host.localFollowed('prompt', 'moved')
    host.localFollowed('tab', 'no-tile')
    expect(localFollowed.mock.calls).toEqual([['prompt', 'moved'], ['tab', 'no-tile']])
  })

  it('knows an agent outside Harness', () => {
    const host = setup(five())
    expect(host.knows('g1')).toBe(true)
    expect(host.knows('nobody')).toBe(false)
  })

  it('two reads in a row give the same shown app and the same order', async () => {
    const appRandom = vi.fn(() => 0.75)
    const host = setup([agent('g1', 'ghostty'), agent('v1', 'vscode'), agent('g2', 'ghostty'), agent('v2', 'vscode')], { appRandom })
    // A tie, drawn once: the second of the two.
    const first = await host.listAgentSnapshot({ apps: true })
    expect(first.apps?.shown).toBe('vscode')
    expect(await host.listAgentSnapshot({ apps: true })).toEqual(first)
    expect(appRandom).toHaveBeenCalledOnce()
  })

  it('with a window: the tab\'s list exactly as before, no apps, and a pick is ignored', async () => {
    const appSwitched = vi.fn()
    const host = setup(five(), { sessions, appSwitched })
    expect(await shown(host)).toBe('ghostty')
    onTab(host, ['h2'])
    expect(await host.listAgentSnapshot({ apps: true })).toStrictEqual({ tab: 't1', total: 2, agents: [
      { id: 'h2', name: 'h2', engine: 'codex', machineId: 'mine', machine: 'MacbookPro.local' },
    ] })
    expect(host.pickApp('vscode')).toBe('ignored')
    host.setSwarms(null)
    expect(await shown(host)).toBe('ghostty')
    expect(appSwitched).not.toHaveBeenCalled()
  })

  it('appOf is the agent\'s app in the machine view, undefined with a window', async () => {
    const host = setup([agent('g1', 'ghostty'), agent('z1', 'ghostty', { host: 'zellij' })], { sessions })
    await host.listAgentSnapshot({ apps: true })
    expect(['h1', 'g1', 'z1', 'nobody'].map((id) => host.appOf(id))).toEqual(['harness', 'ghostty', 'ghostty', undefined])
    onTab(host, ['h1'])
    expect(['h1', 'g1'].map((id) => host.appOf(id))).toEqual([undefined, undefined])
  })

  it('no agents: shown is empty and nothing is listed', async () => {
    const agents = [agent('g1', 'ghostty')]
    const host = setup(agents)
    expect(await shown(host)).toBe('ghostty')
    agents.length = 0
    expect(await host.listAgentSnapshot({ apps: true })).toStrictEqual({ agents: [], tab: '', total: 0, view: 'machine', apps: { shown: '', apps: [] } })
  })

  it('appPicked is told once for each pick, and not for a notice', async () => {
    const appPicked = vi.fn()
    const appSwitched = vi.fn()
    const host = setup(five(), { appPicked, appSwitched })
    expect(await shown(host)).toBe('ghostty')
    expect([host.pickApp('vscode'), host.pickApp('vscode'), host.pickApp('cursor')]).toEqual(['switched', 'same', 'ignored'])
    expect(host.pickApp('ghostty', 'notice')).toBe('switched')
    expect(appPicked).toHaveBeenCalledTimes(3)
    expect(appSwitched.mock.calls).toEqual([['pick'], ['notice']])
  })

  /** Agents the open scan found, which nothing has told the app of yet: on the unknown app's page. */
  const pending = (n: number): HostAgent[] =>
    Array.from({ length: n }, (_, i) => agent(`t${i + 1}`, 'terminal', { appPending: true }))

  it('agents not known yet are counted on Other\'s page and never win the default', async () => {
    const host = setup([...pending(5), agent('g1', 'ghostty'), agent('g2', 'ghostty')])
    const snapshot = await host.listAgentSnapshot({ apps: true })
    expect(snapshot).toMatchObject({ total: 2, apps: { shown: 'ghostty' } })
    expect(ids(snapshot)).toEqual(['g1', 'g2'])
    expect(snapshot.apps?.apps).toEqual([
      { id: 'terminal', name: 'Other', count: 5, waiting: 0 },
      { id: 'ghostty', name: 'Ghostty', count: 2, waiting: 0 },
    ])
  })

  it('only agents not known yet: Other is shown, and gives way when one of them is known to be in Ghostty', async () => {
    const agents = pending(3)
    const appSwitched = vi.fn()
    const host = setup(agents, { appSwitched })
    expect(await shown(host)).toBe('terminal')
    // Its first hook says it runs in Ghostty.
    agents[0] = agent('t1', 'ghostty')
    const after = await host.listAgentSnapshot({ apps: true })
    expect(after).toMatchObject({ total: 1, apps: { shown: 'ghostty' } })
    expect(ids(after)).toEqual(['t1'])
    expect(await shown(host)).toBe('ghostty')
    expect(appSwitched.mock.calls).toEqual([['empty']])
  })

  it('a notice for an agent not known yet turns the dial to Other', async () => {
    const host = setup([...pending(3), agent('g1', 'ghostty'), agent('g2', 'ghostty')])
    expect(await shown(host)).toBe('ghostty')
    expect(host.appOf('t2')).toBe('terminal')
    expect(host.pickApp('terminal', 'notice')).toBe('switched')
    const next = await host.listAgentSnapshot({ apps: true })
    expect(next).toMatchObject({ total: 3, apps: { shown: 'terminal' } })
    expect(ids(next)).toEqual(['t1', 't2', 't3'])
  })

  it('a notice of an agent on the page shown changes nothing: Other still gives way once agents are known', async () => {
    const agents = pending(3)
    const appSwitched = vi.fn()
    const host = setup(agents, { appSwitched })
    expect(await shown(host)).toBe('terminal')
    expect(host.pickApp('terminal', 'notice')).toBe('same')
    agents.push(agent('g1', 'ghostty'), agent('g2', 'ghostty'), agent('g3', 'ghostty'))
    expect(await shown(host)).toBe('ghostty')
    expect(appSwitched.mock.calls).toEqual([['empty']])
  })

  // Only a list read with no window updates the rings, so a settle or a pick between reads counts the agents there now.
  describe('decided on the agents there now, not those of the last read', () => {
    const ghostty3 = (): HostAgent[] => [agent('g1', 'ghostty'), agent('g2', 'ghostty'), agent('g3', 'ghostty')]
    const settle = (): void => {
      vi.advanceTimersByTime(FRONT_SETTLE_MS)
    }
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('an app whose first agents start in front while a window is open is shown when it closes', async () => {
      const agents = ghostty3()
      const appSwitched = vi.fn()
      const host = setup(agents, { appSwitched })
      expect(await shown(host)).toBe('ghostty')
      onTab(host, [])
      agents.push(agent('v1', 'vscode'), agent('v2', 'vscode'))
      host.front('vscode')
      settle()
      host.setSwarms(null)
      expect(await shown(host)).toBe('vscode')
      expect(appSwitched.mock.calls).toEqual([['front']])
    })

    it('the same across an unplug and a replug', async () => {
      const agents = ghostty3()
      const appSwitched = vi.fn()
      const host = setup(agents, { appSwitched })
      host.onDialAttached()
      expect(await shown(host)).toBe('ghostty')
      host.onDialGone()
      agents.push(agent('v1', 'vscode'), agent('v2', 'vscode'))
      host.front('vscode')
      settle()
      host.onDialAttached()
      expect(await shown(host)).toBe('vscode')
      expect(appSwitched.mock.calls).toEqual([['front']])
    })

    it('an app in front whose agents ended since the last read is not shown, and nothing switches twice', async () => {
      const agents = five()
      const appSwitched = vi.fn()
      const host = setup(agents, { appSwitched })
      expect(await shown(host)).toBe('ghostty')
      agents.splice(0, agents.length, ...agents.filter((a) => a.app !== 'vscode'))
      host.front('vscode')
      settle()
      expect(await shown(host)).toBe('ghostty')
      expect(appSwitched).not.toHaveBeenCalled()
    })

    it('a pick of an app whose last agent ended since the last read is ignored, and the ring stays', async () => {
      const agents = five()
      const appSwitched = vi.fn()
      const host = setup(agents, { appSwitched })
      expect(await shown(host)).toBe('ghostty')
      agents.splice(0, agents.length, ...agents.filter((a) => a.app !== 'vscode'))
      expect(host.pickApp('vscode')).toBe('ignored')
      expect(ids(await host.listAgentSnapshot({ apps: true }))).toEqual(['g1', 'g2', 'g3'])
      expect(appSwitched).not.toHaveBeenCalled()
    })
  })
})

describe('cableEventFor', () => {
  it('carries whether the card is a sub-agent\'s turn end, and nothing else about it', () => {
    const base = { type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'body', recap: 'recap' } }
    expect(cableEventFor(base)).toEqual({ kind: 'summary', agentId: 'a1', text: 'body', recap: 'recap', subagent: false })
    expect(cableEventFor({ ...base, payload: { ...base.payload, subagent: true } })?.subagent).toBe(true)
    expect(cableEventFor({ ...base, payload: { ...base.payload, subagent: 'yes' } })?.subagent).toBe(false)
    // A turn recapped after it ended unseen is history: drawn as quietly as a sub-agent's.
    expect(cableEventFor({ ...base, payload: { ...base.payload, restored: true } })?.subagent).toBe(true)
    expect(cableEventFor({ ...base, payload: { kind: 'tool', text: 'Bash' } })).toBeNull()
  })

  it('carries a summary\'s tier, decided by the recaps, and no word that is not one', () => {
    const base = { type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'body', recap: 'recap' } }
    for (const tier of ['alert', 'list', 'silent'] as const) {
      expect(cableEventFor({ ...base, payload: { ...base.payload, tier } })?.tier).toBe(tier)
    }
    expect(cableEventFor({ ...base, payload: { ...base.payload, tier: 'loud' } })).not.toHaveProperty('tier')
    expect(cableEventFor({ ...base, payload: { kind: 'done', text: 'done', tier: 'alert' } })).not.toHaveProperty('tier')
  })
})


describe('reviewed device answer receipts', () => {
  const answer = { agentId: 'review-local', requestId: 'question-1',
    questions: [{ key: 'scope', q: 'Which scope?', options: ['File', 'Project'], multi: false }],
    answers: { scope: 'File' }, selections: { scope: ['File'] } }
  it('reports the local terminal driver result without invoking the legacy answer path', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: answer.agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const reviewed = vi.fn(async () => true), legacy = vi.fn()
    const host = new DaemonCableHost(wiring({ answerReviewed: reviewed, answer: legacy }))
    expect(await host.answerReviewed(answer)).toEqual({ ok: true })
    reviewed.mockResolvedValue(false)
    expect((await host.answerReviewed(answer)).ok).toBe(false)
    expect(legacy).not.toHaveBeenCalled()
  })
  it('distinguishes remote handoff from completion and refuses unreachable or ambiguous answers', async () => {
    AGENTS.length = 0
    const fleet = fleetOf([REMOTE]); fleet.answerReviewed = vi.fn()
    const host = new DaemonCableHost(wiring(), fleet); host.noteAgent('other','review-remote')
    const remote = { ...answer, agentId: 'review-remote' }
    expect(await host.answerReviewed(remote)).toEqual({ ok: true, pending: true })
    expect(fleet.answerReviewed).toHaveBeenCalledTimes(1)
    fleet.reachable = () => ({ ok: false, at: Date.now() })
    expect((await host.answerReviewed(remote)).ok).toBe(false)
    fleet.reachable = () => ({ ok: true, at: Date.now() })
    expect((await host.answerReviewed({ ...remote, questions: [{ ...remote.questions[0], multi: true }],
      selections: { scope: ['CSV, UTF-8'] } })).ok).toBe(false)
    expect(fleet.answerReviewed).toHaveBeenCalledTimes(1)
  })
})

describe('spoken question capability', () => {
  it('offers speech only for a known local receiver and never forwards text to an older remote driver', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: 'spoken-local', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const answerReviewed = vi.fn(async () => true), fleet = fleetOf([REMOTE])
    fleet.answerReviewed = vi.fn()
    const host = new DaemonCableHost(wiring({ answerReviewed }), fleet)
    host.noteAgent('mine','spoken-local'); host.noteAgent('other','spoken-remote')
    await host.listAgentsFlat()
    expect(host.canSpeakQuestion('spoken-local')).toBe(true)
    expect(host.canSpeakQuestion('spoken-remote')).toBe(false)
    expect(host.canSpeakQuestion('unknown')).toBe(false)
    const answer = { requestId: 'q', agentId: 'spoken-local',
      questions: [{ key: 'scope', q: 'Which scope?', options: ['File'], multi: false, canText: true }],
      answers: { scope: 'Just the parser' }, selections: { scope: [] }, freeTextKeys: ['scope'] }
    expect(await host.answerReviewed(answer)).toEqual({ ok: true })
    expect((await host.answerReviewed({ ...answer, agentId: 'spoken-remote' })).ok).toBe(false)
    expect(fleet.answer).not.toHaveBeenCalled(); expect(fleet.answerReviewed).not.toHaveBeenCalled()
    expect(answerReviewed).toHaveBeenCalledTimes(1)
  })
})

describe('the dial reaches the fleet through the core\'s port', () => {
  /** The fleet service's routing as the port carries it, every answer scripted. */
  function port(over: Partial<FleetRouting> = {}): FleetRouting {
    return {
      listMachines: vi.fn(async () => ({ machines: [{ id: 'mine', name: 'MacbookPro.local', state: 'ready' as const, local: true }, { id: 'other', name: 'office-imac', state: 'ready' as const, local: false }], source: 'backend' as const })),
      listAgentsFlat: vi.fn(async () => [{ id: 'r1', name: 'api', machineId: 'other', machine: 'office-imac' }]),
      activityTimes: vi.fn(async () => new Map()),
      agentTotal: vi.fn(() => 7),
      describe: vi.fn(() => ({ name: 'api', engine: 'claude', machine: 'office-imac' })),
      noteAgent: vi.fn(),
      machineOf: vi.fn(() => 'other'),
      knows: vi.fn(() => true),
      isLocalAgent: vi.fn(() => false),
      sendTurn: vi.fn(() => ({ ok: true as const })),
      lastRouted: vi.fn(() => ({ agentId: 'r1', agoMs: 5 })),
      stopTurn: vi.fn(),
      canSpeakQuestion: vi.fn(() => false),
      answerReviewed: vi.fn(async () => ({ ok: true as const, pending: true })),
      answer: vi.fn(),
      updateAgent: vi.fn(),
      recentSummaries: vi.fn(async () => [{ recap: 'Shipped', text: 'Shipped', ask: 'ship it' }]),
      recentAsks: vi.fn(async () => ['ship it']),
      listModels: vi.fn(async () => ['opus']),
      forkAgent: vi.fn(async () => ({ result: { ok: true as const, agentId: 'r1-fork' }, machineId: 'other', asked: true })),
      hasLane: vi.fn(() => true),
      online: vi.fn(async () => ({ ok: true as const })),
      select: vi.fn(async () => ({ ok: true as const })),
      release: vi.fn(),
      ...over,
    }
  }
  const unavailable = () => new ServiceUnavailableError('fleet')

  it('asks the fleet\'s router for every route, and holds no answer of its own', async () => {
    AGENTS.length = 0
    const fleet = port()
    const w = wiring({ fleet: () => fleet, focused: vi.fn(), opened: vi.fn() })
    const host = new DaemonCableHost(w)
    expect((await host.listMachines()).machines.map((m) => m.id)).toEqual(['mine', 'other'])
    expect((await host.listAgentsFlat()).map((a) => a.id)).toEqual(['r1'])
    expect(host.agentTotal()).toBe(7)
    expect(host.describe('r1')).toEqual({ name: 'api', engine: 'claude', machine: 'office-imac' })
    host.noteAgent('other', 'r9')
    expect(fleet.noteAgent).toHaveBeenCalledWith('other', 'r9')
    expect(host.knows('r1')).toBe(true)
    expect(host.sendTurn('r1', 'ship it')).toEqual({ ok: true })
    expect(fleet.sendTurn).toHaveBeenCalledWith('r1', 'ship it')
    expect(w.sendTurn).not.toHaveBeenCalled()
    expect(host.lastRouted()).toEqual({ agentId: 'r1', agoMs: 5 })
    host.stopTurn('r1'); host.answer('r1', 'q', { k: 'v' }); host.updateAgent('r1', 'opus')
    expect(fleet.stopTurn).toHaveBeenCalledWith('r1')
    expect(fleet.answer).toHaveBeenCalledWith('r1', 'q', { k: 'v' })
    expect(fleet.updateAgent).toHaveBeenCalledWith('r1', 'opus', undefined)
    expect(host.canSpeakQuestion('r1')).toBe(false)
    expect(await host.answerReviewed({ agentId: 'r1', requestId: 'q', questions: [], answers: {}, selections: {} })).toEqual({ ok: true, pending: true })
    expect(await host.recentSummaries('r1')).toEqual([{ recap: 'Shipped', text: 'Shipped', ask: 'ship it' }])
    expect(await host.recentAsks('r1')).toEqual(['ship it'])
    expect(await host.listModels('r1')).toEqual(['opus'])
    // An agent the router places on another machine has no terminal footer here.
    expect(await host.activityText('r1')).toBeNull()
    host.focus('r1')
    expect(w.focused).toHaveBeenCalledWith('other', 'r1')
    expect(await host.forkAgent('r1')).toEqual({ ok: true, agentId: 'r1-fork' })
    expect(w.opened).toHaveBeenCalledWith('other', 'r1-fork')
    expect(w.log).toHaveBeenCalledWith('cable: fork other/r1 → r1-fork')
  })

  it('routes this computer by itself while the fleet is off, or when a call comes back unavailable', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: 'local-1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    let fleet: FleetRouting | null = null
    const w = wiring({ fleet: () => fleet })
    const host = new DaemonCableHost(w)
    // Off: this computer alone, as before the fleet was a service.
    expect(await host.listMachines()).toEqual({ machines: [{ id: 'mine', name: 'MacbookPro.local', state: 'ready', local: true }], source: 'signed-out' })
    expect((await host.listAgentsFlat()).map((a) => a.id)).toEqual(['local-1'])
    host.sendTurn('local-1', 'hello')
    expect(w.sendTurn).toHaveBeenCalledWith('local-1', 'hello')
    // On, but failing: a sync call that throws unavailable, an async one that rejects unavailable.
    fleet = port({
      sendTurn: vi.fn(() => { throw unavailable() }),
      listAgentsFlat: vi.fn(async () => { throw unavailable() }),
    })
    expect(host.sendTurn('local-1', 'again')).toEqual({ ok: true })
    expect(w.sendTurn).toHaveBeenLastCalledWith('local-1', 'again')
    expect((await host.listAgentsFlat()).map((a) => a.id)).toEqual(['local-1'])
  })

  it('lets any other failure through, as before: only an unavailable fleet is routed around', async () => {
    const host = new DaemonCableHost(wiring({ fleet: () => port({
      knows: vi.fn(() => { throw new TypeError('a bug') }),
      recentAsks: vi.fn(async () => { throw new Error('a far-end bug') }),
    }) }))
    expect(() => host.knows('r1')).toThrow('a bug')
    await expect(host.recentAsks('r1')).rejects.toThrow('a far-end bug')
  })

  it('holds the lane through the port: opens it, announces where the dial is, says when it will not, and lets go', async () => {
    const fleet = port()
    const log = vi.fn()
    const host = new DaemonCableHost(wiring({ fleet: () => fleet, log }))
    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.online).toHaveBeenCalled()
    expect(fleet.select).toHaveBeenCalledWith('mine')
    expect(await host.selectMachine('other')).toEqual({ ok: true })
    expect(host.selectedMachine()).toBe('other')
    fleet.select = vi.fn(async () => ({ ok: false as const, code: 'NEEDS_LINK', message: 'Link office-imac to this computer first' }))
    expect(await host.selectMachine('third')).toEqual({ ok: false, code: 'NEEDS_LINK', message: 'Link office-imac to this computer first' })
    expect(host.selectedMachine()).toBe('other')
    expect(await host.selectMachine('mine')).toEqual({ ok: true })
    expect(fleet.release).toHaveBeenCalledWith()
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toHaveBeenCalledWith('cable: could not announce mine (Link office-imac to this computer first)')
    fleet.online = vi.fn(async () => ({ ok: false as const, message: 'backend unreachable' }))
    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toHaveBeenCalledWith('cable: could not open the lane (backend unreachable)')
    host.onDialGone()
    expect(fleet.release).toHaveBeenLastCalledWith(true)
    // No lane to hold: nothing is opened, and a remote machine cannot be chosen.
    fleet.hasLane = vi.fn(() => false)
    fleet.online = vi.fn(async () => ({ ok: true as const }))
    host.onDialAttached()
    expect(fleet.online).not.toHaveBeenCalled()
    expect(await host.selectMachine('other')).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
  })

  it('an agent outside Harness never reaches the core: the fleet\'s router takes an id it does not know for a local agent', async () => {
    const fleet = port()
    const w = wiring({ fleet: () => fleet, recent: vi.fn(() => []), recentAsks: vi.fn(() => []), updateAgent: vi.fn(),
      listModels: vi.fn(async () => []), answerReviewed: vi.fn(async () => true),
      // The devices' own reading of it, which never asks the core (services/devices.ts).
      activityText: async () => 'Waiting for you · Orca', activitySnapshot: async () => ({ text: 'Waiting for you · Orca' }) })
    const host = new DaemonCableHost(w)
    const outside: HostAgent = { id: 'outside-1', engine: 'claude', name: 'scratch', host: 'orca', app: 'orca', state: 'done',
      lastActivityAt: 0, lastAnswer: 'Fixed the login.', unseenDone: true }
    host.setRegistry(new HostRegistry([host.harness, { id: 'observed', list: () => [outside],
      capabilities: () => ({ status: true, voice: false, focus: false, answer: false }) }]))
    expect(host.sendTurn('outside-1', 'ship it')).toMatchObject({ ok: false })
    host.stopTurn('outside-1'); host.answer('outside-1', 'q', { k: 'v' }); host.updateAgent('outside-1', 'opus')
    expect(host.canSpeakQuestion('outside-1')).toBe(false)
    expect(await host.answerReviewed({ agentId: 'outside-1', requestId: 'q', questions: [], answers: {}, selections: {} }))
      .toEqual({ ok: false, error: 'Use the terminal to answer this question.' })
    expect(await host.recentAsks('outside-1')).toEqual([])
    expect(await host.listModels('outside-1')).toEqual([])
    // Its answer, as heard: one entry, which an attach restores without a beep.
    expect(await host.recentSummaries('outside-1')).toEqual([{ recap: 'Fixed the login.', text: 'Fixed the login.', ask: '', fullText: 'Fixed the login.' }])
    // What rides on each of its cards, and its line while it waits, every refresh: read here too.
    expect(host.describe('outside-1')).toEqual({ name: 'scratch', engine: 'claude', machine: 'MacbookPro.local' })
    expect(await host.activityText('outside-1')).toBe('Waiting for you · Orca')
    expect(await host.activitySnapshot('outside-1')).toEqual({ text: 'Waiting for you · Orca' })
    // Not one call to the fleet's router, or to the core's doors this host holds, names it.
    const calls = [...Object.values(fleet), ...Object.values(w)].filter((fn) => vi.isMockFunction(fn)).flatMap((fn) => fn.mock.calls)
    expect(JSON.stringify(calls)).not.toContain('outside-1')
    // A Harness agent's routes are the router's, as before.
    expect(host.sendTurn('r1', 'ship it')).toEqual({ ok: true })
    expect(fleet.sendTurn).toHaveBeenCalledWith('r1', 'ship it')
  })

  it('an agent outside Harness that the machine list folds into a Harness agent of the same session never reaches the core', async () => {
    const fleet = port()
    const w = wiring({ fleet: () => fleet, recentAsks: vi.fn(() => []) })
    const host = new DaemonCableHost(w)
    // The session moved into a Harness pane: the list shows the Harness copy, and the dial may still hold the old id.
    const harness: HostSource = { id: 'harness', list: () => [{ id: 'r1', engine: 'claude', name: 'web', host: 'harness', app: 'harness', state: 'idle',
      sessionId: 's1', lastActivityAt: 0, unseenDone: false }], capabilities: () => ({ status: true, voice: true, focus: false, answer: true }) }
    host.setRegistry(new HostRegistry([harness, { id: 'observed', list: () => [{ id: 'outside-2', engine: 'claude', name: 'web',
      host: 'orca', app: 'orca', state: 'idle', sessionId: 's1', lastActivityAt: 0, unseenDone: false }],
    capabilities: () => ({ status: true, voice: false, focus: false, answer: false }) }]))
    expect(host.sendTurn('outside-2', 'ship it')).toMatchObject({ ok: false })
    host.stopTurn('outside-2')
    expect(await host.recentAsks('outside-2')).toEqual([])
    const calls = [...Object.values(fleet), ...Object.values(w)].filter((fn) => vi.isMockFunction(fn)).flatMap((fn) => fn.mock.calls)
    expect(JSON.stringify(calls)).not.toContain('outside-2')
  })

  it('says nothing of a fork that was refused before anyone was asked, and says a refused one that was', async () => {
    const fleet = port({ forkAgent: vi.fn(async () => ({ result: { ok: false as const, error: 'AGENT_NOT_FOUND' }, machineId: '', asked: false })) })
    const w = wiring({ fleet: () => fleet, opened: vi.fn() })
    const host = new DaemonCableHost(w)
    expect(await host.forkAgent('ghost')).toEqual({ ok: false, error: 'AGENT_NOT_FOUND' })
    expect(w.log).not.toHaveBeenCalled()
    fleet.forkAgent = vi.fn(async () => ({ result: { ok: false as const, error: 'FORK_FAILED', detail: 'busy' }, machineId: 'other', asked: true }))
    expect(await host.forkAgent('r1')).toEqual({ ok: false, error: 'FORK_FAILED', detail: 'busy' })
    expect(w.log).toHaveBeenCalledWith('cable: fork other/r1 refused (FORK_FAILED: busy)')
    expect(w.opened).not.toHaveBeenCalled()
  })

  describe('an agent outside Harness takes its voice, its answer and its tap from its own source', () => {
    const scratch: HostAgent = { id: 'o1', engine: 'claude', sessionId: 's-o1', name: 'scratch', host: 'orca', app: 'orca', state: 'idle',
      lastActivityAt: 0, unseenDone: false }
    function setup(source: Partial<HostSource> = {}) {
      const fleet = port()
      const w = wiring({ fleet: () => fleet, focused: vi.fn(), opened: vi.fn(), answerReviewed: vi.fn(async () => true), swiped: vi.fn() })
      const host = new DaemonCableHost(w)
      const observed = { send: vi.fn(async (_agent: HostAgent, _text: string): Promise<SendResult> => ({ ok: true })),
        focus: vi.fn(async (_agent: HostAgent) => true), markSeen: vi.fn() }
      host.setRegistry(new HostRegistry([host.harness, { id: 'observed', list: () => [scratch],
        capabilities: () => ({ status: true, voice: true, focus: true, answer: true }), ...observed, ...source }]))
      // Every call that reached the fleet's router or the core's doors this host holds.
      const heard = () => [...Object.values(fleet), ...Object.values(w)].filter((fn) => vi.isMockFunction(fn) && fn !== (w.log as unknown))
        .flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls)
      return { host, fleet, w, observed, heard }
    }

    it('sendTurn reaches source.send for an agent outside Harness and answers its result', async () => {
      const { host, observed, heard } = setup()
      expect(await host.sendTurn('o1', 'ship it')).toEqual({ ok: true })
      expect(observed.send).toHaveBeenCalledWith(scratch, 'ship it')
      observed.send.mockResolvedValueOnce({ ok: false, reason: 'scratch did not answer.' })
      expect(await host.sendTurn('o1', 'ship it')).toEqual({ ok: false, machine: '',
        reason: 'scratch did not answer.', message: 'scratch did not answer.' })
      expect(JSON.stringify(heard())).not.toContain('o1')
    })

    it('a harness agent keeps the fleet\'s path', () => {
      const { host, fleet, observed } = setup()
      expect(host.sendTurn('r1', 'ship it')).toEqual({ ok: true })
      expect(fleet.sendTurn).toHaveBeenCalledWith('r1', 'ship it')
      expect(observed.send).not.toHaveBeenCalled()
    })

    it('with a window open, voice to an observed agent reaches no source.send', async () => {
      const { host, observed, heard } = setup()
      onTab(host, ['r1'])
      expect(await host.sendTurn('o1', 'ship it')).toMatchObject({ ok: false })
      expect(observed.send).not.toHaveBeenCalled()
      expect(JSON.stringify(heard())).not.toContain('o1')
    })

    // The dial only shows a waiting prompt (docs/specs/2026-11-13-device-claude-orca.md): an answer for an agent outside
    // Harness, whatever its id, approves nothing, and the fleet never hears of it.
    it('an answer or a reviewed answer for an agent outside Harness, an approval\'s id or not, reaches nothing', async () => {
      const { host, fleet, heard } = setup()
      expect(host.answer('o1', 'approval:7', { approval: 'Allow' })).toBeUndefined()
      expect(await host.answerReviewed({ agentId: 'o1', requestId: 'approval:8', questions: [], answers: { approval: 'Allow' }, selections: {} }))
        .toEqual({ ok: false, error: 'Use the terminal to answer this question.' })
      expect(fleet.answer).not.toHaveBeenCalled()
      expect(fleet.answerReviewed).not.toHaveBeenCalled()
      expect(JSON.stringify(heard())).not.toContain('approval:')
    })

    it('an answer for a Harness agent goes to the fleet as before, whatever its id', async () => {
      const { host, fleet } = setup()
      host.answer('r1', 'approval:1', { k: 'v' })
      expect(fleet.answer).toHaveBeenCalledWith('r1', 'approval:1', { k: 'v' })
      expect(await host.answerReviewed({ agentId: 'r1', requestId: 'q2', questions: [], answers: {}, selections: {} })).toEqual({ ok: true, pending: true })
      expect(fleet.answerReviewed).toHaveBeenCalledTimes(1)
    })

    it('a tap on an agent with f runs source.focus', async () => {
      const { host, observed, heard } = setup()
      expect(await host.openAgent('o1')).toBeUndefined()
      expect(observed.focus).toHaveBeenCalledWith(scratch)
      expect(JSON.stringify(heard())).not.toContain('o1')
    })

    it('a failed focus answers that its own app did not open it', async () => {
      const failed = setup({ focus: vi.fn(async () => false) })
      expect(await failed.host.openAgent('o1')).toEqual({ ok: false, error: 'Orca did not open it.' })
      // A source with no open of its own cannot bring it forward either.
      const none = setup({ focus: undefined, list: () => [{ ...scratch, host: 'ghostty' }] })
      expect(await none.host.openAgent('o1')).toEqual({ ok: false, error: 'Ghostty did not open it.' })
      expect(JSON.stringify([...failed.heard(), ...none.heard()])).not.toContain('o1')
    })

    it('an open with reason question never calls source.focus', async () => {
      const { host, observed, heard } = setup()
      expect(await host.openAgent('o1', 'question')).toBeUndefined()
      expect(observed.focus).not.toHaveBeenCalled()
      expect(JSON.stringify(heard())).not.toContain('o1')
    })

    /** A source whose agent has a pane, which it shows as `shown` says. */
    function withPane(shown: () => Promise<PaneSwitch> = async () => 'ok', source: Partial<HostSource> = {}) {
      const showPane = vi.fn((_agent: HostAgent) => shown())
      const s = setup({ hasPane: vi.fn((_agent: HostAgent) => true), showPane, ...source })
      return { ...s, showPane, swiped: s.w.swiped as ReturnType<typeof vi.fn> }
    }

    it('a swipe to an Orca agent marks it seen at once and brings nothing forward', () => {
      const { host, observed, showPane, heard } = withPane()
      host.focus('o1')
      expect(observed.markSeen).toHaveBeenCalledWith('o1')
      expect(observed.focus).not.toHaveBeenCalled()
      expect(showPane).not.toHaveBeenCalled()
      expect(JSON.stringify(heard())).not.toContain('o1')
    })

    it('swipeSwitches is true only for an outside agent whose source has a pane for it', () => {
      expect(withPane().host.swipeSwitches('o1')).toBe(true)
      expect(setup({ hasPane: () => false }).host.swipeSwitches('o1')).toBe(false)
      expect(setup().host.swipeSwitches('o1')).toBe(false)
      AGENTS.push({ agentId: 'h1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
      try {
        expect(withPane().host.swipeSwitches('h1')).toBe(false)
      } finally {
        AGENTS.length = 0
      }
      expect(withPane().host.swipeSwitches('nobody')).toBe(false)
    })

    it('a rest shows the pane through source.showPane, never source.focus, and tells what came of it', async () => {
      for (const outcome of ['ok', 'failed', 'busy'] as const) {
        const { host, observed, showPane, swiped } = withPane(async () => outcome)
        host.swipeEnded('o1', 'rest')
        await vi.waitFor(() => expect(swiped).toHaveBeenCalledWith(outcome))
        expect(showPane).toHaveBeenCalledWith(scratch)
        expect(observed.focus).not.toHaveBeenCalled()
      }
    })

    it('superseded tells superseded and runs nothing', () => {
      const { host, observed, showPane, swiped } = withPane()
      host.swipeEnded('o1', 'superseded')
      expect(swiped).toHaveBeenCalledWith('superseded')
      expect(showPane).not.toHaveBeenCalled()
      expect(observed.focus).not.toHaveBeenCalled()
    })

    it('a rest on an agent that has gone, and a showPane that rejects, tell failed', async () => {
      const gone = withPane(async () => 'ok', { list: () => [] })
      gone.host.swipeEnded('o1', 'rest')
      await vi.waitFor(() => expect(gone.swiped).toHaveBeenCalledWith('failed'))
      expect(gone.showPane).not.toHaveBeenCalled()
      const rejects = withPane(async () => { throw new Error('orca crashed') })
      rejects.host.swipeEnded('o1', 'rest')
      await vi.waitFor(() => expect(rejects.swiped).toHaveBeenCalledWith('failed'))
      // A source that cannot show a pane runs nothing.
      const none = withPane(async () => 'ok', { showPane: undefined })
      none.host.swipeEnded('o1', 'rest')
      await vi.waitFor(() => expect(none.swiped).toHaveBeenCalledWith('failed'))
    })

    it('nothing of a swipe reaches the fleet or the core\'s doors', async () => {
      const { host, swiped, heard } = withPane()
      host.focus('o1')
      host.swipeEnded('o1', 'superseded')
      host.swipeEnded('o1', 'rest')
      await vi.waitFor(() => expect(swiped).toHaveBeenCalledTimes(2))
      expect(JSON.stringify(heard())).not.toContain('o1')
    })
  })
})

describe('cableStepFor', () => {
  const tool = (text: string, recap = '') => ({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool', text, recap } })
  it('turns a tool card into one step line, a path into its last segment', () => {
    expect(cableStepFor(tool('Read', '/work/cli/src/cable/cableSession.ts'))).toEqual({ agentId: 'a1', step: 'Read · cableSession.ts' })
    expect(cableStepFor(tool('Bash', 'npm test -- --run'))).toEqual({ agentId: 'a1', step: 'Bash · npm test -- --run' })
    expect(cableStepFor(tool('TodoWrite'))).toEqual({ agentId: 'a1', step: 'TodoWrite' })
  })
  it('ignores every other card, and clips long arguments', () => {
    expect(cableStepFor({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Processing' } })).toBeNull()
    expect(cableStepFor(tool(''))).toBeNull()
    expect(cableStepFor(tool('Bash', 'x'.repeat(400)))!.step.length).toBe(120)
  })
})

describe('cableEventFor fullText', () => {
  it('carries the whole answer of a summary card, and only a summary\'s', () => {
    const card = (kind: string) => ({ type: 'commander_event', agentId: 'a1', payload: { kind, text: 'b', recap: 'r', fullText: 'the whole answer' } })
    expect(cableEventFor(card('summary'))).toMatchObject({ kind: 'summary', fullText: 'the whole answer' })
    expect(cableEventFor(card('done'))).not.toHaveProperty('fullText')
    expect(cableEventFor({ ...card('summary'), payload: { kind: 'summary', text: 'b' } })).not.toHaveProperty('fullText')
  })
})

describe('cableEventFor update', () => {
  it('carries the latest assistant paragraph of a processing card, and only then', () => {
    const card = (payload: Record<string, unknown>) => ({ type: 'commander_event', agentId: 'a1', payload })
    expect(cableEventFor(card({ kind: 'processing', text: 'Working', update: 'Checking the tests' })))
      .toEqual({ kind: 'processing', agentId: 'a1', text: 'Working', recap: '', subagent: false, update: 'Checking the tests' })
    expect(cableEventFor(card({ kind: 'processing', text: 'Working' }))).not.toHaveProperty('update')
  })
})

describe('DaemonCableHost player library and member ids', () => {
  it('keeps each tab\'s agent ids in the window\'s order', () => {
    const host = new DaemonCableHost(wiring(), fleetOf([]))
    host.setSwarms({ active: 'w', swarms: [{ id: 'w', name: 'Work', agentIds: ['b', 'a'], panes: 2 }], tiles: [] })
    expect(host.listSwarms().swarms).toEqual([{ id: 'w', name: 'Work', agents: 2, agentIds: ['b', 'a'], panes: 2 }])
  })
  it('lists every agent the router knows, idle, aged by its last activity and never by its creation', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: 'a1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' },
      { agentId: 'a2', registeredAt: 2, active: true, terminalAvailable: true, engine: 'claude', lastHookAt: 5000 })
    const host = new DaemonCableHost(wiring(), fleetOf([]))
    const rows = await host.playerLibrary()
    expect(rows).toMatchObject([{ id: 'a1', machineId: 'mine', status: 'idle', lastActivityAt: null },
      { id: 'a2', machineId: 'mine', status: 'idle', lastActivityAt: 5000 }])
    AGENTS.length = 0
  })
})

describe('announcing over the real lane', () => {
  const CLOUD_ROW = { machineId: 'cloud-1', name: 'cloud-box', state: 'ready', authMode: 'managed', local: false }
  const stops: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    vi.useRealTimers()
    for (const stop of stops.splice(0)) await stop()
  })

  /** Wait on the lane without a timer (they are faked): it reads each frame through promises alone. */
  const soon = async (what: string, check: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 50_000; turn++) {
      if (check()) return
      await new Promise((resolve) => setImmediate(resolve))
    }
    throw new Error(`never: ${what}`)
  }

  async function plugged(over: { linked?: string } = {}) {
    const selects: string[] = []
    let socket: WebSocket | null = null
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (protocols) => [...protocols][0] ?? false })
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    let connections = 0
    wss.on('connection', (ws) => {
      connections++
      socket = ws
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type?: string; payload?: { machineId?: string } }
        if (frame.type === 'machine_select') selects.push(String(frame.payload?.machineId))
      })
    })
    stops.push(() => new Promise<void>((resolve) => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()) }))
    /** The backend has read every select so far: only the newest is answered. */
    const answerNewest = () => socket?.send(JSON.stringify({ type: 'machine_selected', payload: { machineId: selects.at(-1) } }))
    const lines: string[] = []
    const seal = { hello: vi.fn(async () => ({ type: 'e2e_hello', payload: {} })), welcome: vi.fn(async () => true), rekey: vi.fn(), seal: vi.fn(), open: vi.fn(), drop: vi.fn() }
    const link = new DeviceLink({
      auth: { accessToken: async () => 'token' }, backendWsBase: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
      computerId: 'this-computer', autonomousEnv: 'test', seal: seal as never,
      peer: (machineId) => (machineId === over.linked ? { machineId, pub: 'PUB', label: 'linked', linkedAt: 1 } as never : null),
      localMachineId: () => 'mine', log: (line) => { lines.push(line) },
    })
    stops.push(() => link.stop())
    const rows = [{ machineId: 'mine', name: 'MacbookPro.local', state: 'ready', authMode: 'remote', local: true }, CLOUD_ROW,
      { machineId: 'unlinked', name: 'not-linked', state: 'ready', authMode: 'remote', local: false }]
    const fleet = new DeviceFleet({ list: { list: () => ({ machines: rows, source: 'backend' as const }), find: (id: string) => rows.find((r) => r.machineId === id) } as never,
      link, hasPeerLink: () => false, log: (line) => { lines.push(line) } })
    // The lane is up from before (the dial was plugged in already): what overlaps is the announces.
    await link.online()
    const host = new DaemonCableHost(wiring({ log: (line: string) => { lines.push(line) } }), fleet)
    const announced = () => lines.filter((line) => line.includes('could not announce'))
    const welcome = (machineId: string) => socket?.send(JSON.stringify({ type: 'e2e_welcome', machineId, payload: {} }))
    const revoke = () => socket?.send(JSON.stringify({ type: 'device_revoked' }))
    const closeWith = (code: number) => socket?.close(code)
    return { host, selects, answerNewest, lines, announced, seal, welcome, revoke, closeWith, connections: () => connections }
  }

  it('logs no "could not announce" for a plug-in that announces through both paths when the backend answers', async () => {
    const { host, selects, answerNewest, announced, lines } = await plugged()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    host.onDialAttached()                       // announces where the dial is, once the lane is up
    const picked = host.selectMachine('mine')   // the dial's own pick on hello, announced too
    expect(await picked).toEqual({ ok: true })
    await soon('the announce', () => selects.length >= 1)
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve))
    answerNewest()
    await soon('its answer', () => lines.includes('device: machine_selected mine'))
    await vi.advanceTimersByTimeAsync(15_000)
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve))
    expect(announced()).toEqual([])
    expect(selects).toEqual(['mine'])
  })

  it('announces the machine a select is on its way to, instead of replacing it with the one before', async () => {
    const { host, selects, answerNewest, announced, lines } = await plugged()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const picked = host.selectMachine('cloud-1')
    await soon('the pick', () => selects.length === 1)
    host.onDialAttached()
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve))
    answerNewest()
    await soon('its answer', () => lines.some((line) => line.startsWith('device: machine_selected')))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await picked).toEqual({ ok: true })
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve))
    expect(host.selectedMachine()).toBe('cloud-1')
    expect(announced()).toEqual([])
    expect(selects).toEqual(['cloud-1'])
  })

  it('refuses a pick whose session was still being made when the person picked this computer, end to end over the lane', async () => {
    const { host, selects, answerNewest, lines, seal, welcome, announced } = await plugged({ linked: 'cloud-1' })
    const late = host.selectMachine('cloud-1')
    await soon('the pick', () => selects.length === 1)
    answerNewest()
    await soon('its hello', () => seal.hello.mock.calls.length === 1)
    expect(await host.selectMachine('mine')).toEqual({ ok: true })
    await soon('the announce', () => selects.length === 2)
    answerNewest()
    await soon('its answer', () => lines.includes('device: machine_selected mine'))
    welcome('cloud-1')
    expect(await late).toMatchObject({ ok: false, code: 'SUPERSEDED' })
    expect(host.selectedMachine()).toBe('mine')
    expect(announced()).toEqual([])
  })

  it('puts the lane back where the dial is when a refused pick replaced a slow one', async () => {
    // Refused before the lane is asked, so the lane would stay on the machine the person left, and a reconnect return there.
    const { host, selects, answerNewest, lines, seal, welcome, announced } = await plugged({ linked: 'cloud-1' })
    const late = host.selectMachine('cloud-1')
    await soon('the pick', () => selects.length === 1)
    answerNewest()
    await soon('its hello', () => seal.hello.mock.calls.length === 1)
    expect(await host.selectMachine('unlinked')).toMatchObject({ ok: false, code: 'NEEDS_LINK' })
    await soon('the lane told again', () => selects.length === 2)
    answerNewest()
    await soon('its answer', () => lines.includes('device: machine_selected mine'))
    welcome('cloud-1')
    expect(await late).toMatchObject({ ok: false, code: 'SUPERSEDED' })
    expect(selects).toEqual(['cloud-1', 'mine'])
    expect(host.selectedMachine()).toBe('mine')
    expect(announced()).toEqual([])
  })

  describe('a lane that ends during a pick stays ended (review of #2504)', () => {
    /** A pick in its handshake, on a lane about to end. */
    const inHandshake = async () => {
      const up = await plugged({ linked: 'cloud-1' })
      const first = up.host.selectMachine('cloud-1')
      await soon('the pick', () => up.selects.length === 1)
      up.answerNewest()
      await soon('its hello', () => up.seal.hello.mock.calls.length === 1)
      return { ...up, first }
    }

    it('sends no select on the way out of a revoke', async () => {
      const { host, selects, revoke, first } = await inHandshake()
      revoke()
      expect(await first).toMatchObject({ ok: false, code: 'UNREACHABLE' })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(selects).toEqual(['cloud-1'])
      expect(host.selectedMachine()).toBe('mine')
    })

    it('dials nothing after the backend refuses the lane with 4403, whatever is picked next', async () => {
      const { host, selects, closeWith, connections, lines, first } = await inHandshake()
      closeWith(4403)
      expect(await first).toMatchObject({ ok: false })
      await soon('the refusal', () => lines.some((line) => line.includes('not authorized')))
      expect(await host.selectMachine('unlinked')).toMatchObject({ code: 'NEEDS_LINK' })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(connections()).toBe(1)
      expect(selects).toEqual(['cloud-1'])
    })
  })

  it('says nothing of an announce a newer pick replaced, and the pick lands', async () => {
    const { host, selects, answerNewest, announced, lines } = await plugged()
    const first = host.selectMachine('cloud-1')
    await soon('the first pick', () => selects.length === 1)
    answerNewest()
    expect(await first).toEqual({ ok: true })
    host.onDialGone()                            // unplugged: the lane goes with it, and comes back at once
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    host.onDialAttached()                        // and back: announces cloud-1, where the dial was
    await soon('the announce', () => selects.length === 2)
    expect(await host.selectMachine('mine')).toEqual({ ok: true })   // and the person picks this computer
    await soon('the pick', () => selects.length === 3)
    answerNewest()
    await soon('its answer', () => lines.includes('device: machine_selected mine'))
    await vi.advanceTimersByTimeAsync(15_000)
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve))
    expect(announced()).toEqual([])
    expect(selects).toEqual(['cloud-1', 'cloud-1', 'mine'])
    expect(host.selectedMachine()).toBe('mine')
  })
})

/**
 * Diego, 11-02: a pick waiting on a slow machine lands after the person left it. The late answer used to set
 * `selected`, so the check mark moved to a machine nobody had asked for any more. The newest pick decides.
 */
describe('a pick a newer pick replaced', () => {
  const SECOND: FleetMachine = { machineId: 'second', name: 'second-mac', state: 'ready', authMode: 'remote' }
  /** A fleet whose selects wait until the test settles them, in the order they were asked. */
  const slow = () => {
    const asked: Array<{ machineId: string; ok: () => void; fail: (error: Error) => void }> = []
    const fleet = fleetOf([REMOTE, SECOND])
    fleet.select = vi.fn((machineId: string) => new Promise<void>((ok, fail) => { asked.push({ machineId, ok, fail }) }))
    return { fleet, asked }
  }
  const SUPERSEDED = { ok: false, code: 'SUPERSEDED', message: 'Another machine was chosen' }

  it('keeps this computer selected when a pick of another machine lands after a pick of this one', async () => {
    const { fleet, asked } = slow()
    // No machine id yet: nothing is announced, so the lane never hears of the newer pick. The host alone knows of it.
    const host = new DaemonCableHost(wiring({ machineId: () => '' }), fleet)
    const here = host.localMachine().id
    const late = host.selectMachine('other')
    expect(host.pendingPick()).toBe('other')
    expect(await host.selectMachine(here)).toEqual({ ok: true })
    expect(host.pendingPick()).toBe('')
    asked[0]!.ok()
    expect(await late).toEqual(SUPERSEDED)
    expect(host.selectedMachine()).toBe(here)
  })

  it('reports a late failure of a replaced pick as replaced, not as the machine failing', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring({ machineId: () => '' }), fleet)
    const late = host.selectMachine('other')
    await host.selectMachine(host.localMachine().id)
    asked[0]!.fail(new Error('the machine did not answer'))
    expect(await late).toEqual(SUPERSEDED)
  })

  it('lets only the newest of two remote picks move the selection, whichever lands first', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring(), fleet)
    const older = host.selectMachine('other')
    const newer = host.selectMachine('second')
    expect(host.pendingPick()).toBe('second')
    asked[0]!.ok()
    expect(await older).toEqual(SUPERSEDED)
    // Still on its way: the older one's end does not clear it, or a plug-in now would announce the machine before.
    expect(host.pendingPick()).toBe('second')
    expect(host.selectedMachine()).toBe('mine')
    asked[1]!.ok()
    expect(await newer).toEqual({ ok: true })
    expect(host.selectedMachine()).toBe('second')
    expect(host.pendingPick()).toBe('')
  })

  it('answers a person going away and back with the last pick\'s outcome: the first one landing proves nothing', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring({ machineId: () => '' }), fleet)
    const first = host.selectMachine('other')
    await host.selectMachine(host.localMachine().id)
    const third = host.selectMachine('other')
    asked[0]!.ok()
    await new Promise((resolve) => setImmediate(resolve))
    expect(host.selectedMachine()).toBe(host.localMachine().id)
    expect(host.pendingPick()).toBe('other')
    asked[1]!.fail(new Error('the machine did not answer'))
    expect(await third).toMatchObject({ ok: false, code: 'UNREACHABLE' })
    expect(await first).toMatchObject({ ok: false, code: 'UNREACHABLE' })
    expect(host.selectedMachine()).toBe(host.localMachine().id)
  })

  it('answers a first pick ok when the same machine\'s last pick landed before it', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring({ machineId: () => '' }), fleet)
    const first = host.selectMachine('other')
    await host.selectMachine(host.localMachine().id)
    const third = host.selectMachine('other')
    asked[1]!.ok()
    expect(await third).toEqual({ ok: true })
    asked[0]!.ok()
    expect(await first).toEqual({ ok: true })
    expect(host.selectedMachine()).toBe('other')
  })

  it('asks once for two picks of one machine, and gives both its answer', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring(), fleet)
    const first = host.selectMachine('other')
    const second = host.selectMachine('other')
    expect(asked).toHaveLength(1)
    asked[0]!.ok()
    expect([await first, await second]).toEqual([{ ok: true }, { ok: true }])
    expect(host.selectedMachine()).toBe('other')
  })

  it('says where the dial is when a machine refuses a pick that replaced another, and not for a replaced pick failing', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring(), fleet)
    const older = host.selectMachine('other')
    const newest = host.selectMachine('second')
    asked[0]!.fail(new Error('the machine did not answer'))
    await older
    expect(asked.map((a) => a.machineId)).toEqual(['other', 'second'])
    asked[1]!.fail(new FleetError('BILLING', 'second-mac needs a subscription'))
    expect(await newest).toMatchObject({ ok: false, code: 'BILLING' })
    expect(asked.map((a) => a.machineId)).toEqual(['other', 'second', 'mine'])
    asked[2]!.ok()
  })

  it('tells the lane nothing after a refusal with no pick replaced: it never moved', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring(), fleet)
    const pick = host.selectMachine('other')
    asked[0]!.fail(new FleetError('NEEDS_LINK', 'Link it first'))
    expect(await pick).toMatchObject({ code: 'NEEDS_LINK' })
    expect(asked).toHaveLength(1)
  })

  it('tells the lane nothing after a failure that is not a refusal: it may be the lane\'s end', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring(), fleet)
    const older = host.selectMachine('other')
    const newest = host.selectMachine('second')
    asked[1]!.fail(new Error('socket closed (4403)'))
    expect(await newest).toMatchObject({ code: 'UNREACHABLE' })
    asked[0]!.ok()
    await older
    expect(asked).toHaveLength(2)
  })

  it('opens nothing again when a pick fails because the dial was unplugged', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring(), fleet)
    const older = host.selectMachine('other')
    const pick = host.selectMachine('second')
    host.onDialGone()
    asked[1]!.fail(new Error('released'))
    await pick
    asked[0]!.fail(new Error('released'))
    await older
    expect(asked).toHaveLength(2)
    expect(fleet.release).toHaveBeenCalledWith(true)
  })

  it('leaves the lane alone when it says a newer select replaced the pick', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring(), fleet)
    const older = host.selectMachine('other')
    const pick = host.selectMachine('second')
    asked[1]!.fail(new FleetError('SUPERSEDED', 'Another machine was chosen'))
    expect(await pick).toMatchObject({ ok: false, code: 'SUPERSEDED' })
    asked[0]!.ok()
    await older
    expect(asked).toHaveLength(2)
  })

  it('leaves nothing pending when the fleet call fails at once', async () => {
    const { fleet } = slow()
    fleet.select = vi.fn(() => { throw new Error('broken fleet') })
    const host = new DaemonCableHost(wiring(), fleet)
    expect(await host.selectMachine('other')).toMatchObject({ ok: false, code: 'UNREACHABLE' })
    expect(host.pendingPick()).toBe('')
  })

  it('still reports the newest pick\'s own refusal', async () => {
    const { fleet, asked } = slow()
    const host = new DaemonCableHost(wiring(), fleet)
    const pick = host.selectMachine('other')
    asked[0]!.fail(new Error('the machine did not answer'))
    expect(await pick).toMatchObject({ ok: false, code: 'UNREACHABLE' })
    expect(host.pendingPick()).toBe('')
  })
})

/**
 * A plug-in whose first lane open fails — Diego, 11-01: the sign-in refresh failed in a network blip, nothing tried
 * again, and the wheel lost every other Mac until the dial was replugged.
 */
describe('a plug-in whose first lane open fails', () => {
  const stops: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    vi.useRealTimers()
    for (const stop of stops.splice(0)) await stop()
  })
  /** A bare fleet whose online() throws `fails` times, as a token read lost to a blip does, then opens. */
  const failing = (fails: number) => {
    let left = fails
    const fleet = fleetOf([REMOTE])
    fleet.online = vi.fn(async () => { if (left-- > 0) throw Object.assign(new Error('UNAVAILABLE: the sign-in could not be refreshed'), { code: 'TOKEN_UNAVAILABLE' }) })
    fleet.select = vi.fn(async () => {})
    fleet.release = vi.fn()
    return fleet
  }
  const turns = async () => { for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve)) }

  it('opens the lane later, and then announces where the dial is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fleet = failing(2)
    const log = vi.fn()
    const host = new DaemonCableHost(wiring({ log }), fleet)
    host.onDialAttached()
    await turns()
    expect(fleet.online).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('cable: could not open the lane (UNAVAILABLE: the sign-in could not be refreshed)')
    expect(fleet.select).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await turns()
    expect(fleet.online).toHaveBeenCalledTimes(2)   // failed again: the next try waits longer
    await vi.advanceTimersByTimeAsync(1_999)
    await turns()
    expect(fleet.online).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await turns()
    expect(fleet.online).toHaveBeenCalledTimes(3)
    expect(fleet.select).toHaveBeenCalledWith('mine')
    // Open now: nothing more is scheduled.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fleet.online).toHaveBeenCalledTimes(3)
  })

  it('stops trying once the dial is unplugged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fleet = failing(Infinity)
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialAttached()
    await turns()
    host.onDialGone()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fleet.online).toHaveBeenCalledTimes(1)
  })

  it('stops trying once this computer is signed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fleet = failing(Infinity)
    let signedIn = true
    const host = new DaemonCableHost(wiring({ signedIn: () => signedIn }), fleet)
    host.onDialAttached()
    await turns()
    signedIn = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fleet.online).toHaveBeenCalledTimes(1)
  })

  it('announces nothing for an open that lands after the dial was unplugged', async () => {
    let finish: () => void = () => {}
    const fleet = failing(0)
    fleet.online = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialAttached()
    await turns()
    host.onDialGone()
    finish()
    await turns()
    expect(fleet.select).not.toHaveBeenCalled()
  })

  it('keeps one retry for a replug while one is waiting, not two', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fleet = failing(Infinity)
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialAttached()
    await turns()
    host.onDialAttached()   // the session re-reports the dial without an unplug in between
    await turns()
    expect(fleet.online).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    await turns()
    expect(fleet.online).toHaveBeenCalledTimes(3)
  })

  it('stops at once when the session is over, and says why', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fleet = failing(0)
    fleet.online = vi.fn(async () => { throw Object.assign(new Error('sign in again'), { code: 'SESSION_OVER' }) })
    const log = vi.fn()
    const host = new DaemonCableHost(wiring({ log }), fleet)
    host.onDialAttached()
    await turns()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fleet.online).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('cable: could not open the lane (sign in again) — other machines are unavailable until the next sign-in')
    expect(log).not.toHaveBeenCalledWith('cable: trying the cloud lane again')
  })

  it('leaves a socket that failed to the lane\'s own reconnect: one backoff, not two', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fleet = failing(0)
    fleet.online = vi.fn(async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) })
    const log = vi.fn()
    const host = new DaemonCableHost(wiring({ log }), fleet)
    host.onDialAttached()
    await turns()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fleet.online).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('cable: could not open the lane (connect ECONNREFUSED 127.0.0.1:1)')
  })

  it('runs one backoff over the real lane when the backend is down at the first plug-in', async () => {
    // Port 1: every dial is refused at once, as with the backend down. An unprivileged process cannot listen there,
    // where a port freed a moment ago could be taken by another listener before the dial.
    const lines: string[] = []
    const link = new DeviceLink({
      auth: { accessToken: async () => 'token' }, backendWsBase: 'ws://127.0.0.1:1',
      computerId: 'this-computer', autonomousEnv: 'test',
      seal: { hello: vi.fn(), welcome: vi.fn(), rekey: vi.fn(), seal: vi.fn(), open: vi.fn(), drop: vi.fn() } as never,
      peer: () => null, localMachineId: () => 'mine', log: (line) => { lines.push(line) },
    })
    stops.push(() => link.stop())
    const rows = [{ machineId: 'mine', name: 'MacbookPro.local', state: 'ready', authMode: 'remote', local: true }]
    const fleet = new DeviceFleet({ list: { list: () => ({ machines: rows, source: 'backend' as const }), find: (id: string) => rows.find((r) => r.machineId === id) } as never,
      link, hasPeerLink: () => false, log: (line) => { lines.push(line) } })
    const host = new DaemonCableHost(wiring({ log: (line: string) => { lines.push(line) } }), fleet)
    host.onDialAttached()
    await new Promise((resolve) => setTimeout(resolve, 3_500))   // the first dial, then the lane's own at 1 s and 3 s
    const dials = lines.filter((line) => line.startsWith('device: connecting'))
    expect(dials.length).toBeGreaterThanOrEqual(2)   // the lane did try again by itself
    expect(dials.length).toBeLessThanOrEqual(3)
    expect(lines).not.toContain('cable: trying the cloud lane again')
  }, 10_000)

  it('opens the real lane later when its first token read throws', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (protocols) => [...protocols][0] ?? false })
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    const frames: Array<{ type?: string; payload?: { machineId?: string } }> = []
    wss.on('connection', (ws) => { ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString())) }) })
    stops.push(() => new Promise<void>((resolve) => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()) }))
    let fails = 1
    const lines: string[] = []
    const link = new DeviceLink({
      auth: { accessToken: async () => { if (fails-- > 0) throw new Error('UNAVAILABLE'); return 'token' } },
      backendWsBase: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
      computerId: 'this-computer', autonomousEnv: 'test',
      seal: { hello: vi.fn(), welcome: vi.fn(), rekey: vi.fn(), seal: vi.fn(), open: vi.fn(), drop: vi.fn() } as never,
      peer: () => null, localMachineId: () => 'mine', log: (line) => { lines.push(line) },
    })
    stops.push(() => link.stop())
    const rows = [{ machineId: 'mine', name: 'MacbookPro.local', state: 'ready', authMode: 'remote', local: true }]
    const fleet = new DeviceFleet({ list: { list: () => ({ machines: rows, source: 'backend' as const }), find: (id: string) => rows.find((r) => r.machineId === id) } as never,
      link, hasPeerLink: () => false, log: (line) => { lines.push(line) } })
    const host = new DaemonCableHost(wiring({ log: (line: string) => { lines.push(line) } }), fleet)
    host.onDialAttached()
    const deadline = Date.now() + 4_000
    while (!frames.some((frame) => frame.type === 'machine_select')) {
      if (Date.now() > deadline) throw new Error(`the lane never opened: ${lines.join(' | ')}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(lines).toContain('cable: could not open the lane (UNAVAILABLE)')
    expect(frames.filter((frame) => frame.type === 'machines_watch')).toHaveLength(1)
    expect(frames.find((frame) => frame.type === 'machine_select')?.payload?.machineId).toBe('mine')
    expect(link.status()).toBe('ready')
  }, 10_000)
})
