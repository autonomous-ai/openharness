import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '../lib/authSession.js'
import { b64d, b64e, verify } from '../lib/e2ee/core.js'
import { ed25519 } from '@noble/curves/ed25519'
import {
  mintTeamConversion, mintTeamHandoff, redeemTeamHandoff, revokeHarnessRefresh, takeHandoffFile, teamConversionMessage, teamConversionProof,
  teamSession, TeamSignInError,
} from './handoff.js'

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

  // One machine (docs/plans/2026-10-24-swarm-team-account.md): the team machine records the Mac it lives on, so every
  // list shows that Mac once. The backend checks the machine is one of the account's own.
  it('names this computer\'s own machine as the Mac the team account lives on, once it has one', async () => {
    const post = vi.fn(async () => ({ code: CODE, expiresIn: 90 }))
    await mintTeamHandoff(async () => ({ session: { ...computer, machineId: 'machine-placeholder-1' }, headers }), post as never)
    expect(post).toHaveBeenCalledWith('/api/auth/handoff', { kind: 'team', hostMachineId: 'machine-placeholder-1' }, headers)
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

/**
 * The backend's own vector, made with its `teamConversionMessage` (backend/src/lib/teamSession.ts on the team sessions
 * branch: `harness team conversion v1\n${userId}\n${computerId}\n${machineId}\n${at}`) and its noble ed25519, from the
 * private key 32 bytes of 9 its tests use. The computer id is the backend's wire form: lowercase, no dashes.
 */
const VECTOR = {
  priv: new Uint8Array(32).fill(9),
  pub: '/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=',
  userId: 'user-placeholder-1', computerId: '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0', wireComputerId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  machineId: 'machine-placeholder-1', at: 1761300000000,
  message: 'harness team conversion v1\nuser-placeholder-1\n0f1e2d3c4b5a69788796a5b4c3d2e1f0\nmachine-placeholder-1\n1761300000000',
  sig: 'Jm32Kn6SMoox+JdknfweQyzrE7k8NMkmhIUZYzjULM6gAeV/TmgwVq/xjMB8s076bXz9FKQidfz09ltW6bcKCA==',
}

describe('team conversion proof', () => {
  it('signs the backend\'s message, byte for byte, with the machine key, over the computer id as the backend keeps it', () => {
    expect(teamConversionMessage(VECTOR.userId, VECTOR.wireComputerId, VECTOR.machineId, VECTOR.at)).toBe(VECTOR.message)
    expect(b64e(ed25519.getPublicKey(VECTOR.priv))).toBe(VECTOR.pub)
    const proof = teamConversionProof({ userId: VECTOR.userId, computerId: VECTOR.computerId, machineId: VECTOR.machineId, at: VECTOR.at, priv: VECTOR.priv })
    expect(proof).toEqual({ machineId: VECTOR.machineId, at: VECTOR.at, sig: VECTOR.sig })
    expect(verify(b64d(VECTOR.pub), new TextEncoder().encode(VECTOR.message), b64d(proof.sig))).toBe(true)
  })
})

describe('mintTeamConversion', () => {
  const autonomous: AuthSession = { ...computer, computerId: VECTOR.computerId, machineId: VECTOR.machineId }
  const harness: AuthSession = { ...autonomous, accessToken: 'hna_computer', refreshToken: 'hnr_computer', method: 'qr' }
  const deps = (session: AuthSession, over: Record<string, unknown> = {}) => ({
    auth: async () => ({ session, headers }),
    post: vi.fn(async () => ({ code: CODE, expiresIn: 90, kind: 'team' })),
    get: vi.fn(async () => ({ user: { id: VECTOR.userId } })),
    machineKey: () => ({ priv: VECTOR.priv }),
    now: () => VECTOR.at,
    ...over,
  })

  it('asks for a code for this very computer, with its machine key\'s proof, whichever sign-in it has', async () => {
    for (const session of [autonomous, harness]) {
      const d = deps(session)
      await expect(mintTeamConversion(d as never)).resolves.toEqual({ code: CODE, expiresIn: 90 })
      expect(d.get).toHaveBeenCalledWith('/api/auth/me', headers)
      expect(d.post).toHaveBeenCalledWith('/api/auth/handoff',
        { kind: 'team', computerId: VECTOR.wireComputerId, proof: { machineId: VECTOR.machineId, at: VECTOR.at, sig: VECTOR.sig } }, headers)
    }
  })

  it('refuses an Autonomous sign-in it cannot prove is this computer, before asking; a Harness sign-in asks without', async () => {
    const cases: Array<[Record<string, unknown>, AuthSession, string]> = [
      [{ machineKey: () => null }, autonomous, 'no device key'],
      [{}, { ...autonomous, machineId: undefined }, 'Start Harness once'],
      [{ get: vi.fn(async () => ({ user: {} })) }, autonomous, 'did not say which account'],
      [{ get: vi.fn(async () => { throw new Error('offline') }) }, autonomous, 'offline'],
    ]
    for (const [over, session, says] of cases) {
      const d = deps(session, over)
      await expect(mintTeamConversion(d as never), says).rejects.toThrow(says)
      expect(d.post).not.toHaveBeenCalled()
      const own = deps({ ...session, accessToken: 'hna_computer' }, over)
      await expect(mintTeamConversion(own as never)).resolves.toEqual({ code: CODE, expiresIn: 90 })
      expect(own.post).toHaveBeenCalledWith('/api/auth/handoff', { kind: 'team', computerId: VECTOR.wireComputerId }, headers)
    }
  })

  it('refuses a team sign-in and a signed-out computer, and an answer that is not a team code', async () => {
    await expect(mintTeamConversion(deps({ ...autonomous, kind: 'team' }) as never)).rejects.toMatchObject({ code: 'TEAM_SESSION' })
    await expect(mintTeamConversion(deps(autonomous, { auth: async () => { throw new Error('Not signed in.') } }) as never)).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
    await expect(mintTeamConversion(deps(autonomous, { post: vi.fn(async () => ({ code: CODE, kind: 'viewer' })) }) as never)).rejects.toMatchObject({ code: 'BACKEND' })
    const refused = Object.assign(new Error('Only this computer can make itself a team machine'), { status: 403 })
    await expect(mintTeamConversion(deps(autonomous, { post: vi.fn(async () => { throw refused }) }) as never))
      .rejects.toThrow('Only this computer can make itself a team machine')
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
    // A team session's refresh token (hta_/htr_) is the backend's own too.
    expect(await revokeHarnessRefresh(post as never, 'htr_team')).toBe(true)
    expect(post).toHaveBeenCalledWith('/api/auth/revoke', { refreshToken: 'htr_team' })
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
