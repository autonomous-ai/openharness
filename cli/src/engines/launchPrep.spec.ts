import { describe, expect, it, vi } from 'vitest'
import { recordTrustIn, trustsIn } from './kit/folderTrust.js'
import { folderTrust } from './launchPrep.js'

vi.mock('./kit/homeAdoption.js', async original => ({ ...await original<typeof import('./kit/homeAdoption.js')>(), homeIsNetworkOrDevice: (path: string) => path.startsWith('/net/') }))
vi.mock('./kit/folderTrust.js', () => ({ trustsIn: vi.fn(() => true), recordTrustIn: vi.fn(() => 'trusted') }))

describe('folder trust in a network home on Windows', () => {
  it.each([['claude', { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/net/x' }], ['codex', { HOME: '/home/u', CODEX_HOME: '/net/x' }]] as const)(
    '%s: counts as no trust file, and never reads or writes the share', (engine, environment) => {
      const trust = folderTrust(engine, null, environment)!
      expect(trust.trusts('/work')).toBe(false)
      expect(trust.record('/work')).toBe('skipped')
      expect(trustsIn).not.toHaveBeenCalled()
      expect(recordTrustIn).not.toHaveBeenCalled()
    })

  it('still reads and records in a home on the drive', () => {
    const trust = folderTrust('codex', null, { HOME: '/home/u', CODEX_HOME: '/home/u/.codex2' })!
    expect(trust.trusts('/work')).toBe(true)
    expect(trust.record('/work')).toBe('trusted')
  })
})
