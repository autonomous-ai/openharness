// Tier A's model of Orca (orca.ts) on a world whose devices are not started: what Orca's CLI answers the devices' own
// reads and actions of it (cable/hosts/orca.ts), where the devices find it, and what a focus watch prints. Every folder is
// a temp one, on virtual time; nothing runs.
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrcaAdapter, createOrcaReads } from '../../../../cable/hosts/orca.js'
import type { CorePorts } from '../../../../core/api.js'
import { orcaBinary, readOrcaHomes } from '../../../../devices/orcaHomes.js'
import type { DevicesDeps, startDevices } from '../../../../services/devices.js'
import { dialStream, orcaFrontHandler, type ListenerStream, type ListenerStreamHandler } from '../../../../services/devicesListener.js'
import { orcaGhost, orcaSession, scenario } from '../../catalog.js'
import { orcaTerminalHandle, orcaWorktreeId, type Platform, type Scenario, type SessionKey } from '../../types.js'
import { installClock } from '../clock.js'
import { machine } from '../machine.js'
import { World } from '../world.js'
import { answerOrca, closeOrca, orcaModelSteps, reopenOrca } from './orca.js'
import { sessionsSteps } from './sessions.js'

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

/** A world on that platform with Orca's answers, as the driver gives it, and the deps it handed the devices, whose
 *  port takes the hooks. */
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
  answerOrca(world)
  return { world, deps: handed! }
}

const started = async (world: World, keys: SessionKey[]): Promise<void> => {
  for (const session of keys) await sessionsSteps.hook(world, { kind: 'hook', session, event: 'start' })
}
/** A child's stdout comes on a later turn. */
const landed = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** The devices' own dial stream and orcaFront handler on the world's listener, as the devices open them: each stream
 *  opened, with what it was told and the stream it was handed, and each front the devices took. */
async function pluginDoor(deps: DevicesDeps) {
  const dial = dialStream({ log: () => {}, after: () => () => {} })
  const opened: Array<{ message: Record<string, unknown>; lines: unknown[]; stream: ListenerStream }> = []
  const fronts: Array<readonly string[] | null> = []
  const handler: ListenerStreamHandler = { ...dial.handler, open: (message, stream) => {
    const lines: unknown[] = []
    opened.push({ message, lines, stream })
    return dial.handler.open(message, { ...stream, write: (line) => { lines.push(line); return stream.write(line) } })
  } }
  await deps.listen!({ dial: handler, orcaFront: orcaFrontHandler(() => dial.isOpen(), (terminals) => { fronts.push(terminals) }) }, () => {})
  return { dial, opened, fronts }
}
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

  it("account list names each Codex agent's own home, an Orca account's, and nothing else, as the devices' Orca homes do", async () => {
    // b is the layout's one Codex with a home of its own; f's is the daemon's, no Orca account's.
    const { world, deps } = worldOn('darwin', layout({ sessions: [...layout().sessions, orcaSession('f', { engine: 'codex', codexHome: undefined, tab: 3 })] }))
    // Started, so its home is there, as an account's is.
    await started(world, ['b', 'f'])
    const home = join(world.folders.codexHomes, 'b')
    const read = await readOrcaHomes({ ...deps.orca!, uid: process.getuid?.() ?? -1,
      run: async (file, args) => ({ ...await deps.orca!.run(file, args, 1_000), timedOut: false }) })
    expect(read).toEqual({ homes: { claude: [], codex: [home] } })
    expect([deps.orcaHomes!.get(), deps.orcaHomes!.answered()]).toEqual([read.homes, true])
  })

  it("the CLI is where each platform's installer puts it, its accept never called: the app's on macOS, orca-ide on Linux's "
    + "PATH, and on Windows under LOCALAPPDATA, which the devices' Orca deps do not carry", () => {
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
      // Orca's installer puts nothing on Windows' PATH: the devices' reads find no CLI there. Its homes' read, which
      // carries LOCALAPPDATA (devices/orcaHomes.ts orcaHomesDeps), finds the install's.
      expect(orcaBinary(deps.orca!), platform).toBe(platform === 'win32' ? null : installed)
      expect(orcaBinary({ ...deps.orca!, localAppData: local }), platform).toBe(installed)
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

  it('a switch is echoed on each running watch 100 ms later', async () => {
    const { world, deps } = worldOn('darwin', layout())
    await started(world, ['a', 'b'])
    const reads = createOrcaReads(deps.orca!)
    const heard: Array<Array<string | null>> = [[], []]
    for (const into of heard) reads.watchOrcaFocus((handle) => { into.push(handle) })
    expect(await createOrcaAdapter(deps.orca!).show({ adapter: 'orca', id: orcaTerminalHandle('b') }, 'eval-agent')).toBe('ok')
    vi.advanceTimersByTime(99)
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
