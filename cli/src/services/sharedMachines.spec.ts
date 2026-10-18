import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCore } from '../testing/fakeCore.js'
import type { Asker, BackendNotice } from '../core/api.js'
import type { PortFailure, SharedMachine, SharedMachinesPort, SharePolicy } from '../lib/sharedMachinesPort.js'
import { normalizeEmails, readPolicy, SHARE_EMAILS_MAX, SHARED_MACHINES_REQUESTS, startSharedMachines, trustedKeys } from './sharedMachines.js'

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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shared-machines-'))
    file = join(dir, 'shared-machines.json')
    timers = []
    log.mockReset()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const start = (port: ReturnType<typeof fakePort> | null, notices?: Array<(n: BackendNotice) => void>) => {
    const core = fakeCore({ dataDir: dir, account: { onNotice: vi.fn((listener) => { notices?.push(listener); return () => {} }) } })
    return startSharedMachines(core, { port: port as SharedMachinesPort | null, file, setTimer, log }).shared_machines!
  }

  it('declares its one request', () => {
    expect(SHARED_MACHINES_REQUESTS).toEqual(['shared_machines'])
  })

  it('is the owner’s alone', async () => {
    const handle = start(fakePort())
    expect(await handle({ action: 'get' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await handle({ action: 'teleport' }, owner)).toEqual({ error: 'UNKNOWN_ACTION' })
  })

  describe('this machine’s sharing', () => {
    it('is off by default, and offers the owner’s domain', async () => {
      expect(await start(fakePort())({ action: 'get' }, owner)).toEqual({ emails: [], sameDomain: false, domain: 'acme.io', members: [] })
    })

    it('shares with addresses and the domain: published, kept here, and the machines it names trusted', async () => {
      const port = fakePort({ policy: vi.fn(async () => policy({ emails: ['ann@gmail.com'], sameDomain: true, members: [ann, kim,
        { email: 'old@acme.io', name: null, via: 'email', machines: [] }] })) })
      const view = await start(port)({ action: 'set', emails: [' Ann@Gmail.com ', 'ann@gmail.com'], sameDomain: true }, owner)
      expect(port.publish).toHaveBeenCalledWith(['ann@gmail.com'], true)
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ emails: ['ann@gmail.com'], sameDomain: true })
      expect(port.trust).toHaveBeenCalledWith({ pins: [], keys: [
        { machineId: 'a'.repeat(32), pub: key(2), label: 'Machine · ann@gmail.com' },
        { machineId: 'k'.repeat(32), pub: key(1), label: 'Kim’s Mac · kim@acme.io' },
      ] })
      // Who uses it: those this machine's own policy names, never one the backend alone lists.
      expect(view).toEqual({ emails: ['ann@gmail.com'], sameDomain: true, domain: 'acme.io', members: [
        { email: 'ann@gmail.com', name: null, via: 'email', machines: 1 },
        { email: 'kim@acme.io', name: 'Kim', via: 'domain', machines: 1 },
      ] })
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
      expect(readPolicy(file)).toEqual({ emails: [], sameDomain: false })
    })

    it('reads as kept here when the backend cannot say, and signed out', async () => {
      writeFileSync(file, JSON.stringify({ emails: ['ann@gmail.com'], sameDomain: true }))
      expect(await start(fakePort({ policy: vi.fn(async () => down) }))({ action: 'get' }, owner)).toEqual({
        emails: ['ann@gmail.com'], sameDomain: true, domain: null, members: [], error: 'BACKEND_UNREACHABLE', message: down.failed.message })
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
      expect(readPolicy(file)).toEqual({ emails: ['ann@gmail.com'], sameDomain: false })
      // Held the same way on both sides: nothing to tell.
      port.publish.mockClear()
      port.policy.mockResolvedValue(policy({ emails: ['ann@gmail.com'], members: [ann] }))
      await fire()
      expect(port.publish).not.toHaveBeenCalled()
      expect(port.trust).toHaveBeenLastCalledWith({ pins: [], keys: [{ ...ann.machines[0], label: 'Machine · ann@gmail.com' }] })
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
    expect(readPolicy(join(dir, 'missing.json'))).toEqual({ emails: [], sameDomain: false })
    writeFileSync(file, '{')
    expect(readPolicy(file)).toEqual({ emails: [], sameDomain: false })
    writeFileSync(file, JSON.stringify({ emails: ['nope'], sameDomain: 'yes' }))
    expect(readPolicy(file)).toEqual({ emails: [], sameDomain: false })
    expect(normalizeEmails([7])).toBeNull()
    expect(normalizeEmails([`${'x'.repeat(250)}@a.io`])).toBeNull()
  })

  it('trusts only the members its own policy names', () => {
    expect(trustedKeys({ emails: [], sameDomain: true }, policy({ domain: null, members: [kim] }))).toEqual([])
    expect(trustedKeys({ emails: [], sameDomain: false }, policy({ members: [kim, ann] }))).toEqual([])
    expect(trustedKeys({ emails: [], sameDomain: true }, policy({ members: [{ ...kim, email: 'kim@other.io' }] }))).toEqual([])
  })

  it('keeps its own timer, file and log by default', async () => {
    vi.useFakeTimers()
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
    } finally { said.mockRestore(); vi.useRealTimers() }
  })
})
