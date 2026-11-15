import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import type { ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { ProcessIdentity, TerminalRootObservation, TerminalRuntimeRef } from './terminalTypes.js'

/**
 * The Codex profile a process runs under rides the LIVE discovery path, pinned the same way `grid`
 * is in `terminalAgentDiscovery.grid.spec.ts`: a probe wired on the wrong function stays green while
 * every discovered codex row arrives with `codexHome` undefined — and its transcript then fails
 * validation against the default profile. `engines/discoveries.spec.ts` covers what the probe makes of the rollout a
 * process holds open, and `processTable.engineChildren.spec.ts` which children it may list.
 */

const probeProfileHome = vi.hoisted(() => vi.fn())
const processRows = vi.hoisted(() => vi.fn())
const agentCommandOwnershipSnapshot = vi.hoisted(() => vi.fn())

vi.mock('../engines/discoveries.js', async (real) => ({ ...await real<object>(), probeProfileHome }))
vi.mock('./engineBin.js', async (real) => ({ ...await real<typeof import('./engineBin.js')>(), agentCommandOwnershipSnapshot }))
vi.mock('./processTable.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./processTable.js')>(),
  processRows,
  enrichProcessRows: vi.fn(async (rows: unknown) => rows),
}))

const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

// No installed command is any engine's: each row is named by its argv alone, and nothing walks PATH (#3880).
const OWNERSHIP: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

const START = 'Sat Aug 15 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: START, args })

const TMUX_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const OTHER_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%2' }

function backendWith(roots: TerminalRootObservation[]): TerminalBackend {
  return { name: 'tmux', instanceId: 'tmux', inventory: async () => ({ state: 'available', roots }) } as unknown as TerminalBackend
}

beforeEach(() => {
  probeProfileHome.mockReset()
  processRows.mockReset()
  agentCommandOwnershipSnapshot.mockReset()
  agentCommandOwnershipSnapshot.mockReturnValue(OWNERSHIP)
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
    // Each agent's own selected process and engine, and a way to name that process's engine children.
    expect(probeProfileHome.mock.calls.map(([identity, engine, children]) => [(identity as ProcessIdentity).pid, engine, typeof children]).sort())
      .toEqual([[30, 'codex', 'function'], [40, 'claude', 'function']])
    for (const [identity] of probeProfileHome.mock.calls) expect(identity).toMatchObject({ startMarker: START })
    // The pass's one ownership snapshot serves the walk and the children alike: building one walks PATH (#3880).
    expect(agentCommandOwnershipSnapshot).toHaveBeenCalledOnce()
  })

  it('passes an unreadable probe through as undefined, so the registry keeps what it knew', async () => {
    processRows.mockResolvedValue([row(10, 1, 'bash'), row(30, 10, 'codex')])
    probeProfileHome.mockResolvedValue(undefined)
    const probe = await probeTerminalAgents([backendWith([{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])], ['tmux'], 999)
    expect(probe.agents[0]).toHaveProperty('codexHome', undefined)
    expect(agentCommandOwnershipSnapshot).toHaveBeenCalledOnce()
  })

  it('names a launcher\'s Codex children, and no other process', async () => {
    const named: ProcessIdentity[][] = []
    probeProfileHome.mockImplementation(async (_identity: unknown, _engine: string, children: () => ProcessIdentity[]) => {
      named.push(children())
      return undefined
    })
    // npm's Codex 0.169.0: the launcher discovery selects, two `codex` processes right under it (given highest pid
    // first), and a tool's shell beside them.
    processRows.mockResolvedValue([row(10, 1, 'bash'), row(30, 10, 'codex'), row(33, 30, 'zsh', 'zsh -c git status'),
      row(32, 30, 'codex', 'codex app-server'), row(31, 30, 'codex')])
    await probeTerminalAgents([backendWith([{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])], ['tmux'], 999)
    expect(named).toEqual([[{ pid: 31, executable: 'codex', startMarker: START }, { pid: 32, executable: 'codex', startMarker: START }]])

    // The one `codex` under that shell instead, a level further down: none is named.
    named.length = 0
    processRows.mockResolvedValue([row(10, 1, 'bash'), row(30, 10, 'codex'), row(33, 30, 'zsh'), row(34, 33, 'codex', 'codex exec review')])
    await probeTerminalAgents([backendWith([{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])], ['tmux'], 999)
    expect(named).toEqual([[]])
  })
})
