import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './tmux.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalRootObservation, TerminalRuntimeRef } from './terminalTypes.js'

/**
 * The Codex profile a process runs under rides the LIVE discovery path, pinned the same way `grid`
 * is in `terminalAgentDiscovery.grid.spec.ts`: a probe wired on the wrong function stays green while
 * every discovered codex row arrives with `codexHome` undefined — and its transcript then fails
 * validation against the default profile. `engines/kit/processFacts.spec.ts` covers what the probe reads.
 */

const probeGatewayRuntime = vi.hoisted(() => vi.fn())
const probeGridAssignment = vi.hoisted(() => vi.fn())
const probeProfileHome = vi.hoisted(() => vi.fn())
const processRows = vi.hoisted(() => vi.fn())

vi.mock('./gatewayRuntime.js', () => ({ probeGatewayRuntime }))
vi.mock('./gridAssignment.js', () => ({ probeGridAssignment }))
vi.mock('../engines/discoveries.js', async (real) => ({ ...await real<object>(), probeProfileHome }))
vi.mock('./tmux.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tmux.js')>(),
  processRows,
}))

const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Sat Aug 15 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: START, args })

const TMUX_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const OTHER_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%2' }

function backendWith(roots: TerminalRootObservation[]): TerminalBackend {
  return { name: 'tmux', instanceId: 'tmux', inventory: async () => ({ state: 'available', roots }) } as unknown as TerminalBackend
}

beforeEach(() => {
  probeGatewayRuntime.mockReset()
  probeGatewayRuntime.mockResolvedValue({ kind: null })
  probeGridAssignment.mockReset()
  probeGridAssignment.mockResolvedValue(null)
  probeProfileHome.mockReset()
  processRows.mockReset()
})

describe('Codex profile on the live terminal discovery path', () => {
  it('reports the profile off the process, and the probe decides for every engine', async () => {
    processRows.mockResolvedValue([row(10, 1, 'bash'), row(30, 10, 'codex'), row(20, 1, 'bash'), row(40, 20, 'claude')])
    probeProfileHome.mockImplementation(async (_identity: unknown, engine: string) => engine === 'codex' ? '/home/u/.codex-work' : null)
    const probe = await probeTerminalAgents(
      [backendWith([{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }, { runtime: OTHER_RUNTIME, rootPid: 20, cwd: '/work' }])],
      ['tmux'],
      999,
    )
    const byEngine = Object.fromEntries(probe.agents.map((agent) => [agent.engine, agent.codexHome]))
    expect(byEngine).toEqual({ codex: '/home/u/.codex-work', claude: null })
    expect(probeProfileHome).toHaveBeenCalledTimes(2)
    for (const [identity] of probeProfileHome.mock.calls) expect(identity).toMatchObject({ startMarker: START })
  })

  it('passes an unreadable probe through as undefined, so the registry keeps what it knew', async () => {
    processRows.mockResolvedValue([row(10, 1, 'bash'), row(30, 10, 'codex')])
    probeProfileHome.mockResolvedValue(undefined)
    const probe = await probeTerminalAgents([backendWith([{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])], ['tmux'], 999)
    expect(probe.agents[0]).toHaveProperty('codexHome', undefined)
  })
})
