import { describe, expect, it } from 'vitest'
import type { ProcessRow } from './tmux.js'
import { discoverTerminalAgentsFromSnapshot } from './terminalAgentDiscovery.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRootObservation } from './terminalTypes.js'

const start = 'Sat Aug 15 10:00:00 2026'
const shell = (pid: number, parentPid: number): ProcessRow => ({ pid, parentPid, executable: 'bash', startMarker: start, args: 'bash' })
const claude = (pid: number, parentPid: number): ProcessRow => ({ pid, parentPid, executable: 'claude', startMarker: start, args: 'claude' })

const tmux: TerminalRootObservation = {
  runtime: { backend: 'tmux', paneId: '%1' }, rootPid: 10, cwd: '/work',
}
const nested: TerminalRootObservation = {
  runtime: { backend: 'tmux', paneId: '%2' }, rootPid: 20, cwd: '/work',
}

describe('process discovery', () => {
  it('ignores the startup help probe and discovers only the subsequent Codex resume', () => {
    const probe: ProcessRow = {
      pid: 30, parentPid: 20, executable: 'node', startMarker: start,
      args: 'node /opt/node_modules/@openai/codex/bin/codex.js --help',
    }
    const snapshot = (engine: ProcessRow) => discoverTerminalAgentsFromSnapshot(
      [tmux], [shell(10, 1), shell(20, 10), engine], 999, ['tmux'],
    )
    expect(snapshot(probe).agents).toEqual([])
    const live = snapshot({ ...probe, pid: 31,
      args: 'node /opt/node_modules/@openai/codex/bin/codex.js --no-daemon resume 01234567-89ab-cdef-0123-456789abcdef',
    })
    expect(live.agents).toHaveLength(1)
    expect(live.agents[0]).toMatchObject({
      engine: 'codex', processIdentity: { pid: 31 },
      resumeSessionId: '01234567-89ab-cdef-0123-456789abcdef',
    })
  })

  it('deduplicates nested roots by engine PID and start marker', () => {
    const result = discoverTerminalAgentsFromSnapshot(
      [tmux, nested],
      [shell(10, 1), shell(20, 10), claude(30, 20)],
      999,
      ['tmux'],
    )
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].runtimes).toHaveLength(2)
    expect(result.agents[0].primaryRuntimeKey).toBe(terminalRouteKey(nested.runtime))
  })

  it('chooses the nearest root as primary', () => {
    const result = discoverTerminalAgentsFromSnapshot(
      [tmux, nested],
      [shell(20, 1), shell(25, 20), shell(10, 25), claude(30, 10)],
      999,
      ['tmux'],
    )
    expect(result.agents[0].primaryRuntimeKey).toBe(terminalRouteKey(tmux.runtime))
  })

  it('keeps independent, nested, ambiguous and daemon-owned panes separate in one scan', () => {
    const root = (pid: number): TerminalRootObservation => ({
      runtime: { backend: 'tmux', paneId: `%${pid}` }, rootPid: pid, cwd: `/work/${pid}`,
    })
    const result = discoverTerminalAgentsFromSnapshot(
      [root(10), root(20), root(21), root(30), root(40)],
      [
        shell(10, 1), claude(11, 10),
        shell(20, 1), shell(21, 20), claude(22, 21),
        shell(30, 1), shell(999, 30), claude(1000, 999),
        shell(40, 1), claude(41, 40), claude(42, 40),
      ],
      999,
      ['tmux'],
    )

    expect(result.agents.map(agent => ({
      pid: agent.processIdentity.pid,
      cwd: agent.cwd,
      runtimes: agent.runtimes,
    }))).toEqual([
      { pid: 11, cwd: '/work/10', runtimes: [root(10).runtime] },
      { pid: 22, cwd: '/work/21', runtimes: [root(21).runtime, root(20).runtime] },
    ])
    expect(result.ambiguousPlacements).toEqual(new Set([terminalRouteKey(root(40).runtime)]))
  })

  it('sees exits and reused PIDs on the next snapshot', () => {
    const roots = [tmux, nested]
    const before = discoverTerminalAgentsFromSnapshot(
      roots, [shell(10, 1), claude(11, 10), shell(20, 1), claude(21, 20)], 999, ['tmux'],
    )
    const replacement: ProcessRow = {
      pid: 11, parentPid: 20, executable: 'codex', args: 'codex', startMarker: 'Sat Aug 15 11:00:00 2026',
    }
    const after = discoverTerminalAgentsFromSnapshot(
      roots, [shell(10, 1), shell(20, 1), replacement], 999, ['tmux'],
    )

    expect(before.agents.map(agent => agent.processIdentity.pid)).toEqual([11, 21])
    expect(after.agents).toHaveLength(1)
    expect(after.agents[0]).toMatchObject({
      engine: 'codex',
      processIdentity: { pid: 11, startMarker: replacement.startMarker },
      runtimes: [nested.runtime],
    })
  })
})
