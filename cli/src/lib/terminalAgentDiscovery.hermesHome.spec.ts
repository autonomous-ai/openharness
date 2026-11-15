import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { HERMES_HELD_STORE } from '../engines/hermes/contract.js'
import type { ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { ProcessIdentity } from './terminalTypes.js'

/**
 * The Hermes home rides the live discovery path through eager process facts: the store its process holds open.
 * `engines/identities.hermes.spec.ts` pins what is made of that store, and `processHeldFiles.spec.ts` how it is
 * found; this pins when it is asked, and when the home is marked.
 */
const processRows = vi.hoisted(() => vi.fn())
const heldHome = vi.hoisted(() => vi.fn())
vi.mock('./gridAssignment.js', () => ({ probeGridAssignment: vi.fn(async () => null) }))
vi.mock('./processHeldFiles.js', async (real) => ({ ...await real<object>(), heldHome }))
const processView = vi.hoisted(() => vi.fn())
vi.mock('./processMounts.js', async (real) => ({ ...await real<object>(), processView }))
vi.mock('./processTable.js', async (real) => ({ ...await real<typeof import('./processTable.js')>(), processRows, enrichProcessRows: vi.fn(async (rows: unknown) => rows) }))
vi.mock('../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})

const { loadEngine } = await import('../engines/inProcess.js')
const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Thu Oct  8 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow => ({ pid, parentPid, executable, startMarker: START, args })
const backend = {
  name: 'tmux', instanceId: 'tmux',
  inventory: async () => ({ state: 'available', roots: [{ runtime: { backend: 'tmux', paneId: '%1' }, rootPid: 10, cwd: '/work' }, { runtime: { backend: 'tmux', paneId: '%2' }, rootPid: 20, cwd: '/work' }] }),
} as unknown as TerminalBackend
const agents = async () => Object.fromEntries((await probeTerminalAgents([backend], ['tmux'], 999)).agents.map((agent) => [agent.engine, agent]))
const homes = async () => Object.fromEntries(Object.entries(await agents()).map(([engine, agent]) => [engine, agent.hermesHome]))

beforeEach(() => {
  vi.mocked(loadEngine).mockClear()
  processRows.mockResolvedValue([row(10, 1, 'zsh'), row(11, 10, 'python3', '/opt/hermes-agent/hermes'), row(20, 1, 'zsh'), row(21, 20, 'claude')])
  heldHome.mockReset().mockResolvedValue('/home/u/.hermes/profiles/work')
  processView.mockReset().mockResolvedValue({ state: 'same' })
})

describe('Hermes\'s home on the live terminal discovery path', () => {
  it('is read without the optional engine loader', async () => {
    expect(await homes()).toEqual({ hermes: '/home/u/.hermes/profiles/work', claude: null })
    expect(loadEngine).not.toHaveBeenCalled()
    // The Hermes's own selected process, the store's pattern, and a way to name its engine children: no other.
    expect(heldHome.mock.calls.map(([identity, file, children]) => [(identity as ProcessIdentity).pid, file, typeof children]))
      .toEqual([[11, HERMES_HELD_STORE, 'function']])
    expect(heldHome.mock.calls[0]![0]).toMatchObject({ startMarker: START })
  })

  it('still discovers the home when Hermes interpretation cannot load', async () => {
    vi.mocked(loadEngine).mockImplementationOnce(() => new Promise(() => {}))
    expect(await homes()).toEqual({ hermes: '/home/u/.hermes/profiles/work', claude: null })
    expect(loadEngine).not.toHaveBeenCalled()
  })

  it('finds the home of a Hermes that only has a HOME of its own', async () => {
    heldHome.mockResolvedValue('/sandbox/agent/.hermes')
    expect(await homes()).toEqual({ hermes: '/sandbox/agent/.hermes', claude: null })
  })

  it('preserves an unknown home when the process holds no store, or its files cannot be listed', async () => {
    heldHome.mockResolvedValue(undefined)
    expect(await homes()).toEqual({ hermes: undefined, claude: null })
  })

  it('gives a sandboxed Hermes the daemon\'s path of its folder, and keeps the one it names', async () => {
    heldHome.mockResolvedValue('/data/agents/a1/.hermes')
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.replace(/^\/work/, '/data/work/p1') })
    const { hermes, claude } = await agents()
    expect(hermes).toMatchObject({ cwd: '/data/work/p1', sandbox: { cwd: '/work' }, hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true })
    expect(claude.cwd).toBe('/work')
    expect(claude).not.toHaveProperty('sandbox')
    expect(claude).not.toHaveProperty('hermesHomeDerived')
  })

  it('marks a sandbox it cannot see and leaves the pane\'s folder', async () => {
    heldHome.mockResolvedValue(undefined)
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: () => null })
    const { hermes } = await agents()
    expect(hermes).toMatchObject({ cwd: '/work', sandbox: 'unseen', hermesHome: undefined })
    expect(hermes).not.toHaveProperty('hermesHomeDerived')
  })

  it('leaves a home found outside a sandbox unmarked, so a relaunch names it', async () => {
    heldHome.mockResolvedValue('/x')                         // HERMES_HOME=/x hermes, typed by hand
    processView.mockResolvedValue({ state: 'same' })
    const { hermes } = await agents()
    expect(hermes.hermesHome).toBe('/x')
    expect(hermes).not.toHaveProperty('hermesHomeDerived')
    expect(hermes).not.toHaveProperty('sandbox')
  })

  it('marks a home found in a sandbox, whether or not its folder has a path here', async () => {
    heldHome.mockResolvedValue('/data/agents/a1/.hermes')    // the daemon's path, as heldHome maps it
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.replace(/^\/work/, '/data/work/p1') })
    expect((await agents()).hermes).toMatchObject({ cwd: '/data/work/p1', sandbox: { cwd: '/work' }, hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true })
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: () => null })
    expect((await agents()).hermes).toMatchObject({ cwd: '/work', sandbox: 'unseen', hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true })
  })

  it('marks nothing with no home, in a sandbox too', async () => {
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p })
    for (const held of [env.HERMES_HOME, undefined]) {
      heldHome.mockResolvedValue(held)
      const { hermes, claude } = await agents()
      expect(hermes.hermesHome).toBe(held === undefined ? undefined : null)
      expect(hermes).not.toHaveProperty('hermesHomeDerived')
      expect(claude).not.toHaveProperty('hermesHomeDerived')
    }
  })

  it('is not asked of a pane with no Hermes in it', async () => {
    processRows.mockResolvedValue([row(20, 1, 'zsh'), row(21, 20, 'claude')])
    expect(await homes()).toEqual({ claude: null })
    expect(loadEngine).not.toHaveBeenCalled()
    expect(processView).not.toHaveBeenCalled()
    expect(heldHome).not.toHaveBeenCalled()
  })
})
