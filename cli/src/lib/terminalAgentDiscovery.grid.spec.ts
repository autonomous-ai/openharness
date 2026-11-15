import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'
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

const processRows = vi.hoisted(() => vi.fn())

vi.mock('./processTable.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./processTable.js')>(),
  processRows,
}))

const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Sat Aug 15 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: START, args })

const TMUX_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const SECOND_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%2' }
const ON_GRID = '-c model_providers.grid.base_url="https://grid.example/relay/v1" -m chosen'

function backendWith(name: 'tmux', instanceId: string, roots: TerminalRootObservation[]): TerminalBackend {
  return {
    name,
    instanceId,
    inventory: async () => ({ state: 'available', roots }),
  } as unknown as TerminalBackend
}

/** One pane rooted at pid 10, over [rows]; null for a process table that could not be read. */
function probeOne(rows: ProcessRow[] | null) {
  processRows.mockResolvedValue(rows)
  return probeTerminalAgents([backendWith('tmux', 'tmux', [{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])], ['tmux'], 999)
}

beforeEach(() => {
  processRows.mockReset()
})

describe('grid assignment on the live terminal discovery path', () => {
  it("reports the grid a Codex's command line names, in every pane, and none for an engine whose grid is in no command line", async () => {
    processRows.mockResolvedValue([
      row(10, 1, 'bash'), row(30, 10, 'claude', `claude ${ON_GRID}`),
      row(20, 1, 'bash'), row(40, 20, 'codex', `codex --prompt private ${ON_GRID}`),
    ])

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

    const byEngine = new Map(probe.agents.map((agent) => [agent.engine, agent]))
    expect([...byEngine.keys()].sort()).toEqual(['claude', 'codex'])
    expect(byEngine.get('codex')!.grid).toBeUndefined()
    expect(byEngine.get('codex')!.gridProcess).toEqual({
      key: '', engine: 'codex', args: 'model_providers.grid.base_url="https://grid.example/relay/v1"  -m chosen',
    })
    // Claude Code's grid is in its environment, which is not read: its row keeps the grid its launch recorded.
    expect(byEngine.get('claude')!.gridProcess).toBeUndefined()
    expect(byEngine.get('claude')!.grid).toBeUndefined()
  })

  it('a Claude Code started by hand has no grid to report', async () => {
    const probe = await probeOne([row(10, 1, 'bash'), row(30, 10, 'claude')])
    expect(probe.agents.map((agent) => agent.engine)).toEqual(['claude'])
    expect(probe.agents[0].gridProcess).toBeUndefined()
    expect(probe.agents[0].grid).toBeUndefined()
  })

  it('reports null for a Codex whose command line names no grid', async () => {
    const probe = await probeOne([row(10, 1, 'bash'), row(30, 10, 'codex', 'codex -m gpt-5')])
    expect(probe.agents.map((agent) => agent.engine)).toEqual(['codex'])
    expect(probe.agents[0].grid).toBeNull()
    expect(probe.agents[0].gridProcess).toBeUndefined()
  })

  it("reads a renamed Pi from the launcher's command line, and calls it known only when that names a grid", async () => {
    // Pi renames its process: `ps` shows `pi` with no arguments (2026-10-14), so its launcher's command line is read.
    const launcher = (args: string) => row(10, 1, 'zsh', `/bin/zsh -lic . '/d/launch/1.sh' harness-engine /work /n/bin/pi --session s ${args}`)
    const probe = (rows: ProcessRow[]) => probeOne(rows)
      .then((result) => { expect(result.agents.map((agent) => agent.engine)).toEqual(['pi']); return result.agents[0] })
    const onGrid = await probe([launcher('--model grid/m -e /c/grid-provider.ts'), row(30, 10, 'pi', 'pi       ')])
    expect(onGrid.gridProcess).toEqual({ key: '', engine: 'pi', args: '-e /c/grid-provider.ts --model grid/m' })
    // Nothing naming a grid: a Pi launched before its extension may still be on one, so it stays unknown.
    const unknown = await probe([launcher(''), row(30, 10, 'pi', 'pi       ')])
    expect(unknown.gridProcess).toBeUndefined()
    expect(unknown.grid).toBeUndefined()
  })

  it('does not probe when the process table is unavailable', async () => {
    const probe = await probeOne(null)
    expect(probe.processTableAvailable).toBe(false)
    expect(probe.agents).toEqual([])
  })
})
