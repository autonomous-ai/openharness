import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalRootObservation } from './terminalTypes.js'

/**
 * A daemon at rest has no pane. Every discovery pass (every 5 s) still read the whole machine's
 * process table and walked PATH for every engine's command, which was most of an idle core's CPU
 * (#3880, profiled 2026-11-10). With no pane neither can find anything, so neither is read.
 */

const processRows = vi.hoisted(() => vi.fn())
const agentCommandOwnershipSnapshot = vi.hoisted(() => vi.fn())

vi.mock('./processTable.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./processTable.js')>(),
  processRows,
}))
vi.mock('./engineBin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engineBin.js')>()
  agentCommandOwnershipSnapshot.mockImplementation(actual.agentCommandOwnershipSnapshot)
  return { ...actual, agentCommandOwnershipSnapshot }
})

const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Sat Aug 15 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: START, args: executable })

const backendWith = (roots: TerminalRootObservation[]): TerminalBackend =>
  ({ name: 'tmux', instanceId: 'tmux', inventory: async () => ({ state: 'available', roots }) }) as unknown as TerminalBackend

beforeEach(async () => {
  processRows.mockReset()
  processRows.mockResolvedValue([row(10, 1, 'bash')])
  // A pass that sees no pane, so the next one starts as a daemon at rest does.
  await probeTerminalAgents([backendWith([])], ['tmux'], 999)
  processRows.mockClear()
  agentCommandOwnershipSnapshot.mockClear()
})

describe('a discovery pass with no pane', () => {
  it('reads neither the process table nor the engines on PATH, and finds nothing', async () => {
    const probe = await probeTerminalAgents([backendWith([])], ['tmux'], 999)

    expect(probe).toMatchObject({ processTableAvailable: true, agents: [] })
    expect(processRows).not.toHaveBeenCalled()
    expect(agentCommandOwnershipSnapshot).not.toHaveBeenCalled()
  })

  it('still reads the table beside the panes for a pass someone waits on (an engine starting in a pane)', async () => {
    const probe = await probeTerminalAgents([backendWith([])], ['tmux'], 999, new Map([['tmux:%1', 'claude']]))

    expect(probe.processTableAvailable).toBe(true)
    expect(processRows).toHaveBeenCalledTimes(1)
  })

  it('reads both once a pane is there', async () => {
    await probeTerminalAgents([backendWith([{ runtime: { backend: 'tmux', paneId: '%1' }, rootPid: 10, cwd: '/work' }])], ['tmux'], 999)

    expect(processRows).toHaveBeenCalledTimes(1)
    expect(agentCommandOwnershipSnapshot).toHaveBeenCalledTimes(1)
  })

  it('says the table could not be read when there is a pane and ps failed', async () => {
    processRows.mockResolvedValue(null)
    const probe = await probeTerminalAgents([backendWith([{ runtime: { backend: 'tmux', paneId: '%1' }, rootPid: 10, cwd: '/work' }])], ['tmux'], 999)

    expect(probe.processTableAvailable).toBe(false)
  })
})

describe('a discovery pass after one that saw a pane', () => {
  it('reads the table beside the panes, and stops once a pass has seen none', async () => {
    const pane: TerminalRootObservation = { runtime: { backend: 'tmux', paneId: '%1' }, rootPid: 10, cwd: '/work' }
    let roots: TerminalRootObservation[] = []
    const order: string[] = []
    const backend = { name: 'tmux', instanceId: 'tmux', inventory: async () => { order.push('panes'); return { state: 'available', roots } } } as unknown as TerminalBackend
    processRows.mockImplementation(async () => { order.push('ps'); return [row(10, 1, 'bash')] })
    const pass = async (now: TerminalRootObservation[]) => { roots = now; order.length = 0; await probeTerminalAgents([backend], ['tmux'], 999); return [...order] }

    await pass([])
    expect(await pass([pane]), 'the first pane: listed, then read under').toEqual(['panes', 'ps'])
    expect(await pass([pane]), 'while there are panes: read beside them').toEqual(['ps', 'panes'])
    expect(await pass([]), 'the pass that finds them gone').toEqual(['ps', 'panes'])
    expect(await pass([]), 'at rest again').toEqual(['panes'])
  })
})
