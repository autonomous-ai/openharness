import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { acceptedIn, recordAcceptanceIn, recordSettingIn, recordTrustIn, trustsIn } from './kit/folderTrust.js'
import { answerFirstRun, firstRunAnswered, folderTrust, skipOnboarding } from './launchPrep.js'

vi.mock('./kit/homeAdoption.js', async original => ({ ...await original<typeof import('./kit/homeAdoption.js')>(), homeIsNetworkOrDevice: (path: string) => path.startsWith('/net/') }))
vi.mock('./kit/folderTrust.js', () => ({ trustsIn: vi.fn(() => true), recordTrustIn: vi.fn(() => 'trusted'), recordAcceptanceIn: vi.fn(() => 'accepted'),
  acceptedIn: vi.fn(() => false), recordSettingIn: vi.fn(() => 'recorded') }))

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

// The Dell's first Buddy sat at Claude Code's "Choose the text style" until the Swarm gave up on it (2026-11-06).
describe('first-run screens done', () => {
  it('in the .claude.json beside the folder trust the launch reads, never in a network home, and not for an engine without one', () => {
    vi.mocked(recordAcceptanceIn).mockClear()
    expect(skipOnboarding('claude', { HOME: '/home/u' })).toBe('accepted')
    expect(recordAcceptanceIn).toHaveBeenLastCalledWith(join('/home/u', '.claude.json'), 'hasCompletedOnboarding')
    expect(skipOnboarding('claude', { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/moved' })).toBe('accepted')
    expect(recordAcceptanceIn).toHaveBeenLastCalledWith(join('/home/u/moved', '.claude.json'), 'hasCompletedOnboarding')
    expect(skipOnboarding('claude', { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/net/x' })).toBe('skipped')
    expect(skipOnboarding('codex', { HOME: '/home/u' })).toBeNull()
    expect(recordAcceptanceIn).toHaveBeenCalledTimes(2)
  })
})

// Asked on the phone setting up the computer instead of on Claude Code's screen (owner, 2026-11-06).
describe('first-run questions answered from the phone', () => {
  it('reads the answer where the engine keeps it, and records the theme and the screens, never a permission setting', () => {
    vi.mocked(acceptedIn).mockReset().mockReturnValue(false)
    expect(firstRunAnswered('claude', { HOME: '/home/u' })).toBe(false)
    vi.mocked(acceptedIn).mockReturnValue(true)
    expect(firstRunAnswered('claude', { HOME: '/home/u' })).toBe(true)
    expect(acceptedIn).toHaveBeenCalledWith(join('/home/u', '.claude.json'), 'hasCompletedOnboarding')
    expect(firstRunAnswered('claude', { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/net/x' })).toBe(false)
    expect(firstRunAnswered('codex', { HOME: '/home/u' })).toBeNull()
    vi.mocked(recordAcceptanceIn).mockClear()
    expect(answerFirstRun('claude', { theme: 'light' }, { HOME: '/home/u' })).toBe(true)
    expect(recordSettingIn).toHaveBeenLastCalledWith(join('/home/u', '.claude.json'), 'theme', 'light')
    // Task #4215: no permission setting goes into a person's settings for an agent Harness starts.
    expect(recordAcceptanceIn).toHaveBeenCalledExactlyOnceWith(join('/home/u', '.claude.json'), 'hasCompletedOnboarding')
    // A theme the engine has no word for is not written; the rest still is.
    vi.mocked(recordSettingIn).mockClear()
    expect(answerFirstRun('claude', { theme: 'purple' }, { HOME: '/home/u' })).toBe(true)
    expect(recordSettingIn).not.toHaveBeenCalled()
    expect(answerFirstRun('claude', { theme: 'dark' }, { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/net/x' })).toBe(false)
    expect(answerFirstRun('codex', { theme: 'dark' }, { HOME: '/home/u' })).toBe(false)
  })
})
