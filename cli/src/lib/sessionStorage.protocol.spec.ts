/** Deterministic IPC faults complement the real-child descriptor and publication tests. */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as nativeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as bundle from '../harnessd/bundleFingerprint.js'
import * as custody from './secureState.js'
import { SessionStorage } from './sessionStorage.js'
import { sessionStorageFrames } from './sessionStorageFrames.js'
import { SessionStorageUnavailable, sessionFileIdentity, type SessionImageProof, type SessionStorageOperation } from './sessionStorageWire.js'

const launch = vi.hoisted(() => ({ spawn: vi.fn(), report: undefined as undefined | ((line: string) => void) }))
vi.mock('node:child_process', async original => ({ ...await original<object>(), spawn: launch.spawn }))
vi.mock('../harnessd/processName.js', () => ({ baseNode: (file: string) => file, namedNode: (file: string, _name: string, _root: string, options: { log(line: string): void }) => { launch.report = options.log; return file } }))
vi.mock('../harnessd/bundleFingerprint.js', async original => ({ ...await original<object>() }))
vi.mock('./secureState.js', async original => ({ ...await original<object>() }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, constants: { ...actual.constants } }
})

class Link extends EventEmitter {
  pid: number | undefined = 123456789 // A synthetic emitter only; this fixture never calls an OS signal.
  connected = true
  handshake = true
  holdKill = false
  sendError = false
  requests: Array<{ id: number; operation: SessionStorageOperation }> = []
  peer: ReturnType<typeof sessionStorageFrames> | undefined
  incarnation = ''
  kill = vi.fn(() => { if (!this.holdKill) queueMicrotask(() => this.exit()); return true })
  send(value: any, callback: (error?: Error) => void) {
    if (this.sendError) { callback(new Error('fixture IPC failure')); return }
    callback()
    if (value.protocol === 'session-storage-init-1') {
      this.incarnation = value.incarnation
      this.peer = sessionStorageFrames(value.incarnation, async frame => { queueMicrotask(() => this.emit('message', frame)) }, (id, body) => {
        this.requests.push({ id, operation: (body as { operation: SessionStorageOperation }).operation })
        this.emit('request')
      }, () => {})
      if (this.handshake) queueMicrotask(() => this.ready())
    } else queueMicrotask(() => this.peer?.message(value))
  }
  ready(value: unknown = { protocol: 'session-storage-ready-1', incarnation: this.incarnation }) { this.emit('message', value) }
  async requested(count = 1) {
    while (this.requests.length < count) await new Promise<void>(resolve => this.once('request', resolve))
    return this.requests[count - 1]
  }
  async answer(value: unknown, index = this.requests.length - 1, id = this.requests[index].id) {
    await this.peer!.send(id, value).catch(() => {})
  }
  exit() { this.connected = false; this.emit('exit', 0, null); this.peer?.close(); this.emit('close', 0, null) }
}

type Owner = { start(): Promise<void>; request<T>(operation: SessionStorageOperation): Promise<T>;
  active?: { expires: number }; queue: Array<{ expires: number }>; child?: ChildProcess }
let root: string, file: string, storage: SessionStorage, link: Link, expectedCloseFailure: boolean
const owner = () => storage as unknown as Owner
beforeEach(() => {
  expectedCloseFailure = false
  root = mkdtempSync(join(tmpdir(), 'storage-link-'))
  mkdirSync(join(root, 'data'), { mode: 0o700 })
  file = join(root, 'entry.mjs'); writeFileSync(file, '', { mode: 0o600 })
  vi.stubEnv('PATH', '/usr/bin:/bin')
  launch.spawn.mockReset()
  link = new Link()
  launch.spawn.mockImplementation(() => link)
  storage = new SessionStorage(join(root, 'data'), () => ({ file, sha256: bundle.fingerprint(file)! }))
})
afterEach(async () => {
  vi.useRealTimers()
  link.holdKill = false
  link.exit()
  try { await storage.close() } catch (error) { if (!expectedCloseFailure) throw error }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) }
})

it('validates fixed document paths and refuses an invalid archive container before starting a child', () => {
  expect(() => new SessionStorage(root, undefined, '../outside')).toThrow('invalid')
  expect(() => storage.path({ kind: 'stopped', agentId: '../outside' })).toThrow('invalid')
  expect(storage.path({ kind: 'legacy-registry' })).toBe(join(root, 'data', 'registry.pre-v2.json'))
  expect(storage.path({ kind: 'stopped', agentId: 'fixture' })).toBe(join(root, 'data', 'stopped-agents', 'fixture.json'))
  expect(storage.path({ kind: 'superseded', agentId: 'fixture' })).toBe(join(root, 'data', 'stopped-agents', 'superseded', 'fixture.json'))
  expect(launch.spawn.mock.calls.length).toBe(0)
})

it('refuses missing source and unconfigured packaged entries without spawning', async () => {
  storage = new SessionStorage(root)
  vi.spyOn(bundle, 'fingerprint').mockReturnValue(null)
  await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
  const endsWith = String.prototype.endsWith
  vi.spyOn(String.prototype, 'endsWith').mockImplementation(function (this: string, suffix, end) {
    return suffix === '.ts' && String(this).includes('/lib/sessionStorage.ts') ? false : endsWith.call(this, suffix, end)
  })
  storage = new SessionStorage(root)
  await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
  expect(launch.spawn.mock.calls.length).toBe(0)
})

it.each([null, { protocol: 'wrong' }, { protocol: 'session-storage-ready-1', incarnation: 'foreign' }])(
  'reaps an unadmitted handshake without sending a request (%#)', async reply => {
    link.handshake = false
    const reading = storage.read({ kind: 'registry' }).catch(error => error)
    link.ready(reply)
    expect(await reading).toMatchObject({ code: 'disconnected' })
    expect(link.requests).toEqual([])
    expect(link.kill).toHaveBeenCalledOnce()
  })

it.each(['spawn', 'initial-send', 'disconnected', 'running-error'])('settles %s failure through the proper process owner', async fault => {
  if (fault === 'initial-send') link.sendError = true
  if (fault === 'disconnected') link.connected = false
  const reading = storage.read({ kind: 'registry' }).catch(error => error)
  if (fault === 'spawn') { link.pid = undefined; link.emit('error', new Error('fixture spawn error')) }
  if (fault === 'running-error') { await link.requested(); link.emit('error', new Error('fixture child error')) }
  expect(await reading).toMatchObject({ code: 'disconnected' })
  if (fault === 'spawn') expect(link.kill).not.toHaveBeenCalled()
  else expect(link.kill).toHaveBeenCalledOnce()
})

it.each([null, {}, { ok: 'yes' }, { ok: false, code: 'private-error-message' }])(
  'reaps malformed reply envelopes without releasing the active request early (%#)', async answer => {
    const reading = storage.read({ kind: 'registry' }).catch(error => error)
    await link.requested()
    await link.answer(answer)
    expect(await reading).toMatchObject({ code: 'disconnected' })
    expect(owner().child).toBeUndefined()
  })

it('reaps a reply for another request and ignores messages from the retired child', async () => {
  const reading = storage.read({ kind: 'registry' }).catch(error => error)
  await link.requested()
  await link.answer({ ok: true, value: { state: 'missing' } }, 0, 77)
  expect(await reading).toMatchObject({ code: 'disconnected' })
  link.emit('message', { protocol: 'anything' })
  link.emit('error', new Error('retired child error'))
  expect(link.kill).toHaveBeenCalledOnce()
})

it('holds a hung child until actual exit after the monotonic deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  link.holdKill = true
  let settled = false
  const reading = storage.read({ kind: 'registry' }).catch(error => error).finally(() => { settled = true })
  await link.requested()
  await vi.advanceTimersByTimeAsync(5000)
  expect(link.kill).toHaveBeenCalledOnce()
  expect(settled).toBe(false)
  link.exit()
  expect(await reading).toMatchObject({ code: 'disconnected' })
})

it('refuses expired queued requests before sending them and bounds admission at 64 waiters', async () => {
  const first = storage.read({ kind: 'registry' })
  await link.requested()
  const waiting = Array.from({ length: 64 }, () => storage.read({ kind: 'names' }).catch(error => error))
  await expect(storage.read({ kind: 'names' })).rejects.toMatchObject({ code: 'busy' })
  for (const pending of owner().queue) pending.expires = 0
  await link.answer({ ok: true, value: { state: 'missing' } })
  expect(await first).toEqual({ state: 'missing' })
  expect((await Promise.all(waiting)).every(error => (error as { code: string }).code === 'expired')).toBe(true)
  expect(link.requests).toHaveLength(1)
})

it('checks the active deadline again after delayed admission', async () => {
  link.handshake = false
  const reading = storage.read({ kind: 'registry' }).catch(error => error)
  owner().active!.expires = 0
  link.ready()
  expect(await reading).toMatchObject({ code: 'disconnected' })
  expect(link.requests).toEqual([])
})

it('does not start or send a pending request after close during admission', async () => {
  link.handshake = false
  const reading = storage.read({ kind: 'registry' }).catch(error => error)
  const closing = storage.close()
  link.ready()
  await closing
  expect(await reading).toMatchObject({ code: 'disconnected' })
  await expect(owner().start()).rejects.toMatchObject({ code: 'disconnected' })
  expect(link.requests).toEqual([])
})

it.each([null, { witness: 'wrong', matches: [false] }, { witness: 'missing', matches: [] }, { witness: 'missing', matches: [1] }])(
  'refuses a malformed child authority answer (%#)', async value => {
    const query = storage.stoppedQuery({ kind: 'folder', root, exceptAgentId: 'fixture' })
    await link.requested()
    await link.answer({ ok: true, value })
    await expect(query).rejects.toMatchObject({ code: 'invalid' })
  })

it('requires selected-row proof output for an owners query', async () => {
  const query = storage.stoppedQuery({ kind: 'owners', keys: ['fixture'], defaultCodexHome: root })
  await link.requested()
  await link.answer({ ok: true, value: { witness: 'missing', matches: [false] } })
  await expect(query).rejects.toMatchObject({ code: 'invalid' })
})

it('never starts new work after shared descriptor cleanup becomes uncertain', async () => {
  vi.spyOn(custody, 'stateFileCustodyHealthy').mockImplementationOnce(() => { throw new custody.StateFileCleanupUnconfirmed() })
  await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  await expect(storage.read({ kind: 'names' })).rejects.toMatchObject({ code: 'disconnected' })
  await expect(storage.close()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(launch.spawn.mock.calls.length).toBe(0)
  expectedCloseFailure = true
})

it('bounds and expires write admission without executing the refused callback', async () => {
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    void storage.withWrite(Infinity, () => new Promise<void>(done => { release = done; resolve() }))
  })
  await entered
  const apply = vi.fn(), waiting = Array.from({ length: 64 }, () => storage.withWrite(0, apply).catch(error => error))
  await expect(storage.withWrite(Infinity, apply)).rejects.toMatchObject({ code: 'busy' })
  release()
  expect((await Promise.all(waiting)).every(error => (error as { code: string }).code === 'expired')).toBe(true)
  expect(apply).not.toHaveBeenCalled()
  await storage.close()
  await expect(storage.withWrite(performance.now() + 1000, apply)).rejects.toMatchObject({ code: 'disconnected' })
})

const token = '12345678-1234-1234-1234-123456789012'
const creationId = 'fixture-creation-123456'
it.each([null, { ids: null }, { cursor: 'wrong' }, { ids: [3] }, { ids: ['short'] }, { ids: Array(65).fill(creationId) },
  { done: 'yes' }, { damaged: -1 }, { damaged: 65 }, { damaged: 0.5 }])('refuses malformed pending-creation pages (%#)', async changes => {
  const scan = storage.creations.scan(), next = scan.next()
  await link.requested()
  const page = { cursor: token, ids: [], done: true, damaged: 0 }
  await link.answer({ ok: true, value: changes === null ? null : { ...page, ...changes } })
  await expect(next).rejects.toMatchObject({ code: 'invalid' })
})

it('admits fixed creation identities, yields empty bounded work and warns once for damaged evidence', async () => {
  await expect(storage.creations.ensure('../outside')).rejects.toMatchObject({ code: 'invalid' })
  const ensuring = storage.creations.ensure(creationId)
  await link.requested(); await link.answer({ ok: true, value: null }); await ensuring
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const scan = storage.creations.scan(), first = scan.next()
  await link.requested(2)
  await link.answer({ ok: true, value: { cursor: token, ids: [], damaged: 1, done: false } })
  expect(await first).toEqual({ done: false, value: null })
  const second = scan.next()
  await link.requested(3)
  await link.answer({ ok: true, value: { cursor: token, ids: [creationId], damaged: 1, done: true } })
  expect(await second).toEqual({ done: false, value: creationId })
  expect(await scan.next()).toEqual({ done: true, value: undefined })
  expect(warn).toHaveBeenCalledExactlyOnceWith('[creation] CREATION_EVIDENCE_UNAVAILABLE')
})

it('closes the exact pending cursor after early return and after a foreign later-page reply', async () => {
  for (const foreign of [false, true]) {
    const scan = storage.creations.scan(), first = scan.next(), count = link.requests.length + 1
    await link.requested(count)
    await link.answer({ ok: true, value: { cursor: token, ids: [creationId], damaged: 0, done: false } })
    await first
    const ending = (foreign ? scan.next() : scan.return(undefined)).catch(error => error)
    await link.requested(count + 1)
    if (foreign) {
      await link.answer({ ok: true, value: { cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ids: [], damaged: 0, done: true } })
      await link.requested(count + 2)
    }
    expect(link.requests.at(-1)!.operation).toEqual({ kind: 'creation-close', cursor: token })
    await link.answer({ ok: true, value: null })
    expect(await ending).toMatchObject(foreign ? { code: 'invalid' } : { done: true })
  }
})

it('finishes an empty creation directory and abandons a cursor only after its child is gone', async () => {
  const empty = storage.creations.scan().next()
  await link.requested()
  await link.answer({ ok: true, value: { cursor: '', ids: [], damaged: 0, done: true } })
  expect(await empty).toMatchObject({ done: true })
  const scan = storage.creations.scan(), first = scan.next()
  await link.requested(2)
  await link.answer({ ok: true, value: { cursor: token, ids: [creationId], damaged: 0, done: false } })
  await first
  link.exit()
  expect(await scan.return(undefined)).toMatchObject({ done: true })
  expect(link.requests).toHaveLength(2)
})

async function admit() {
  const reading = storage.read({ kind: 'names' })
  await link.requested()
  await link.answer({ ok: true, value: { state: 'missing' } })
  await reading
}
const imageProof = (path: string): SessionImageProof => ({ document: { kind: 'registry' },
  identity: sessionFileIdentity(nativeFs.lstatSync(path, { bigint: true })), bytes: 2, sha256: 'a'.repeat(64) })

it('bounds retained source descriptors, rejects changed images, and makes release idempotent', async () => {
  await admit()
  const path = storage.path({ kind: 'registry' }); writeFileSync(path, '[]', { mode: 0o600 })
  const proof = imageProof(path)
  const request = vi.spyOn(owner(), 'request').mockImplementation(async operation => operation.kind === 'read'
    ? { state: 'image', proof, json: true, value: [] } : null)
  const first = await storage.retain({ kind: 'registry' }), second = await storage.retain({ kind: 'registry' })
  await expect(storage.retain({ kind: 'registry' })).rejects.toMatchObject({ code: 'busy' })
  first.check()
  writeFileSync(path, '[1]', { mode: 0o600 })
  expect(() => first.check()).toThrow('changed')
  await first.release(); await first.release()
  expect(() => first.check()).toThrow('changed')
  link.exit()
  await second.release()
  expect(request.mock.calls.filter(([operation]) => operation.kind === 'release')).toHaveLength(1)
  await storage.close()
  await expect(storage.retain({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
})

it.each(['missing-fd', 'wrong-proof', 'unexpected-file', 'failed-release'])('refuses an unproved retained source and settles its descriptor (%s)', async fault => {
  await admit()
  const path = storage.path({ kind: 'registry' })
  writeFileSync(path, '[]', { mode: 0o600 })
  const proof = imageProof(path)
  if (fault === 'missing-fd') rmSync(path)
  const close = vi.spyOn(nativeFs, 'closeSync')
  vi.spyOn(owner(), 'request').mockImplementation(async operation => {
    if (operation.kind === 'release') {
      if (fault === 'failed-release') throw new SessionStorageUnavailable('disconnected')
      return null
    }
    return fault === 'unexpected-file' ? { state: 'missing' }
      : { state: 'image', proof: { ...proof, identity: fault === 'missing-fd' ? proof.identity : '1:2:3' }, json: true, value: [] }
  })
  await expect(storage.retain({ kind: 'registry' })).rejects.toMatchObject({ code: 'changed' })
  expect(close.mock.calls.length).toBe(fault === 'missing-fd' ? 0 : 1)
})

it('refuses inaccessible retained sources with their finite code before requesting a child', async () => {
  vi.spyOn(nativeFs, 'open').mockImplementation((...args: any[]) => args.at(-1)(Object.assign(new Error('fixture private path'), { code: 'EACCES' })))
  await expect(storage.retain({ kind: 'registry' })).rejects.toMatchObject({ code: 'EACCES' })
  expect(launch.spawn.mock.calls.length).toBe(0)
})

it('preserves already selected import authority and skips lease cleanup only after actual child exit', async () => {
  const reference = { networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.example.test',
    credential: { version: 1 as const, binding: 'b'.repeat(64), row: { agentId: 'fixture', registeredAt: 1 },
      source: { kind: 'import' as const, lease: token } } }
  const apply = vi.fn(async value => value)
  expect(await storage.withImport(reference.credential.row, reference, apply)).toBe(reference)
  expect(launch.spawn.mock.calls.length).toBe(0)
  const imported = storage.withImport(reference.credential.row, { ...reference, apiKey: 'synthetic-in-memory' }, async value => {
    link.exit(); return value
  })
  await link.requested()
  await link.answer({ ok: true, value: reference })
  expect(await imported).toEqual(reference)
  expect(link.requests).toHaveLength(1)
})

it('bounds prepared-image admission and expires every waiting writer without a new temporary', async () => {
  const first = storage.prepare({ kind: 'registry' }, null, [])
  const request = await link.requested()
  if (request.operation.kind !== 'prepare') throw new Error('unexpected operation')
  const reservation = request.operation.reservation
  const prepared = { temporary: reservation.temporary, proof: { ...imageProof(join(storage.root, reservation.temporary)), bytes: 0 },
    projection: 'registry-credentials', credentials: [] }
  await link.answer({ ok: true, value: prepared }); await first
  const waiting = Array.from({ length: 64 }, () => storage.prepare({ kind: 'registry' }, null, []).catch(error => error))
  await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toMatchObject({ code: 'busy' })
  vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 6000)
  const discard = storage.discard(prepared as Awaited<typeof first>)
  await link.requested(2); await link.answer({ ok: true, value: null }); await discard
  expect((await Promise.all(waiting)).every(error => error.code === 'expired')).toBe(true)
  expect(nativeFs.readdirSync(storage.root)).toEqual([])
  await expect(storage.discard(prepared as Awaited<typeof first>)).rejects.toMatchObject({ code: 'invalid' })
})

it('does not release a failed parent descriptor close or reopen storage afterward', async () => {
  await admit()
  const path = storage.path({ kind: 'registry' }); writeFileSync(path, '[]', { mode: 0o600 })
  const request = vi.spyOn(owner(), 'request').mockResolvedValue({ state: 'image', proof: imageProof(path), json: true, value: [] })
  const source = await storage.retain({ kind: 'registry' }), close = nativeFs.closeSync
  let closed: number | undefined
  vi.spyOn(nativeFs, 'closeSync').mockImplementation(fd => { close(fd); closed = fd; throw new Error('fixture close uncertainty') })
  await expect(source.release()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(typeof closed).toBe('number')
  request.mockRestore()
  // The mocked OS has settled the actual handle; drop only this fixture's retained metadata to avoid closing a reused number.
  ;(storage as unknown as { retained: Map<string, unknown> }).retained.clear()
  expectedCloseFailure = true
  await expect(storage.read({ kind: 'names' })).rejects.toMatchObject({ code: 'disconnected' })
})

it('keeps a newer child owner when a superseded spawn reports its exit', async () => {
  link.handshake = false
  const reading = storage.read({ kind: 'registry' }).catch(error => error)
  const replacement = new Link()
  owner().child = replacement as unknown as ChildProcess
  link.exit()
  expect(owner().child).toBe(replacement)
  // The old admission cannot become a usable link; close its original pending owner explicitly.
  owner().child = link as unknown as ChildProcess
  link.pid = undefined; link.emit('error', new Error('settled old spawn'))
  // The old finish is one-shot. Restore only the private synthetic owner to settle this adversarial fixture.
  ;(storage as unknown as { ready?: Promise<void>; active?: { reject(error: Error): void } }).active?.reject(new SessionStorageUnavailable('disconnected'))
  ;(storage as unknown as { active?: unknown }).active = undefined
  expect(await reading).toMatchObject({ code: 'disconnected' })
})

it('reaps a failed credited send and a response received after its active deadline', async () => {
  await admit()
  link.sendError = true
  await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
  link = new Link(); launch.spawn.mockImplementation(() => link)
  const reading = storage.read({ kind: 'registry' }).catch(error => error)
  await link.requested()
  owner().active!.expires = 0
  await link.answer({ ok: true, value: { state: 'missing' } })
  expect(await reading).toMatchObject({ code: 'disconnected' })
})

it('refuses a preparation open failure before any child owns a temporary', async () => {
  vi.spyOn(nativeFs, 'open').mockImplementation((...args: any[]) => args.at(-1)(Object.assign(new Error('fixture private path'), { code: 'ENOSPC' })))
  await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toMatchObject({ code: 'ENOSPC' })
  expect(nativeFs.readdirSync(storage.root)).toEqual([])
  expect(launch.spawn.mock.calls.length).toBe(0)
})

it('keeps shared cleanup identity when preparation is refused before opening its temporary', async () => {
  vi.spyOn(custody, 'stateFileCustodyHealthy').mockImplementation(() => { throw new custody.StateFileCleanupUnconfirmed() })
  expectedCloseFailure = true
  await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(nativeFs.readdirSync(storage.root)).toEqual([])
  expect(launch.spawn.mock.calls.length).toBe(0)
  vi.restoreAllMocks()
})

it('closes queued preparation ownership when storage closes during its preceding write', async () => {
  const first = storage.prepare({ kind: 'registry' }, null, []).catch(error => error)
  await link.requested()
  const second = storage.prepare({ kind: 'registry' }, null, []).catch(error => error)
  await storage.close()
  expect(await first).toMatchObject({ code: 'disconnected' })
  expect(await second).toMatchObject({ code: 'expired' })
  expect(nativeFs.readdirSync(storage.root)).toEqual([])
})

it('treats an unproved temporary identity or failed close as retained cleanup uncertainty', async () => {
  const internal = storage as unknown as { closeReservationDescriptor(value: object): void; removeTemporary(value: object): void }
  internal.closeReservationDescriptor({ temporary: 'unused' })
  expect(() => internal.removeTemporary({ temporary: 'unused', closeUnconfirmed: true })).toThrow('cleanup-unconfirmed')
  expect(() => internal.removeTemporary({ temporary: 'unused' })).toThrow('cleanup-unconfirmed')
  expectedCloseFailure = true
})

it('forwards the fixed executable preparation warning and rejects every queued request on child exit', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const first = storage.read({ kind: 'registry' }).catch(error => error)
  await link.requested()
  launch.report!('fixture executable preparation refused')
  expect(warning).toHaveBeenCalledWith('fixture executable preparation refused')
  const second = storage.read({ kind: 'names' }).catch(error => error)
  link.exit()
  expect(await first).toMatchObject({ code: 'disconnected' })
  expect(await second).toMatchObject({ code: 'disconnected' })
})

it('rejects all queued callers before close waits for the active child', async () => {
  const first = storage.read({ kind: 'registry' }).catch(error => error)
  await link.requested()
  const second = storage.read({ kind: 'names' }).catch(error => error)
  await storage.close()
  expect(await first).toMatchObject({ code: 'disconnected' })
  expect(await second).toMatchObject({ code: 'disconnected' })
})

it('does not retry or release a failed send while its child ignores termination', async () => {
  await admit()
  link.holdKill = true; link.sendError = true
  let killed!: () => void
  const killing = new Promise<void>(resolve => { killed = resolve })
  link.kill.mockImplementation(() => { killed(); return true })
  const reading = storage.read({ kind: 'registry' }).catch(error => error)
  await killing
  await Promise.resolve(); await Promise.resolve()
  expect(owner().child).toBe(link)
  expect(link.kill).toHaveBeenCalledOnce()
  link.exit()
  expect(await reading).toMatchObject({ code: 'disconnected' })
})

it('ignores an already queued admission timer after the waiter became the list owner', async () => {
  const acquire = storage as unknown as { acquireListing(): Promise<() => void> }
  const first = await acquire.acquireListing()
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  const waiting = acquire.acquireListing()
  const callback = timeout.mock.calls[0][0] as () => void
  first()
  const second = await waiting
  callback()
  second()
  const third = await acquire.acquireListing()
  third()
})

it('releases a failed list-close slot after the cursor owner actually exited', async () => {
  const listing = storage.stoppedList(() => { throw new Error('fixture reader stopped') }).catch(error => error)
  await link.requested()
  await link.answer({ ok: true, value: { cursor: token, offset: 0, next: 1, total: 2, done: false,
    images: [{ state: 'image', json: true, proof: { document: { kind: 'stopped', agentId: 'fixture' }, identity: '1:2:3', bytes: 2, sha256: 'a'.repeat(64) }, value: {} }] } })
  await link.requested(2)
  expect(link.requests[1].operation.kind).toBe('stopped-list-close')
  link.exit()
  expect(await listing).toMatchObject({ code: 'disconnected' })
})

it('owns the reserved descriptor when its close fails and does not retry that descriptor', async () => {
  const close = nativeFs.closeSync, owned = new Set<number>()
  const open = nativeFs.open
  vi.spyOn(nativeFs, 'open').mockImplementation(((...args: any[]) => {
    const callback = args.pop()
    ;(open as (...values: any[]) => void)(...args, (error: unknown, fd: number) => { if (!error) owned.add(fd); callback(error, fd) })
  }) as typeof open)
  vi.spyOn(nativeFs, 'closeSync').mockImplementation(fd => {
    if (owned.has(fd)) { close(fd); owned.delete(fd); throw new Error('fixture close uncertainty') }
    close(fd)
  })
  expectedCloseFailure = true
  await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(owned.size).toBe(0)
  await expect(storage.close()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
})

it('retains the exact native flags available on portable platforms without a second reader', async () => {
  const constants = nativeFs.constants as { O_NOFOLLOW?: number; O_NONBLOCK?: number }
  const nofollow = constants.O_NOFOLLOW, nonblock = constants.O_NONBLOCK
  delete constants.O_NOFOLLOW; delete constants.O_NONBLOCK
  try {
    const source = storage.retain({ kind: 'registry' })
    await link.requested(); await link.answer({ ok: true, value: { state: 'missing' } })
    const held = await source
    const release = held.release()
    await link.requested(2); await link.answer({ ok: true, value: null }); await release
    const preparing = storage.prepare({ kind: 'registry' }, null, [])
    const request = await link.requested(3)
    if (request.operation.kind !== 'prepare') throw new Error('unexpected operation')
    expect(request.operation.reservation.identity).toMatch(/^[0-9:]+$/)
    await link.answer({ ok: false, code: 'unsafe' })
    await expect(preparing).rejects.toMatchObject({ code: 'unsafe' })
  } finally { constants.O_NOFOLLOW = nofollow; constants.O_NONBLOCK = nonblock }
})
