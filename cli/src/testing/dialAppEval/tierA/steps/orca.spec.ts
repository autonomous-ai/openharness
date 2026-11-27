// Tier A's model of Orca (orca.ts) on a world whose devices are not started: what Orca's CLI answers the devices' own
// reads and actions of it (cable/hosts/orca.ts), where the devices find it, and what a focus watch prints. Every folder is
// a temp one, on virtual time; nothing runs.
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observedAgentId } from '../../../../cable/hosts/observed.js'
import { createOrcaAdapter, createOrcaReads } from '../../../../cable/hosts/orca.js'
import { OrcaChatSource, type HeardChat } from '../../../../cable/hosts/orcaChatSource.js'
import type { CorePorts } from '../../../../core/api.js'
import { orcaBinary } from '../../../../devices/orcaHomes.js'
import type { DevicesDeps, startDevices } from '../../../../services/devices.js'
import { dialStream, orcaFrontHandler, type ListenerStream, type ListenerStreamHandler } from '../../../../services/devicesListener.js'
import { orcaChat, orcaGhost, orcaSession, scenario } from '../../catalog.js'
import { agentIdOf, ORCA_ECHO_MS, orcaTerminalHandle, orcaWorktreeId, type Platform, type Scenario, type SessionKey } from '../../types.js'
import { installClock } from '../clock.js'
import { machine } from '../machine.js'
import { World } from '../world.js'
import { closeOrca, orcaModelSteps, reopenOrca } from './orca.js'
import { sessionsSteps } from './sessions.js'
import { tmuxSteps } from './tmux.js'

// No process starts: the real reads of Orca run here, and one past the model would run this machine's `orca`.
const { reached, refused } = await vi.hoisted(async () => await import('../refuseProcesses.js'))
vi.mock('node:child_process', refused)
vi.mock('child_process', refused)

const PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'linux']

/** w1: a and c split in its first tab, b in its second, e in its third, never started; w2: d. */
const layout = (more: Partial<Scenario> = {}): Scenario => scenario({
  id: 'O0', app: 'orca', title: 'Eval Orca', dims: ['D1'], tiers: ['a'], steps: [], checks: [], probes: [],
  sessions: [orcaSession('a'), orcaSession('c', { split: 1 }), orcaSession('b', { engine: 'codex', tab: 1 }),
    orcaSession('e', { tab: 2 }), orcaSession('d', { worktree: 'w2' }), orcaGhost],
  ...more,
})

const worlds: World[] = []
beforeEach(() => { installClock() })
afterEach(() => {
  for (const world of worlds.splice(0)) world.remove()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  expect(reached.splice(0)).toEqual([])
})

/** A world on that platform, which answers Orca's CLI from its start, and the deps it handed the devices, whose port
 *  takes the hooks. */
function worldOn(platform: Platform, of: Scenario): { world: World; deps: DevicesDeps } {
  machine.reset()
  let handed: DevicesDeps | undefined
  const start = ((_core: unknown, ports: CorePorts, deps: DevicesDeps) => {
    ports.devices = { observed: () => true, inboxPoll: () => new Promise(() => {}), inboxGone: () => {} } as unknown as CorePorts['devices']
    handed = deps
    return {}
  }) as unknown as typeof startDevices
  const world = new World(of, platform, start)
  worlds.push(world)
  return { world, deps: handed! }
}

const started = async (world: World, keys: SessionKey[]): Promise<void> => {
  for (const session of keys) await sessionsSteps.hook(world, { kind: 'hook', session, event: 'start' })
}
/** A child's stdout comes on a later turn. */
const landed = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** The devices' own dial stream and orcaFront handler on the world's listener, as the devices open them: each stream
 *  opened, with what it was told and the stream it was handed, and each front the devices took, with its workspace. */
async function pluginDoor(deps: DevicesDeps) {
  const dial = dialStream({ log: () => {}, after: () => () => {} })
  const opened: Array<{ message: Record<string, unknown>; lines: unknown[]; stream: ListenerStream }> = []
  const fronts: Array<readonly string[] | null> = []
  const workspaces: Array<string | null | undefined> = []
  const handler: ListenerStreamHandler = { ...dial.handler, open: (message, stream) => {
    const lines: unknown[] = []
    opened.push({ message, lines, stream })
    return dial.handler.open(message, { ...stream, write: (line) => { lines.push(line); return stream.write(line) } })
  } }
  await deps.listen!({ dial: handler, orcaFront: orcaFrontHandler(() => dial.isOpen(), (terminals, workspace) => {
    fronts.push(terminals)
    workspaces.push(workspace)
  }) }, () => {})
  return { dial, opened, fronts, workspaces }
}

/** w1: a's pane, and c, a chat no process runs; w2: d, a chat whose Claude Code runs, and e, a Codex chat that rests. */
const chats = (more: Partial<Scenario> = {}): Scenario => layout({
  sessions: [orcaSession('a'), orcaChat('c', 'resting'), orcaChat('d', 'live', { worktree: 'w2' }),
    orcaChat('e', 'resting', { worktree: 'w2', engine: 'codex' }), orcaGhost],
  ...more,
})
/** The devices' own read of Orca's chats on the world's CLI, with the sessions the hooks named. A read is over once the
 *  world's answers have landed: they come on the run's own turn. */
function chatSource(deps: DevicesDeps, heard: ReadonlyMap<string, HeardChat> = new Map()) {
  const source = new OrcaChatSource({ binary: () => orcaBinary(deps.orca!), run: deps.orca!.run, mtime: deps.orca!.mtime,
    heard: () => heard, focus: async () => false, show: async () => 'failed', log: () => {}, now: () => Date.now() })
  const read = async (opts?: { worktrees?: boolean }): Promise<void> => {
    source.read(opts)
    await landed()
  }
  return { source, read }
}
/** What Orca's CLI prints for that command, as JSON. */
const answered = async (deps: DevicesDeps, args: string[]): Promise<Record<string, unknown>> =>
  JSON.parse((await deps.orca!.run(orcaBinary(deps.orca!)!, args, 5_000)).stdout) as Record<string, unknown>
const plugin = (world: World, open: boolean) => orcaModelSteps['orca.plugin'](world, { kind: 'orca.plugin', open })
const front = (world: World, worktree: string) => orcaModelSteps['orca.front'](world, { kind: 'orca.front', worktree })

describe("tier A's Orca", () => {
  it("terminal list answers the layout step's worktrees, each open pane by tab then split", async () => {
    const { world, deps } = worldOn('darwin', layout())
    const reads = createOrcaReads(deps.orca!)
    await started(world, ['d', 'b', 'c', 'a'])
    // Until the first layout, Orca lists nothing.
    expect(await reads.orcaTabs()).toEqual({ tabs: [], terminals: [], worktrees: new Map() })
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w2', 'w1'], renamed: { b: 'Eval Renamed' } })
    const listed = await reads.orcaTabs()
    // e never started: no pane of it is open.
    expect(listed!.tabs).toEqual([
      { handle: orcaTerminalHandle('d'), title: 'Eval Delta' },
      { handle: orcaTerminalHandle('a'), title: 'Eval Alpha' }, { handle: orcaTerminalHandle('c'), title: 'Eval Alpha' },
      { handle: orcaTerminalHandle('b'), title: 'Eval Renamed', renamed: true },
    ])
    expect(listed!.terminals).toEqual([
      { handle: orcaTerminalHandle('d'), worktreePath: '/work/eval-w2', agentIdentity: 'claude' },
      { handle: orcaTerminalHandle('a'), worktreePath: '/work/eval-w1', agentIdentity: 'claude' },
      { handle: orcaTerminalHandle('c'), worktreePath: '/work/eval-w1', agentIdentity: 'claude' },
      { handle: orcaTerminalHandle('b'), worktreePath: '/work/eval-w1', agentIdentity: 'codex' },
    ])
    expect(listed!.worktrees).toEqual(new Map([['d', 'w2'], ['a', 'w1'], ['c', 'w1'], ['b', 'w1']]
      .map(([key, worktree]) => [orcaTerminalHandle(key!), orcaWorktreeId(worktree!)])))
    expect(world.seen([]).commands.map(({ argv, ok }) => [argv.slice(1).join(' '), ok])).toEqual([
      ['terminal list --json --include-visual-layouts', true], ['terminal list --json --include-visual-layouts', true],
    ])
  })

  it('terminal --help lists watch-focus unless the world says Orca has none', async () => {
    expect(await createOrcaReads(worldOn('darwin', layout()).deps.orca!).orcaWatchesFocus()).toBe(true)
    const older = layout({ world: { orca: { watchFocus: false } } })
    expect(await createOrcaReads(worldOn('darwin', older).deps.orca!).orcaWatchesFocus()).toBe(false)
  })

  it('an Orca with no watch-focus fails the command: its watch ends at once and hears no focus', async () => {
    const { world, deps } = worldOn('darwin', layout({ world: { orca: { watchFocus: false } } }))
    await started(world, ['a'])
    const heard: Array<string | null> = []
    let ended = false
    void createOrcaReads(deps.orca!).watchOrcaFocus((handle) => { heard.push(handle) }).ended.then(() => { ended = true })
    await orcaModelSteps['orca.focus'](world, { kind: 'orca.focus', session: 'a' })
    await landed()
    expect([ended, heard]).toEqual([true, []])
    expect(world.seen([]).commands.map(({ argv, ok }) => [argv.slice(1).join(' '), ok])).toEqual([['terminal watch-focus --json', false]])
  })

  it('worktree activate, terminal switch and send answer 0 and are recorded', async () => {
    const { world, deps } = worldOn('linux', layout())
    await started(world, ['a'])
    const switches: string[] = []
    const adapter = createOrcaAdapter(deps.orca!, { worktreeOf: () => orcaWorktreeId('w1'), log: () => {}, switching: (h) => { switches.push(h) } })
    const pane = { adapter: 'orca', id: orcaTerminalHandle('a') }
    expect(await adapter.show(pane, 'eval-agent')).toBe('ok')
    expect(await adapter.type(pane, 'Eval words for alpha.', 'claude')).toBe(true)
    expect(switches).toEqual([orcaTerminalHandle('a')])
    const orca = '/opt/eval/orca/resources/bin/orca-ide'
    expect(world.seen([]).commands.map(({ argv, ok }) => [argv, ok])).toEqual([
      [[orca, 'worktree', 'activate', '--worktree', `id:${orcaWorktreeId('w1')}`, '--json'], true],
      [[orca, 'terminal', 'switch', '--terminal', orcaTerminalHandle('a'), '--json'], true],
      [[orca, 'terminal', 'send', '--terminal', orcaTerminalHandle('a'), '--text=Eval words for alpha.', '--enter', '--wait-submit', '5', '--json'], true],
    ])
  })

  it("the devices' read of Orca's homes as they start runs `account list`, which names each Codex agent's own home, an "
    + "Orca account's, there from the start, and nothing else, on every platform", async () => {
    // b is the layout's one Codex with a home of its own; f's is the daemon's, no Orca account's.
    const of = layout({ sessions: [...layout().sessions, orcaSession('f', { engine: 'codex', codexHome: undefined, tab: 3 })] })
    const programs: Readonly<Record<Platform, string>> = { darwin: 'orca', linux: 'orca-ide', win32: 'orca.exe' }
    for (const platform of PLATFORMS) {
      machine.reset()
      let handed: DevicesDeps | undefined
      let read: Promise<boolean> | undefined
      // The devices read the homes at once as they start (services/devices.ts).
      const world = new World(of, platform, ((_core: unknown, _ports: unknown, deps: DevicesDeps) => {
        handed = deps
        read = deps.orcaHomes!.refresh()
        return {}
      }) as unknown as typeof startDevices)
      worlds.push(world)
      expect(await read, platform).toBe(true)
      expect([handed!.orcaHomes!.get(), handed!.orcaHomes!.answered()], platform)
        .toEqual([{ claude: [], codex: [join(world.folders.codexHomes, 'b')] }, true])
      expect(world.seen([]).commands.map(({ argv, ok }) => [win32.basename(argv[0]!), argv.slice(1).join(' '), ok]), platform)
        .toEqual([[programs[platform], 'account list --json', true]])
      vi.unstubAllEnvs()
    }
  })

  it("the CLI is where each platform's installer puts it, its accept never called: the app's on macOS, orca-ide on Linux's "
    + "PATH, and on Windows under LOCALAPPDATA, which the devices' Orca deps carry", () => {
    const linux = '/opt/eval/orca/resources/bin/orca-ide'
    for (const platform of PLATFORMS) {
      const { deps } = worldOn(platform, layout())
      const app = process.env.HARNESS_ORCA_APP_BIN!
      // The world's own made-up app, inside its temp folder: never this machine's Orca.
      expect(app.startsWith(tmpdir())).toBe(true)
      expect(app.endsWith(join('Orca.app', 'Contents', 'Resources', 'bin', 'orca'))).toBe(true)
      // Windows' per-user folder is the world's own too, and no other platform has one.
      const local = process.env.LOCALAPPDATA!
      expect(local.startsWith(tmpdir()), platform).toBe(platform === 'win32')
      const exe = win32.join(local, 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
      const installed = { darwin: app, linux, win32: exe }[platform]
      // Only Orca's install is there.
      expect([app, linux, exe, '/Applications/Orca.app/Contents/Resources/bin/orca'].filter((path) => deps.orca!.exists(path)), platform)
        .toEqual([installed])
      // Orca's installer puts nothing on Windows' PATH: the devices find its install's by LOCALAPPDATA.
      expect(orcaBinary(deps.orca!), platform).toBe(installed)
      // The accept reads the real disk: the model's PATH never asks it.
      const accept = vi.fn(() => true)
      for (const name of ['orca', 'orca-ide']) deps.orca!.onPath(name, accept)
      expect(accept).not.toHaveBeenCalled()
      vi.unstubAllEnvs()
    }
  })

  it('a watch prints the last focus line told, then each orca.focus line', async () => {
    const { world, deps } = worldOn('darwin', layout())
    await started(world, ['a', 'b'])
    const reads = createOrcaReads(deps.orca!)
    const focus = (session: SessionKey) => orcaModelSteps['orca.focus'](world, { kind: 'orca.focus', session })
    // With no watch running, a focus is told to nobody.
    await focus('a')
    const first: Array<string | null> = []
    const one = reads.watchOrcaFocus((handle) => { first.push(handle) })
    await landed()
    expect(first).toEqual([orcaTerminalHandle('a')])
    await focus('b')
    const second: Array<string | null> = []
    reads.watchOrcaFocus((handle) => { second.push(handle) })
    await landed()
    expect([first, second]).toEqual([[orcaTerminalHandle('a'), orcaTerminalHandle('b')], [orcaTerminalHandle('b')]])
    // A watch stopped ends, and hears no more.
    one.stop()
    await one.ended
    await focus('a')
    await landed()
    expect([first, second]).toEqual([[orcaTerminalHandle('a'), orcaTerminalHandle('b')], [orcaTerminalHandle('b'), orcaTerminalHandle('a')]])
    // Each watch's start is a command Orca ran.
    expect(world.seen([]).commands.filter(({ argv }) => argv[2] === 'watch-focus')).toHaveLength(2)
    // A focus on a pane that is not open is the scenario's mistake.
    await expect(focus('e')).rejects.toThrow(/e, whose pane is not open/)
  })

  it("a switch is echoed on each running watch 1.5 s later, inside the devices' 2 s echo window", async () => {
    const { world, deps } = worldOn('darwin', layout())
    await started(world, ['a', 'b'])
    const reads = createOrcaReads(deps.orca!)
    const heard: Array<Array<string | null>> = [[], []]
    for (const into of heard) reads.watchOrcaFocus((handle) => { into.push(handle) })
    expect(await createOrcaAdapter(deps.orca!).show({ adapter: 'orca', id: orcaTerminalHandle('b') }, 'eval-agent')).toBe('ok')
    vi.advanceTimersByTime(1_499)
    await landed()
    expect(heard).toEqual([[], []])
    vi.advanceTimersByTime(1)
    await landed()
    expect(heard).toEqual([[orcaTerminalHandle('b')], [orcaTerminalHandle('b')]])
  })

  it('orcaSession gives a Codex its own CODEX_HOME', async () => {
    expect(orcaSession('d', { worktree: 'w2', tab: 1 })).toEqual({ key: 'd', app: 'orca', id: '00000000-0000-4000-8c00-000000000064',
      handle: orcaTerminalHandle('d'), title: 'Eval Delta', worktree: 'w2', tab: 1, split: 0, cwd: '/work/eval-w2', ageMs: 0 })
    expect(orcaSession('b', { engine: 'codex' })).toMatchObject({ engine: 'codex', codexHome: 'own' })
    const { world } = worldOn('darwin', layout())
    await started(world, ['b'])
    expect(machine.owners.get(world.session('b').id)!.transcriptPath!.startsWith(world.folders.codexHomes)).toBe(true)
  })

  it('orca.plugin opens the devices\' dial stream as the plugin does, and with plugin false opens nothing', async () => {
    const { world, deps } = worldOn('darwin', layout())
    const door = await pluginDoor(deps)
    await plugin(world, true)
    // A standby open, and the stream told it can take a line once it has opened: the devices write their state.
    expect(door.opened.map(({ message, lines }) => ({ message, lines }))).toEqual([{ message: { type: 'dial', standby: true }, lines: [{ attached: false }] }])
    expect(door.dial.isOpen()).toBe(true)
    await plugin(world, false)
    expect([door.dial.isOpen(), door.opened[0]!.stream.ended.reason]).toEqual([false, 'gone'])

    const none = worldOn('darwin', layout({ world: { orca: { plugin: false } } }))
    const nothing = await pluginDoor(none.deps)
    await plugin(none.world, true)
    await plugin(none.world, false)
    expect([nothing.opened, nothing.dial.isOpen()]).toEqual([[], false])
  })

  it("orca.front sends the worktree's open handles in layout order on orcaFront", async () => {
    const { world, deps } = worldOn('darwin', layout())
    const door = await pluginDoor(deps)
    await started(world, ['b', 'd', 'c', 'a'])
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w2', 'w1'] })
    await plugin(world, true)
    await front(world, 'w1')
    await front(world, 'w2')
    // e never started: its pane is not open.
    expect(door.fronts).toEqual([[orcaTerminalHandle('a'), orcaTerminalHandle('c'), orcaTerminalHandle('b')], [orcaTerminalHandle('d')]])
  })

  it("the worktree on screen is told again as a pane of it opens or closes, before the agent's start hook; another worktree's pane, a rename and a stream opened again tell nothing", async () => {
    const { world, deps } = worldOn('darwin', layout())
    const door = await pluginDoor(deps)
    // What the plugin had told as each start hook came.
    const atStart: Array<readonly string[] | null | undefined> = []
    const port = world.ports.devices!
    world.ports.devices = { ...port, observed: (event) => {
      if (event.event === 'session-start') atStart.push(door.fronts.at(-1))
      return port.observed(event)
    } }
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1', 'w2'] })
    await plugin(world, true)
    // Told before its agents start: none of its terminals is open yet.
    await front(world, 'w1')
    await started(world, ['a', 'd', 'c'])
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1', 'w2'], renamed: { a: 'Eval Renamed' } })
    await orcaModelSteps['orca.close'](world, { kind: 'orca.close', session: 'c' })
    await sessionsSteps.hook(world, { kind: 'hook', session: 'a', event: 'end' })
    // The plugin's next stream, as after Orca's relaunch, knows no worktree until the next front.
    await plugin(world, false)
    await plugin(world, true)
    await started(world, ['e'])
    const [a, c] = [orcaTerminalHandle('a'), orcaTerminalHandle('c')]
    expect(door.fronts).toEqual([[], [a], [a, c], [a], []])
    expect(atStart).toEqual([[a], [a], [a, c], []])
  })

  it('a layout without the worktree on screen tells it again with no terminals: its panes went with it', async () => {
    const { world, deps } = worldOn('darwin', layout())
    const door = await pluginDoor(deps)
    await started(world, ['a', 'd'])
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1', 'w2'] })
    await plugin(world, true)
    await front(world, 'w2')
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1'] })
    expect(door.fronts).toEqual([[orcaTerminalHandle('d')], []])
    // A front the scenario names, though, must be laid out.
    await expect(front(world, 'w2')).rejects.toThrow(/w2, which Orca has not laid out/)
  })

  it('a front with no stream open throws', async () => {
    const { world, deps } = worldOn('darwin', layout())
    const door = await pluginDoor(deps)
    await started(world, ['a'])
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1'] })
    await expect(front(world, 'w1')).rejects.toThrow(/orcaFront/)
    await plugin(world, true)
    await plugin(world, false)
    await expect(front(world, 'w1')).rejects.toThrow(/orcaFront/)
    expect(door.fronts).toEqual([])
  })

  it('terminal list lays out a tab two tmux sessions share as one terminal, with the engine of the pane tmux shows there; '
    + 'orca.focus of either tells that handle, and the front lists it once', async () => {
    // a in w1's tab 0; c and d under one tmux in tab 1, its splits 0 and 1, d a Codex; e under a tmux of its own in tab 2.
    const { world, deps } = worldOn('darwin', layout({ sessions: [orcaSession('a'), orcaSession('c', { tmux: true, tab: 1 }),
      orcaSession('d', { tmux: true, tab: 1, split: 1, engine: 'codex' }), orcaSession('e', { tmux: true, tab: 2 }), orcaGhost] }))
    const reads = createOrcaReads(deps.orca!)
    const door = await pluginDoor(deps)
    // c starts first, so its pane is the one tmux shows.
    await started(world, ['c', 'd', 'a', 'e'])
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1'] })
    const [a, c, e] = ['a', 'c', 'e'].map(orcaTerminalHandle)
    const listed = await reads.orcaTabs()
    expect(listed!.tabs.map((t) => t.handle)).toEqual([a, c, e])
    expect(listed!.terminals.map((t) => [t.handle, t.agentIdentity])).toEqual([[a, 'claude'], [c, 'claude'], [e, 'claude']])
    await tmuxSteps['tmux.selectPane'](world, { kind: 'tmux.selectPane', session: 'd' })
    expect((await reads.orcaTabs())!.terminals.map((t) => [t.handle, t.agentIdentity])).toEqual([[a, 'claude'], [c, 'codex'], [e, 'claude']])
    const heard: Array<string | null> = []
    reads.watchOrcaFocus((handle) => { heard.push(handle) })
    for (const session of ['d', 'a', 'c']) await orcaModelSteps['orca.focus'](world, { kind: 'orca.focus', session })
    await landed()
    expect(heard).toEqual([c, a, c])
    await plugin(world, true)
    await front(world, 'w1')
    expect(door.fronts).toEqual([[a, c, e]])
  })

  it('orca.close takes the pane out of the list', async () => {
    const { world, deps } = worldOn('darwin', layout())
    const reads = createOrcaReads(deps.orca!)
    await started(world, ['a', 'c'])
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1'] })
    await orcaModelSteps['orca.close'](world, { kind: 'orca.close', session: 'c' })
    expect((await reads.orcaTabs())!.terminals.map((t) => t.handle)).toEqual([orcaTerminalHandle('a')])
  })

  it("Orca's quit ends each watch and the plugin's stream; its relaunch opens the stream again", async () => {
    const { world, deps } = worldOn('darwin', layout())
    const door = await pluginDoor(deps)
    const reads = createOrcaReads(deps.orca!)
    await started(world, ['a'])
    await plugin(world, true)
    const gone: number[] = []
    for (const n of [1, 2]) void reads.watchOrcaFocus(() => {}).ended.then(() => { gone.push(n) })
    closeOrca(world)
    await landed()
    expect(gone.sort()).toEqual([1, 2])
    expect([door.dial.isOpen(), door.opened[0]!.stream.ended.reason]).toEqual([false, 'gone'])
    reopenOrca(world)
    expect([door.dial.isOpen(), door.opened.length]).toEqual([true, 2])
    // An Orca quit with the stream closed comes back with it closed.
    await plugin(world, false)
    closeOrca(world)
    reopenOrca(world)
    expect([door.dial.isOpen(), door.opened.length]).toEqual([false, 2])
  })

  it("a switch's echo still to come as Orca quits is never told: its pane went with Orca", async () => {
    const { world, deps } = worldOn('darwin', layout())
    await started(world, ['a', 'b'])
    const reads = createOrcaReads(deps.orca!)
    expect(await createOrcaAdapter(deps.orca!).show({ adapter: 'orca', id: orcaTerminalHandle('b') }, 'eval-agent')).toBe('ok')
    vi.advanceTimersByTime(ORCA_ECHO_MS - 1)
    closeOrca(world)
    reopenOrca(world)
    const heard: Array<string | null> = []
    reads.watchOrcaFocus((handle) => { heard.push(handle) })
    vi.advanceTimersByTime(ORCA_ECHO_MS)
    await landed()
    expect(heard).toEqual([])
  })

  it("agent --help lists list, and agent list answers each chat of the scenario in Orca's envelope, in the order declared, "
    + 'from Orca\'s start on, resting or live, and no pane\'s agent', async () => {
    const { deps } = worldOn('darwin', chats())
    expect(await deps.orca!.run(orcaBinary(deps.orca!)!, ['agent', '--help'], 5_000)).toEqual({ code: 0, stdout: 'Commands:\n  list\n' })
    // No layout yet: Orca's chats were there before the scenario began.
    const answer = await answered(deps, ['agent', 'list', '--json'])
    const row = (key: SessionKey, agent: string, worktree: string, title: string) => ({ orcaSessionId: `eval-orca-${key}`, kind: 'chat',
      agent, state: 'done', worktreeId: orcaWorktreeId(worktree), workspace: `eval-${worktree}`, repo: 'eval-repo', hostId: 'local',
      paneKey: expect.stringMatching(/^00000000-0000-4000-8f00-[0-9a-f]{12}$/), title, lastAssistantMessage: '', updatedAt: Date.now() })
    expect(answer).toEqual({ id: 'eval', ok: true, result: {
      agents: [row('c', 'claude', 'w1', 'Eval Charlie'), row('d', 'claude', 'w2', 'Eval Delta'), row('e', 'codex', 'w2', 'Eval Echo')],
      truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } }, _meta: { runtimeId: 'eval' } })
    // The devices' own read lists them so: a resting chat by its Orca session, a live one its hook named by its Claude
    // Code's, each in its worktree's folder and by its title.
    const d = chats().sessions[2]!
    const { source, read } = chatSource(deps, new Map([['eval-orca-d', { engine: 'claude', sessionId: d.id }]]))
    await read()
    expect(source.list().map(({ id, name, cwd, engine }) => [id, name, cwd, engine])).toEqual([
      [observedAgentId('orca', 'eval-orca-c'), 'Eval Charlie', '/work/eval-w1', 'claude'],
      [agentIdOf(d), 'Eval Delta', '/work/eval-w2', 'claude'],
      [observedAgentId('orca', 'eval-orca-e'), 'Eval Echo', '/work/eval-w2', 'codex'],
    ])
    expect(source.order()).toEqual(chats().sessions.slice(1, 4).map(agentIdOf))
    // A scenario with no chat has none.
    expect((await answered(worldOn('darwin', layout()).deps, ['agent', 'list', '--json'])).result).toMatchObject({ agents: [] })
  })

  it("worktree list answers the layout's worktrees, each with an identity unless the world gives it none, and the plugin "
    + 'names the worktree on screen by that identity, else by its id, which the devices map to the chats\' worktree', async () => {
    const { world, deps } = worldOn('darwin', chats({ world: { orca: { noIdentity: ['w2'] } } }))
    const door = await pluginDoor(deps)
    await started(world, ['a', 'd'])
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1', 'w2'] })
    await plugin(world, true)
    await front(world, 'w1')
    await front(world, 'w2')
    const [w1, w2] = door.workspaces
    expect(w1).toMatch(/^identity:wt2:local:00000000-0000-4000-8e00-[0-9a-f]{12}$/)
    expect(w2).toBe(orcaWorktreeId('w2'))
    expect(await answered(deps, ['worktree', 'list', '--json'])).toEqual({ id: 'eval', ok: true, result: {
      worktrees: [{ id: orcaWorktreeId('w1'), identity: { key: w1!.slice('identity:'.length) } }, { id: orcaWorktreeId('w2') }],
      hostScope: { hostIds: ['local'], omittedHostIds: [] }, totalCount: 2, truncated: false }, _meta: { runtimeId: 'eval' } })
    const { source, read } = chatSource(deps)
    await read({ worktrees: true })
    expect(source.worktreeFor(w1!)).toBe(orcaWorktreeId('w1'))
    // Each worktree with an identity has its own.
    const both = worldOn('darwin', chats())
    const told = await pluginDoor(both.deps)
    await orcaModelSteps['orca.layout'](both.world, { kind: 'orca.layout', worktrees: ['w1', 'w2'] })
    await plugin(both.world, true)
    await front(both.world, 'w1')
    await front(both.world, 'w2')
    const { source: other, read: readOther } = chatSource(both.deps)
    await readOther({ worktrees: true })
    expect(told.workspaces.map((w) => other.worktreeFor(w!))).toEqual([orcaWorktreeId('w1'), orcaWorktreeId('w2')])
  })

  it("a chat has no pane: Orca's terminal list, the worktree on screen's terminals and a focus line know none of it", async () => {
    const { world, deps } = worldOn('darwin', chats())
    const door = await pluginDoor(deps)
    await orcaModelSteps['orca.layout'](world, { kind: 'orca.layout', worktrees: ['w1', 'w2'] })
    await plugin(world, true)
    await front(world, 'w2')
    await started(world, ['d', 'a'])
    expect((await createOrcaReads(deps.orca!).orcaTabs())!.terminals.map((t) => t.handle)).toEqual([orcaTerminalHandle('a')])
    // w2 holds d's chat alone: its terminals were none, and they are none still.
    expect(door.fronts).toEqual([[]])
    await expect(orcaModelSteps['orca.focus'](world, { kind: 'orca.focus', session: 'd' })).rejects.toThrow(/d, whose pane is not open/)
  })

  it("a watch after Orca's relaunch prints no focus from before its quit: that terminal went with it", async () => {
    const { world, deps } = worldOn('darwin', layout())
    const reads = createOrcaReads(deps.orca!)
    await started(world, ['a'])
    await orcaModelSteps['orca.focus'](world, { kind: 'orca.focus', session: 'a' })
    closeOrca(world)
    reopenOrca(world)
    const heard: Array<string | null> = []
    reads.watchOrcaFocus((handle) => { heard.push(handle) })
    await landed()
    expect(heard).toEqual([])
  })
})
