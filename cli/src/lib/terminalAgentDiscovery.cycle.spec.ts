/**
 * A pane root whose parent pid names one of its own descendants (#4268). Windows never re-parents a process and
 * reuses pids, so the pid of a root's dead parent can go to a process the root started: the parent-to-children map
 * then has a cycle through the root. The walk down the pane had no end, in the daemon core, on every discovery pass.
 */
import { describe, expect, it } from 'vitest'
import type { ProcessRow } from './processTable.js'
import { discoverTerminalAgentsFromSnapshot } from './terminalAgentDiscovery.js'
import { terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRootObservation } from './terminalTypes.js'

const row = (pid: number, parentPid: number, executable: string): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: `w:${pid}`, args: executable })
const id = (process: ProcessRow) => ({ pid: process.pid, executable: process.executable, startMarker: process.startMarker })
const pane = (paneId: string, rootPid: number): TerminalRootObservation =>
  ({ runtime: { backend: 'ptyhost', instance: 'default', paneId }, rootPid, cwd: 'C:\\work' })

/**
 * [process], throwing once its command line was read 10,000 times: one visit reads it 55 times (each engine's match).
 * A walk with no end is synchronous, so it would hold the runner's own timeout too and the test would never fail.
 */
function counted(process: ProcessRow): ProcessRow {
  let reads = 0
  return Object.defineProperty({ ...process }, 'args', {
    enumerable: true,
    get: () => {
      if (++reads > 10_000) throw new Error(`pid ${process.pid} was read ${reads} times: the walk does not end`)
      return process.args
    },
  })
}

const ROOT = row(10, 1, 'cmd.exe')
const SHELL = row(11, 10, 'powershell.exe')
const CLAUDE = row(12, 11, 'claude.exe')
/** What discovery finds for [roots] when the table says the root's parent is [rootParent]. */
const discover = (roots: TerminalRootObservation[], rootParent: number) =>
  discoverTerminalAgentsFromSnapshot(roots, [counted({ ...ROOT, parentPid: rootParent }), SHELL, CLAUDE], 999, ['ptyhost'])
const listed = (found: ReturnType<typeof discover>, paneId: string) =>
  found.paneProcesses.get(terminalPlacementKey(pane(paneId, 0).runtime))?.map((process) => process.pid)

describe('a pane root whose parent pid names one of its own descendants', () => {
  it.each([
    ['its child', SHELL.pid],
    ['the engine below', CLAUDE.pid],
  ])('holds what it holds without the cycle: %s', (_name, rootParent) => {
    const cycle = discover([pane('p1', 10)], rootParent)
    const plain = discover([pane('p1', 10)], ROOT.parentPid)
    expect(cycle.agents.map((agent) => agent.processIdentity.pid)).toEqual([CLAUDE.pid])
    expect(cycle.agents).toEqual(plain.agents)
    expect(cycle.ambiguousPlacements).toEqual(plain.ambiguousPlacements)
    // #4266's lists: each process of the pane once, and the engine's parents up to the root, each once.
    expect(listed(cycle, 'p1')).toEqual([10, 11, 12])
    expect(cycle.agents[0].formerProcesses).toEqual([id(SHELL), id(ROOT)])
  })

  it('names each parent once for an engine two panes on the cycle see, the nearer pane first', () => {
    const found = discover([pane('p1', 10), pane('p2', 11)], SHELL.pid)
    expect(found.agents).toHaveLength(1)
    expect(found.agents[0].primaryRuntimeKey).toBe(terminalRouteKey(pane('p2', 11).runtime))
    expect(found.agents[0].formerProcesses).toEqual([id(SHELL), id(ROOT)])
    expect(listed(found, 'p1')).toEqual([10, 11, 12])
    // The inner pane's root is the shell, and the table says the outer root is its child.
    expect(listed(found, 'p2')).toEqual([11, 10, 12])
  })
})
