import { describe, expect, it, vi } from 'vitest'
import { recordTrustIn, trustsIn } from './kit/folderTrust.js'
import { recordInheritedMcp } from './kit/inheritedMcp.js'
import { folderTrust } from './launchPrep.js'
import { hashOf } from '../lib/log.js'

vi.mock('./kit/homeAdoption.js', async original => ({ ...await original<typeof import('./kit/homeAdoption.js')>(), homeIsNetworkOrDevice: (path: string) => path.startsWith('/net/') }))
vi.mock('./kit/folderTrust.js', () => ({ trustsIn: vi.fn(() => true), recordTrustIn: vi.fn(() => 'trusted') }))
vi.mock('./kit/inheritedMcp.js', () => ({ recordInheritedMcp: vi.fn(() => []) }))

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

describe('the MCP servers a trusted folder continues without, in the log', () => {
  it('are counted, never named: the person chose their names', () => {
    vi.mocked(recordInheritedMcp).mockReturnValueOnce(['sentinel-notes', 'sentinel-mail'])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(folderTrust('claude', null, { HOME: '/home/u' })!.record('/work')).toBe('trusted')
      const lines = log.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
      expect(lines).not.toContain('sentinel')
      expect(lines).toContain(`[launch] claude: continues without the 2 MCP servers it found above ${hashOf('/work')}, as its question does by default`)
    } finally { log.mockRestore() }
  })
})
