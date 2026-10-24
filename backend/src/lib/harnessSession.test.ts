import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// In-memory stand-ins for Redis and the sessions collection, so the real handoff, refresh and
// authentication code runs end to end — only the stores are fake.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  const ttls = new Map<string, number>()
  let failRedis = false
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  const users = new Map<string, Record<string, unknown>>()
  const pick = (where: Record<string, unknown>) =>
    sessions.find((s) => Object.entries(where).every(([k, v]) => s[k] === v)) ?? null
  const pub = {
    set: vi.fn(async (key: string, value: string, _ex: string, ttl: number, ...flags: string[]) => {
      if (failRedis) throw new Error('redis down')
      if (flags.includes('NX') && redis.has(key)) return null
      redis.set(key, value); ttls.set(key, ttl); return 'OK'
    }),
    get: vi.fn(async (key: string) => {
      if (failRedis) throw new Error('redis down')
      return redis.get(key) ?? null
    }),
    // GET then DEL, in one transaction — how a redeem spends a code.
    multi: vi.fn(() => {
      const ops: Array<() => unknown> = []
      const chain = {
        get: (key: string) => { ops.push(() => redis.get(key) ?? null); return chain },
        del: (key: string) => { ops.push(() => (redis.delete(key) ? 1 : 0)); return chain },
        exec: async () => ops.map((op) => [null, op()]),
      }
      return chain
    }),
  }
  const harnessSession = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      // Like MongoDB: a new row has no `revokedAt` at all, and `revokedAt: null` does not match that.
      const row = { id: `s${sessions.length + 1}`, createdAt: new Date(), lastUsedAt: new Date(), ...data }
      sessions.push(row); return row
    }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(where)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = pick(where)!; Object.assign(row, data); return row
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const field = (s: Record<string, unknown>, k: string, v: unknown): boolean =>
        v !== null && typeof v === 'object' && 'isSet' in v ? (k in s) === (v as { isSet: boolean }).isSet : k in s && s[k] === v
      const matches = (s: Record<string, unknown>, w: Record<string, unknown>): boolean => Object.entries(w).every(([k, v]) =>
        k === 'OR' ? (v as Record<string, unknown>[]).some((o) => matches(s, o)) : field(s, k, v))
      const rows = sessions.filter((s) => matches(s, where))
      rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }
    }),
  }
  // The account's machines, for the check that a team code never binds to a computer a normal sign-in holds.
  const machines: Array<Record<string, unknown>> = []
  const live = (where: Record<string, unknown>) => machines.filter((m) => !m.deletedAt &&
    Object.entries(where).every(([k, v]) => k === 'OR' || m[k] === v))
  const machine = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => live(where)),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => live(where)[0] ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = live(where); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }
    }),
  }
  // A transaction over the same in-memory collections: what one changes, the others see.
  const transaction = vi.fn(async (body: (tx: unknown) => Promise<unknown>) => body({ harnessSession, machine }))
  const publishDown = vi.fn(async () => 1)
  const activeMachineKeys = vi.fn(async (_userId: string): Promise<Array<{ pub: string; machineId: string; kind: string }>> => [])
  return {
    redis, ttls, sessions, users, machines, pub, harnessSession, machine, transaction, publishDown, activeMachineKeys,
    setFailRedis: (v: boolean) => { failRedis = v },
    get: vi.fn(async (id: string) => users.get(id) ?? null),
    findByEmail: vi.fn(),
  }
})

vi.mock('./bus.js', () => ({ pub: fakes.pub, publishDown: fakes.publishDown }))
vi.mock('./deviceKeyLog.js', () => ({ activeMachineKeys: fakes.activeMachineKeys }))
vi.mock('./prisma.js', () => ({
  prisma: { harnessSession: fakes.harnessSession, machine: fakes.machine, $transaction: fakes.transaction },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('../services/UserService.js', () => ({
  userService: { get: fakes.get, findByEmail: fakes.findByEmail },
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: () => false,
}))
vi.mock('../services/index.js', () => ({ userService: { get: fakes.get, toPublic: (u: unknown) => u } }))

import { authenticateAccessToken, SsoAuthError } from './ssoAuth.js'
import { HANDOFF_TTL_SEC, redeemHandoff, refreshHarnessSession, revokeHarnessSession, startHandoff } from './harnessSession.js'
import { HARNESS_ACCESS_PREFIX, harnessTokenHash, newHarnessToken } from './harnessTokenFormat.js'
import { teamConversionMessage } from './teamSession.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { authRoutes } from '../routes/auth.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const USER = { id: 'u1', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' }

beforeEach(() => {
  fakes.redis.clear(); fakes.ttls.clear(); fakes.sessions.length = 0; fakes.users.clear(); fakes.machines.length = 0
  fakes.users.set(USER.id, USER)
  fakes.setFailRedis(false)
  vi.clearAllMocks()
})

describe('scan to sign in — the handoff', () => {
  it('signs the phone in as the account that minted the code, and never asks the account service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { code, expiresIn } = await startHandoff(USER.id)
    expect(code).toMatch(/^hnh_[A-Za-z0-9_-]{43}$/)
    expect(expiresIn).toBe(HANDOFF_TTL_SEC)
    // Only the hash is kept, and it dies on its own.
    expect([...fakes.redis.keys()].some((k) => k.includes(code))).toBe(false)
    expect([...fakes.ttls.values()]).toEqual([HANDOFF_TTL_SEC])

    const tokens = await redeemHandoff(code, "Dee's iPhone")
    expect(tokens).toMatchObject({ expiresIn: 3600, autonomousEnv: 'prod' })
    expect(tokens!.token).toMatch(/^hna_/)
    expect(tokens!.refreshToken).toMatch(/^hnr_/)
    expect(fakes.sessions[0]).toMatchObject({ userId: USER.id, label: "Dee's iPhone" })
    expect(fakes.sessions[0].refreshHash).not.toBe(tokens!.refreshToken)

    await expect(authenticateAccessToken(tokens!.token)).resolves.toEqual({
      sub: USER.id, email: USER.email, role: 'user', autonomousEnv: 'prod', harnessSessionId: 's1', harnessSessionKind: 'viewer',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fakes.findByEmail).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('works once: a second phone scanning the same QR gets nothing', async () => {
    const { code } = await startHandoff(USER.id)
    expect(await redeemHandoff(code, 'first')).not.toBeNull()
    expect(await redeemHandoff(code, 'second')).toBeNull()
    expect(fakes.sessions).toHaveLength(1)
  })

  it('refuses a code it never issued, or one that is not shaped like one', async () => {
    expect(await redeemHandoff(`hnh_${'A'.repeat(43)}`, 'x')).toBeNull()
    expect(await redeemHandoff('hnh_short', 'x')).toBeNull()
    expect(fakes.pub.multi).toHaveBeenCalledTimes(1) // the malformed one never reached Redis
  })

  it('a phone session is a viewer: machine connections refuse it', async () => {
    const { code } = await startHandoff(USER.id)
    const { token } = (await redeemHandoff(code, 'phone'))!
    await expect(authenticateAccessToken(token, 'prod', { allowHarnessSession: false }))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('an outage is not a bad token: Redis down answers AUTH_SERVICE_UNAVAILABLE, not a sign-out', async () => {
    const { code } = await startHandoff(USER.id)
    const { token } = (await redeemHandoff(code, 'phone'))!
    fakes.setFailRedis(true)
    const err = await authenticateAccessToken(token).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SsoAuthError)
    expect(err).toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' })
  })

  it('an access token nobody issued is simply invalid', async () => {
    await expect(authenticateAccessToken(`hna_${'B'.repeat(43)}`)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })
})

describe('scan to sign in — the routes', () => {
  let app: FastifyInstance
  const signedIn = { sub: USER.id, email: USER.email, role: 'user', autonomousEnv: 'prod' as const }

  async function build(authenticate: typeof authenticateAccessToken): Promise<FastifyInstance> {
    const server = Fastify()
    server.setErrorHandler(errorHandler)
    registerAuthMiddleware(server, authenticate)
    await server.register(authRoutes)
    await server.ready()
    return server
  }

  beforeEach(async () => {
    // The computer's Autonomous token is faked; a Harness token goes through the real check.
    app = await build(async (token, env, opts) =>
      token === 'sso-token' ? signedIn : authenticateAccessToken(token, env, opts))
  })

  it('the computer mints a code, the phone redeems it, refreshes, and signs out', async () => {
    const minted = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: 'Bearer sso-token' } })
    expect(minted.statusCode).toBe(200)
    const { code } = minted.json().data

    // No bearer: the code is the credential.
    const redeemed = await app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload: { code, label: "Dee's iPhone" } })
    expect(redeemed.statusCode).toBe(200)
    const { token, refreshToken } = redeemed.json().data

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json().data.user.email).toBe(USER.email)

    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } })
    expect(refreshed.statusCode).toBe(200)
    const renewed = refreshed.json().data
    expect(renewed.token).toMatch(/^hna_/)
    expect(renewed.token).not.toBe(token)
    expect(renewed.refreshToken).toBeUndefined() // not rotated: the phone keeps the one it has

    expect((await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: { refreshToken } })).statusCode).toBe(200)
    // Signed out at once: the refresh token and BOTH access tokens it was ever given.
    const again = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } })
    expect(again.statusCode).toBe(401)
    expect(again.json().error.code).toBe('REFRESH_TOKEN_INVALID')
    for (const t of [token, renewed.token]) {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${t}` } })
      expect(res.statusCode).toBe(401)
    }
  })

  it('minting needs a signed-in computer', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/handoff' })
    expect(res.statusCode).toBe(401)
  })

  it('a phone signed in by a scan cannot mint codes of its own', async () => {
    const { code } = await startHandoff(USER.id)
    const { token } = (await redeemHandoff(code, 'phone'))!
    const res = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('HANDOFF_NOT_ALLOWED')
  })

  it('a spent or unknown code is one answer, 401', async () => {
    const { code } = await startHandoff(USER.id)
    await app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload: { code } })
    for (const c of [code, 'nonsense', '']) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload: { code: c } })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('HANDOFF_INVALID')
    }
  })
})

// A teammate's agents run on the owner's Mac inside a second macOS user, whose own daemon is signed in to the owner's
// account with a TEAM session (docs/plans/2026-10-24-swarm-team-account.md, Task 1). It must be able to do strictly
// less than a computer: it is minted only by a computer, bound to the computer that redeemed it, and refused by every
// connection that has not said it confines a team session to that computer's own machine.
describe('team sessions — minting and redeeming', () => {
  const COMPUTER = 'ab12cd34ef56ab12cd34ef56ab12cd34'
  const OTHER_COMPUTER = 'ffff0000ffff0000ffff0000ffff0000'

  it('a team code redeems to a team session bound to the computer that redeemed it', async () => {
    const { code, expiresIn } = await startHandoff(USER.id, 'team')
    expect(code).toMatch(/^hnh_[A-Za-z0-9_-]{43}$/)
    expect(expiresIn).toBe(HANDOFF_TTL_SEC)
    expect([...fakes.ttls.values()]).toEqual([HANDOFF_TTL_SEC])
    const tokens = await redeemHandoff(code, 'MacBook Pro · Team', COMPUTER)
    expect(tokens).toMatchObject({ expiresIn: 3600, autonomousEnv: 'prod' })
    expect(fakes.sessions[0]).toMatchObject({ userId: USER.id, label: 'MacBook Pro · Team', kind: 'team', computerId: COMPUTER })
    await expect(authenticateAccessToken(tokens!.token, 'prod', { allowTeamSession: true })).resolves.toEqual({
      sub: USER.id, email: USER.email, role: 'user', autonomousEnv: 'prod',
      harnessSessionId: 's1', harnessSessionKind: 'team', harnessComputerId: COMPUTER,
    })
  })

  it('a viewer code minted without a kind still redeems to a viewer, a computer id or not', async () => {
    const plain = await startHandoff(USER.id)
    expect((await redeemHandoff(plain.code, 'phone', COMPUTER))).not.toBeNull()
    expect(fakes.sessions[0]).toMatchObject({ kind: 'viewer' })
    expect(fakes.sessions[0].computerId).toBeUndefined()
    // A code minted before team sessions existed holds the bare user id: it is a viewer's.
    const viewer = await startHandoff(USER.id, 'viewer')
    expect([...fakes.redis.values()]).toContain(USER.id)
    expect(await redeemHandoff(viewer.code, 'phone')).not.toBeNull()
    expect(fakes.sessions[1]).toMatchObject({ kind: 'viewer' })
  })

  it('a team code holds no bare user id, so a server that predates team sessions can never redeem it as a viewer', async () => {
    await startHandoff(USER.id, 'team')
    const held = [...fakes.redis.values()][0]!
    expect(held).not.toBe(USER.id)
    expect(JSON.parse(held)).toEqual({ userId: USER.id, kind: 'team' })
  })

  it('a team code without a computer id, or with a malformed one, is spent and answers nothing', async () => {
    for (const computerId of [undefined, '', 'not-a-computer']) {
      const { code } = await startHandoff(USER.id, 'team')
      expect(await redeemHandoff(code, 'x', computerId)).toBeNull()
      expect(await redeemHandoff(code, 'x', COMPUTER)).toBeNull() // spent: a second try with a good id gets nothing either
    }
    expect(fakes.sessions).toHaveLength(0)
  })

  it('a team code never binds to a computer the account already runs with a normal sign-in', async () => {
    fakes.machines.push({ userId: USER.id, computerId: COMPUTER, machineId: 'owner-mac', sessionKind: 'computer' })
    fakes.machines.push({ userId: USER.id, computerId: OTHER_COMPUTER, machineId: 'legacy', sessionKind: null })
    for (const computerId of [COMPUTER, OTHER_COMPUTER]) {
      const { code } = await startHandoff(USER.id, 'team')
      expect(await redeemHandoff(code, 'x', computerId)).toBeNull()
    }
    expect(fakes.sessions).toHaveLength(0)
    // The team machine itself, signed in again (a re-setup), is fine.
    fakes.machines.push({ userId: USER.id, computerId: 'abababababababababababababababab', machineId: 'team-mac', sessionKind: 'team' })
    const { code } = await startHandoff(USER.id, 'team')
    expect(await redeemHandoff(code, 'x', 'ABABABAB-ABAB-ABAB-ABAB-ABABABABABAB')).not.toBeNull()
    expect(fakes.sessions[0]).toMatchObject({ kind: 'team', computerId: 'abababababababababababababababab' })
  })

  it('a team session\'s tokens have their own prefixes, which a server from before team sessions does not take as Harness ones', async () => {
    const { code } = await startHandoff(USER.id, 'team')
    const tokens = (await redeemHandoff(code, 'x', COMPUTER))!
    expect(tokens.token).toMatch(/^hta_[A-Za-z0-9_-]{43}$/)
    expect(tokens.refreshToken).toMatch(/^htr_[A-Za-z0-9_-]{43}$/)
    expect((await refreshHarnessSession(tokens.refreshToken!))!.token).toMatch(/^hta_/)
    // The prefix and the session's kind must agree: one dressed as the other is no token at all.
    const viewer = (await redeemHandoff((await startHandoff(USER.id)).code, 'phone'))!
    const teamDressedAsViewer = `hna_${tokens.token.slice(4)}`
    fakes.redis.set(`hnauth:access:${harnessTokenHash(teamDressedAsViewer)}`, fakes.redis.get(`hnauth:access:${harnessTokenHash(tokens.token)}`)!)
    await expect(authenticateAccessToken(teamDressedAsViewer, 'prod', { allowTeamSession: true })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    const viewerDressedAsTeam = `hta_${viewer.token.slice(4)}`
    fakes.redis.set(`hnauth:access:${harnessTokenHash(viewerDressedAsTeam)}`, fakes.redis.get(`hnauth:access:${harnessTokenHash(viewer.token)}`)!)
    await expect(authenticateAccessToken(viewerDressedAsTeam, 'prod', { allowTeamSession: true })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    // The refresh tokens' hashes differ with their prefixes, so a renamed one finds no session.
    expect(await refreshHarnessSession(`hnr_${tokens.refreshToken!.slice(4)}`)).toBeNull()
  })

  it('a team session row without its computer is not a session at all', async () => {
    const { code } = await startHandoff(USER.id, 'team')
    const { token } = (await redeemHandoff(code, 'x', COMPUTER))!
    delete fakes.sessions[0].computerId
    await expect(authenticateAccessToken(token, 'prod', { allowTeamSession: true })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })
})

describe('team sessions — refused by every connection that does not confine them', () => {
  const COMPUTER = 'ab12cd34ef56ab12cd34ef56ab12cd34'
  async function teamToken(): Promise<string> {
    const { code } = await startHandoff(USER.id, 'team')
    return (await redeemHandoff(code, 'team', COMPUTER))!.token
  }

  it('by default, as a machine, and where only an Autonomous sign-in will do', async () => {
    const token = await teamToken()
    for (const opts of [undefined, {}, { allowHarnessSession: true }, { allowHarnessSession: 'computer' as const }, { enforceEnv: false }]) {
      const err = await authenticateAccessToken(token, 'prod', opts).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SsoAuthError)
      expect(err).toMatchObject({ code: 'TEAM_SESSION_LIMITED' })
    }
    await expect(authenticateAccessToken(token, 'prod', { allowHarnessSession: false })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('accepted only where the caller opts in, as a machine too', async () => {
    const token = await teamToken()
    await expect(authenticateAccessToken(token, 'prod', { allowHarnessSession: 'computer', allowTeamSession: true }))
      .resolves.toMatchObject({ harnessSessionKind: 'team', harnessComputerId: COMPUTER })
  })

  it('a computer session is unchanged by the option', async () => {
    const { code } = await startHandoff(USER.id)
    const { token } = (await redeemHandoff(code, 'phone'))!
    await expect(authenticateAccessToken(token, 'prod', { allowTeamSession: true })).resolves.toMatchObject({ harnessSessionKind: 'viewer' })
    await expect(authenticateAccessToken(token, 'prod', { allowHarnessSession: 'computer', allowTeamSession: true }))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('refreshes and signs out like any Harness session', async () => {
    const { code } = await startHandoff(USER.id, 'team')
    const { refreshToken } = (await redeemHandoff(code, 'team', COMPUTER))!
    const renewed = await refreshHarnessSession(refreshToken!)
    await expect(authenticateAccessToken(renewed!.token, 'prod', { allowTeamSession: true })).resolves.toMatchObject({ harnessSessionKind: 'team' })
    await revokeHarnessSession(refreshToken!)
    expect(await refreshHarnessSession(refreshToken!)).toBeNull()
  })
})

describe('team sessions — the routes', () => {
  const COMPUTER = 'ab12cd34ef56ab12cd34ef56ab12cd34'
  const handoffCodes = () => [...fakes.redis.keys()].filter((key) => key.startsWith('hnauth:handoff:'))
  let app: FastifyInstance
  const signedIn = { sub: USER.id, email: USER.email, role: 'user', autonomousEnv: 'prod' as const }

  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    registerAuthMiddleware(app, async (token, env, opts) => token === 'sso-token' ? signedIn : authenticateAccessToken(token, env, opts))
    await app.register(authRoutes)
    await app.ready()
  })

  const mint = (authorization: string, payload?: unknown) => app.inject({ method: 'POST', url: '/api/auth/handoff',
    headers: { authorization }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) })
  const redeem = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload })

  it('an Autonomous sign-in mints a team code; the redeeming computer gets a team session bound to it', async () => {
    const minted = await mint('Bearer sso-token', { kind: 'team' })
    expect(minted.statusCode).toBe(200)
    // The answer names what it minted, and the code is a plain token (what the team daemon's file carries).
    expect(minted.json().data).toEqual({ code: expect.stringMatching(/^[A-Za-z0-9_-]{16,256}$/), expiresIn: HANDOFF_TTL_SEC, kind: 'team' })
    const redeemed = await redeem({ code: minted.json().data.code, label: 'MacBook Pro · Team', computerId: COMPUTER })
    expect(redeemed.statusCode).toBe(200)
    expect(Object.keys(redeemed.json().data).sort()).toEqual(['autonomousEnv', 'expiresIn', 'kind', 'refreshToken', 'token'])
    expect(redeemed.json().data.kind).toBe('team')
    expect(fakes.sessions[0]).toMatchObject({ kind: 'team', computerId: COMPUTER, label: 'MacBook Pro · Team' })
  })

  it('a computer signed in by QR mints a team code too', async () => {
    // A computer session as a QR claim leaves it: its row, and its access token in the store.
    const computer = newHarnessToken(HARNESS_ACCESS_PREFIX)
    fakes.sessions.push({ id: 'computer-1', userId: USER.id, label: 'MacBook Pro', kind: 'computer', refreshHash: 'unused' })
    fakes.redis.set(`hnauth:access:${harnessTokenHash(computer)}`, JSON.stringify({ sessionId: 'computer-1', userId: USER.id }))
    const minted = await mint(`Bearer ${computer}`, { kind: 'team' })
    expect(minted.statusCode).toBe(200)
    expect((await redeem({ code: minted.json().data.code, label: 'Team', computerId: COMPUTER })).statusCode).toBe(200)
    expect(fakes.sessions.at(-1)).toMatchObject({ kind: 'team' })
  })

  it('without a body, or asking for a viewer, the code is a viewer\'s exactly as before', async () => {
    for (const payload of [undefined, {}, { kind: 'viewer' }]) {
      const minted = await mint('Bearer sso-token', payload)
      expect(minted.statusCode).toBe(200)
      expect(minted.json().data.kind).toBe('viewer')
      const redeemed = await redeem({ code: minted.json().data.code, label: 'phone' })
      expect(redeemed.statusCode).toBe(200)
      expect(redeemed.json().data.kind).toBe('viewer')
      expect(fakes.sessions.at(-1)).toMatchObject({ kind: 'viewer' })
    }
  })

  it('refuses a kind it does not know, without minting', async () => {
    for (const kind of ['computer', 'admin', 1, null]) {
      const res = await mint('Bearer sso-token', { kind })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('INVALID_HANDOFF_KIND')
    }
    expect(handoffCodes()).toEqual([])
  })

  it('a team session can never mint a code of any kind', async () => {
    const { code } = await startHandoff(USER.id, 'team')
    const { token } = (await redeemHandoff(code, 'team', COMPUTER))!
    for (const payload of [undefined, { kind: 'team' }, { kind: 'viewer' }]) {
      const res = await mint(`Bearer ${token}`, payload)
      expect(res.statusCode).toBe(403)
    }
    expect(handoffCodes()).toEqual([])
  })

  it('a phone signed in by a scan cannot mint a team code either', async () => {
    const { code } = await startHandoff(USER.id)
    const { token } = (await redeemHandoff(code, 'phone'))!
    const res = await mint(`Bearer ${token}`, { kind: 'team' })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('HANDOFF_NOT_ALLOWED')
  })

  it('a team code redeemed without its computer is the same one answer as a spent code', async () => {
    const minted = await mint('Bearer sso-token', { kind: 'team' })
    const res = await redeem({ code: minted.json().data.code, label: 'Team' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('HANDOFF_INVALID')
    expect(fakes.sessions).toHaveLength(0)
  })
})

// `harness team on`: a machine used only for agents becomes a team machine in place, keeping its computer id so its
// Swarm contributions and history survive. Only the computer itself may ask: its own Harness computer session, or a
// signature by its key on the account's device key log. Anyone else asking for a computer in ordinary use is refused.
describe('team sessions — a computer turning itself into a team machine', () => {
  const BOX = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
  const LAPTOP = 'efefefefefefefefefefefefefefefef'
  let app: FastifyInstance
  const signedIn = { sub: USER.id, email: USER.email, role: 'user', autonomousEnv: 'prod' as const }
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    registerAuthMiddleware(app, async (token, env, opts) => token === 'sso-token' ? signedIn : authenticateAccessToken(token, env, opts))
    await app.register(authRoutes)
    await app.ready()
    fakes.machines.push({ userId: USER.id, computerId: BOX, machineId: 'box-machine', autonomousEnv: 'prod', sessionKind: 'computer' })
  })
  const mint = (authorization: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization }, payload })
  const redeem = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload })
  /** A Harness computer session, as a QR sign-in leaves it, signed in as [computerId] (or as no computer it recorded). */
  function computerSession(id: string, computerId?: string): string {
    const token = newHarnessToken(HARNESS_ACCESS_PREFIX)
    fakes.sessions.push({ id, userId: USER.id, label: 'Mac mini', kind: 'computer', refreshHash: `unused-${id}`, ...(computerId ? { computerId } : {}) })
    fakes.redis.set(`hnauth:access:${harnessTokenHash(token)}`, JSON.stringify({ sessionId: id, userId: USER.id }))
    return token
  }
  const machineKey = ed25519.getPublicKey(new Uint8Array(32).fill(9))
  const proof = (overrides: { machineId?: string; at?: number; computerId?: string; priv?: Uint8Array } = {}) => {
    const machineId = overrides.machineId ?? 'box-machine', at = overrides.at ?? Date.now()
    const message = teamConversionMessage(USER.id, overrides.computerId ?? BOX, machineId, at)
    const sig = ed25519.sign(new TextEncoder().encode(message), overrides.priv ?? new Uint8Array(32).fill(9))
    return { machineId, at, sig: Buffer.from(sig).toString('base64') }
  }

  it('its own computer session converts it: redeeming ends its ordinary sign-ins and makes it a team machine, in one transaction', async () => {
    const own = computerSession('box-session', BOX)
    computerSession('box-older-session', BOX)
    computerSession('laptop-session', LAPTOP)
    const minted = await mint(`Bearer ${own}`, { kind: 'team', computerId: BOX.toUpperCase() })
    expect(minted.statusCode, minted.body).toBe(200)
    expect(minted.json().data).toMatchObject({ kind: 'team' })
    const redeemed = await redeem({ code: minted.json().data.code, label: 'Mac mini · Team', computerId: BOX })
    expect(redeemed.statusCode, redeemed.body).toBe(200)
    expect(redeemed.json().data.kind).toBe('team')
    expect(fakes.transaction).toHaveBeenCalledTimes(1)
    const byId = (id: string) => fakes.sessions.find((s) => s.id === id)!
    expect(byId('box-session').revokedAt).toBeInstanceOf(Date)
    expect(byId('box-older-session').revokedAt).toBeInstanceOf(Date)
    expect(byId('laptop-session').revokedAt).toBeUndefined()
    expect(fakes.sessions.at(-1)).toMatchObject({ kind: 'team', computerId: BOX, label: 'Mac mini · Team' })
    expect(fakes.machines[0]).toMatchObject({ machineId: 'box-machine', sessionKind: 'team' })
    // A socket still connected under the old sign-in is told to close (lib/adapterWs.ts).
    expect(fakes.publishDown).toHaveBeenCalledWith('box-machine', { connId: '', frame: { type: '__team_converted' } })
    // The old sign-in is over at once.
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${own}` } })
    expect(res.statusCode).toBe(401)
    await expect(authenticateAccessToken(redeemed.json().data.token, 'prod', { allowTeamSession: true }))
      .resolves.toMatchObject({ harnessSessionKind: 'team', harnessComputerId: BOX })
  })

  it('a conversion code redeems only for the computer that asked', async () => {
    const own = computerSession('box-session', BOX)
    const minted = await mint(`Bearer ${own}`, { kind: 'team', computerId: BOX })
    for (const computerId of [LAPTOP, undefined]) {
      const res = await redeem({ code: minted.json().data.code, label: 'x', ...(computerId ? { computerId } : {}) })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('HANDOFF_INVALID')
    }
    expect(fakes.sessions.find((s) => s.id === 'box-session')!.revokedAt).toBeUndefined()
    expect(fakes.machines[0].sessionKind).toBe('computer')
  })

  it('a computer signed in with Autonomous converts itself with its machine key\'s signature', async () => {
    fakes.activeMachineKeys.mockResolvedValue([{ pub: Buffer.from(machineKey).toString('base64'), machineId: 'box-machine', kind: 'machine' }])
    const minted = await mint('Bearer sso-token', { kind: 'team', computerId: BOX, proof: proof() })
    expect(minted.statusCode, minted.body).toBe(200)
    expect((await redeem({ code: minted.json().data.code, label: 'Mac mini', computerId: BOX })).statusCode).toBe(200)
    expect(fakes.machines[0].sessionKind).toBe('team')
  })

  it('no other session may convert a computer: not another computer, not an Autonomous sign-in without the machine\'s key, not a phone', async () => {
    fakes.activeMachineKeys.mockResolvedValue([{ pub: Buffer.from(machineKey).toString('base64'), machineId: 'box-machine', kind: 'machine' },
      { pub: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(5))).toString('base64'), machineId: 'laptop-machine', kind: 'machine' }])
    fakes.machines.push({ userId: USER.id, computerId: LAPTOP, machineId: 'laptop-machine', autonomousEnv: 'prod', sessionKind: 'computer' })
    const refused = async (authorization: string, payload: Record<string, unknown>) => {
      const res = await mint(authorization, { kind: 'team', computerId: BOX, ...payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(403)
      expect(res.json().error.code).toBe('HANDOFF_NOT_ALLOWED')
    }
    await refused(`Bearer ${computerSession('laptop-session', LAPTOP)}`, {})
    await refused(`Bearer ${computerSession('unrecorded-session')}`, {})
    await refused('Bearer sso-token', {})
    await refused('Bearer sso-token', { proof: { ...proof(), sig: proof({ priv: new Uint8Array(32).fill(5) }).sig } })
    await refused('Bearer sso-token', { proof: proof({ machineId: 'laptop-machine', priv: new Uint8Array(32).fill(5) }) })
    await refused('Bearer sso-token', { proof: proof({ at: Date.now() - 10 * 60_000 }) })
    await refused('Bearer sso-token', { proof: proof({ computerId: LAPTOP }) })
    await refused('Bearer sso-token', { proof: 'not a proof' })
    // A proof is good once.
    const once = proof()
    expect((await mint('Bearer sso-token', { kind: 'team', computerId: BOX, proof: once })).statusCode).toBe(200)
    await refused('Bearer sso-token', { proof: once })
    // A phone asks for nothing, of any kind.
    const { code } = await startHandoff(USER.id)
    const { token: phone } = (await redeemHandoff(code, 'phone'))!
    expect((await mint(`Bearer ${phone}`, { kind: 'team', computerId: BOX })).statusCode).toBe(403)
    expect(fakes.sessions.filter((s) => s.revokedAt)).toEqual([])
    expect(fakes.machines.every((m) => m.sessionKind === 'computer')).toBe(true)
  })

  it('a team session never mints, even a conversion of its own computer', async () => {
    fakes.machines[0].sessionKind = 'team'
    const { code } = await startHandoff(USER.id, 'team')
    const { token } = (await redeemHandoff(code, 'team', BOX))!
    const res = await mint(`Bearer ${token}`, { kind: 'team', computerId: BOX })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('TEAM_SESSION_LIMITED')
  })

  it('a computer id in the mint is only for a team code, and only a well-formed one', async () => {
    const own = computerSession('box-session', BOX)
    for (const payload of [{ kind: 'viewer', computerId: BOX }, { computerId: BOX }]) {
      const res = await mint(`Bearer ${own}`, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('INVALID_HANDOFF_KIND')
    }
    for (const computerId of ['not-a-computer', 7]) {
      const res = await mint(`Bearer ${own}`, { kind: 'team', computerId })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('INVALID_COMPUTER_ID')
    }
  })
})

// One machine (docs/plans/2026-10-24-swarm-team-account.md): a Mac's team account is a mechanism under the scenes, so
// every list shows that Mac once. Its team machine records the Mac it lives on: the minting computer's own machine, or,
// from an Autonomous sign-in, the machine the CLI names, which must be one of the account's ordinary machines here.
describe('team sessions — the Mac a team account lives on', () => {
  const LAPTOP = 'efefefefefefefefefefefefefefefef'
  const TEAM = 'abababababababababababababababab'
  let app: FastifyInstance
  const signedIn = { sub: USER.id, email: USER.email, role: 'user', autonomousEnv: 'prod' as const }
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    registerAuthMiddleware(app, async (token, env, opts) => token === 'sso-token' ? signedIn : authenticateAccessToken(token, env, opts))
    await app.register(authRoutes)
    await app.ready()
    fakes.machines.push(
      { userId: USER.id, computerId: LAPTOP, machineId: 'laptop-machine', autonomousEnv: 'prod', sessionKind: 'computer' },
      { userId: USER.id, computerId: 'c'.repeat(32), machineId: 'other-machine', autonomousEnv: 'prod', sessionKind: 'computer' },
      { userId: USER.id, computerId: 'd'.repeat(32), machineId: 'older-machine', autonomousEnv: 'prod' },
      { userId: 'u2', computerId: 'e'.repeat(32), machineId: 'their-machine', autonomousEnv: 'prod', sessionKind: 'computer' },
      { userId: USER.id, computerId: '1'.repeat(32), machineId: 'stag-machine', autonomousEnv: 'stag', sessionKind: 'computer' },
      { userId: USER.id, computerId: '2'.repeat(32), machineId: 'gone-machine', autonomousEnv: 'prod', sessionKind: 'computer', deletedAt: new Date() },
      { userId: USER.id, computerId: '3'.repeat(32), machineId: 'dedicated-machine', autonomousEnv: 'prod', sessionKind: 'team' },
    )
  })
  const mint = (authorization: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization }, payload })
  const redeem = (code: string) => app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload: { code, label: 'MacBook Pro · Team', computerId: TEAM } })
  const handoffCodes = () => [...fakes.redis.keys()].filter((key) => key.startsWith('hnauth:handoff:'))
  function computerSession(id: string, computerId?: string): string {
    const token = newHarnessToken(HARNESS_ACCESS_PREFIX)
    fakes.sessions.push({ id, userId: USER.id, label: 'MacBook Pro', kind: 'computer', refreshHash: `unused-${id}`, ...(computerId ? { computerId } : {}) })
    fakes.redis.set(`hnauth:access:${harnessTokenHash(token)}`, JSON.stringify({ sessionId: id, userId: USER.id }))
    return token
  }

  it('a computer signed in by QR records its own machine, named or not', async () => {
    const laptop = computerSession('laptop-session', LAPTOP)
    for (const payload of [{ kind: 'team' }, { kind: 'team', hostMachineId: 'laptop-machine' }]) {
      const minted = await mint(`Bearer ${laptop}`, payload)
      expect(minted.statusCode, minted.body).toBe(200)
      expect((await redeem(minted.json().data.code)).statusCode).toBe(200)
      expect(fakes.sessions.at(-1)).toMatchObject({ kind: 'team', computerId: TEAM, hostMachineId: 'laptop-machine' })
    }
  })

  it('a computer session may name any of its own computer\'s machines', async () => {
    fakes.machines.push({ userId: USER.id, computerId: LAPTOP, machineId: 'laptop-second', autonomousEnv: 'prod', sessionKind: 'computer' })
    const minted = await mint(`Bearer ${computerSession('laptop-session', LAPTOP)}`, { kind: 'team', hostMachineId: 'laptop-second' })
    expect(minted.statusCode, minted.body).toBe(200)
    expect((await redeem(minted.json().data.code)).statusCode).toBe(200)
    expect(fakes.sessions.at(-1)).toMatchObject({ kind: 'team', hostMachineId: 'laptop-second' })
  })

  it('a computer session may not name another machine as its Mac', async () => {
    const res = await mint(`Bearer ${computerSession('laptop-session', LAPTOP)}`, { kind: 'team', hostMachineId: 'other-machine' })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('HANDOFF_NOT_ALLOWED')
    expect(handoffCodes()).toEqual([])
  })

  it('an Autonomous sign-in names its own machine, which is recorded', async () => {
    for (const hostMachineId of ['laptop-machine', 'older-machine']) {
      const minted = await mint('Bearer sso-token', { kind: 'team', hostMachineId })
      expect(minted.statusCode, minted.body).toBe(200)
      expect((await redeem(minted.json().data.code)).statusCode).toBe(200)
      expect(fakes.sessions.at(-1)).toMatchObject({ kind: 'team', hostMachineId })
    }
  })

  it('refuses a machine that is not one of the account\'s ordinary machines in this environment, minting nothing', async () => {
    for (const hostMachineId of ['their-machine', 'stag-machine', 'gone-machine', 'dedicated-machine', 'no-such-machine']) {
      const res = await mint('Bearer sso-token', { kind: 'team', hostMachineId })
      expect(res.statusCode, hostMachineId).toBe(403)
      expect(res.json().error.code).toBe('HANDOFF_NOT_ALLOWED')
    }
    expect(handoffCodes()).toEqual([])
  })

  it('names a Mac only for a team code, never for a phone or a computer turning itself into one', async () => {
    for (const payload of [{ hostMachineId: 'laptop-machine' }, { kind: 'viewer', hostMachineId: 'laptop-machine' },
      { kind: 'team', computerId: LAPTOP, hostMachineId: 'laptop-machine' }]) {
      const res = await mint('Bearer sso-token', payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json().error.code).toBe('INVALID_HANDOFF_KIND')
    }
    for (const hostMachineId of [1, '', 'x'.repeat(200), null]) {
      const res = await mint('Bearer sso-token', { kind: 'team', hostMachineId })
      expect(res.statusCode, JSON.stringify(hostMachineId)).toBe(400)
      expect(res.json().error.code).toBe('INVALID_MACHINE_ID')
    }
    expect(handoffCodes()).toEqual([])
  })

  it('without a Mac the code mints as before and records none', async () => {
    const minted = await mint('Bearer sso-token', { kind: 'team' })
    // What the code holds is the same JSON as before, so a server from before this change redeems it the same way.
    expect(handoffCodes().map((key) => JSON.parse(fakes.redis.get(key)!))).toEqual([{ userId: USER.id, kind: 'team' }])
    expect((await redeem(minted.json().data.code)).statusCode).toBe(200)
    expect(fakes.sessions.at(-1)!.hostMachineId).toBeUndefined()
  })

  it('redeeming again (a repair run) records the Mac on the team machine that already exists', async () => {
    fakes.machines.push({ userId: USER.id, computerId: TEAM, machineId: 'team-machine', autonomousEnv: 'prod', sessionKind: 'team' })
    const minted = await mint('Bearer sso-token', { kind: 'team', hostMachineId: 'laptop-machine' })
    expect((await redeem(minted.json().data.code)).statusCode).toBe(200)
    expect(fakes.machines.find((m) => m.machineId === 'team-machine')).toMatchObject({ hostMachineId: 'laptop-machine' })
    // A dedicated machine and the person's own machines are untouched.
    expect(fakes.machines.find((m) => m.machineId === 'dedicated-machine')!.hostMachineId).toBeUndefined()
    expect(fakes.machines.find((m) => m.machineId === 'laptop-machine')!.hostMachineId).toBeUndefined()
  })
})
