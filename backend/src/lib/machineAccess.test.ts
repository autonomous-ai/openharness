import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  prisma: {
    machineShare: { findUnique: vi.fn(), findMany: vi.fn() },
    machineShareAdd: { findUnique: vi.fn(), findMany: vi.fn() },
    machine: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  presence: vi.fn(), keys: vi.fn(), keysOf: vi.fn(),
}))
vi.mock('./prisma.js', () => ({ prisma: mocks.prisma, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }))
vi.mock('./bus.js', () => ({ getAgentPresenceMany: mocks.presence }))
vi.mock('./deviceKeyLog.js', () => ({ activeMachineKeys: mocks.keys, activeMachineKeysOf: mocks.keysOf }))
import { machinesSharedWith, shareMembers, sharedMachineAccess, sharedVia } from './machineAccess.js'
import { emailDomain, isPublicEmailDomain } from './publicEmailDomains.js'

const pub = (n: number) => Buffer.alloc(32, n).toString('base64')
const kim = { sub: 'kim', email: ' Kim@Acme.io ', role: 'user', autonomousEnv: 'prod' as const }
const share = (patch: Record<string, unknown> = {}) => ({ id: 's1', machineId: 'm1', ownerId: 'owner', autonomousEnv: 'prod',
  emails: [] as string[], domain: null as string | null, grantVersions: null, createdAt: new Date(), updatedAt: new Date(), ...patch })
const machine = (patch: Record<string, unknown> = {}) => ({ machineId: 'm1', userId: 'owner', autonomousEnv: 'prod', name: 'Studio',
  hostname: 'studio.local', billingStatus: 'not_required', ...patch })

describe('public email domains', () => {
  it('reads a domain, and knows the ones anyone can have an address at', () => {
    expect(emailDomain(' Kim@Acme.IO ')).toBe('acme.io')
    expect(emailDomain('kim@localhost')).toBeNull()
    expect(emailDomain('no-at-all')).toBeNull()
    for (const domain of ['gmail.com', 'GMAIL.COM', 'privaterelay.appleid.com', 'pending.harness.invalid', 'x.invalid', null]) {
      expect(isPublicEmailDomain(domain)).toBe(true)
    }
    expect(isPublicEmailDomain('acme.io')).toBe(false)
  })
})

describe('who a share reaches', () => {
  it('names an address, or everyone at the domain, never a public one', () => {
    expect(sharedVia(share({ emails: ['kim@acme.io'] }), kim.email)).toBe('email')
    expect(sharedVia(share({ domain: 'acme.io' }), kim.email)).toBe('domain')
    expect(sharedVia(share({ domain: 'acme.io' }), 'kim@other.io')).toBeNull()
    // A row that somehow holds a public domain shares with no one through it.
    expect(sharedVia(share({ domain: 'gmail.com' }), 'stranger@gmail.com')).toBeNull()
    expect(sharedVia(share(), kim.email)).toBeNull()
  })
})

describe('sharedMachineAccess', () => {
  beforeEach(() => { vi.resetAllMocks() })

  // The owner, 2026-10-16: a machine shared with the domain is used as one shared by email is, nothing to add.
  it('lets a named address in, and a colleague at the domain as well, with nothing to add first', async () => {
    mocks.prisma.machineShare.findUnique.mockResolvedValue(share({ emails: ['kim@acme.io'] }))
    expect(await sharedMachineAccess(kim, machine())).toBe('email')
    mocks.prisma.machineShare.findUnique.mockResolvedValue(share({ domain: 'acme.io' }))
    expect(await sharedMachineAccess(kim, machine())).toBe('domain')
    expect(mocks.prisma.machineShareAdd.findUnique).not.toHaveBeenCalled()
  })

  it('refuses the owner (no share needed), no share, another owner’s row and another environment', async () => {
    expect(await sharedMachineAccess(kim, machine({ userId: 'kim' }))).toBeNull()
    expect(mocks.prisma.machineShare.findUnique).not.toHaveBeenCalled()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(null)
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share({ emails: ['kim@acme.io'], ownerId: 'someone-else' }))
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share({ emails: ['kim@acme.io'], autonomousEnv: 'stag' }))
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share({ emails: ['kim@acme.io'] }))
    expect(await sharedMachineAccess(kim, machine({ autonomousEnv: 'stag' }))).toBeNull()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share({ emails: ['ann@acme.io'] }))
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
  })
})

describe('machinesSharedWith', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.presence.mockResolvedValue(new Map([['m1', 'mgr']]))
    mocks.prisma.machineShareAdd.findMany.mockResolvedValue([])
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 'owner', name: 'Dee', email: 'dee@acme.io' }])
    mocks.keys.mockResolvedValue([{ machineId: 'm1', pub: pub(1), label: 'studio', kind: 'machine', addedAt: 1, seq: 1 }])
  })

  it('lists named and domain shares alike, with the owner and the machine key', async () => {
    mocks.prisma.machineShare.findMany.mockResolvedValue([share({ emails: ['kim@acme.io'] }), share({ machineId: 'm2', domain: 'acme.io' })])
    mocks.prisma.machine.findMany.mockResolvedValue([machine(), machine({ machineId: 'm2', name: null, hostname: null })])
    const rows = await machinesSharedWith(kim)
    expect(mocks.prisma.machineShare.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      autonomousEnv: 'prod', ownerId: { not: 'kim' }, OR: [{ emails: { has: 'kim@acme.io' } }, { domain: 'acme.io' }],
    } }))
    expect(rows).toEqual([
      { machineId: 'm1', name: 'Studio', hostname: 'studio.local', authMode: 'remote', status: 'running', pub: pub(1),
        share: { ownerName: 'Dee', ownerEmail: 'dee@acme.io', via: 'email', added: true } },
      { machineId: 'm2', name: null, hostname: null, authMode: 'remote', status: 'offline', pub: null,
        share: { ownerName: 'Dee', ownerEmail: 'dee@acme.io', via: 'domain', added: true } },
    ])
    expect(mocks.prisma.machineShareAdd.findMany).not.toHaveBeenCalled()
  })

  it('asks no domain at a public one, and drops deleted, suspended and re-owned machines', async () => {
    const gmail = { ...kim, email: 'kim@gmail.com' }
    mocks.prisma.machineShare.findMany.mockResolvedValue([share({ emails: ['kim@gmail.com'] }), share({ machineId: 'm2', emails: ['kim@gmail.com'] }),
      share({ machineId: 'm3', emails: ['kim@gmail.com'] })])
    mocks.prisma.machine.findMany.mockResolvedValue([machine({ billingStatus: 'suspended' }), machine({ machineId: 'm2', userId: 'thief' })])
    expect(await machinesSharedWith(gmail)).toEqual([])
    expect(mocks.prisma.machineShare.findMany.mock.calls[0][0].where.OR).toEqual([{ emails: { has: 'kim@gmail.com' } }])
  })

  it('answers nothing without touching machines when nothing reaches the person', async () => {
    mocks.prisma.machineShare.findMany.mockResolvedValue([share({ emails: ['ann@acme.io'] })])
    expect(await machinesSharedWith(kim)).toEqual([])
    expect(mocks.prisma.machine.findMany).not.toHaveBeenCalled()
  })

  it('names an owner with no name by email, and one gone as a Harness user', async () => {
    mocks.prisma.machineShare.findMany.mockResolvedValue([share({ domain: 'acme.io' })])
    mocks.prisma.machine.findMany.mockResolvedValue([machine()])
    mocks.prisma.user.findMany.mockResolvedValueOnce([{ id: 'owner', name: null, email: 'dee@acme.io' }])
    expect((await machinesSharedWith(kim))[0].share).toEqual({ ownerName: 'dee@acme.io', ownerEmail: 'dee@acme.io', via: 'domain', added: true })
    mocks.prisma.user.findMany.mockResolvedValueOnce([])
    expect((await machinesSharedWith(kim))[0].share).toMatchObject({ ownerName: 'Harness user', ownerEmail: '' })
  })
})

describe('shareMembers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.keys.mockImplementation(async (id: string) => [{ machineId: `${id}-mac`, pub: pub(id.length), label: `${id}'s Mac`, kind: 'machine', addedAt: 1, seq: 1 }])
    mocks.keysOf.mockImplementation(async (ids: string[]) => new Map(ids.map(id => [id, [{ machineId: `${id}-mac`, pub: pub(id.length), label: `${id}'s Mac`, kind: 'machine', addedAt: 1, seq: 1 }]])))
  })

  // Diego's issue file (2026-10-27): one log replay per member made a 200-person domain 400+ parallel queries a read.
  it('shareMembers reads device key snapshots in one query', async () => {
    mocks.prisma.user.findMany.mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map(id => ({ id, email: `${id}@acme.io`, name: null })))
    const members = await shareMembers(share({ domain: 'acme.io' }))
    expect(members.map(m => m.machines)).toEqual(['a', 'b', 'c', 'd', 'e'].map(id => [{ machineId: `${id}-mac`, name: `${id}'s Mac`, pub: pub(1) }]))
    expect(mocks.keysOf).toHaveBeenCalledTimes(1)
    expect(mocks.keysOf).toHaveBeenCalledWith(['a', 'b', 'c', 'd', 'e'])
    expect(mocks.keys).not.toHaveBeenCalled()
  })

  it('names the addresses, then everyone at the domain, with their machines’ keys', async () => {
    mocks.prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'ann', email: 'Ann@Gmail.com', name: 'Ann' }])
      .mockResolvedValueOnce([
        { id: 'kim', email: 'kim@acme.io', name: null },
        { id: 'old', email: 'old@other.io', name: 'Old' }, // not at the domain after all: never trusted
      ])
    const members = await shareMembers(share({ emails: ['ann@gmail.com'], domain: 'acme.io' }))
    expect(mocks.prisma.user.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: {
      autonomousEnv: 'prod', id: { not: 'owner' }, email: { in: ['ann@gmail.com'] },
    } }))
    expect(mocks.prisma.user.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: {
      autonomousEnv: 'prod', id: { notIn: ['owner', 'ann'] }, email: { endsWith: '@acme.io', mode: 'insensitive' },
    } }))
    expect(members).toEqual([
      { email: 'ann@gmail.com', name: 'Ann', via: 'email', machines: [{ machineId: 'ann-mac', name: "ann's Mac", pub: pub(3) }] },
      { email: 'kim@acme.io', name: null, via: 'domain', machines: [{ machineId: 'kim-mac', name: "kim's Mac", pub: pub(3) }] },
    ])
    expect(mocks.prisma.machineShareAdd.findMany).not.toHaveBeenCalled()
  })

  it('asks for no one at the domain when it is not shared with the domain, or the domain is a public one', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 'ann', email: 'ann@gmail.com', name: 'Ann' }])
    await shareMembers(share({ emails: ['ann@gmail.com'] }))
    await shareMembers(share({ emails: ['ann@gmail.com'], domain: 'gmail.com' }))
    expect(mocks.prisma.user.findMany).toHaveBeenCalledTimes(2)
    mocks.prisma.user.findMany.mockClear()
    // Shared with the domain alone: one query, for the domain.
    mocks.prisma.user.findMany.mockResolvedValue([])
    expect(await shareMembers(share({ domain: 'acme.io' }))).toEqual([])
    expect(mocks.prisma.user.findMany).toHaveBeenCalledTimes(1)
  })
})
