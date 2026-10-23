import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { b64e, newEphemeral, newIdentity } from '../lib/e2ee/core.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { TerminalBackendCoordinator } from '../lib/terminalBackendCoordinator.js'
import type { TerminalStreamSink } from '../lib/terminalTypes.js'
import { decodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'
import { HarnessGrantStore } from './grants.js'
import { HarnessCollaborationStore } from './collaboration.js'
import { HarnessShareOwner, type ShareOwnerDeps } from './owner.js'
import { recipientHandshake, type ObserverCipher } from './crypto.js'
import type { Roster } from '../messages/roster.js'

describe('owner authority and read-only observation', () => {
  let root: string, store: HarnessGrantStore, owner: HarnessShareOwner
  const identity = newIdentity()
  let frames: Array<{ id: string; type: string; payload: any }>
  let agents: Map<string, RegisteredSession>
  let publish: Mock<ShareOwnerDeps['publish']>, send: Mock<ShareOwnerDeps['send']>, watchViewer: Mock<NonNullable<ShareOwnerDeps['watchViewer']>>
  let opened: Array<{ sink: TerminalStreamSink; handle: any }>
  let machineId: string
  let rosters: Mock<NonNullable<ShareOwnerDeps['rosters']>>
  beforeEach(() => {
    vi.useFakeTimers()
    root = mkdtempSync(join(tmpdir(), 'share-owner-test-'))
    store = new HarnessGrantStore(join(root, 'grants.json'))
    frames = []; opened = []; machineId = 'machine'
    agents = new Map([['agent', { agentId: 'agent', sessionId: 's', engine: 'codex',
      active: true, projectPath: '/tmp/project', runtimes: [{ backend: 'tmux', paneId: '%1' }],
      primaryRuntimeKey: 'tmux:default:%1' } as unknown as RegisteredSession]])
    publish = vi.fn(async () => ({ status: 200, body: {} }))
    rosters = vi.fn(async () => ({ accountId: 'bob', rosters: [] as Roster[], consent: new Set<string>() }))
    send = vi.fn((id, type, payload) => { frames.push({ id, type, payload }); return true })
    watchViewer = vi.fn((_id, callback) => { callback({ state: 'live', data: 'jpeg' }); return vi.fn() })
    owner = new HarnessShareOwner({ machineId: () => machineId, identity, grants: store, rosters,
      resolveAgent: id => agents.get(id), send, publish, watchViewer,
      terminals: { openStream: async (_agent: RegisteredSession, _size: unknown, sink: TerminalStreamSink, readOnly: boolean) => {
        expect(readOnly).toBe(true)
        const handle = { runtime: { backend: 'tmux', paneId: '%1' },
          snapshot: vi.fn(async () => ({ state: 'succeeded', value: { bytes: Buffer.from('hello'), cols: 120, rows: 40 } })),
          beginSnapshot: vi.fn(), endSnapshot: vi.fn(), close: vi.fn(async () => {}),
          writeRaw: vi.fn(), pasteRaw: vi.fn(), resize: vi.fn(), scroll: vi.fn(),
          pauseOutput: vi.fn(async () => ({ state: 'succeeded' })), resumeOutput: vi.fn(async () => ({ state: 'succeeded' })) }
        opened.push({ sink, handle })
        return { state: 'succeeded', value: handle }
      } } as unknown as TerminalBackendCoordinator,
    })
  })
  afterEach(async () => { await owner.stop(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
  async function invite(emails = ['ken@example.com']) {
    return owner.manage('harness_share_invite', { agentId: 'agent', emails })
  }
  async function connect(email = 'ken@example.com', id = 'observer:ken') {
    const grant = store.list('machine', 'agent').find(g => g.recipientEmail === email)!
    const ephemeral = newEphemeral()
    await owner.receive(id, 'observer_open', { shareId: grant.id, email, ephemeral: b64e(ephemeral.pub) })
    const welcome = frames.findLast(f => f.id === id && f.type === 'observer_welcome')!
    const cipher = recipientHandshake(ephemeral, 'machine', grant.id, b64e(identity.pub), welcome.payload)
    return { id, cipher, grant }
  }
  async function request(client: { id: string; cipher: ObserverCipher }, type: string, payload: Record<string, unknown> = {}) {
    await owner.receive(client.id, 'observer_frame', client.cipher.seal({ type, payload }) as any)
  }
  function read(client: { id: string; cipher: ObserverCipher }) {
    const list = frames.filter(f => f.id === client.id && f.type === 'observer_frame')
    frames = frames.filter(f => f.id !== client.id || f.type !== 'observer_frame')
    return list.map(f => client.cipher.open(f.payload) as any)
  }
  it('validates management, normalizes duplicate emails and preserves invitation IDs on renewal', async () => {
    expect(await owner.manage('harness_share_list', {})).toMatchObject({ error: 'HARNESS_NOT_FOUND' })
    expect(await owner.manage('wrong', { agentId: 'agent' })).toMatchObject({ error: 'UNSUPPORTED' })
    expect(await invite(['bad'])).toMatchObject({ error: 'INVALID_INVITATION' })
    const result = await invite([' Ken@Example.com ', 'ken@example.com', 'diego@example.com'])
    expect(result.shares).toHaveLength(2)
    expect(publish).toHaveBeenCalledTimes(2)
    const first = store.all()[0]
    expect(first.pending).toBe(false)
    expect(first.recipientEmail).toBe('ken@example.com')
    await invite()
    expect(store.all().find(g => g.recipientEmail === first.recipientEmail)?.id).toBe(first.id)
    expect(await owner.manage('harness_share_remove', { agentId: 'agent', id: 'missing' })).toMatchObject({ error: 'INVITATION_NOT_FOUND' })
  })
  it('gives two observers independent streams and only read capabilities, with no control or resizing', async () => {
    await invite(['ken@example.com', 'diego@example.com'])
    const ken = await connect(), diego = await connect('diego@example.com', 'observer:diego')
    for (const client of [ken, diego]) {
      await request(client, 'terminal_capabilities', { requestId: 'cap' })
      const capabilities = read(client)[0].payload
      expect(capabilities.engines.every((e: any) => !e.input && !e.resize && !e.mouse && !e.paste)).toBe(true)
      await request(client, 'terminal_open', { requestId: 'open', protocolVersion: 3, agentId: 'agent', cols: 200, rows: 100 })
      const received = read(client)
      expect(received[0]).toMatchObject({ type: 'terminal_ready', payload: { readOnly: true } })
      const keyframe = decodeTerminalLocal(Buffer.from(received[1].payload.bytes, 'base64'))
      expect(keyframe?.kind).toBe(TerminalBinaryKind.keyframe)
      expect(Buffer.from(keyframe!.bytes).toString()).toBe('hello')
    }
    expect(opened).toHaveLength(2)
    opened[0].sink.onData(Buffer.from('live update'))
    await vi.advanceTimersByTimeAsync(8)
    expect(read(ken)).toHaveLength(1)
    expect(read(diego)).toHaveLength(0)
    for (const type of ['terminal_input', 'terminal_resize', 'terminal_paste', 'terminal_takeover',
      'terminal_scroll', 'send', 'answer', 'read_file', 'list_agents', 'delete_agent', 'harness_share_invite']) {
      await request(ken, type, { agentId: 'agent', requestId: type })
      expect(read(ken)[0]).toMatchObject({ type: 'terminal_error', payload: { code: 'VIEW_ONLY', requestId: type } })
    }
    for (const payload of [{ agentId: 'unshared' }, {}]) {
      await request(ken, 'terminal_open', payload)
      expect(read(ken)[0].payload.code).toBe('VIEW_ONLY')
    }
    for (const { handle } of opened) {
      expect(handle.writeRaw).not.toHaveBeenCalled(); expect(handle.pasteRaw).not.toHaveBeenCalled()
      expect(handle.resize).not.toHaveBeenCalled(); expect(handle.scroll).not.toHaveBeenCalled()
    }
    expect((await owner.manage('harness_share_list', { agentId: 'agent' })).shares).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: 'ken@example.com', watching: 1 })]))
  })
  it('streams viewer pixels once per observer and immediately closes a revoked viewer', async () => {
    await invite()
    const client = await connect()
    await request(client, 'observer_viewer')
    await request(client, 'observer_viewer')
    expect(watchViewer).toHaveBeenCalledTimes(1)
    expect(read(client)[0]).toMatchObject({ type: 'observer_viewer', payload: { data: 'jpeg' } })
    publish.mockRejectedValue(new Error('offline'))
    expect((await owner.manage('harness_share_remove', { agentId: 'agent', id: client.grant.id })).shares).toEqual([])
    expect(watchViewer.mock.results[0].value).toHaveBeenCalledTimes(1)
    expect(frames.at(-1)).toMatchObject({ type: 'observer_closed', payload: { reason: 'Access removed', retry: false } })
    expect(new HarnessGrantStore(join(root, 'grants.json')).active(client.grant.id, 'ken@example.com', 'machine')).toBeNull()
    watchViewer.mock.calls[0][1]({ data: 'late pixels' })
    expect(read(client)).toEqual([])
    await owner.receive(client.id, 'observer_open', { shareId: client.grant.id, email: 'ken@example.com' })
    expect(frames.at(-1)?.type).toBe('observer_closed')
  })
  it('fails closed for forged, replayed, wrong-email and malformed observer frames', async () => {
    await invite()
    const client = await connect()
    await owner.receive('ordinary-client', 'observer_open', {})
    await owner.receive('observer:unknown', 'observer_frame', {})
    const before = frames.length
    await owner.receive('observer:bad', 'observer_open', { shareId: client.grant.id, email: 'wrong@example.com' })
    await owner.receive('observer:bad', 'observer_open', { shareId: client.grant.id, email: 'ken@example.com', ephemeral: 'bad' })
    expect(frames.slice(before).every(f => f.type === 'observer_closed')).toBe(true)
    const packet = client.cipher.seal({ type: 'terminal_capabilities', payload: {} })
    await owner.receive(client.id, 'observer_frame', packet as any)
    await owner.receive(client.id, 'observer_frame', packet as any)
    expect(frames.at(-1)?.payload.reason).toBe('Invalid observer message')
    for (const value of [{}, { type: 4, payload: {} }, { type: 'terminal_open' }]) {
      const c = await connect('ken@example.com', `observer:${JSON.stringify(value)}`)
      await owner.receive(c.id, 'observer_frame', c.cipher.seal(value) as any)
      expect(frames.at(-1)?.payload.reason).toBe('Invalid observer message')
    }
    const c = await connect('ken@example.com', 'observer:repeated')
    await owner.receive(c.id, 'observer_open', {})
    expect(frames.at(-1)?.payload.reason).toBe('Invalid observer handshake')
    const d = await connect('ken@example.com', 'observer:other-type')
    await owner.receive(d.id, 'shell', {})
    expect(frames.at(-1)?.payload.reason).toBe('Invalid observer message')
  })
  it('closes on expiry, deleted harness, changed machine, and failed transport', async () => {
    await invite()
    const c = await connect()
    agents.clear()
    await request(c, 'observer_viewer')
    expect(frames.at(-1)?.type).toBe('observer_closed')
    agents.set('agent', { agentId: 'agent', engine: 'codex' } as RegisteredSession)
    const d = await connect('ken@example.com', 'observer:expired')
    vi.setSystemTime(Date.now() + 31 * 86400_000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(frames.findLast(f => f.id === d.id)?.type).toBe('observer_closed')
    await invite()
    const e = await connect('ken@example.com', 'observer:machine')
    machineId = 'another-machine'
    await vi.advanceTimersByTimeAsync(1000)
    expect(frames.findLast(f => f.id === e.id)?.type).toBe('observer_closed')
    machineId = 'machine'
    send.mockReturnValue(false)
    const grant = store.all()[0]
    await owner.receive('observer:failed', 'observer_open', { shareId: grant.id, email: grant.recipientEmail, ephemeral: b64e(newEphemeral().pub) })
    expect((await owner.manage('harness_share_list', { agentId: 'agent' })).shares).toEqual([expect.objectContaining({ watching: 0 })])
  })
  it('retains pending changes through outages, reports permanent failures and retries durable revocation', async () => {
    publish.mockResolvedValue({ status: 503, body: {} })
    expect((await invite()).shares).toEqual([expect.objectContaining({ pending: true })])
    publish.mockResolvedValue({ status: 400, body: { error: { message: 'You already own this harness.' } } })
    await owner.sync()
    const failed = store.all()[0]
    expect(failed.publicationError).toBe('You already own this harness.')
    expect(store.active(failed.id, failed.recipientEmail, 'machine')).toBeNull()
    publish.mockResolvedValue({ status: 403, body: {} })
    await invite()
    expect(store.all()[0].publicationError).toContain('could not be shared')
    publish.mockResolvedValue({ status: 200, body: {} })
    await invite()
    expect(store.all()[0].publicationError).toBeNull()
    publish.mockResolvedValue({ status: 404, body: {} })
    await owner.manage('harness_share_remove', { agentId: 'agent', id: failed.id })
    expect(store.all()[0]).toMatchObject({ revoked: true, pending: false })
  })
  it('serializes invitation changes, and a removal during a pending publication cannot be lost', async () => {
    await invite()
    const grant = store.all()[0]
    store.invite(grant)
    let finish!: (value: { status: number; body: {} }) => void
    publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const syncing = owner.sync()
    expect(owner.sync()).toBe(syncing)
    const remove = owner.manage('harness_share_remove', { agentId: 'agent', id: grant.id })
    await Promise.resolve()
    expect(store.all()[0].revoked).toBe(true)
    finish({ status: 200, body: {} })
    await remove
    expect(publish.mock.calls.at(-1)?.[0]).toBe('DELETE')
    expect(store.all()[0]).toMatchObject({ revoked: true, pending: false })
  })
  it('marks owner disconnects as recoverable and releases explicit departures', async () => {
    await invite()
    const c = await connect()
    await owner.receive(c.id, 'observer_close', {})
    expect(frames.at(-1)?.payload.retry).toBe(false)
    await connect('ken@example.com', 'observer:again')
    owner.closeAll()
    expect(frames.at(-1)?.payload).toMatchObject({ reason: 'Owner disconnected', retry: true })
    owner.close('observer:already-gone')
  })
  it('keeps valid observers alive, retries on its clock and recovers from a local persistence error', async () => {
    await invite(['ken@example.com', 'diego@example.com'])
    const ken = await connect(); await connect('diego@example.com', 'observer:diego')
    await vi.advanceTimersByTimeAsync(30000)
    expect(frames.filter(f => f.type === 'observer_closed')).toHaveLength(0)
    await owner.manage('harness_share_remove', { agentId: 'agent', id: ken.grant.id })
    expect((await owner.manage('harness_share_list', { agentId: 'agent' })).shares).toEqual([expect.objectContaining({ watching: 1 })])
    vi.spyOn(store, 'invite').mockImplementationOnce(() => { throw new Error('Disk full') })
    await expect(invite()).rejects.toThrow('Disk full')
    expect((await owner.manage('harness_share_list', { agentId: 'agent' })).shares).toHaveLength(1)
    const other = store.all().find(g => g.recipientEmail === 'diego@example.com')!
    store.failed(other.id, 'not published')
    expect(store.all().find(g => g.id === ken.grant.id)?.publicationError).toBeNull()
    store.invite(other)
    let finish!: (result: { status: number; body: {} }) => void
    publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const sync = owner.sync()
    store.revoke(other.id, 'machine', 'agent'); finish({ status: 403, body: {} }); await sync
    expect(store.all().find(g => g.id === other.id)).toMatchObject({ revoked: true, publicationError: null, pending: true })
  })

  describe('observers derived from the shared tabs\' rosters', () => {
    const KEY = 'A'.repeat(43) + '=', TAB = 'a'.repeat(24), DAY = 86400_000
    /** Bob (this account) asked for his harness `agent` on this machine in Alice's tab. */
    const ASKED = new Set([`${TAB}\nmachine\nagent`])
    /** A tab Alice owns, with Bob (this account) and Carol as members, and Bob's harness `agent` on this machine. */
    function tab(members = ['carol']): Roster {
      return { sharedTabId: TAB, version: 2, name: 'Launch',
        owner: { accountId: 'alice', email: 'alice@example.com', machineId: 'alice-mac', machinePublicKey: KEY }, leader: null,
        members: ['bob', ...members].map(id => ({ accountId: id, email: `${id}@example.com`, name: id, acceptedAt: '2026-10-15T00:00:00.000Z' })),
        harnesses: [{ accountId: 'bob', machineId: 'machine', machinePublicKey: KEY, agentId: 'agent', name: 'api', engine: 'codex' }],
        invites: [] }
    }
    /** Derive, and let what it published settle. */
    const derive = async () => { const result = await owner.manage('harness_share_rosters', {}); await owner.sync(); return result }
    const holding = (roster: Roster | null, consent: ReadonlySet<string> = ASKED) => { rosters.mockResolvedValue(roster && { accountId: 'bob', rosters: [roster], consent }) }
    const open = (grant: { id: string; recipientEmail: string }, id = 'observer:carol') =>
      owner.receive(id, 'observer_open', { shareId: grant.id, email: grant.recipientEmail, ephemeral: b64e(newEphemeral().pub) })
    const carolOf = () => store.all().find(g => g.recipientEmail === 'carol@example.com')!

    it('preserves unread legacy rosters while replacing only the current Super Tab grants', async () => {
      await owner.stop()
      const grant = (email: string, tab: string) => ({ agentId: 'agent', email, tab, name: 'api', engine: 'codex', ownerPublicKey: KEY })
      const expiry = new Date(Date.now() + 10 * DAY).toISOString()
      store.derive('machine', [grant('legacy@example.com', TAB), grant('removed@example.com', TAB), grant('old@example.com', 'super:old')], expiry, 0)
      store.derive('machine', [grant('legacy@example.com', TAB), grant('old@example.com', 'super:old')], expiry, 0)
      store.derive('other-machine', [grant('elsewhere@example.com', TAB)], expiry, 0)
      store.invite({ machineId: 'machine', agentId: 'agent', recipientEmail: 'manual@example.com', name: 'Manual', engine: 'codex', ownerPublicKey: KEY, expiresAt: expiry })
      rosters.mockResolvedValue(null)
      let wanted = [grant('current@example.com', 'super:current')]
      owner = new HarnessShareOwner({ machineId: () => machineId, identity, grants: store, rosters,
        derivedGrants: () => wanted, resolveAgent: id => agents.get(id), send, publish, terminals: {} as TerminalBackendCoordinator })
      await derive()
      const active = () => store.all().filter(g => !g.revoked).map(g => g.recipientEmail).sort()
      expect(active()).toEqual(['current@example.com', 'elsewhere@example.com', 'legacy@example.com', 'manual@example.com'])
      expect(publish.mock.calls.some(call => (call[2] as any)?.superTabId === 'current')).toBe(true)
      wanted = []
      await vi.advanceTimersByTimeAsync(1000); await owner.sync()
      expect(active()).toEqual(['elsewhere@example.com', 'legacy@example.com', 'manual@example.com'])
    })

    it('refuses and closes an observer immediately when its external grant authority expires', async () => {
      await owner.stop()
      let allowed = true
      owner = new HarnessShareOwner({ machineId: () => machineId, identity, grants: store,
        derivedGrants: () => [{ agentId: 'agent', email: 'carol@example.com', tab: 'super:tab', name: 'api', engine: 'codex' }],
        allowsGrant: () => allowed, resolveAgent: id => agents.get(id), send, publish, terminals: {} as TerminalBackendCoordinator })
      await derive(); await open(carolOf())
      expect(frames.at(-1)?.type).toBe('observer_welcome')
      allowed = false
      await owner.receive('observer:carol', 'observer_frame', {})
      expect(frames.at(-1)?.type).toBe('observer_closed')
      await open(carolOf(), 'observer:new')
      expect(frames.at(-1)).toMatchObject({ id: 'observer:new', type: 'observer_closed' })
    })

    it('keeps Swarm invitations while no roster is in force, and withdraws one only when its member leaves', async () => {
      await owner.stop()
      rosters.mockResolvedValue(null)
      const carol = { agentId: 'agent', email: 'carol@example.com', tab: 'super:tab', name: 'api', engine: 'codex' }
      let known: Array<typeof carol> | null = [carol]
      owner = new HarnessShareOwner({ machineId: () => machineId, identity, grants: store, rosters,
        derivedGrants: () => known, resolveAgent: id => agents.get(id), send, publish, terminals: {} as TerminalBackendCoordinator })
      await derive()
      expect(publish.mock.calls.map(c => c[0])).toEqual(['PUT'])
      // The host stalled: its roster lapsed. Neither the clock's derivation nor a nudge withdraws or sends anything again.
      known = null
      await vi.advanceTimersByTimeAsync(3000); await owner.sync()
      expect(await derive()).toEqual({ invited: 0, revoked: 0 })
      known = [carol]
      await vi.advanceTimersByTimeAsync(3000); await owner.sync()
      expect(publish.mock.calls.map(c => c[0])).toEqual(['PUT'])
      expect(carolOf().revoked).toBe(false)
      // A roster in force that no longer lists her is a real change: withdrawn at the next tick.
      known = []
      await vi.advanceTimersByTimeAsync(1000); await owner.sync()
      expect(carolOf().revoked).toBe(true)
      expect(publish.mock.calls.map(c => c[0])).toEqual(['PUT', 'DELETE'])
    })

    it('derives a grant for every other account in the tab, publishes it, and lets that observer watch', async () => {
      holding(tab())
      expect(await derive()).toEqual({ invited: 2, revoked: 0 })
      expect(publish.mock.calls.map(c => [c[0], (c[2] as any).recipientEmail, (c[2] as any).name])).toEqual([
        ['PUT', 'alice@example.com', 'api'], ['PUT', 'carol@example.com', 'api']])
      expect(store.all().every(g => g.tab === TAB && !g.pending && g.ownerPublicKey === b64e(identity.pub))).toBe(true)
      await open(carolOf())
      expect(frames.at(-1)).toMatchObject({ id: 'observer:carol', type: 'observer_welcome' })
      expect(await derive()).toEqual({ invited: 0, revoked: 0 })
    })

    it('grants nothing for a member harness this machine never asked for, nor one listed again after it was taken out', async () => {
      holding(tab(), new Set())
      expect(await derive()).toEqual({ invited: 0, revoked: 0 })
      expect(store.all()).toEqual([])
      holding(tab())
      expect(await derive()).toEqual({ invited: 2, revoked: 0 })
      // Taken out by the member (the consent goes, messages/consentStore.ts), the owner listing it again grants nothing.
      holding(tab(), new Set())
      expect(await derive()).toEqual({ invited: 0, revoked: 2 })
    })

    it('closes a removed member\'s observer as soon as the roster changes, and unpublishes its grant', async () => {
      holding(tab())
      await derive()
      const grant = carolOf()
      await open(grant)
      holding(tab([]))
      void owner.manage('harness_share_rosters', {})
      await vi.advanceTimersByTimeAsync(1000)
      expect(frames.findLast(f => f.id === 'observer:carol')).toMatchObject({ type: 'observer_closed', payload: { reason: 'Access removed' } })
      expect(publish).toHaveBeenLastCalledWith('DELETE', `/api/harness-shares/${grant.id}`, undefined)
      expect(store.active(grant.id, 'carol@example.com', 'machine')).toBeNull()
      // Added back, the member gets the same grant again.
      holding(tab())
      expect(await derive()).toEqual({ invited: 1, revoked: 0 })
      expect(carolOf()).toMatchObject({ id: grant.id, revoked: false })
    })

    it('closes it at once even while a slow publish holds the owner\'s controls', async () => {
      holding(tab())
      await derive()
      await open(carolOf())
      let finish!: (result: { status: number; body: {} }) => void
      publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const inviting = invite(['dave@example.com'])
      await Promise.resolve()
      holding(tab([]))
      expect(await owner.manage('harness_share_rosters', {})).toEqual({ invited: 0, revoked: 1 })
      expect(frames.findLast(f => f.id === 'observer:carol')).toMatchObject({ type: 'observer_closed', payload: { reason: 'Access removed' } })
      finish({ status: 200, body: {} })
      await inviting
      await owner.sync()
      expect(publish).toHaveBeenCalledWith('DELETE', `/api/harness-shares/${carolOf().id}`, undefined)
    })

    it('derives once as Share starts, so a member removed while it was off loses the view without a nudge', async () => {
      holding(tab())
      const started = new HarnessShareOwner({ machineId: () => machineId, identity, grants: store, rosters,
        resolveAgent: id => agents.get(id), send, publish, terminals: {} as TerminalBackendCoordinator })
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(store.all().filter(g => g.tab === TAB && !g.revoked)).toHaveLength(2)
        expect(rosters).toHaveBeenCalled()
      } finally { await started.stop() }
    })

    it('revokes nothing when the rosters or the account cannot be read', async () => {
      holding(tab())
      await derive()
      await open(carolOf())
      holding(null)
      expect(await derive()).toEqual({ invited: 0, revoked: 0 })
      rosters.mockRejectedValueOnce(new Error('EIO'))
      expect(await derive()).toEqual({ invited: 0, revoked: 0 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(frames.findLast(f => f.id === 'observer:carol')?.type).toBe('observer_welcome')
      expect(store.all().filter(g => !g.revoked)).toHaveLength(2)
    })

    it('hides derived grants from the Share list, refuses to remove one, and ignores them for a private link', async () => {
      holding(tab())
      await derive()
      expect((await owner.manage('harness_share_list', { agentId: 'agent' })).shares).toEqual([])
      const grant = store.all()[0]
      expect(await owner.manage('harness_share_remove', { agentId: 'agent', id: grant.id })).toMatchObject({ error: 'INVITATION_NOT_FOUND' })
      expect(store.active(grant.id, grant.recipientEmail, 'machine')).not.toBeNull()
      const linked = new HarnessShareOwner({ machineId: () => machineId, identity, grants: store, rosters,
        collaboration: new HarnessCollaborationStore(join(root, 'collaboration.json')),
        resolveAgent: id => agents.get(id), send, publish, terminals: {} as TerminalBackendCoordinator })
      try {
        const { link } = await linked.manage('harness_share_link', { agentId: 'agent', visibility: 'private' }) as { link: { id: string } }
        // Watching the tab's harness is not an invitation to its private link.
        await linked.receive('observer:link', 'observer_open', { linkId: link.id, email: grant.recipientEmail, ephemeral: b64e(newEphemeral().pub) })
        expect(frames.at(-1)).toMatchObject({ id: 'observer:link', type: 'observer_closed' })
        // Turning the link off takes back the person's invitations, never the tab's.
        await linked.manage('harness_share_link', { agentId: 'agent', visibility: 'off' })
        expect(store.all().filter(g => !g.revoked)).toHaveLength(2)
      } finally { await linked.stop() }
    })

    it('derives again and renews on its 30 s clock, and closes a removed member there at the latest', async () => {
      holding(tab())
      await derive()
      await open(carolOf())
      vi.setSystemTime(Date.now() + 24 * DAY)
      publish.mockClear()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(publish.mock.calls.map(c => c[0])).toEqual(['PUT', 'PUT'])
      expect(Date.parse(store.all()[0].expiresAt)).toBeGreaterThan(Date.now() + 29 * DAY)
      expect(frames.findLast(f => f.id === 'observer:carol')?.type).toBe('observer_welcome')
      holding(tab([]))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(frames.findLast(f => f.id === 'observer:carol')?.type).toBe('observer_closed')
      // A derivation that fails outright still publishes what waits.
      vi.spyOn(store, 'derive').mockImplementationOnce(() => { throw new Error('Disk full') })
      store.invite({ machineId: 'machine', agentId: 'agent', recipientEmail: 'dave@example.com', name: 'api', engine: 'codex',
        ownerPublicKey: carolOf().ownerPublicKey, expiresAt: new Date(Date.now() + DAY).toISOString() })
      publish.mockClear()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(publish).toHaveBeenCalledWith('PUT', expect.any(String), expect.objectContaining({ recipientEmail: 'dave@example.com' }))
    })

    it('runs one tick derivation at a time: a tick finding one still waiting starts no other', async () => {
      holding(tab())
      await derive()
      let release!: () => void
      rosters.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ accountId: 'bob', rosters: [tab()], consent: ASKED }) }))
      rosters.mockClear()
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(rosters).toHaveBeenCalledTimes(1)
      release()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(rosters).toHaveBeenCalledTimes(2)
    })

    it('tries a refused grant again on a roster change, and from the clock at most hourly', async () => {
      publish.mockResolvedValue({ status: 403, body: { error: { message: 'This machine is not available to share.' } } })
      holding(tab())
      await derive()
      expect(carolOf()).toMatchObject({ publicationError: 'This machine is not available to share.', failedAt: Date.now() })
      publish.mockClear()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(publish).not.toHaveBeenCalled()
      // A nudge tries every refused grant again.
      await derive()
      expect(publish).toHaveBeenCalledTimes(2)
      publish.mockClear()
      publish.mockResolvedValue({ status: 200, body: {} })
      // The clock does, once the refusal is an hour old.
      await vi.advanceTimersByTimeAsync(3600_000)
      expect(publish).toHaveBeenCalledTimes(2)
      expect(carolOf()).toMatchObject({ publicationError: null, pending: false })
    })

    it('still takes access away when this machine\'s key cannot be read, and derives nothing without rosters', async () => {
      let keyed = false
      const key = { publicKey: vi.fn(async () => { if (!keyed) throw new Error('no gateway'); return identity.pub }), signWelcome: vi.fn() }
      const keyless = new HarnessShareOwner({ machineId: () => machineId, key, grants: store, rosters,
        resolveAgent: id => agents.get(id), send, publish, terminals: {} as TerminalBackendCoordinator })
      try {
        holding(tab())
        expect(await keyless.manage('harness_share_rosters', {})).toEqual({ invited: 0, revoked: 0 })
        keyed = true
        expect(await keyless.manage('harness_share_rosters', {})).toEqual({ invited: 2, revoked: 0 })
        keyed = false
        holding(tab([]))
        expect(await keyless.manage('harness_share_rosters', {})).toEqual({ invited: 0, revoked: 1 })
        expect(store.all().find(g => g.recipientEmail === 'alice@example.com')).toMatchObject({ revoked: false })
      } finally { await keyless.stop() }
      const plain = new HarnessShareOwner({ machineId: () => machineId, identity, grants: store,
        resolveAgent: id => agents.get(id), send, publish, terminals: {} as TerminalBackendCoordinator })
      try { expect(await plain.manage('harness_share_rosters', {})).toEqual({ invited: 0, revoked: 0 }) } finally { await plain.stop() }
    })
  })
})
