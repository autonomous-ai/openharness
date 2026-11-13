/**
 * What the probe says of a pane for an agent whose bound process `exec`ed into another name (#4259): the engine's
 * ancestors inside its pane, root included, are its former processes, and every process in a pane's tree is listed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'
import { terminalPlacementKey } from './terminalRuntime.js'
import type { TerminalRootObservation } from './terminalTypes.js'

const processRows = vi.hoisted(() => vi.fn())
vi.mock('./gatewayRuntime.js', () => ({ probeGatewayRuntime: vi.fn(async () => ({ kind: null })) }))
vi.mock('./processEnv.js', async (real) => ({ ...await real<object>(), readProcessEnv: vi.fn(async () => null) }))
vi.mock('./processMounts.js', async (real) => ({ ...await real<object>(), processView: vi.fn(async () => ({ state: 'same' })) }))
vi.mock('./processTable.js', async (real) => ({ ...await real<typeof import('./processTable.js')>(), processRows, enrichProcessRows: vi.fn(async (rows: unknown) => rows) }))

const { discoverTerminalAgentsFromSnapshot, probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Fri Nov 13 14:22:00 2026'
const LATER = 'Fri Nov 13 15:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable, startMarker = START): ProcessRow =>
  ({ pid, parentPid, executable, startMarker, args })
const id = (process: ProcessRow) => ({ pid: process.pid, executable: process.executable, startMarker: process.startMarker })
const pane = (paneId: string, rootPid: number): TerminalRootObservation => ({ runtime: { backend: 'tmux', paneId }, rootPid, cwd: '/work' })
const probe = (roots: TerminalRootObservation[], rows: ProcessRow[]) => {
  processRows.mockResolvedValue(rows)
  const backend = { name: 'tmux', instanceId: 'tmux:default', inventory: async () => ({ state: 'available', roots }) } as unknown as TerminalBackend
  return probeTerminalAgents([backend], ['tmux'], 999)
}
/** The pids and starts the probe lists for a pane, by pid. */
const listed = (found: Awaited<ReturnType<typeof probe>>, paneId: string) =>
  [...found.paneProcesses?.get(terminalPlacementKey({ backend: 'tmux', paneId })) ?? []]
    .map((process) => [process.pid, process.startMarker]).sort(([a], [b]) => Number(a) - Number(b))

const TMUX = row(5, 1, 'tmux')
const SHELL = row(10, 5, 'zsh', '-zsh')
const UNSHARE = row(11, 10, 'unshare', '/usr/bin/unshare --fork -- /usr/local/bin/hermes-ns')
const HERMES = row(12, 11, 'python3', '/opt/hermes-agent/hermes')
const GATEWAY = row(13, 12, 'python3', 'python3 -m hermes_cli.main gateway run')

describe('the former processes of a pane\'s engine', () => {
  it('are its ancestors inside the pane, root included, and the Hermes gateway under it: nothing outside the pane', async () => {
    const { agents } = await probe([pane('%1', 10)], [TMUX, SHELL, UNSHARE, HERMES, GATEWAY])
    expect(agents.map((agent) => agent.processIdentity.pid)).toEqual([12])
    expect(agents[0].formerProcesses).toEqual([id(UNSHARE), id(SHELL), id(GATEWAY)])
  })

  it('include the root when it is the pane\'s own command', async () => {
    const root = { ...UNSHARE, parentPid: 5 }
    const { agents } = await probe([pane('%1', 11)], [TMUX, root, HERMES])
    expect(agents[0].formerProcesses).toEqual([id(root)])
  })

  it('are none for an engine that is its pane\'s root, and the shell above it for any other engine', async () => {
    const shell = row(20, 5, 'zsh', '-zsh')
    const { agents } = await probe([pane('%1', 12), pane('%2', 20)], [TMUX, { ...HERMES, parentPid: 5 }, shell, row(21, 20, 'claude')])
    const by = Object.fromEntries(agents.map((agent) => [agent.engine, agent]))
    expect(by.hermes).not.toHaveProperty('formerProcesses')
    expect(by.claude.formerProcesses).toEqual([id(shell)])
  })

  it('stop at the last row the table has when the pane\'s root is not in it', async () => {
    const found = await probe([pane('%1', 10)], [TMUX, UNSHARE, HERMES])
    expect(found.agents[0].formerProcesses).toEqual([id(UNSHARE)])
    expect(listed(found, '%1')).toEqual([[11, START], [12, START]])
  })

  it('reach the outer root for an engine two panes see', () => {
    const { agents } = discoverTerminalAgentsFromSnapshot([pane('%1', 10), pane('%2', 20)],
      [SHELL, row(20, 10, 'zsh', '-zsh'), row(30, 20, 'claude')], 999, ['tmux'])
    expect(agents).toHaveLength(1)
    expect(agents[0].formerProcesses?.map((process) => process.pid)).toEqual([20, 10])
  })
})

describe('the processes of a pane', () => {
  it('are every process in its tree, an engine among them or not, and none outside it', async () => {
    const found = await probe([pane('%1', 10), pane('%2', 20)],
      [TMUX, SHELL, UNSHARE, HERMES, row(20, 5, 'zsh', '-zsh'), row(21, 20, 'unshare', 'unshare', LATER), row(30, 1, 'unshare')])
    expect(listed(found, '%1')).toEqual([[10, START], [11, START], [12, START]])
    expect(listed(found, '%2')).toEqual([[20, START], [21, LATER]])
    expect(found.agents.map((agent) => agent.processIdentity.pid)).toEqual([12])
  })
})
