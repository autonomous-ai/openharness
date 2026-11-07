import { beforeEach, describe, expect, it, vi } from 'vitest'
import { probeEngines } from './engineProbe.js'
import { engineAccount } from './engineAccount.js'
import { commandAvailableInInteractiveShell } from './engineLaunch.js'

vi.mock('./engineAccount.js', () => ({ engineAccount: vi.fn() }))
vi.mock('./engineLaunch.js', () => ({ commandAvailableInInteractiveShell: vi.fn() }))
vi.mock('./engineBin.js', () => ({
  engineBin: (engine: string) => engine === 'terminal' ? '' : engine,
  enginePathOverride: () => undefined,
}))

beforeEach(() => {
  vi.mocked(commandAvailableInInteractiveShell).mockReset().mockResolvedValue(true)
  vi.mocked(engineAccount).mockReset().mockResolvedValue({ signedIn: null, lastUsedAt: null })
})

describe('account availability for pane engines', () => {
  it.each([true, false, null])('reports an installed Cursor account as %s without copying credential fields', async signedIn => {
    vi.mocked(engineAccount).mockResolvedValue({ signedIn, lastUsedAt: 42, token: 'test-secret' } as never)
    expect(await probeEngines(['cursor'], { accounts: true })).toEqual([
      { engine: 'cursor', installed: true, command: 'cursor', installable: false, signedIn, lastUsedAt: 42 },
    ])
  })

  it('leaves failed account reads unknown and does not expose their error', async () => {
    vi.mocked(engineAccount).mockRejectedValue(new Error('test-secret'))
    expect(await probeEngines(['cursor'], { accounts: true })).toEqual([
      { engine: 'cursor', installed: true, command: 'cursor', installable: false, signedIn: null, lastUsedAt: null },
    ])
  })

  it('does not turn malformed reader fields into signed-in readiness or expose them', async () => {
    vi.mocked(engineAccount).mockResolvedValue({ signedIn: 'test-secret', lastUsedAt: 'test-secret' } as never)
    expect(await probeEngines(['cursor'], { accounts: true })).toEqual([
      { engine: 'cursor', installed: true, command: 'cursor', installable: false, signedIn: null, lastUsedAt: null },
    ])
  })

  it('does not read accounts unless requested, installed, and a process engine', async () => {
    await probeEngines(['claude', 'cursor'])
    vi.mocked(commandAvailableInInteractiveShell).mockResolvedValue(false)
    await probeEngines(['claude', 'cursor', 'terminal'], { accounts: true })
    expect(engineAccount).not.toHaveBeenCalled()
  })

  it('keeps existing Claude and Codex account results', async () => {
    vi.mocked(engineAccount).mockResolvedValue({ signedIn: true, lastUsedAt: 123 })
    expect((await probeEngines(['claude', 'codex'], { accounts: true })).map(row => [row.engine, row.signedIn, row.lastUsedAt]))
      .toEqual([['claude', true, 123], ['codex', true, 123]])
  })
})
