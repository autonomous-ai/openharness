import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './tmux.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalRootObservation, TerminalRuntimeRef } from './terminalTypes.js'

/**
 * The grid an agent is on has to ride the LIVE discovery path, exactly like `gateway` before it.
 *
 * This repo has already paid for this once: a probe wired onto `probeTmuxAgents` kept its own tests
 * green while the reconciler had moved to `probeTerminalAgents`, and every agent silently arrived
 * with the field undefined (see `terminalAgentDiscovery.gateway.spec.ts`). Nothing would go red here
 * either — the app would simply believe every agent is on no grid, offer to move ones that are
 * already right, and restart them for nothing. So the wiring is pinned, not the classifier
 * (`gridAssignment.spec.ts` covers that).
 */

const probeGatewayRuntime = vi.hoisted(() => vi.fn())
const readProcessEnv = vi.hoisted(() => vi.fn())
const processRows = vi.hoisted(() => vi.fn())

vi.mock('./gatewayRuntime.js', () => ({ probeGatewayRuntime }))
vi.mock('./processEnv.js', () => ({ readProcessEnv }))
vi.mock('./tmux.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tmux.js')>(),
  processRows,
}))

const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Sat Aug 15 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: START, args })

const TMUX_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const SECOND_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%2' }
const ASSIGNMENT = { baseUrl: 'https://grid.autonomous.ai/grid-3378218621364f16/relay', model: 'GLM-4.7-Flash' }

function backendWith(name: 'tmux', instanceId: string, roots: TerminalRootObservation[]): TerminalBackend {
  return {
    name,
    instanceId,
    inventory: async () => ({ state: 'available', roots }),
  } as unknown as TerminalBackend
}

beforeEach(() => {
  probeGatewayRuntime.mockReset()
  probeGatewayRuntime.mockResolvedValue({ kind: null })
  readProcessEnv.mockReset()
  processRows.mockReset()
})

describe('grid assignment on the live terminal discovery path', () => {
  it('reports the grid for every pane, from the process rather than the pane', async () => {
    processRows.mockResolvedValue([
      row(10, 1, 'bash'), row(30, 10, 'claude'),
      row(20, 1, 'bash'), row(40, 20, 'codex', 'codex -c model_providers.grid.base_url="https://grid.example/relay/v1" -m chosen'),
    ])
    readProcessEnv.mockResolvedValue({ ANTHROPIC_BASE_URL: ASSIGNMENT.baseUrl, ANTHROPIC_MODEL: ASSIGNMENT.model, API_KEY: 'secret' })

    const probe = await probeTerminalAgents(
      [
        backendWith('tmux', 'tmux', [
          { runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' },
          { runtime: SECOND_RUNTIME, rootPid: 20, cwd: '/work' },
        ]),
      ],
      ['tmux'],
      999,
    )

    expect(probe.agents).toHaveLength(2)
    expect(probe.agents.every((agent) => agent.grid === undefined && agent.gridProcess)).toBe(true)
    expect(JSON.stringify(probe.agents.map(a => a.gridProcess))).not.toContain('secret')
    expect(readProcessEnv).toHaveBeenCalled()
    for (const [identity] of readProcessEnv.mock.calls) {
      expect(identity).toMatchObject({ startMarker: START })
    }
  })

  it('reports null for an agent on its own login', async () => {
    processRows.mockResolvedValue([row(10, 1, 'bash'), row(30, 10, 'claude')])
    readProcessEnv.mockResolvedValue({})
    const probe = await probeTerminalAgents(
      [backendWith('tmux', 'tmux', [{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])],
      ['tmux'],
      999,
    )
    expect(probe.agents[0].grid).toBeNull()
  })

  it('does not probe when the process table is unavailable', async () => {
    processRows.mockResolvedValue(null)
    const probe = await probeTerminalAgents(
      [backendWith('tmux', 'tmux', [{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])],
      ['tmux'],
      999,
    )
    expect(probe.processTableAvailable).toBe(false)
    expect(readProcessEnv).not.toHaveBeenCalled()
  })
})
