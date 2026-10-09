import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './tmux.js'
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
vi.mock('./tmux.js', async (real) => ({ ...await real<typeof import('./tmux.js')>(), processRows, enrichProcessRows: vi.fn(async (rows: unknown) => rows) }))
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
const homes = async () => {
  const probe = await probeTerminalAgents([backend], ['tmux'], 999)
  return Object.fromEntries(probe.agents.map((agent) => [agent.engine, agent.hermesHome]))
}

beforeEach(() => {
  vi.mocked(loadEngine).mockClear()
  processRows.mockResolvedValue([row(10, 1, 'zsh'), row(11, 10, 'python3', '/opt/hermes-agent/hermes'), row(20, 1, 'zsh'), row(21, 20, 'claude')])
  readProcessEnv.mockResolvedValue({ HERMES_HOME: '/home/u/.hermes/profiles/work' })
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

  it('preserves an unknown home when the process environment cannot be read', async () => {
    readProcessEnv.mockResolvedValue(null)
    expect(await homes()).toEqual({ hermes: undefined, claude: null })
  })

  it('is not asked of a pane with no Hermes in it', async () => {
    processRows.mockResolvedValue([row(20, 1, 'zsh'), row(21, 20, 'claude')])
    expect(await homes()).toEqual({ claude: null })
    expect(loadEngine).not.toHaveBeenCalled()
  })
})
