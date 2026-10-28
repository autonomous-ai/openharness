import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCore } from '../testing/fakeCore.js'
import { emptyPorts, type Asker, type BackendNotice } from '../core/api.js'
import type { GuestHelperState } from '../lib/guestHelperInstall.js'
import type { PortFailure, SharedMachine, SharedMachinesPort, SharePolicy } from '../lib/sharedMachinesPort.js'
import type { GuestLaunches } from './guestLaunches.js'
import { guestLaunchInput, normalizeEmails, normalizeFolders, ownerFolderProblem, readPolicy, SHARE_EMAILS_MAX, SHARED_FOLDERS_MAX,
  SHARED_MACHINES_REQUESTS, startSharedMachines, stillShared, trustedKeys } from './sharedMachines.js'

// The real guests reach the machine (the helper, sudo, the owner's sign-ins, a loopback relay): never in a test. The
// defaults are proven against these fakes, which say what they were asked.
const machine = vi.hoisted(() => ({ state: 'missing' as string, relayLog: null as ((line: string) => void) | null }))
vi.mock('../lib/guestHelperInstall.js', () => ({
  guestHelperStatus: vi.fn(async () => ({ state: machine.state, version: null })),
  installGuestHelper: vi.fn(async () => ({ ok: false, code: 'CANCELLED', message: 'cancelled' })),
}))
vi.mock('../lib/guestAccounts.js', async (actual) => ({
  ...await actual<typeof import('../lib/guestAccounts.js')>(),
  createGuestAccounts: () => ({ ensureGuest: async () => ({ user: 'hg_0123456789ab', home: '/g', workspace: '/g/work' }) }),
}))
vi.mock('../lib/ownerSubscriptions.js', () => ({ createOwnerSubscriptions: () => ({}) }))
vi.mock('../lib/subscriptionRelay.js', async (actual) => ({
  ...await actual<typeof import('../lib/subscriptionRelay.js')>(),
  startSubscriptionRelay: vi.fn(async (deps: { log: (line: string) => void }) => {
    machine.relayLog = deps.log
    return { port: 1, url: 'http://127.0.0.1:1', mintToken: () => 'token', revoke: () => {}, close: async () => {} }
  }),
}))

const owner: Asker = { local: true, owner: true }
const key = (n: number) => Buffer.alloc(32, n).toString('base64')
const M = 'ab'.repeat(16)
const down: PortFailure = { failed: { status: 502, code: 'BACKEND_UNREACHABLE', message: 'Could not reach the Harness backend.' } }

function policy(patch: Partial<SharePolicy> = {}): SharePolicy {
  return { emails: [], sameDomain: false, domain: 'acme.io', members: [], ...patch }
}
const kim = { email: 'kim@acme.io', name: 'Kim', via: 'domain' as const, machines: [{ machineId: 'k'.repeat(32), pub: key(1), label: 'Kim’s Mac' }] }
const ann = { email: 'ann@gmail.com', name: null, via: 'email' as const, machines: [{ machineId: 'a'.repeat(32), pub: key(2), label: '' }] }
const studio: SharedMachine = { machineId: M, name: 'Studio', hostname: 'studio.local', pub: key(3),
  share: { ownerName: 'Dee', ownerEmail: 'dee@acme.io', via: 'domain', added: true } }

function fakePort(over: Partial<SharedMachinesPort> = {}): { [K in keyof SharedMachinesPort]: ReturnType<typeof vi.fn> } {
  return {
    policy: vi.fn(async () => policy()),
    publish: vi.fn(async (emails: string[], sameDomain: boolean) => policy({ emails, sameDomain })),
    shared: vi.fn(async () => []),
    add: vi.fn(async () => true as const),
    remove: vi.fn(async () => true as const),
    trust: vi.fn(async () => ({ pins: 0, keys: 0 })),
    ...over,
  } as never
}

describe('shared machines', () => {
  let dir: string
  let file: string
  let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>
  const setTimer = (fn: () => void, ms: number) => {
    const t = { fn, ms, cancelled: false }
    timers.push(t)
    return { cancel: () => { t.cancelled = true } }
  }
  const live = () => timers.filter((t) => !t.cancelled)
  const fire = async () => { const t = live().at(-1)!; t.cancelled = true; t.fn(); await vi.waitFor(() => expect(live().length).toBe(1)) }
  const log = vi.fn()
  let guests: { [K in keyof GuestLaunches]: ReturnType<typeof vi.fn> }
  let guestAccess: ReturnType<typeof vi.fn<() => Promise<GuestHelperState>>>
  let enableGuests: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shared-machines-'))
    file = join(dir, 'shared-machines.json')
    timers = []
    log.mockReset()
    guests = { launch: vi.fn(async () => ({ ok: true, workspace: '/g/work', argv: ['sh'], env: {} })), sync: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    guestAccess = vi.fn(async () => 'ready' as const)
    enableGuests = vi.fn(async () => ({ ok: true }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const start = (port: ReturnType<typeof fakePort> | null, notices?: Array<(n: BackendNotice) => void>, ports?: ReturnType<typeof emptyPorts>) => {
    const core = fakeCore({ dataDir: dir, account: { onNotice: vi.fn((listener) => { notices?.push(listener); return () => {} }) } })
    return startSharedMachines(core, { port: port as SharedMachinesPort | null, file, setTimer, log, guests: guests as never, guestAccess,
      enableGuests: enableGuests as never, folderProblem: (path) => (path.includes('secret') ? `Only your own folders can be shared: ${path}` : null),
      ...(ports ? { ports } : {}) }).shared_machines!
  }

  it('declares its requests: the owner\'s, and where a guest may start a harness', () => {
    expect(SHARED_MACHINES_REQUESTS).toEqual(['shared_machines', 'guest_folders'])
  })

  it('is the owner’s alone', async () => {
    const handle = start(fakePort())
    expect(await handle({ action: 'get' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await handle({ action: 'teleport' }, owner)).toEqual({ error: 'UNKNOWN_ACTION' })
  })

  describe('this machine’s sharing', () => {
    it('is off by default, and offers the owner’s domain', async () => {
      expect(await start(fakePort())({ action: 'get' }, owner)).toEqual({ emails: [], sameDomain: false, folders: [], domain: 'acme.io', members: [], guestAccess: 'ready' })
    })

    it('shares with addresses and the domain: published, kept here, and the machines it names trusted', async () => {
      const port = fakePort({ policy: vi.fn(async () => policy({ emails: ['ann@gmail.com'], sameDomain: true, members: [ann, kim,
        { email: 'old@acme.io', name: null, via: 'email', machines: [] }] })) })
      const view = await start(port)({ action: 'set', emails: [' Ann@Gmail.com ', 'ann@gmail.com'], sameDomain: true }, owner)
      expect(port.publish).toHaveBeenCalledWith(['ann@gmail.com'], true)
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ emails: ['ann@gmail.com'], sameDomain: true, folders: [] })
      expect(port.trust).toHaveBeenCalledWith({ pins: [], keys: [
        // Each key with the account it is shared with: whose guest its sessions are.
        { machineId: 'a'.repeat(32), pub: key(2), label: 'Machine · ann@gmail.com', email: 'ann@gmail.com' },
        { machineId: 'k'.repeat(32), pub: key(1), label: 'Kim’s Mac · kim@acme.io', email: 'kim@acme.io' },
      ] })
      // Who uses it: those this machine's own policy names, never one the backend alone lists.
      expect(view).toEqual({ emails: ['ann@gmail.com'], sameDomain: true, folders: [], domain: 'acme.io', members: [
        { email: 'ann@gmail.com', name: null, via: 'email', machines: 1 },
        { email: 'kim@acme.io', name: 'Kim', via: 'domain', machines: 1 },
      ], guestAccess: 'ready' })
    })

    it('refuses what is not a list of addresses, and says why the backend did', async () => {
      const port = fakePort({ publish: vi.fn(async () => ({ failed: { status: 400, code: 'PUBLIC_DOMAIN', message: 'It is a public email domain.' } })) })
      const handle = start(port)
      // An address the backend would refuse is named, never sent: a whole save once failed on `name@!gmail.com`.
      expect(await handle({ action: 'set', emails: ['ann@gmail.com', 'bitcoinbuilder.ai@!gmail.com'], sameDomain: false }, owner))
        .toEqual({ error: 'BAD_REQUEST', message: 'Not an email address: bitcoinbuilder.ai@!gmail.com' })
      for (const payload of [{ emails: 'a@b.io', sameDomain: false }, { emails: ['nope'], sameDomain: false }, { emails: [7], sameDomain: false }, { emails: [], sameDomain: 'yes' },
        { emails: Array.from({ length: SHARE_EMAILS_MAX + 1 }, (_, i) => `p${i}@acme.io`), sameDomain: false }]) {
        expect(await handle({ action: 'set', ...payload }, owner)).toMatchObject({ error: 'BAD_REQUEST' })
      }
      expect(await handle({ action: 'set', emails: [], sameDomain: true }, owner)).toEqual({ error: 'PUBLIC_DOMAIN', message: 'It is a public email domain.' })
      expect(readPolicy(file)).toEqual({ emails: [], sameDomain: false, folders: [] })
    })

    it('reads as kept here when the backend cannot say, and signed out', async () => {
      writeFileSync(file, JSON.stringify({ emails: ['ann@gmail.com'], sameDomain: true }))
      expect(await start(fakePort({ policy: vi.fn(async () => down) }))({ action: 'get' }, owner)).toEqual({
        emails: ['ann@gmail.com'], sameDomain: true, folders: [], domain: null, members: [], error: 'BACKEND_UNREACHABLE', message: down.failed.message })
      const before = timers.length
      const signedOut = start(null)
      expect(await signedOut({ action: 'get' }, owner)).toMatchObject({ emails: ['ann@gmail.com'], error: 'NOT_SIGNED_IN' })
      expect(await signedOut({ action: 'set', emails: [], sameDomain: false }, owner)).toMatchObject({ error: 'NOT_SIGNED_IN' })
      expect(await signedOut({ action: 'add', machineId: M }, owner)).toMatchObject({ error: 'NOT_SIGNED_IN' })
      // Signed out, nothing is read: no timer.
      expect(timers.length).toBe(before)
    })

    it('offers no domain sharing at a public one, even one kept from before', async () => {
      writeFileSync(file, JSON.stringify({ emails: [], sameDomain: true }))
      const port = fakePort({ policy: vi.fn(async () => policy({ domain: null })) })
      expect(await start(port)({ action: 'get' }, owner)).toMatchObject({ sameDomain: false, domain: null })
    })
  })

  describe('machines shared with this account', () => {
    it('adds one shared with the domain, and pins the machines it may use', async () => {
      const port = fakePort({ shared: vi.fn(async () => [studio, { ...studio, machineId: 'n'.repeat(32), name: null, hostname: null, share: { ...studio.share, ownerEmail: '', added: false } },
        { ...studio, machineId: 'x'.repeat(32), pub: null }, { ...studio, machineId: 'h'.repeat(32), name: null, share: { ...studio.share, via: 'email' as const, ownerEmail: '' } },
        { ...studio, machineId: 'z'.repeat(32), name: null, hostname: null }]) })
      expect(await start(port)({ action: 'add', machineId: M }, owner)).toEqual({ ok: true })
      expect(port.add).toHaveBeenCalledWith(M)
      expect(port.trust).toHaveBeenCalledWith({ pins: [
        { machineId: M, pub: key(3), label: 'Studio · dee@acme.io' },
        { machineId: 'h'.repeat(32), pub: key(3), label: 'studio.local · Dee' },
        { machineId: 'z'.repeat(32), pub: key(3), label: 'Machine · dee@acme.io' },
      ], keys: [] })
    })

    it('takes one back out, and says why it could not', async () => {
      const port = fakePort({ remove: vi.fn(async () => ({ failed: { status: 404, code: 'NOT_SHARED', message: 'This machine is not shared with you.' } })) })
      const handle = start(port)
      expect(await handle({ action: 'remove', machineId: M }, owner)).toEqual({ error: 'NOT_SHARED', message: 'This machine is not shared with you.' })
      expect(await handle({ action: 'remove' }, owner)).toEqual({ error: 'BAD_REQUEST' })
      port.remove.mockResolvedValueOnce(true)
      expect(await handle({ action: 'remove', machineId: M }, owner)).toEqual({ ok: true })
    })
  })

  describe('reading again', () => {
    it('starts soon, again when the machines change, and every few minutes, more often while anything is shared', async () => {
      const notices: Array<(n: BackendNotice) => void> = []
      const port = fakePort()
      start(port, notices)
      expect(live().map((t) => t.ms)).toEqual([5_000])
      await fire()
      expect(port.trust).toHaveBeenCalledWith({ pins: [], keys: [] })
      expect(live().map((t) => t.ms)).toEqual([15 * 60_000])
      notices[0]({ type: 'desk_changed', revision: 1 } as BackendNotice)
      expect(live().map((t) => t.ms)).toEqual([15 * 60_000])
      // A harness shared or taken back changes no machine's sharing: every member's daemon read it again a second after each.
      notices[0]({ type: 'machines_changed', reason: 'harness_shares' })
      expect(live().map((t) => t.ms)).toEqual([15 * 60_000])
      notices[0]({ type: 'machines_changed', reason: 'updated' })
      expect(live().map((t) => t.ms)).toEqual([1_000])
      port.shared.mockResolvedValue([studio])
      await fire()
      expect(live().map((t) => t.ms)).toEqual([2 * 60_000])
    })

    it('tells the backend again what this machine holds, and stops sharing at a domain that went public', async () => {
      writeFileSync(file, JSON.stringify({ emails: ['ann@gmail.com'], sameDomain: true }))
      const port = fakePort({ policy: vi.fn(async () => policy({ domain: null })) })
      start(port)
      await fire()
      expect(port.publish).toHaveBeenCalledWith(['ann@gmail.com'], false)
      expect(readPolicy(file)).toEqual({ emails: ['ann@gmail.com'], sameDomain: false, folders: [] })
      // Held the same way on both sides: nothing to tell.
      port.publish.mockClear()
      port.policy.mockResolvedValue(policy({ emails: ['ann@gmail.com'], members: [ann] }))
      await fire()
      expect(port.publish).not.toHaveBeenCalled()
      expect(port.trust).toHaveBeenLastCalledWith({ pins: [], keys: [{ ...ann.machines[0], label: 'Machine · ann@gmail.com', email: 'ann@gmail.com' }] })
    })

    it('keeps what the backend holds after telling it again, so an address it drops is written once and then left alone', async () => {
      // The backend never holds the owner's own address. Kept here, it read back as a different policy at every
      // read, so the daemon wrote it again every two minutes and each write told every member's apps to re-read.
      writeFileSync(file, JSON.stringify({ emails: ['dee@acme.io', 'ann@gmail.com'], sameDomain: false }))
      let held: string[] = []
      const port = fakePort({
        policy: vi.fn(async () => policy({ emails: held })),
        publish: vi.fn(async (emails: string[], sameDomain: boolean) => {
          held = emails.filter((e) => e !== 'dee@acme.io')
          return policy({ emails: held, sameDomain })
        }),
      })
      start(port)
      await fire()
      expect(port.publish).toHaveBeenCalledExactlyOnceWith(['dee@acme.io', 'ann@gmail.com'], false)
      expect(readPolicy(file).emails).toEqual(['ann@gmail.com'])
      await fire()
      await fire()
      expect(port.publish).toHaveBeenCalledOnce()
    })

    it('changes only what it could read, and nothing when it read nothing', async () => {
      const port = fakePort({ shared: vi.fn(async () => down), policy: vi.fn(async () => down) })
      start(port)
      await fire()
      expect(port.trust).not.toHaveBeenCalled()
      port.policy.mockResolvedValue(policy())
      await fire()
      expect(port.trust).toHaveBeenLastCalledWith({ keys: [] })
      port.shared.mockResolvedValue([])
      port.policy.mockResolvedValue(down)
      await fire()
      expect(port.trust).toHaveBeenLastCalledWith({ pins: [] })
      // A publish that failed is not written as the policy here.
      writeFileSync(file, JSON.stringify({ emails: [], sameDomain: true }))
      port.policy.mockResolvedValue(policy({ domain: null }))
      port.publish.mockResolvedValue(down)
      await fire()
      expect(readPolicy(file).sameDomain).toBe(true)
      expect(port.trust).toHaveBeenLastCalledWith({ pins: [] })
    })

    it('logs a read or a trust update that failed, and goes on', async () => {
      const port = fakePort({ trust: vi.fn(async () => down) })
      start(port)
      await fire()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('could not update the trust stores'))
      port.shared.mockRejectedValueOnce(new Error('boom'))
      await fire()
      expect(log).toHaveBeenCalledWith('read failed: boom')
      port.shared.mockRejectedValueOnce('odd')
      await fire()
      expect(log).toHaveBeenCalledWith('read failed: odd')
    })

    it('runs one read at a time, and one asked for meanwhile right after', async () => {
      let release: () => void = () => {}
      const port = fakePort({ shared: vi.fn(() => new Promise<SharedMachine[]>((resolve) => { release = () => resolve([]) })) })
      const handle = start(port)
      const adding = handle({ action: 'add', machineId: M }, owner)
      const removing = handle({ action: 'remove', machineId: M }, owner)
      await vi.waitFor(() => expect(port.shared).toHaveBeenCalledTimes(1))
      release()
      await vi.waitFor(() => expect(port.shared).toHaveBeenCalledTimes(2))
      release()
      expect(await adding).toEqual({ ok: true })
      expect(await removing).toEqual({ ok: true })
      expect(port.shared).toHaveBeenCalledTimes(2)
    })
  })

  it('reads a policy file that is missing, broken or holds what is not an address as off', () => {
    expect(readPolicy(join(dir, 'missing.json'))).toEqual({ emails: [], sameDomain: false, folders: [] })
    writeFileSync(file, '{')
    expect(readPolicy(file)).toEqual({ emails: [], sameDomain: false, folders: [] })
    writeFileSync(file, JSON.stringify({ emails: ['nope'], sameDomain: 'yes' }))
    expect(readPolicy(file)).toEqual({ emails: [], sameDomain: false, folders: [] })
    expect(normalizeEmails([7])).toBeNull()
    expect(normalizeEmails([`${'x'.repeat(250)}@a.io`])).toBeNull()
  })

  it('trusts only the members its own policy names', () => {
    expect(trustedKeys({ emails: [], sameDomain: true, folders: [] }, policy({ domain: null, members: [kim] }))).toEqual([])
    expect(trustedKeys({ emails: [], sameDomain: false, folders: [] }, policy({ members: [kim, ann] }))).toEqual([])
    expect(trustedKeys({ emails: [], sameDomain: true, folders: [] }, policy({ members: [{ ...kim, email: 'kim@other.io' }] }))).toEqual([])
  })

  describe('guests', () => {
    // A guest's harness runs as their own OS account, on the owner's subscription
    // (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
    const input = { email: 'kim@acme.io', engine: 'claude', bypassPermission: true }

    it('says whether guest access is on, and turns it on behind the owner\'s one admin prompt', async () => {
      const handle = start(fakePort())
      guestAccess.mockResolvedValueOnce('missing')
      expect(await handle({ action: 'get' }, owner)).toMatchObject({ guestAccess: 'missing' })
      expect(await handle({ action: 'enable_guests' }, owner)).toEqual({ ok: true, guestAccess: 'ready' })
      expect(enableGuests).toHaveBeenCalledTimes(1)
      enableGuests.mockResolvedValueOnce({ ok: false, code: 'CANCELLED', message: 'Sharing was not turned on: the admin prompt was cancelled.' })
      expect(await handle({ action: 'enable_guests' }, owner)).toEqual({ error: 'CANCELLED', message: 'Sharing was not turned on: the admin prompt was cancelled.' })
      expect(await handle({ action: 'enable_guests' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
      // A helper that cannot be read is off.
      guestAccess.mockRejectedValue(new Error('EACCES'))
      expect(await handle({ action: 'get' }, owner)).toMatchObject({ guestAccess: 'missing' })
      expect(await handle({ action: 'enable_guests' }, owner)).toEqual({ ok: true, guestAccess: 'missing' })
    })

    it('builds a guest\'s harness for the core, and stops its relay and its reads when the service stops', async () => {
      const ports = emptyPorts()
      start(fakePort(), undefined, ports)
      expect(await ports.sharedMachines!.guestLaunch(input)).toEqual({ ok: true, workspace: '/g/work', argv: ['sh'], env: {} })
      expect(guests.launch).toHaveBeenCalledWith(input)
      expect(live()).toHaveLength(1)
      await ports.sharedMachines!.stop()
      expect(live()).toHaveLength(0)
      expect(guests.stop).toHaveBeenCalledTimes(1)
      // Stopped before its first read was scheduled: nothing to cancel.
      const early = emptyPorts()
      const core = fakeCore({ dataDir: dir })
      startSharedMachines(core, { port: null, file, setTimer, log, guests: guests as never, guestAccess, enableGuests: enableGuests as never, ports: early })
      await early.sharedMachines!.stop()
    })

    it('keeps sharing true at each read: the guests it names, and every address it may name', async () => {
      writeFileSync(file, JSON.stringify({ emails: ['ann@gmail.com', 'bo@x.io'], sameDomain: true }))
      const port = fakePort({ policy: vi.fn(async () => policy({ emails: ['ann@gmail.com', 'bo@x.io'], sameDomain: true, members: [ann, kim] })) })
      start(port)
      await fire()
      const [still, shared] = guests.sync.mock.calls[0] as [(email: string) => boolean, string[]]
      expect(['ann@gmail.com', 'kim@acme.io', 'lee@other.io'].map(still)).toEqual([true, true, false])
      // The policy's addresses, and the backend's members: each once.
      expect(shared).toEqual(['ann@gmail.com', 'bo@x.io', 'kim@acme.io'])
      // A read that could not say whom it is shared with changes nothing.
      guests.sync.mockClear()
      port.policy.mockResolvedValue(down)
      await fire()
      expect(guests.sync).not.toHaveBeenCalled()
    })

    describe('folders', () => {
      it('shares the owner\'s folders with every guest, read or read-write, and takes them back', async () => {
        const port = fakePort()
        const handle = start(port)
        const view = await handle({ action: 'set_folders', folders: [{ path: '/Users/dee/code/app/', write: true }, { path: '/Users/dee/docs', write: false }] }, owner)
        expect(view).toMatchObject({ folders: [{ path: '/Users/dee/code/app', write: true }, { path: '/Users/dee/docs', write: false }] })
        expect(readPolicy(file).folders).toEqual([{ path: '/Users/dee/code/app', write: true }, { path: '/Users/dee/docs', write: false }])
        // Given to the guests now, by a read of the sharing.
        expect(guests.sync).toHaveBeenCalled()
        // Sharing with someone keeps the folders.
        await handle({ action: 'set', emails: ['kim@acme.io'], sameDomain: false }, owner)
        expect(readPolicy(file)).toMatchObject({ emails: ['kim@acme.io'], folders: [{ path: '/Users/dee/code/app', write: true }, { path: '/Users/dee/docs', write: false }] })
        expect(await handle({ action: 'set_folders', folders: [] }, owner)).toMatchObject({ folders: [] })
      })

      it('signed out, gives them to the guests at once all the same', async () => {
        const handle = start(null)
        await handle({ action: 'set_folders', folders: [{ path: '/Users/dee/docs', write: false }] }, owner)
        const [still, shared] = guests.sync.mock.calls[0] as [(email: string) => boolean, string[]]
        expect(shared).toEqual([])
        expect(still('kim@acme.io')).toBe(false)
      })

      it('refuses what is not a folder of the owner\'s, by name, and changes nothing', async () => {
        const handle = start(fakePort())
        expect(await handle({ action: 'set_folders', folders: [{ path: '/Users/kim/secret', write: false }] }, owner))
          .toEqual({ error: 'BAD_REQUEST', message: 'Only your own folders can be shared: /Users/kim/secret' })
        for (const folders of ['/x', [{ path: 'relative', write: false }], [{ path: '/x' }], [{ path: '/', write: true }],
          [{ path: '/x', write: true }, { path: '/x/', write: false }], [{ path: '/a\tb', write: true }], [null],
          Array.from({ length: SHARED_FOLDERS_MAX + 1 }, (_, i) => ({ path: `/f${i}`, write: false }))]) {
          expect(await handle({ action: 'set_folders', folders }, owner), JSON.stringify(folders)).toMatchObject({ error: 'BAD_REQUEST' })
        }
        expect(await handle({ action: 'set_folders', folders: [] }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
        expect(readPolicy(file).folders).toEqual([])
      })

      it('tells a guest where it may start a harness: its workspace and the folders shared with it', async () => {
        writeFileSync(file, JSON.stringify({ emails: ['kim@acme.io'], sameDomain: false, folders: [{ path: '/Users/dee/docs', write: false }] }))
        const core = fakeCore({ dataDir: dir })
        const requests = startSharedMachines(core, { port: null, file, setTimer, log, guests: guests as never, guestAccess, enableGuests: enableGuests as never })
        const folders = requests.guest_folders!
        expect(await folders({}, { local: false, owner: false, guest: 'Kim@acme.io' })).toEqual({
          workspace: expect.stringMatching(/\/hg_[0-9a-f]{12}\/work$/), folders: [{ path: '/Users/dee/docs', write: false }] })
        expect(await folders({}, owner)).toEqual({ workspace: null, folders: [{ path: '/Users/dee/docs', write: false }] })
        // A session that is neither: nothing.
        expect(await folders({}, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
        expect(await folders({}, { local: false, owner: false, guest: '' })).toEqual({ error: 'OWNER_REQUIRED' })
      })

      it('reads folders as full paths, each once, never /, and nothing from a file that holds otherwise', () => {
        expect(normalizeFolders([{ path: '/a/b/../c/', write: true }])).toEqual([{ path: '/a/c', write: true }])
        expect(normalizeFolders([{ path: `/${'x'.repeat(4096)}`, write: true }])).toBeNull()
        expect(normalizeFolders([{ path: '/a\nb', write: true }])).toBeNull()
        writeFileSync(file, JSON.stringify({ emails: [], sameDomain: false, folders: [{ path: 'nope', write: true }] }))
        expect(readPolicy(file).folders).toEqual([])
      })

      it('says in words why a folder cannot be shared, before the helper would', () => {
        const home = mkdtempSync(join(tmpdir(), 'owner-home-'))
        try {
          mkdirSync(join(home, 'code'))
          writeFileSync(join(home, 'notes.txt'), 'x')
          const guests = join(home, 'guests')
          mkdirSync(join(guests, 'hg_0123456789ab'), { recursive: true })
          const uid = process.getuid!()
          expect(ownerFolderProblem(join(home, 'code'), home, guests, uid)).toBeNull()
          expect(ownerFolderProblem(join(home, 'missing'), home, guests, uid)).toMatch(/^No such folder on this computer/)
          expect(ownerFolderProblem(join(home, 'notes.txt'), home, guests, uid)).toMatch(/^Not a folder/)
          expect(ownerFolderProblem(home, home, guests, uid)).toMatch(/whole home folder/)
          expect(ownerFolderProblem(join(guests, 'hg_0123456789ab'), home, guests, uid)).toMatch(/belongs to someone you share with/)
          expect(ownerFolderProblem(guests, home, guests, uid)).toMatch(/belongs to someone you share with/)
          expect(ownerFolderProblem(join(home, 'code'), home, guests, uid + 1)).toMatch(/your own folders/)
          // A platform with no uids checks the rest; the defaults are this account's.
          expect(ownerFolderProblem(join(home, 'code'), home, guests, undefined)).toBeNull()
          expect(ownerFolderProblem(join(home, 'missing'))).toMatch(/^No such folder/)
        } finally { rmSync(home, { recursive: true, force: true }) }
      })
    })

    it('reads a launch the core asked for, and nothing else as one', () => {
      expect(guestLaunchInput({ ...input, extra: 1 })).toEqual(input)
      expect(guestLaunchInput({ ...input, prompt: 'Fix the tests' })).toEqual({ ...input, prompt: 'Fix the tests' })
      expect(guestLaunchInput({ ...input, prompt: '' })).toEqual(input)
      expect(guestLaunchInput({ ...input, cwd: '/Users/dee/docs' })).toEqual({ ...input, cwd: '/Users/dee/docs' })
      expect(guestLaunchInput({ ...input, cwd: '' })).toEqual(input)
      expect(guestLaunchInput({ ...input, permissionFlags: ['--permission-mode', 'auto'] })).toEqual({ ...input, permissionFlags: ['--permission-mode', 'auto'] })
      for (const permissionFlags of ['--x', [7], ['; rm -rf /'], ['a', 'b', 'c', 'd', 'e'], ['--model=x']]) {
        expect(guestLaunchInput({ ...input, permissionFlags }), JSON.stringify(permissionFlags)).toBeNull()
      }
      for (const payload of [{}, { ...input, email: 1 }, { ...input, engine: null }, { ...input, bypassPermission: 'yes' }, { ...input, prompt: 7 }, { ...input, cwd: 7 }]) {
        expect(guestLaunchInput(payload as Record<string, unknown>)).toBeNull()
      }
    })

    it('shares with whom the policy names: by address, or by the owner\'s domain while it has one', () => {
      expect(stillShared({ emails: ['ann@gmail.com'], sameDomain: false, folders: [] }, 'acme.io', 'ann@gmail.com')).toBe(true)
      expect(stillShared({ emails: [], sameDomain: true, folders: [] }, 'acme.io', 'kim@acme.io')).toBe(true)
      expect(stillShared({ emails: [], sameDomain: true, folders: [] }, null, 'kim@acme.io')).toBe(false)
      expect(stillShared({ emails: [], sameDomain: false, folders: [] }, 'acme.io', 'kim@acme.io')).toBe(false)
      expect(stillShared({ emails: [], sameDomain: true, folders: [] }, 'acme.io', 'kim@acme.io.evil.io')).toBe(false)
    })
  })

  it('keeps its own guests, helper check and install by default, on the machine\'s helper and the owner\'s sign-ins', async () => {
    const said = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('LANG', 'vi_VN.UTF-8')
    try {
      const ports = emptyPorts()
      const handle = startSharedMachines(fakeCore({ dataDir: dir }), { port: fakePort() as never, file, setTimer, ports }).shared_machines!
      machine.state = 'missing'
      expect(await handle({ action: 'get' }, owner)).toMatchObject({ guestAccess: 'missing' })
      expect(await handle({ action: 'enable_guests' }, owner)).toEqual({ error: 'CANCELLED', message: 'cancelled' })
      // Folders are checked on this computer as they are shared.
      expect(await handle({ action: 'set_folders', folders: [{ path: join(dir, 'missing'), write: false }] }, owner))
        .toEqual({ error: 'BAD_REQUEST', message: `No such folder on this computer: ${join(dir, 'missing')}` })
      expect(await ports.sharedMachines!.guestLaunch({ email: 'kim@acme.io', engine: 'claude', bypassPermission: true })).toMatchObject({ ok: false, error: 'GUEST_HELPER_REQUIRED' })
      machine.state = 'ready'
      expect(await ports.sharedMachines!.guestLaunch({ email: 'kim@acme.io', engine: 'claude', bypassPermission: true }))
        .toMatchObject({ ok: true, workspace: '/g/work', env: expect.objectContaining({ LANG: 'vi_VN.UTF-8' }) })
      machine.relayLog!('claude · 200')
      expect(said).toHaveBeenCalledWith('[shared-machines] guest launch · claude · hg_0123456789ab')
      expect(said).toHaveBeenCalledWith('[shared-machines] relay · claude · 200')
      await ports.sharedMachines!.stop()
    } finally { said.mockRestore(); vi.unstubAllEnvs() }
  })

  it('keeps its own timer, file and log by default', async () => {
    vi.useFakeTimers()
    // No LANG of the owner's: a guest's harness gets the default (lib/guestPaneCommand.ts).
    vi.stubEnv('LANG', '')
    const said = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const notices: Array<(n: BackendNotice) => void> = []
      const core = fakeCore({ dataDir: dir, account: { onNotice: vi.fn((listener) => { notices.push(listener); return () => {} }) } })
      const port = fakePort({ trust: vi.fn(async () => down) })
      startSharedMachines(core, { port: port as never })
      notices[0]({ type: 'machines_changed', reason: 'updated' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(port.shared).toHaveBeenCalledTimes(1)
      expect(said).toHaveBeenCalledWith(expect.stringContaining('[shared-machines] could not update the trust stores'))
      startSharedMachines(core)
    } finally { said.mockRestore(); vi.useRealTimers(); vi.unstubAllEnvs() }
  })
})
