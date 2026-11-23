import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'

/**
 * When discovery cannot look, it says why: the process table could not be read, or the engines' executables could
 * not be resolved. The second is what a daemon whose start folder was deleted, or a Windows PATH folder with an odd
 * error, hit (Windows run 44758521149), and its log line read as a broken `ps`. Only the error's kind is carried: its
 * words can quote a path.
 */

const processRows = vi.hoisted(() => vi.fn())
const ownership = vi.hoisted(() => vi.fn())

vi.mock('./engineBin.js', async (real) => ({ ...await real<typeof import('./engineBin.js')>(), agentCommandOwnershipSnapshotAsync: ownership }))
vi.mock('./processTable.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./processTable.js')>(),
  processRows,
  enrichProcessRows: vi.fn(async (rows: unknown) => rows),
}))

const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Sat Aug 15 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: START, args: executable })

const backend = {
  name: 'tmux', instanceId: 'tmux',
  inventory: async () => ({ state: 'available', roots: [{ runtime: { backend: 'tmux', paneId: '%1' }, rootPid: 10, cwd: '/work' }] }),
} as unknown as TerminalBackend

beforeEach(() => {
  processRows.mockReset()
  ownership.mockReset()
  processRows.mockResolvedValue([row(10, 1, 'bash'), row(30, 10, 'codex')])
})

describe('a probe that could not look', () => {
  it('says the engines\' executables could not be resolved, with the kind', async () => {
    ownership.mockRejectedValue(Object.assign(new Error('ENGINE_LOOKUP_TIMEOUT'), { code: 'ENGINE_LOOKUP_TIMEOUT' }))
    expect(await probeTerminalAgents([backend], ['tmux'])).toMatchObject({
      processTableAvailable: false, ownershipFailure: 'ENGINE_LOOKUP_TIMEOUT', agents: [],
    })
  })

  it('names a system code, never the words', async () => {
    ownership.mockRejectedValue(Object.assign(new Error("ENOENT: uv_cwd '/Users/sentinel-person/gone'"), { code: 'ENOENT' }))
    const probe = await probeTerminalAgents([backend], ['tmux'])
    expect(probe.ownershipFailure).toBe('ENOENT')
    expect(JSON.stringify({ ...probe, ambiguousPlacements: [] })).not.toContain('sentinel-person')
  })

  it('says nothing of executables when the process table itself could not be read', async () => {
    processRows.mockResolvedValue(null)
    const probe = await probeTerminalAgents([backend], ['tmux'])
    expect(probe.processTableAvailable).toBe(false)
    expect(probe).not.toHaveProperty('ownershipFailure')
    expect(ownership).not.toHaveBeenCalled()
  })
})
