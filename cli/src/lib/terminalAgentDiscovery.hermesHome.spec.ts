import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'

/**
 * The Hermes home rides the live discovery path through eager process facts.
 * `engines/otherAdmission.golden.spec.ts` pins what it reads; this pins when it is asked.
 */
const processRows = vi.hoisted(() => vi.fn())
const readProcessEnv = vi.hoisted(() => vi.fn())
vi.mock('./gatewayRuntime.js', () => ({ probeGatewayRuntime: vi.fn(async () => ({ kind: null })) }))
vi.mock('./gridAssignment.js', () => ({ probeGridAssignment: vi.fn(async () => null) }))
vi.mock('./processEnv.js', async (real) => ({ ...await real<object>(), readProcessEnv }))
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
  readProcessEnv.mockResolvedValue({ HERMES_HOME: '/home/u/.hermes/profiles/work' })
  processView.mockReset().mockResolvedValue({ state: 'same' })
})

describe('Hermes\'s home on the live terminal discovery path', () => {
  it('is read without the optional engine loader', async () => {
    expect(await homes()).toEqual({ hermes: '/home/u/.hermes/profiles/work', claude: null })
    expect(loadEngine).not.toHaveBeenCalled()
  })

  it('still discovers the home when Hermes interpretation cannot load', async () => {
    vi.mocked(loadEngine).mockImplementationOnce(() => new Promise(() => {}))
    expect(await homes()).toEqual({ hermes: '/home/u/.hermes/profiles/work', claude: null })
    expect(loadEngine).not.toHaveBeenCalled()
  })

  it('finds the home of a Hermes that only has a HOME of its own', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/sandbox/agent' })
    expect(await homes()).toEqual({ hermes: '/sandbox/agent/.hermes', claude: null })
  })

  it('preserves an unknown home when the process environment cannot be read', async () => {
    readProcessEnv.mockResolvedValue(null)
    expect(await homes()).toEqual({ hermes: undefined, claude: null })
  })

  it('gives a sandboxed Hermes the daemon\'s path of its folder, and keeps the one it names', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/home/agent' })
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.replace('/home/agent', '/data/agents/a1').replace(/^\/work/, '/data/work/p1') })
    const { hermes, claude } = await agents()
    expect(hermes).toMatchObject({ cwd: '/data/work/p1', sandbox: { cwd: '/work' }, hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true })
    expect(claude.cwd).toBe('/work')
    expect(claude).not.toHaveProperty('sandbox')
    expect(claude).not.toHaveProperty('hermesHomeDerived')
  })

  it('marks a sandbox it cannot see and leaves the pane\'s folder', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/home/agent' })
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: () => null })
    const { hermes } = await agents()
    expect(hermes).toMatchObject({ cwd: '/work', sandbox: 'unseen', hermesHome: undefined })
    expect(hermes).not.toHaveProperty('hermesHomeDerived')
  })

  it('marks a home worked out from HOME, and not a profile the process named', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/sandbox/agent' })
    expect((await agents()).hermes).toMatchObject({ hermesHome: '/sandbox/agent/.hermes', hermesHomeDerived: true })
    readProcessEnv.mockResolvedValue({ HOME: '/h', HERMES_HOME: '/h/.hermes/profiles/work' })
    const { hermes } = await agents()
    expect(hermes.hermesHome).toBe('/h/.hermes/profiles/work')
    expect(hermes).not.toHaveProperty('hermesHomeDerived')
    expect(hermes).not.toHaveProperty('sandbox')
  })

  it('is not asked of a pane with no Hermes in it', async () => {
    processRows.mockResolvedValue([row(20, 1, 'zsh'), row(21, 20, 'claude')])
    expect(await homes()).toEqual({ claude: null })
    expect(loadEngine).not.toHaveBeenCalled()
    expect(processView).not.toHaveBeenCalled()
  })
})
