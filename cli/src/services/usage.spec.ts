import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { startUsage, startUsageInCore, USAGE_REQUESTS } from './usage.js'
import { emptyPorts } from '../core/api.js'
import { linkClaudeProfile, profileId } from '../lib/claudeProfiles.js'
import { linkCodexProfile } from '../lib/codexProfiles.js'
import { usageTarget } from '../lib/agentUsageWire.js'

const ASKER = { local: false, owner: true }

describe('the usage service', () => {
  it('composes an explicit inline reader on the same bounded wire', async () => {
    const ports = emptyPorts()
    expect(Object.keys(startUsageInCore(fakeCore(), ports))).toEqual(['usage_read'])
    expect(await ports.usage!.read(usageTarget({ agentId: 'a', sessionId: '', engine: 'claude', transcriptPath: null, registeredAt: 1 })))
      .toEqual({ error: 'INVALID_USAGE_TARGET' })
    ports.usage!.stop()
  })
  it('answers exactly the request it declares', () => {
    expect(Object.keys(startUsage(fakeCore())).sort()).toEqual([...USAGE_REQUESTS].sort())
  })

  it('usage_read: this machine\'s own readings, as the vendors gave them', async () => {
    const readings = [{ provider: 'claude' as const, account: 'k1', outcome: 'answered' as const, httpStatus: 200, body: { seven_day: { utilization: 42 } } }]
    const read = vi.fn(async () => readings)
    expect(await startUsage(fakeCore(), { read }).usage_read!({}, ASKER)).toEqual({ providers: readings })
    expect(read).toHaveBeenCalledOnce()
  })

  it('usage_read: a reading that fails is said, never thrown', async () => {
    const requests = startUsage(fakeCore(), { read: async () => { throw new Error('keychain locked') } })
    expect(await requests.usage_read!({}, ASKER)).toEqual({ error: 'USAGE_READ_FAILED' })
  })

  it('usage_read without a payload asks the reader for nothing in particular', async () => {
    const read = vi.fn(async () => [])
    await startUsage(fakeCore(), { read }).usage_read!({}, ASKER)
    expect(read).toHaveBeenCalledWith(undefined)
  })

  it('usage_read with an unknown profile id answers PROFILE_UNKNOWN', async () => {
    const read = vi.fn(async () => [])
    const requests = startUsage(fakeCore(), { read })
    for (const profile of [{ engine: 'claude', id: 'nope' }, { engine: 'codex', id: 'nope' }, { engine: 'gemini', id: 'default' }]) {
      expect(await requests.usage_read!({ profile }, ASKER)).toEqual({ error: 'PROFILE_UNKNOWN' })
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('usage_read for a profile is the owner\'s alone', async () => {
    const read = vi.fn(async () => [])
    expect(await startUsage(fakeCore(), { read }).usage_read!({ profile: { engine: 'claude', id: 'default' } }, { local: false, owner: false }))
      .toEqual({ error: 'OWNER_REQUIRED' })
    expect(read).not.toHaveBeenCalled()
  })

  it('usage_read for a default profile reads that provider only', async () => {
    const read = vi.fn(async () => [])
    await startUsage(fakeCore(), { read }).usage_read!({ profile: { engine: 'codex', id: 'default' } }, ASKER)
    expect(read).toHaveBeenCalledWith({ only: 'codex' })
  })

  it('usage_read takes the default account by its hex id too, for both engines', async () => {
    const read = vi.fn(async () => [])
    const core = fakeCore()
    const requests = startUsage(core, { read })
    for (const engine of ['claude', 'codex'] as const) {
      await requests.usage_read!({ profile: { engine, id: profileId(core.daemon.machineId(), engine, 'default') } }, ASKER)
    }
    expect(read.mock.calls).toEqual([[{ only: 'claude' }], [{ only: 'codex' }]])
  })

  it('usage_read finds a Claude and a Codex profile by id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-profile-'))
    try {
      const claude = join(dir, 'claude')
      const codex = join(dir, 'codex')
      mkdirSync(claude)
      mkdirSync(codex)
      const real = realpathSync(dir)
      const core = fakeCore()
      expect(linkClaudeProfile(claude, 'machine-1')).toHaveProperty('profile')
      linkCodexProfile(codex)
      const read = vi.fn(async () => [])
      const requests = startUsage(core, { read })
      await requests.usage_read!({ profile: { engine: 'claude', id: profileId('machine-1', 'claude', join(real, 'claude')) } }, ASKER)
      await requests.usage_read!({ profile: { engine: 'codex', id: profileId('machine-1', 'codex', join(real, 'codex')) } }, ASKER)
      expect(read.mock.calls).toEqual([[{ claudeHome: join(dir, 'claude') }], [{ codexHome: join(real, 'codex') }]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
