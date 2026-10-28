import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(),
    upsert: vi.fn(), update: vi.fn(), count: vi.fn() })
  return { prisma: { agentMessageShare: model(), agentMessageInvite: model(), agentMessageMember: model(), machine: model(), user: model() } }
})
vi.mock('./prisma.js', () => ({ prisma: mocks.prisma, machineAlive: {} }))
import { accept, accountIdByEmail, ROSTER_MAX_BYTES, admits, invite, listShares, moveShare, pendingInvites, putRoster, removeMember, revokeInvite, shareMemberIds, shareOwner, sharedTabId, stopSharing } from './agentMessageShares.js'

const p = mocks.prisma
const S = sharedTabId('alice', 'tab-1')
const put = (over: Record<string, unknown> = {}) => putRoster({ ownerUserId: 'alice', tabId: 'tab-1', machineId: 'm1', version: 1,
  roster: { sig: 'x' }, autonomousEnv: 'prod', ...over } as never)
const inv = (over: Record<string, unknown> = {}) => invite({ ownerUserId: 'alice', ownerEmail: 'alice@x.io', sharedTabId: S,
  email: 'Bob@X.io', expiresAt: new Date('2030-01-01T00:00:00Z'), autonomousEnv: 'prod', ...over })
const p2002 = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' })

describe('agent message shares', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    p.machine.findFirst.mockResolvedValue({ machineId: 'm1' })
  })

  it('names a shared tab differently per account', () => {
    const a = sharedTabId('alice', 'tab-1'), b = sharedTabId('bob', 'tab-1')
    expect(a).toMatch(/^[a-f0-9]{24}$/); expect(b).toMatch(/^[a-f0-9]{24}$/)
    expect(a).not.toBe(b)
  })

  it('refuses a roster over 128 KiB, body plus signature, without touching the database', async () => {
    // The daemons' one ceiling (cli lib/e2ee/tabSession.ts): a 96 KiB body, escaped as JSON and signed, stays below this.
    expect(ROSTER_MAX_BYTES).toBe(128 * 1024)
    // `{"pad":"…"}` is ten bytes more than its padding.
    expect(await put({ roster: { pad: 'x'.repeat(128 * 1024 - 9) } })).toEqual({ error: 'ROSTER_TOO_LARGE' })
    expect(p.machine.findFirst).not.toHaveBeenCalled()
    expect(p.agentMessageShare.findUnique).not.toHaveBeenCalled()
    p.machine.findFirst.mockResolvedValue(null)
    expect(await put({ roster: { pad: 'x'.repeat(128 * 1024 - 10) } })).toEqual({ error: 'FORBIDDEN' })
  })

  it('refuses a roster from a machine the owner does not have', async () => {
    p.machine.findFirst.mockResolvedValue(null)
    expect(await put()).toEqual({ error: 'FORBIDDEN' })
    expect(p.machine.findFirst).toHaveBeenCalledWith({ where: { machineId: 'm1', userId: 'alice', autonomousEnv: 'prod' }, select: { machineId: true } })
    expect(p.agentMessageShare.create).not.toHaveBeenCalled()
  })

  it('stores the first roster', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue(null)
    expect(await put()).toEqual({ sharedTabId: S, version: 1 })
    expect(p.agentMessageShare.findUnique).toHaveBeenCalledWith({ where: { id: S }, select: { ownerMachineId: true, rosterVersion: true, stoppedAt: true } })
    expect(p.agentMessageShare.create).toHaveBeenCalledWith({ data: { id: S, ownerUserId: 'alice', ownerMachineId: 'm1', tabId: 'tab-1',
      autonomousEnv: 'prod', roster: { sig: 'x' }, rosterVersion: 1, stoppedAt: null } })
    expect(p.agentMessageShare.updateMany).not.toHaveBeenCalled()
  })

  it('converges when two first writes race', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue(null)
    p.agentMessageShare.create.mockRejectedValue(p2002())
    p.agentMessageShare.updateMany.mockResolvedValue({ count: 1 })
    expect(await put()).toEqual({ sharedTabId: S, version: 1 })
    expect(p.agentMessageShare.updateMany).toHaveBeenCalledWith({ where: { id: S, ownerMachineId: 'm1', stoppedAt: null, rosterVersion: { lt: 1 } },
      data: { roster: { sig: 'x' }, rosterVersion: 1, stoppedAt: null } })
  })

  it('refuses the loser of a first-write race that is another machine of the owner', async () => {
    p.agentMessageShare.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ownerMachineId: 'other', rosterVersion: 1 })
    p.agentMessageShare.create.mockRejectedValue(p2002())
    p.agentMessageShare.updateMany.mockResolvedValue({ count: 0 })
    expect(await put()).toEqual({ error: 'FORBIDDEN' })
    expect(p.agentMessageShare.findUnique).toHaveBeenLastCalledWith({ where: { id: S }, select: { ownerMachineId: true, rosterVersion: true } })
  })

  it('calls the same machine\'s lost first-write race stale, with the version held', async () => {
    p.agentMessageShare.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ownerMachineId: 'm1', rosterVersion: 1 })
    p.agentMessageShare.create.mockRejectedValue(p2002())
    p.agentMessageShare.updateMany.mockResolvedValue({ count: 0 })
    expect(await put()).toEqual({ error: 'STALE_ROSTER', version: 1 })
  })

  it('calls a put stale with version 0 when the share is gone by the time it is read again', async () => {
    p.agentMessageShare.findUnique.mockResolvedValueOnce({ ownerMachineId: 'm1', rosterVersion: 1, stoppedAt: null }).mockResolvedValueOnce(null)
    p.agentMessageShare.updateMany.mockResolvedValue({ count: 0 })
    expect(await put({ version: 2 })).toEqual({ error: 'STALE_ROSTER', version: 0 })
  })

  it('rethrows any other create error', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue(null)
    p.agentMessageShare.create.mockRejectedValue(new Error('x'))
    await expect(put()).rejects.toThrow('x')
    p.agentMessageShare.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('other', { code: 'P2010', clientVersion: 'test' }))
    await expect(put()).rejects.toThrow('other')
  })

  it('refuses a second machine of the owner', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue({ ownerMachineId: 'other', rosterVersion: 1, stoppedAt: null })
    expect(await put()).toEqual({ error: 'FORBIDDEN' })
    expect(p.agentMessageShare.updateMany).not.toHaveBeenCalled()
  })

  it('refuses a roster that is not newer than the held one, with the version held, and never revives a stopped one', async () => {
    p.agentMessageShare.findUnique.mockResolvedValueOnce({ ownerMachineId: 'm1', rosterVersion: 3, stoppedAt: null })
      .mockResolvedValueOnce({ ownerMachineId: 'm1', rosterVersion: 3 })
    p.agentMessageShare.updateMany.mockResolvedValue({ count: 0 })
    expect(await put({ version: 2 })).toEqual({ error: 'STALE_ROSTER', version: 3 })
    // `stoppedAt: null`: a stop that lands between the read and this write is not undone by it.
    expect(p.agentMessageShare.updateMany).toHaveBeenCalledWith({ where: { id: S, ownerMachineId: 'm1', stoppedAt: null, rosterVersion: { lt: 2 } },
      data: { roster: { sig: 'x' }, rosterVersion: 2, stoppedAt: null } })
  })

  it('starts a stopped share again from any live machine of the owner, past the version it stopped at', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue({ ownerMachineId: 'other', rosterVersion: 7, stoppedAt: new Date('2026-10-01T00:00:00Z') })
    p.agentMessageShare.updateMany.mockResolvedValue({ count: 1 })
    expect(await put({ version: 8 })).toEqual({ sharedTabId: S, version: 8 })
    // One write: the new computer, the version and the restart together.
    expect(p.agentMessageShare.updateMany).toHaveBeenCalledWith({ where: { id: S, ownerUserId: 'alice', stoppedAt: { not: null }, rosterVersion: { lt: 8 } },
      data: { roster: { sig: 'x' }, rosterVersion: 8, stoppedAt: null, ownerMachineId: 'm1' } })
    expect(p.agentMessageShare.create).not.toHaveBeenCalled()
  })

  it('refuses to start a stopped share again at or below the version it stopped at, and says that version', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue({ ownerMachineId: 'other', rosterVersion: 7, stoppedAt: new Date('2026-10-01T00:00:00Z') })
    expect(await put({ version: 1 })).toEqual({ error: 'STALE_ROSTER', version: 7 })
    expect(await put({ version: 7 })).toEqual({ error: 'STALE_ROSTER', version: 7 })
    expect(p.agentMessageShare.updateMany).not.toHaveBeenCalled()
  })

  it('calls a stopped share another put started again first stale, with the version that put left', async () => {
    p.agentMessageShare.findUnique.mockResolvedValueOnce({ ownerMachineId: 'm1', rosterVersion: 7, stoppedAt: new Date('2026-10-01T00:00:00Z') })
      .mockResolvedValueOnce({ rosterVersion: 9 })
    p.agentMessageShare.updateMany.mockResolvedValue({ count: 0 })
    expect(await put({ version: 8 })).toEqual({ error: 'STALE_ROSTER', version: 9 })
    expect(p.agentMessageShare.updateMany).toHaveBeenCalledTimes(1)
    expect(p.agentMessageShare.findUnique).toHaveBeenLastCalledWith({ where: { id: S }, select: { rosterVersion: true } })
    p.agentMessageShare.findUnique.mockResolvedValueOnce({ ownerMachineId: 'm1', rosterVersion: 7, stoppedAt: new Date('2026-10-01T00:00:00Z') })
      .mockResolvedValueOnce(null)
    expect(await put({ version: 8 })).toEqual({ error: 'STALE_ROSTER', version: 0 })
  })

  it('still refuses a machine the owner no longer has, for a stopped share too', async () => {
    p.machine.findFirst.mockResolvedValue(null)
    p.agentMessageShare.findUnique.mockResolvedValue({ ownerMachineId: 'm1', rosterVersion: 7, stoppedAt: new Date('2026-10-01T00:00:00Z') })
    expect(await put()).toEqual({ error: 'FORBIDDEN' })
    expect(p.agentMessageShare.updateMany).not.toHaveBeenCalled()
  })

  it('accepts a newer roster from the same machine', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue({ ownerMachineId: 'm1', rosterVersion: 1, stoppedAt: null })
    p.agentMessageShare.updateMany.mockResolvedValue({ count: 1 })
    expect(await put({ version: 2 })).toEqual({ sharedTabId: S, version: 2 })
  })

  it('refuses to invite oneself, ignoring case and spaces', async () => {
    expect(await inv({ email: ' Alice@X.io ' })).toEqual({ error: 'SELF_INVITE' })
    expect(p.agentMessageShare.findFirst).not.toHaveBeenCalled()
  })

  it('refuses to invite to a share the caller does not own', async () => {
    p.agentMessageShare.findFirst.mockResolvedValue(null)
    expect(await inv()).toEqual({ error: 'FORBIDDEN' })
    expect(p.agentMessageShare.findFirst).toHaveBeenCalledWith({ where: { id: S, ownerUserId: 'alice', stoppedAt: null } })
    expect(p.agentMessageInvite.upsert).not.toHaveBeenCalled()
  })

  it('refuses an invitation to a full tab', async () => {
    p.agentMessageShare.findFirst.mockResolvedValue({ id: S, ownerMachineId: 'm1' })
    p.agentMessageMember.count.mockResolvedValue(5); p.agentMessageInvite.count.mockResolvedValue(3)
    expect(await inv()).toEqual({ error: 'TAB_FULL' })
    expect(p.agentMessageMember.count).toHaveBeenCalledWith({ where: { shareId: S, removedAt: null } })
    expect(p.agentMessageInvite.count).toHaveBeenCalledWith({ where: { shareId: S, acceptedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) } } })
    expect(p.agentMessageInvite.upsert).not.toHaveBeenCalled()
  })

  it('invites by lower-cased email and renews a past invitation', async () => {
    p.agentMessageShare.findFirst.mockResolvedValue({ id: S, ownerMachineId: 'm1' })
    p.agentMessageMember.count.mockResolvedValue(1); p.agentMessageInvite.count.mockResolvedValue(0)
    p.agentMessageInvite.upsert.mockResolvedValue({ id: 'i1' })
    const expiresAt = new Date('2030-01-01T00:00:00Z')
    expect(await inv()).toEqual({ id: 'i1' })
    expect(p.agentMessageInvite.upsert).toHaveBeenCalledWith({
      where: { shareId_email: { shareId: S, email: 'bob@x.io' } },
      create: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), shareId: S, ownerUserId: 'alice', ownerMachineId: 'm1', email: 'bob@x.io', autonomousEnv: 'prod', expiresAt,
        acceptedAt: null, acceptedBy: null, revokedAt: null },
      update: { expiresAt, revokedAt: null, acceptedAt: null, acceptedBy: null },
    })
  })

  it('revokes an invitation once', async () => {
    p.agentMessageInvite.findFirst.mockResolvedValueOnce({ shareId: S, email: 'bob@x.io' }).mockResolvedValueOnce(null)
    p.agentMessageInvite.updateMany.mockResolvedValueOnce({ count: 1 })
    expect(await revokeInvite('alice', 'i1')).toEqual({ shareId: S, email: 'bob@x.io' })
    expect(await revokeInvite('alice', 'i1')).toBeNull()
    expect(p.agentMessageInvite.updateMany).toHaveBeenCalledTimes(1)
    expect(p.agentMessageInvite.updateMany).toHaveBeenCalledWith({ where: { id: 'i1', ownerUserId: 'alice', revokedAt: null }, data: { revokedAt: expect.any(Date) } })
  })
  it('calls an invitation revoked in the meantime gone', async () => {
    p.agentMessageInvite.findFirst.mockResolvedValue({ shareId: S, email: 'bob@x.io' })
    p.agentMessageInvite.updateMany.mockResolvedValue({ count: 0 })
    expect(await revokeInvite('alice', 'i1')).toBeNull()
  })

  it('lists the invitations waiting for an email, with the owner\'s email', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z')
    p.agentMessageInvite.findMany.mockResolvedValue([
      { id: 'i1', shareId: S, ownerUserId: 'alice', ownerMachineId: 'm1', expiresAt },
      { id: 'i2', shareId: 'S2', ownerUserId: 'ghost', ownerMachineId: 'm9', expiresAt },
    ])
    p.user.findMany.mockResolvedValue([{ id: 'alice', email: 'alice@x.io' }])
    p.agentMessageShare.findMany.mockResolvedValue([{ id: S }, { id: 'S2' }])
    expect(await pendingInvites('BOB@x.io', 'prod')).toEqual([
      { id: 'i1', sharedTabId: S, ownerEmail: 'alice@x.io', ownerMachineId: 'm1', expiresAt: '2030-01-01T00:00:00.000Z', tabName: '' },
      { id: 'i2', sharedTabId: 'S2', ownerEmail: '', ownerMachineId: 'm9', expiresAt: '2030-01-01T00:00:00.000Z', tabName: '' },
    ])
    expect(p.agentMessageInvite.findMany).toHaveBeenCalledWith({ where: { email: 'bob@x.io', autonomousEnv: 'prod',
      acceptedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) } } })
    expect(p.agentMessageShare.findMany).toHaveBeenCalledWith({ where: { id: { in: [S, 'S2'] }, stoppedAt: null }, select: { id: true, roster: true } })
    expect(p.user.findMany).toHaveBeenCalledWith({ where: { id: { in: ['alice', 'ghost'] } }, select: { id: true, email: true } })
  })

  const pendingWith = async (roster: unknown) => {
    p.agentMessageInvite.findMany.mockResolvedValue([{ id: 'i1', shareId: S, ownerUserId: 'alice', ownerMachineId: 'm1', expiresAt: new Date('2030-01-01T00:00:00Z') }])
    p.agentMessageShare.findMany.mockResolvedValue([{ id: S, roster }])
    p.user.findMany.mockResolvedValue([])
    return pendingInvites('bob@x.io', 'prod')
  }

  it('names the tab of a pending invitation from the roster it holds, cleaned', async () => {
    // Control and format characters (a bidi override, a bell) are another account's to send, not ours to pass on.
    const [one] = await pendingWith({ body: JSON.stringify({ name: 'app\u202e\u0007' }), signature: 's' })
    expect(one).toEqual(expect.objectContaining({ sharedTabId: S, tabName: 'app' }))
    const [long] = await pendingWith({ body: JSON.stringify({ name: 'x'.repeat(300) }), signature: 's' })
    expect(long.tabName).toBe('x'.repeat(200))
  })

  it('gives an empty name when the roster is missing, not JSON, or has no name', async () => {
    expect((await pendingWith(null))[0].tabName).toBe('')
    expect((await pendingWith({ body: '{', signature: 's' }))[0].tabName).toBe('')
    expect((await pendingWith({ body: JSON.stringify({ name: 7 }), signature: 's' }))[0].tabName).toBe('')
    expect((await pendingWith({ body: 5, signature: 's' }))[0].tabName).toBe('')
    expect((await pendingWith('text'))[0].tabName).toBe('')
  })

  it('hides the invitations of a stopped share', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z')
    p.agentMessageInvite.findMany.mockResolvedValue([{ id: 'i1', shareId: S, ownerUserId: 'alice', ownerMachineId: 'm1', expiresAt }])
    p.agentMessageShare.findMany.mockResolvedValue([])
    p.user.findMany.mockResolvedValue([])
    expect(await pendingInvites('bob@x.io', 'prod')).toEqual([])
  })

  const now = new Date('2029-01-01T00:00:00Z')
  const row = (over: Record<string, unknown> = {}) => ({ id: 'i1', shareId: S, email: 'bob@x.io', expiresAt: new Date('2030-01-01T00:00:00Z'), ...over })

  it('does not accept an invitation addressed to another email, taken already, or revoked', async () => {
    p.agentMessageInvite.findFirst.mockResolvedValue(null)
    expect(await accept({ sub: 'eve', email: ' Eve@X.io', autonomousEnv: 'prod' }, 'i1', now)).toEqual({ error: 'NOT_FOUND' })
    // Only an invitation of the environment the person is signed in to.
    expect(p.agentMessageInvite.findFirst).toHaveBeenCalledWith({ where: { id: 'i1', email: 'eve@x.io', autonomousEnv: 'prod', acceptedAt: null, revokedAt: null } })
  })

  it('does not accept the invitation of a stopped share', async () => {
    p.agentMessageInvite.findFirst.mockResolvedValue(row())
    p.agentMessageShare.findFirst.mockResolvedValue(null)
    expect(await accept({ sub: 'bob', email: 'bob@x.io', autonomousEnv: 'prod' }, 'i1', now)).toEqual({ error: 'NOT_FOUND' })
    expect(p.agentMessageShare.findFirst).toHaveBeenCalledWith({ where: { id: S, stoppedAt: null }, select: { id: true } })
    expect(p.agentMessageMember.upsert).not.toHaveBeenCalled()
  })

  it('does not let a removed member re-accept the invitation they used', async () => {
    // removeMember revoked it, and an accepted one no longer matches `acceptedAt: null`
    p.agentMessageInvite.findFirst.mockResolvedValue(null)
    expect(await accept({ sub: 'bob', email: 'bob@x.io', autonomousEnv: 'prod' }, 'i1', now)).toEqual({ error: 'NOT_FOUND' })
    expect(p.agentMessageInvite.findFirst.mock.calls[0][0].where).toMatchObject({ acceptedAt: null, revokedAt: null })
    expect(p.agentMessageMember.upsert).not.toHaveBeenCalled()
  })

  it('does not accept an expired invitation', async () => {
    p.agentMessageShare.findFirst.mockResolvedValue({ id: S })
    p.agentMessageInvite.findFirst.mockResolvedValue(row({ expiresAt: new Date('2028-01-01T00:00:00Z') }))
    expect(await accept({ sub: 'bob', email: 'bob@x.io', autonomousEnv: 'prod' }, 'i1', now)).toEqual({ error: 'EXPIRED' })
    expect(p.agentMessageInvite.update).not.toHaveBeenCalled()
    expect(p.agentMessageMember.upsert).not.toHaveBeenCalled()
  })

  it('accepts an invitation and (re)activates the member', async () => {
    p.agentMessageShare.findFirst.mockResolvedValue({ id: S })
    p.agentMessageInvite.findFirst.mockResolvedValue(row())
    expect(await accept({ sub: 'bob', email: 'bob@x.io', autonomousEnv: 'prod' }, 'i1', now)).toEqual({ sharedTabId: S })
    expect(p.agentMessageInvite.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { acceptedBy: 'bob', acceptedAt: now } })
    const id = expect.stringMatching(/^[a-f0-9]{24}$/)
    expect(p.agentMessageMember.upsert).toHaveBeenCalledWith({ where: { id },
      create: { id, shareId: S, userId: 'bob', email: 'bob@x.io', inviteId: 'i1', acceptedAt: now, removedAt: null },
      update: { removedAt: null, inviteId: 'i1', acceptedAt: now } })
  })

  it('lets only the owner or the member remove a member', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue({ ownerUserId: 'alice' })
    p.agentMessageMember.updateMany.mockResolvedValue({ count: 1 })
    expect(await removeMember('eve', S, 'bob')).toBe(false)
    expect(p.agentMessageMember.updateMany).not.toHaveBeenCalled()
    expect(await removeMember('alice', S, 'bob')).toBe(true)
    expect(await removeMember('bob', S, 'bob')).toBe(true)
    expect(p.agentMessageMember.updateMany).toHaveBeenCalledWith({ where: { shareId: S, userId: 'bob', removedAt: null }, data: { removedAt: expect.any(Date) } })
    expect(p.agentMessageShare.findUnique).toHaveBeenCalledWith({ where: { id: S }, select: { ownerUserId: true } })
    expect(p.agentMessageInvite.updateMany).toHaveBeenCalledWith({ where: { shareId: S, revokedAt: null, OR: [{ acceptedBy: 'bob' }] }, data: { revokedAt: expect.any(Date) } })
  })

  // #1376: accept, the owner invites again, the owner removes bob: the invitation the re-invite reset to waiting brought
  // bob back with no new invitation, and counted toward the tab's 8 twice.
  it('a removed member cannot accept an earlier re-invite', async () => {
    const invites: Record<string, unknown>[] = [], members: Record<string, unknown>[] = []
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Record<string, unknown>[]).some(w => matches(row, w))
      if (want && typeof want === 'object' && 'gt' in want) return (row[key] as Date) > (want as { gt: Date }).gt
      return (row[key] ?? null) === want
    })
    p.agentMessageShare.findFirst.mockResolvedValue({ id: S, ownerMachineId: 'm1' })
    p.agentMessageShare.findUnique.mockResolvedValue({ ownerUserId: 'alice' })
    p.agentMessageInvite.count.mockImplementation(async ({ where }) => invites.filter(r => matches(r, where)).length)
    p.agentMessageMember.count.mockImplementation(async ({ where }) => members.filter(r => matches(r, where)).length)
    p.agentMessageInvite.findFirst.mockImplementation(async ({ where }) => invites.find(r => matches(r, where)) ?? null)
    p.agentMessageMember.findFirst.mockImplementation(async ({ where }) => members.find(r => matches(r, where)) ?? null)
    p.agentMessageInvite.upsert.mockImplementation(async ({ where, create, update }) => {
      const found = invites.find(r => r.shareId === where.shareId_email.shareId && r.email === where.shareId_email.email)
      if (found) return Object.assign(found, update)
      invites.push({ ...create }); return create
    })
    p.agentMessageInvite.update.mockImplementation(async ({ where, data }) => Object.assign(invites.find(r => r.id === where.id)!, data))
    p.agentMessageMember.upsert.mockImplementation(async ({ where, create, update }) => {
      const found = members.find(r => r.id === where.id)
      if (found) return Object.assign(found, update)
      members.push({ ...create }); return create
    })
    const updateMany = (rows: Record<string, unknown>[]) => async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }
    }
    p.agentMessageInvite.updateMany.mockImplementation(updateMany(invites))
    p.agentMessageMember.updateMany.mockImplementation(updateMany(members))
    const bob = { sub: 'bob', email: 'bob@x.io', autonomousEnv: 'prod' }
    const first = await inv() as { id: string }
    expect(await accept(bob, first.id, now)).toEqual({ sharedTabId: S })
    // A member already: the owner's second invitation is refused, so it neither waits nor counts toward the 8.
    expect(await inv()).toEqual({ error: 'ALREADY_MEMBER' })
    expect(await removeMember('alice', S, 'bob')).toBe(true)
    expect(await accept(bob, first.id, now)).toEqual({ error: 'NOT_FOUND' })
    // An invitation still waiting for that address goes with the member too.
    invites.push({ id: 'i2', shareId: S, email: 'bob@x.io', autonomousEnv: 'prod', expiresAt: new Date('2030-01-01T00:00:00Z'), acceptedAt: null, acceptedBy: null, revokedAt: null })
    members[0]!.removedAt = null
    expect(await removeMember('alice', S, 'bob')).toBe(true)
    expect(await accept(bob, 'i2', now)).toEqual({ error: 'NOT_FOUND' })
  })

  it('reports no removal for a missing share or member', async () => {
    p.agentMessageShare.findUnique.mockResolvedValue(null)
    expect(await removeMember('alice', S, 'bob')).toBe(false)
    p.agentMessageShare.findUnique.mockResolvedValue({ ownerUserId: 'alice' })
    p.agentMessageMember.updateMany.mockResolvedValue({ count: 0 })
    expect(await removeMember('alice', S, 'bob')).toBe(false)
  })

  it('stops sharing only for the owner, once', async () => {
    p.agentMessageShare.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    expect(await stopSharing('alice', S)).toBe(true)
    expect(await stopSharing('eve', S)).toBe(false)
    expect(p.agentMessageShare.updateMany).toHaveBeenNthCalledWith(1, { where: { id: S, ownerUserId: 'alice', stoppedAt: null }, data: { stoppedAt: expect.any(Date) } })
    // ends every member's access and every pending invitation, once, for the owner's stop only
    expect(p.agentMessageMember.updateMany).toHaveBeenCalledTimes(1)
    expect(p.agentMessageMember.updateMany).toHaveBeenCalledWith({ where: { shareId: S, removedAt: null }, data: { removedAt: expect.any(Date) } })
    expect(p.agentMessageInvite.updateMany).toHaveBeenCalledTimes(1)
    expect(p.agentMessageInvite.updateMany).toHaveBeenCalledWith({ where: { shareId: S, revokedAt: null }, data: { revokedAt: expect.any(Date) } })
  })

  describe('moving a share to another computer of the owner', () => {
    it('moves a live share to a live machine the owner has, and its pending invitations with it', async () => {
      p.machine.findFirst.mockResolvedValue({ machineId: 'm2' })
      p.agentMessageShare.updateMany.mockResolvedValue({ count: 1 })
      expect(await moveShare('alice', S, 'm2', 'prod')).toEqual({ sharedTabId: S })
      expect(p.machine.findFirst).toHaveBeenCalledWith({ where: { machineId: 'm2', userId: 'alice', autonomousEnv: 'prod' }, select: { machineId: true } })
      // Only the owner's live share of this environment: a stopped one starts again by a put, never by a move.
      expect(p.agentMessageShare.updateMany).toHaveBeenCalledWith({ where: { id: S, ownerUserId: 'alice', autonomousEnv: 'prod', stoppedAt: null },
        data: { ownerMachineId: 'm2' } })
      // An invitation names the computer to expect the roster from; only those still waiting are changed.
      expect(p.agentMessageInvite.updateMany).toHaveBeenCalledWith({ where: { shareId: S, acceptedAt: null, revokedAt: null }, data: { ownerMachineId: 'm2' } })
    })
    it('says a stopped share, or one of another owner, is not found, and changes nothing else', async () => {
      p.agentMessageShare.updateMany.mockResolvedValue({ count: 0 })
      expect(await moveShare('alice', S, 'm1', 'prod')).toEqual({ error: 'NOT_FOUND' })
      expect(p.agentMessageInvite.updateMany).not.toHaveBeenCalled()
    })
    it('refuses a machine of another account, or one gone, before touching the share', async () => {
      p.machine.findFirst.mockResolvedValue(null)
      expect(await moveShare('alice', S, 'm-bob', 'prod')).toEqual({ error: 'FORBIDDEN' })
      expect(p.agentMessageShare.updateMany).not.toHaveBeenCalled()
      expect(p.agentMessageInvite.updateMany).not.toHaveBeenCalled()
    })
    it('refuses the old machine\'s next roster once the share moved', async () => {
      p.agentMessageShare.findUnique.mockResolvedValue({ ownerMachineId: 'm2', rosterVersion: 4, stoppedAt: null })
      expect(await put({ machineId: 'm1', version: 5 })).toEqual({ error: 'FORBIDDEN' })
      expect(p.agentMessageShare.updateMany).not.toHaveBeenCalled()
    })
  })

  it('lists owned shares with members and invitations, joined shares without', async () => {
    const at = new Date('2029-05-05T00:00:00Z')
    const mine = { id: S, ownerUserId: 'alice', ownerMachineId: 'm1', tabId: 'tab-1', rosterVersion: 2, roster: { sig: 'a' } }
    const theirs = { id: 'S2', ownerUserId: 'carol', ownerMachineId: 'm7', tabId: 'tab-9', rosterVersion: 4, roster: { sig: 'c' } }
    p.agentMessageMember.findMany
      .mockResolvedValueOnce([{ shareId: 'S2' }])
      .mockResolvedValueOnce([{ userId: 'bob', email: 'bob@x.io', acceptedAt: at }])
    p.agentMessageShare.findMany.mockResolvedValue([mine, theirs])
    p.user.findMany.mockResolvedValue([{ id: 'alice', email: 'alice@x.io' }, { id: 'carol', email: 'carol@x.io' }])
    p.agentMessageInvite.findMany.mockResolvedValue([{ id: 'i1', email: 'dan@x.io', expiresAt: at }])
    expect(await listShares('alice', 'prod')).toEqual([
      { sharedTabId: S, owner: true, ownerEmail: 'alice@x.io', ownerMachineId: 'm1', version: 2, roster: { sig: 'a' }, tabId: 'tab-1',
        members: [{ userId: 'bob', email: 'bob@x.io', acceptedAt: at.toISOString() }],
        invites: [{ id: 'i1', email: 'dan@x.io', expiresAt: at.toISOString() }] },
      { sharedTabId: 'S2', owner: false, ownerEmail: 'carol@x.io', ownerMachineId: 'm7', version: 4, roster: { sig: 'c' } },
    ])
    expect(p.agentMessageMember.findMany).toHaveBeenNthCalledWith(1, { where: { userId: 'alice', removedAt: null }, select: { shareId: true } })
    expect(p.agentMessageShare.findMany).toHaveBeenCalledWith({ where: { autonomousEnv: 'prod', stoppedAt: null,
      OR: [{ ownerUserId: 'alice' }, { id: { in: ['S2'] } }] } })
    expect(p.agentMessageMember.findMany).toHaveBeenNthCalledWith(2, { where: { shareId: S, removedAt: null }, select: { userId: true, email: true, acceptedAt: true } })
    expect(p.agentMessageInvite.findMany).toHaveBeenCalledWith({ where: { shareId: S, acceptedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      select: { id: true, email: true, expiresAt: true } })
  })

  it('falls back to an empty owner email in a listing', async () => {
    p.agentMessageMember.findMany.mockResolvedValue([])
    p.agentMessageShare.findMany.mockResolvedValue([{ id: 'S2', ownerUserId: 'gone', ownerMachineId: 'm7', tabId: 't', rosterVersion: 1, roster: null }])
    p.user.findMany.mockResolvedValue([])
    expect((await listShares('bob', 'prod'))[0]).toMatchObject({ ownerEmail: '', owner: false })
  })

  describe('admits', () => {
    it('admits the owner', async () => {
      p.agentMessageShare.findFirst.mockResolvedValue({ ownerUserId: 'alice' })
      expect(await admits('alice', 'm1', S, 'prod')).toBe(true)
      expect(p.agentMessageShare.findFirst).toHaveBeenCalledWith({ where: { id: S, autonomousEnv: 'prod', stoppedAt: null }, select: { ownerUserId: true } })
      expect(p.agentMessageMember.findFirst).not.toHaveBeenCalled()
    })
    it('admits an active member', async () => {
      p.agentMessageShare.findFirst.mockResolvedValue({ ownerUserId: 'alice' })
      p.agentMessageMember.findFirst.mockResolvedValue({ id: 'x' })
      expect(await admits('bob', 'm1', S, 'prod')).toBe(true)
      expect(p.agentMessageMember.findFirst).toHaveBeenCalledWith({ where: { shareId: S, userId: 'bob', removedAt: null }, select: { id: true } })
    })
    it('refuses a removed member', async () => {
      p.agentMessageShare.findFirst.mockResolvedValue({ ownerUserId: 'alice' })
      p.agentMessageMember.findFirst.mockResolvedValue(null)
      expect(await admits('bob', 'm1', S, 'prod')).toBe(false)
    })
    it('refuses a stopped or unknown share', async () => {
      p.agentMessageShare.findFirst.mockResolvedValue(null)
      expect(await admits('alice', 'm1', S, 'prod')).toBe(false)
    })
    it('refuses a machine the account does not own', async () => {
      p.machine.findFirst.mockResolvedValue(null)
      expect(await admits('alice', 'm9', S, 'prod')).toBe(false)
      expect(p.agentMessageShare.findFirst).not.toHaveBeenCalled()
    })
  })
  describe('who to tell', () => {
    it('names the owner of a share, or nobody', async () => {
      p.agentMessageShare.findUnique.mockResolvedValueOnce({ ownerUserId: 'alice' }).mockResolvedValueOnce(null)
      expect(await shareOwner(S)).toBe('alice')
      expect(await shareOwner(S)).toBeNull()
      expect(p.agentMessageShare.findUnique).toHaveBeenCalledWith({ where: { id: S }, select: { ownerUserId: true } })
    })
    it('lists the current members', async () => {
      p.agentMessageMember.findMany.mockResolvedValue([{ userId: 'bob' }, { userId: 'carol' }])
      expect(await shareMemberIds(S)).toEqual(['bob', 'carol'])
      expect(p.agentMessageMember.findMany).toHaveBeenCalledWith({ where: { shareId: S, removedAt: null }, select: { userId: true } })
    })
    it('finds the account behind an email, ignoring case and spaces', async () => {
      p.user.findUnique.mockResolvedValueOnce({ id: 'bob' }).mockResolvedValueOnce(null)
      expect(await accountIdByEmail(' Bob@X.io ')).toBe('bob')
      expect(await accountIdByEmail('none@x.io')).toBeNull()
      expect(p.user.findUnique).toHaveBeenCalledWith({ where: { email: 'bob@x.io' }, select: { id: true } })
    })
  })
})
