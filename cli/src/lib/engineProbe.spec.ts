import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { probeEngines } from './engineProbe.js'
import { engineAccount } from './engineAccount.js'
import { commandAvailableInInteractiveShell, commandOutputInInteractiveShell } from './engineLaunch.js'

vi.mock('./engineAccount.js', () => ({ engineAccount: vi.fn() }))
vi.mock('./engineLaunch.js', () => ({ commandAvailableInInteractiveShell: vi.fn(), commandOutputInInteractiveShell: vi.fn() }))
vi.mock('./engineBin.js', () => ({
  engineBin: (engine: string) => engine === 'terminal' ? '' : engine,
  enginePathOverride: () => undefined,
}))

beforeEach(() => {
  vi.mocked(commandAvailableInInteractiveShell).mockReset().mockResolvedValue(true)
  vi.mocked(commandOutputInInteractiveShell).mockReset().mockResolvedValue(null)
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

describe('an engine installed where it cannot run', () => {
  const recorded = (name: string) => readFileSync(new URL(`../engines/openclaw/__fixtures__/${name}`, import.meta.url), 'utf8')

  it('says OpenClaw needs Node 24 when the Node its shell finds cannot run it', async () => {
    vi.mocked(commandOutputInInteractiveShell).mockResolvedValue({ code: 0, output: recorded('version-old-node-darwin.txt') })
    expect(await probeEngines(['openclaw'])).toEqual([
      { engine: 'openclaw', installed: true, command: 'openclaw', installable: false, unavailable: 'OpenClaw needs Node 24.' },
    ])
    expect(commandOutputInInteractiveShell).toHaveBeenCalledWith('openclaw', ['--version'])
    vi.mocked(commandOutputInInteractiveShell).mockResolvedValue({ code: 1, output: recorded('version-node20-darwin.txt') })
    expect((await probeEngines(['openclaw']))[0]).toMatchObject({ unavailable: 'OpenClaw needs Node 24.' })
  })

  it('says nothing for an OpenClaw that runs, one that did not answer, or another engine', async () => {
    vi.mocked(commandOutputInInteractiveShell).mockResolvedValue({ code: 0, output: 'OpenClaw 2026.11.2 (b556fdf)\n' })
    expect((await probeEngines(['openclaw']))[0]).not.toHaveProperty('unavailable')
    vi.mocked(commandOutputInInteractiveShell).mockResolvedValue(null)
    expect((await probeEngines(['openclaw']))[0]).not.toHaveProperty('unavailable')
    vi.mocked(commandAvailableInInteractiveShell).mockResolvedValue(false)
    expect((await probeEngines(['openclaw']))[0]).not.toHaveProperty('unavailable')
    vi.mocked(commandAvailableInInteractiveShell).mockResolvedValue(true)
    await probeEngines(['claude', 'opencode'])
    expect(commandOutputInInteractiveShell).toHaveBeenCalledTimes(2)
  })
})
