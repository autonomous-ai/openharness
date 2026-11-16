import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalRootObservation, TerminalRuntimeRef } from './terminalTypes.js'

/**
 * The gateway flag has to ride the LIVE discovery path, not just the tmux-only one it was born on.
 *
 * This is the regression a backend refactor produced for free: `probeTmuxAgents` (since deleted) kept
 * its probe and its tests kept passing, while the reconciler had quietly moved to `probeTerminalAgents`
 * and every agent arrived with `gateway: undefined`. Nothing goes red — an `ori codex` pane just starts offering
 * the native catalog again and accepts `/model` it cannot honour. So the wiring is pinned here, through the
 * real reader of the command line, with no stand-in for it.
 */

const processRows = vi.hoisted(() => vi.fn())

vi.mock('./processTable.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./processTable.js')>(),
  processRows,
}))

const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Sat Aug 15 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: START, args })

const ORI_CODEX = 'codex -c model_provider=openrouter -c model_providers.openrouter.base_url="https://openrouter.ai/api/v1"'

const pane = (paneId: string): TerminalRuntimeRef => ({ backend: 'tmux', paneId })

function backendWith(name: 'tmux', instanceId: string, roots: TerminalRootObservation[]): TerminalBackend {
  return {
    name,
    instanceId,
    inventory: async () => ({ state: 'available', roots }),
  } as unknown as TerminalBackend
}

beforeEach(() => {
  processRows.mockReset()
})

describe('gateway detection on the live terminal discovery path', () => {
  it('marks a Codex whose argv names the provider in every pane, from its command line rather than the pane', async () => {
    processRows.mockResolvedValue([
      row(10, 1, 'bash'), row(30, 10, 'codex', ORI_CODEX),                                  // tmux pane %1
      row(20, 1, 'bash'), row(40, 20, 'codex', 'codex -c model_providers.openrouter.name=OpenRouter'), // tmux pane %2
    ])

    const probe = await probeTerminalAgents(
      [backendWith('tmux', 'tmux', [
        { runtime: pane('%1'), rootPid: 10, cwd: '/work' },
        { runtime: pane('%2'), rootPid: 20, cwd: '/work' },
      ])],
      ['tmux'],
      999,
    )

    expect(probe.agents.map((agent) => agent.engine)).toEqual(['codex', 'codex'])
    expect(probe.agents.map((agent) => agent.gateway)).toEqual(['ori', 'ori'])
  })

  it('says null for a plain Codex, and nothing for a Claude Code, whose gateway only its hook can say', async () => {
    processRows.mockResolvedValue([
      row(10, 1, 'bash'), row(30, 10, 'codex', 'codex -m gpt-5'),  // tmux pane %1
      row(20, 1, 'bash'), row(40, 20, 'claude'),                   // tmux pane %2
    ])

    const probe = await probeTerminalAgents(
      [backendWith('tmux', 'tmux', [
        { runtime: pane('%1'), rootPid: 10, cwd: '/work' },
        { runtime: pane('%2'), rootPid: 20, cwd: '/work' },
      ])],
      ['tmux'],
      999,
    )

    const byEngine = new Map(probe.agents.map((agent) => [agent.engine, agent]))
    expect(byEngine.get('codex')!.gateway).toBeNull()
    expect(byEngine.has('claude')).toBe(true)
    expect(byEngine.get('claude')!.gateway).toBeUndefined()
  })

  // A row keeps a gateway a build that read the environment stored. Nothing says one of a pi, Grok or Kilo, so a pass
  // clears theirs; a Claude Code's is its hook's word, which a pass leaves standing.
  it('clears the gateway a pi, Grok or Kilo row kept, and keeps the one a Claude Code hook said', async () => {
    processRows.mockResolvedValue([
      row(10, 1, 'bash'), row(30, 10, 'pi'),      // tmux pane %1
      row(20, 1, 'bash'), row(40, 20, 'grok'),    // tmux pane %2
      row(50, 1, 'bash'), row(60, 50, 'kilo'),    // tmux pane %3
      row(70, 1, 'bash'), row(80, 70, 'claude'),  // tmux pane %4
    ])
    const probe = await probeTerminalAgents(
      [backendWith('tmux', 'tmux', ([['%1', 10], ['%2', 20], ['%3', 50], ['%4', 70]] as const)
        .map(([paneId, rootPid]) => ({ runtime: pane(paneId), rootPid, cwd: '/work' })))],
      ['tmux'],
      999,
    )
    const directory = mkdtempSync(join(tmpdir(), 'discovery-gateway-'))
    try {
      for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) vi.stubEnv(key, directory)
      vi.resetModules()
      const { registry } = await import('./registry.js')
      registry.load()
      for (const agent of probe.agents) {
        const observed = { engine: agent.engine, runtimes: agent.runtimes, primaryRuntimeKey: agent.primaryRuntimeKey,
          cwd: agent.cwd, processIdentity: agent.processIdentity }
        registry.openProcessAgent({ ...observed, gateway: 'ori' })
        registry.openProcessAgent({ ...observed, gateway: agent.gateway })
      }
      expect(Object.fromEntries(probe.agents.map((agent) => [agent.engine, registry.byProcess(agent.engine, agent.processIdentity)?.gateway])))
        .toEqual({ pi: null, grok: null, kilo: null, claude: 'ori' })
    } finally {
      vi.unstubAllEnvs()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
