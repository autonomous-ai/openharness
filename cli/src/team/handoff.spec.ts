import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '../lib/authSession.js'
import { mintTeamHandoff, redeemTeamHandoff, revokeHarnessRefresh, takeHandoffFile, teamSession, TeamSignInError } from './handoff.js'

const CODE = `hnh_${'a'.repeat(43)}`
const computer: AuthSession = { version: 1, accessToken: 'access-placeholder', autonomousEnv: 'prod', computerId: 'c'.repeat(32), updatedAt: 1 }
const headers = { authorization: 'Bearer access-placeholder', 'x-autonomous-env': 'prod' }

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-handoff-'))
  cleanup.push(dir)
  return dir
}

describe('mintTeamHandoff', () => {
  it('asks for a team code with this computer\'s sign-in', async () => {
    const post = vi.fn(async () => ({ code: CODE, expiresIn: 90 }))
    await expect(mintTeamHandoff(async () => ({ session: computer, headers }), post as never)).resolves.toEqual({ code: CODE, expiresIn: 90 })
    expect(post).toHaveBeenCalledWith('/api/auth/handoff', { kind: 'team' }, headers)
  })

  it('refuses a team sign-in, a signed-out computer and an answer without a code', async () => {
    const post = vi.fn(async () => ({ code: CODE }))
    await expect(mintTeamHandoff(async () => ({ session: { ...computer, kind: 'team' }, headers }), post as never)).rejects.toMatchObject({ code: 'TEAM_SESSION' })
    expect(post).not.toHaveBeenCalled()
    await expect(mintTeamHandoff(async () => { throw new Error('Not signed in.') }, post as never)).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
    await expect(mintTeamHandoff(async () => ({ session: computer, headers }), (async () => ({ code: 'x; rm -rf /' })) as never)).rejects.toMatchObject({ code: 'BACKEND' })
    await expect(mintTeamHandoff(async () => ({ session: computer, headers }), (async () => { throw new Error('403') }) as never)).rejects.toMatchObject({ code: 'BACKEND' })
    expect((await mintTeamHandoff(async () => ({ session: computer, headers }), post as never)).expiresIn).toBe(90)
  })
})

describe('redeemTeamHandoff', () => {
  it('redeems for this computer id, with its label', async () => {
    const post = vi.fn(async () => ({ token: 'hna_t', refreshToken: 'hnr_r', expiresIn: 3600, kind: 'team' }))
    await expect(redeemTeamHandoff(CODE, 'Mac · Team', 'id', { post: post as never })).resolves.toMatchObject({ token: 'hna_t' })
    expect(post).toHaveBeenCalledWith('/api/auth/handoff/redeem', { code: CODE, label: 'Mac · Team', computerId: 'id' })
  })

  it('takes a refused code as final, and tries an unreachable backend again until the code would run out', async () => {
    const refused = vi.fn(async () => { throw Object.assign(new Error('That code has expired.'), { status: 401 }) })
    await expect(redeemTeamHandoff(CODE, 'l', 'id', { post: refused as never })).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(refused).toHaveBeenCalledTimes(1)
    let now = 0
    const sleep = vi.fn(async (ms: number) => { now += ms })
    const flaky = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce({ token: 'hna_t', kind: 'team' })
    await expect(redeemTeamHandoff(CODE, 'l', 'id', { post: flaky as never, sleep, now: () => now })).resolves.toEqual({ token: 'hna_t', kind: 'team' })
    const down = vi.fn(async () => { throw Object.assign(new Error('Service unavailable'), { status: 503 }) })
    await expect(redeemTeamHandoff(CODE, 'l', 'id', { post: down as never, sleep, now: () => now, retryForMs: 30_000 })).rejects.toMatchObject({ code: 'BACKEND' })
    expect(down.mock.calls.length).toBeGreaterThan(2)
  })

  // A backend from before team sessions ignores {kind:"team"} and makes a phone's session, which reaches every
  // computer on the account. Anything but a session it calls a team one is signed out again and refused.
  it('fails closed on a session the backend does not call a team one, signing it out again', async () => {
    const post = vi.fn(async (path: string) => path.endsWith('/redeem') ? { token: 'hna_t', refreshToken: 'hnr_phone', expiresIn: 3600 } : {})
    await expect(redeemTeamHandoff(CODE, 'l', 'id', { post: post as never })).rejects.toMatchObject({ code: 'NOT_TEAM' })
    expect(post).toHaveBeenCalledWith('/api/auth/revoke', { refreshToken: 'hnr_phone' })
    const viewer = vi.fn(async (path: string) => path.endsWith('/redeem') ? { token: 'hna_t', refreshToken: 'hnr_phone', kind: 'viewer' } : {})
    await expect(redeemTeamHandoff(CODE, 'l', 'id', { post: viewer as never })).rejects.toMatchObject({ code: 'NOT_TEAM' })
    await expect(mintTeamHandoff(async () => ({ session: computer, headers }), (async () => ({ code: CODE, kind: 'viewer' })) as never))
      .rejects.toMatchObject({ code: 'BACKEND' })
  })

  it('refuses a malformed code and an answer without a session', async () => {
    await expect(redeemTeamHandoff('short', 'l', 'id', { post: vi.fn() as never })).rejects.toBeInstanceOf(TeamSignInError)
    await expect(redeemTeamHandoff(CODE, 'l', 'id', { post: (async () => ({})) as never })).rejects.toMatchObject({ code: 'BACKEND' })
  })
})

describe('team session and revoke', () => {
  it('marks the stored session as a team one, keeping what it is given', () => {
    expect(teamSession({ token: 'hna_t', refreshToken: 'hnr_r', expiresIn: 10 }, 'id', 'stag', 1_000, { machineId: 'm' })).toEqual({
      version: 1, accessToken: 'hna_t', refreshToken: 'hnr_r', expiresAt: 11_000, autonomousEnv: 'stag', computerId: 'id', machineId: 'm', kind: 'team', updatedAt: 1_000,
    })
    expect(teamSession({ token: 'hna_t', autonomousEnv: 'prod' }, 'id', 'stag', 1)).toMatchObject({ autonomousEnv: 'prod', kind: 'team' })
  })

  it('revokes only a Harness-issued session, and never fails', async () => {
    const post = vi.fn(async () => ({}))
    expect(await revokeHarnessRefresh(post as never, 'hnr_x')).toBe(true)
    expect(post).toHaveBeenCalledWith('/api/auth/revoke', { refreshToken: 'hnr_x' })
    expect(await revokeHarnessRefresh(post as never, 'eyJ.sso')).toBe(false)
    expect(await revokeHarnessRefresh(post as never, undefined)).toBe(false)
    expect(await revokeHarnessRefresh((async () => { throw new Error('down') }) as never, 'hnr_x')).toBe(false)
  })
})

describe('takeHandoffFile', () => {
  it('reads this account\'s private file once and deletes it', () => {
    const file = join(temp(), 'team-handoff')
    writeFileSync(file, `${CODE}\n`, { mode: 0o600 })
    expect(takeHandoffFile(file)).toBe(CODE)
    expect(existsSync(file)).toBe(false)
    expect(takeHandoffFile(file)).toBeNull()
  })

  it('deletes unread a file others can read, a link, or one holding something else', () => {
    const dir = temp()
    const open = join(dir, 'open')
    writeFileSync(open, CODE, { mode: 0o600 })
    chmodSync(open, 0o644)
    expect(() => takeHandoffFile(open)).toThrow(/deleted unread/)
    expect(existsSync(open)).toBe(false)
    const target = join(dir, 'target'), link = join(dir, 'link')
    writeFileSync(target, CODE, { mode: 0o600 })
    symlinkSync(target, link)
    expect(() => takeHandoffFile(link)).toThrow(TeamSignInError)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(target)).toBe(true)
    const junk = join(dir, 'junk')
    writeFileSync(junk, '$(id)', { mode: 0o600 })
    expect(() => takeHandoffFile(junk)).toThrow(/did not hold a sign-in code/)
    expect(existsSync(junk)).toBe(false)
  })

  it('refuses a file another account owns', () => {
    const deps = {
      open: () => 3, fstat: () => ({ isFile: () => true, uid: 501, mode: 0o100600, size: 10 }), read: vi.fn(() => 0),
      close: vi.fn(), unlink: vi.fn(), euid: () => 502,
    }
    expect(() => takeHandoffFile('/x', deps)).toThrow(/not this account's private file/)
    expect(deps.read).not.toHaveBeenCalled()
    expect(deps.unlink).toHaveBeenCalledWith('/x')
  })
})
