// Tier A's model of Orca (orca.ts) on a world whose devices are not started: what Orca's CLI answers the devices' own
// reads and actions of it (cable/hosts/orca.ts), where the devices find it, and what a focus watch prints. Every folder is
// a temp one, on virtual time; nothing runs.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrcaAdapter, createOrcaReads } from '../../../../cable/hosts/orca.js'
import type { CorePorts } from '../../../../core/api.js'
import { orcaBinary, readOrcaHomes } from '../../../../devices/orcaHomes.js'
import type { DevicesDeps, startDevices } from '../../../../services/devices.js'
import { orcaGhost, orcaSession, scenario } from '../../catalog.js'
import { orcaTerminalHandle, orcaWorktreeId, type Platform, type Scenario, type SessionKey } from '../../types.js'
import { installClock } from '../clock.js'
import { machine } from '../machine.js'
import { World } from '../world.js'
import { answerOrca, orcaModelSteps } from './orca.js'
import { sessionsSteps } from './sessions.js'

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
    // Orca's account homes, should anything ask: none.
    const homes = await readOrcaHomes({ ...deps.orca!, uid: 1,
      run: async (file, args) => ({ ...await deps.orca!.run(file, args, 1_000), timedOut: false }) })
    expect(homes).toEqual({ homes: { claude: [], codex: [] } })
  })

  it('the CLI is found at the model\'s path on each platform, its accept never called, and exists true for HARNESS_ORCA_APP_BIN alone', () => {
    const onPath: Readonly<Record<Platform, string | undefined>> = {
      darwin: undefined,
      linux: '/opt/eval/orca/resources/bin/orca-ide',
      win32: 'C:\\Users\\eval\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe',
    }
    for (const platform of PLATFORMS) {
      const { deps } = worldOn(platform, layout())
      const app = process.env.HARNESS_ORCA_APP_BIN!
      // The world's own made-up app, inside its temp folder: never this machine's Orca.
      expect(app.startsWith(tmpdir())).toBe(true)
      expect(app.endsWith(join('Orca.app', 'Contents', 'Resources', 'bin', 'orca'))).toBe(true)
      expect(orcaBinary(deps.orca!), platform).toBe(onPath[platform] ?? app)
      // The accept reads the real disk: the model's PATH never asks it.
      const accept = vi.fn(() => true)
      for (const name of ['orca', 'orca-ide']) deps.orca!.onPath(name, accept)
      expect(accept).not.toHaveBeenCalled()
      expect([deps.orca!.exists(app), deps.orca!.exists('/Applications/Orca.app/Contents/Resources/bin/orca')]).toEqual([true, false])
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
})
