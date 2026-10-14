import { createHash } from 'node:crypto'
import { fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, type Dir, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNativeHookCatalog, NATIVE_HOOK_STORAGE_LIMITS } from './nativeHookCatalog.js'
import { createNativeHookStagePool, nativeHookMetadata } from './nativeHookStaging.js'
import { nativeHookOutboxShard, type NativeHookClientInput } from './nativeHookOutbox.js'
import type { NativeHookIntake } from './nativeHookJournal.js'
import { createNativeHookReplay } from './nativeHookReplay.js'
import { nativeHookAcknowledgement } from './nativeHookClientProtocol.js'
import * as files from './nativeHookFiles.js'
import type { NativeHookClientRequest } from './nativeHookClient.js'
import { fixtureNativeGenerationFact as generationFact } from '../../testing/nativeGenerationFactFixture.js'

const fault = vi.hoisted(() => ({ fail: false,
  beforePublish: undefined as ((text: string, path: string, publish: (text: string, path: string) => void) => void) | undefined,
  afterPublish: undefined as ((text: string, path: string) => void) | undefined,
  sync: undefined as ((fd: number, done: (error: Error | null) => void) => boolean) | undefined,
  stat: undefined as ((path: string, read: () => unknown) => unknown) | undefined,
  directoryRead: undefined as ((path: string, read: () => Dirent | null) => Dirent | null) | undefined,
  directoryOpen: undefined as ((path: string, open: () => Dir) => Dir) | undefined,
}))
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs,
  fsync: (fd: number, done: (error: Error | null) => void) => {
    if (fault.sync?.(fd, done)) return
    queueMicrotask(() => done(fault.fail ? Error('fixture disk unavailable') : null))
  },
  symlinkSync: (text: string, path: string) => {
    fault.beforePublish?.(text, path, fs.symlinkSync); fs.symlinkSync(text, path); fault.afterPublish?.(text, path)
  },
  lstatSync: (path: string, options: Parameters<typeof fs.lstatSync>[1]) => fault.stat?.(path, () => fs.lstatSync(path, options)) ?? fs.lstatSync(path, options),
  opendirSync: (path: string, options: Parameters<typeof fs.opendirSync>[1]) => {
    const open = () => fs.opendirSync(path, options)
    const directory = fault.directoryOpen ? fault.directoryOpen(path, open) : open(), read = directory.readSync.bind(directory)
    directory.readSync = () => fault.directoryRead ? fault.directoryRead(path, read) : read()
    return directory
  },
} })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const existsSync = (file: string) => { try { lstatSync(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false } }
let root: string, local: boolean, rootChecks: number, pool: ReturnType<typeof createNativeHookStagePool>
let catalogs: ReturnType<typeof createNativeHookCatalog>[]
const verifyRoot = () => { rootChecks++; if (!local) throw Error('fixture storage is unavailable') }
const catalog = (operationTimeoutMs?: number) => {
  const value = createNativeHookCatalog({ root, verifyRoot, pool, operationTimeoutMs }); catalogs.push(value); return value
}
const processKey = 'linux:fixture-boot\u0000codex\u00005100\u0000t:1234'
const intake = (id = 'fixture-delivery-0001', size = 20): NativeHookIntake => ({
  id, agentId: 'fixture-agent', conversationId: 'fixture-conversation', fingerprint: hash(id), payload: { prompt: 'x'.repeat(size) },
})
const clientInput = (): NativeHookClientInput => ({ id: 'fixture-client-replay-0001', firedAt: 1234, port: 19400,
  phases: [{ name: 'registration', path: '/api/hook/session-start', body: { callerPid: 43,
    nativeOrigin: { version: 1, boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', callerPid: 43,
      ancestry: [{ pid: 43, parentPid: 1, birth: '12345', identityV1: hash('fixture-caller') }] } } }] })
const allocationFiles = () => readdirSync(root).filter(name => name.endsWith('.allocation.witness')).sort()
const allocated = (key = processKey) => {
  const name = allocationFiles().find(name => JSON.parse(readlinkSync(join(root, name)))[3] === hash(key))!
  return join(root, name.replace(/\.allocation\.witness$/, ''))
}
const put = (file: string, value: unknown) => {
  const text = JSON.stringify(value); symlinkSync(text, file + '.witness'); symlinkSync(text, file)
}
const reset = () => { fault.fail = false; fault.beforePublish = undefined; fault.afterPublish = undefined; fault.sync = undefined; fault.stat = undefined; fault.directoryRead = undefined; fault.directoryOpen = undefined }
const stagingPool = (options: { maxGenerations?: number; terminalGenerations?: number } = {}) => createNativeHookStagePool({
  root, writer: { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid: 8100, birth: '12345' },
  verifyWriter: verifyRoot, closeWriter: () => {}, dead: async () => false, ...options,
})
beforeEach(() => {
  root = join(realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-catalog-'))), 'data'); mkdirSync(root, { mode: 0o700 })
  local = true; rootChecks = 0; catalogs = []; reset()
  pool = stagingPool()
})
afterEach(async () => {
  reset(); vi.restoreAllMocks(); local = true; await Promise.all(catalogs.map(value => value.close()))
  await pool.close().catch(() => {})
  rmSync(dirname(root), { recursive: true, force: true })
})

it.each(['deadline', 'revocation'])('does not publish a catalog mirror after its last flat leaf check crosses %s', async kind => {
  let now = 0, current = true, checkingMirror = false, crossed = false
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const version = join(root, '.native-hook-catalog'), original = nativeHookMetadata.publish
  vi.spyOn(nativeHookMetadata, 'publish').mockImplementation((...args) => {
    if (args[0] === version) {
      const verify = args[2]
      args[2] = () => {
        checkingMirror = true
        try { verify() } finally { checkingMirror = false }
      }
    }
    return original(...args)
  })
  fault.stat = (path, read) => {
    const info = read()
    if (checkingMirror && path === version + '.witness') {
      crossed = true
      if (kind === 'deadline') now = 5_000
      else current = false
    }
    return info
  }
  await expect(catalog(1_000).effects(processKey, () => current)).rejects.toThrow(kind === 'deadline' ? 'expired' : 'owner changed')
  expect(crossed).toBe(true)
  expect(existsSync(version + '.witness')).toBe(true)
  expect(existsSync(version)).toBe(false)
  expect(allocationFiles()).toEqual([])
})

it('durably allocates before initialization and retains one process namespace across reconstructed catalogs', async () => {
  const store = catalog()
  expect(readdirSync(root)).toEqual([])
  const original = await store.effects(processKey)
  expect(allocationFiles()).toHaveLength(1)
  expect(existsSync(allocated() + '.history')).toBe(false)
  await original.retain(intake())
  const claim = await original.claim(intake().id, intake().agentId)
  await claim.finish({ status: 200, reply: { ok: true } })
  const fresh = await catalog().effects(processKey)
  expect((await fresh.retain(intake())).result).toMatchObject({ status: 200 })
  expect(allocationFiles()).toHaveLength(1)
  expect(readdirSync(root, { recursive: true }).map(String).filter(name => name.endsWith('.tmp'))).toEqual([])
  const names = readdirSync(root, { recursive: true }).map(String)
  expect(names.some(name => name.includes('.harness-hook-'))).toBe(false)
  expect(names.some(name => name.includes('.claim'))).toBe(true)
  expect(names.filter(name => /^\.native-hook-stage-\d\/\d{8}\.claim$/.test(name))).toHaveLength(3)
})

it('looks up only existing sealed effect histories without allocating missing namespaces', async () => {
  const empty = catalog()
  const absent = await empty.readEffects([processKey]).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  expect(absent.error).toBeUndefined()
  expect(absent.value!.size).toBe(0)
  expect(readdirSync(root)).toEqual([])
  const original = await empty.effects(processKey)
  await original.retain(intake())
  await (await original.claim(intake().id, intake().agentId)).finish({ status: 200, reply: { ok: true } })
  const before = allocationFiles(), recovered = await catalog().readEffects([processKey, processKey, 'absent-process'])
  expect([...recovered.keys()]).toEqual([processKey])
  const read = recovered.get(processKey)!
  expect(Object.keys(read).sort()).toEqual(['close', 'snapshot'])
  const snapshot = await read.snapshot(); await snapshot.confirm(); snapshot.verify()
  expect(snapshot.deliveries.get(intake().id)?.result).toMatchObject({ status: 200 })
  expect(allocationFiles()).toEqual(before)
  read.close()
  await expect(read.snapshot()).rejects.toThrow('owner changed')
})

it.each(['allocation', 'seal', 'authority'])('holds an incomplete %s during receipt lookup without rebuilding it', async missing => {
  const store = catalog(), original = await store.effects(processKey)
  await original.retain(intake())
  const file = allocated() + (missing === 'authority' ? '.history.authority' : `.${missing}`)
  unlinkSync(file)
  const before = readdirSync(root, { recursive: true }).map(String).sort()
  await expect(catalog().readEffects([processKey])).rejects.toThrow()
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
  expect(existsSync(file)).toBe(false)
})

it('bounds receipt keys and checks the lookup owner before returning a read capability', async () => {
  const store = catalog()
  await expect(store.readEffects(Array.from({ length: 34 }, (_, i) => `process-${i}`))).rejects.toThrow('lookup keys')
  await expect(store.readEffects([processKey], () => false)).rejects.toThrow('lookup expired')
  expect(readdirSync(root)).toEqual([])
})

it('proves empty recovery slots with one complete listing instead of probing every absent leaf', async () => {
  const leaves: string[] = []
  fault.stat = (path, read) => {
    if (/\.native-hook-(?:effects|outbox)-\d{3}/.test(path)) leaves.push(path)
    return read()
  }
  expect(await catalog().readOutbox(3)).toBeUndefined()
  expect(leaves).toEqual([])
  expect(readdirSync(root)).toEqual([])
})

it.each(['.allocation', '.allocation.witness', '.seal', '.seal.witness', '.history',
  '.history.witnesses', '.history.bootstrap', '.history.authority', '.history.seal'])('does not hide an orphan %s behind the catalog listing', async suffix => {
  await catalog().effects('fixture-seed')
  const file = join(root, '.native-hook-outbox-003' + suffix)
  if (suffix === '.allocation.witness') symlinkSync(JSON.stringify([1, 'outbox', 3, hash('native-hook-client:v1:shard:3')]), file)
  else writeFileSync(file, 'fixture retained evidence')
  const before = readdirSync(root).sort()
  await expect(catalog().readOutbox(3)).rejects.toThrow()
  expect(readdirSync(root).sort()).toEqual(before)
})

it('holds case variants which can resolve to canonical slots on a case-insensitive filesystem', async () => {
  await catalog().effects('fixture-seed')
  writeFileSync(join(root, '.NATIVE-HOOK-OUTBOX-003.HISTORY.AUTHORITY'), 'fixture retained authority')
  await expect(catalog().readOutbox(3)).rejects.toThrow('noncanonical name')
})

it.each([false, true])('discards a directory opened through a transient ancestor redirection (repeated=%s)', async repeated => {
  await catalog().effects('fixture-seed')
  let redirected = false
  const discarded: Dir[] = []
  fault.directoryOpen = (path, open) => {
    if (path !== root || redirected && !repeated) return open()
    redirected = true
    const parent = dirname(root), saved = parent + '.moved'
    renameSync(parent, saved); mkdirSync(parent, { mode: 0o700 }); mkdirSync(root, { mode: 0o700 })
    try { const wrong = open(); discarded.push(wrong); return wrong }
    finally { rmSync(parent, { recursive: true }); renameSync(saved, parent) }
  }
  if (repeated) await expect(catalog().readOutbox(3)).rejects.toThrow('directory route changed')
  else expect(await catalog().readOutbox(3)).toBeUndefined()
  expect(redirected).toBe(true)
  expect(discarded).toHaveLength(repeated ? 3 : 1)
  for (const directory of discarded) expect(() => directory.readSync()).toThrow('closed')
})

it('keeps a pinned catalog listing usable across unrelated ancestor sibling writes', async () => {
  await catalog().effects('fixture-seed')
  for (let index = 0; index < 70; index++) writeFileSync(join(root, `fixture-entry-${index}`), '')
  let scheduled = false, changed = false
  fault.directoryRead = (path, read) => {
    if (!scheduled && path === root) {
      scheduled = true
      setImmediate(() => { writeFileSync(join(dirname(root), 'fixture-sibling'), 'unrelated'); changed = true })
    }
    return read()
  }
  expect(await catalog().readOutbox(3)).toBeUndefined()
  expect(changed).toBe(true)
})

it('charges unrelated directory entries to the same bounded catalog scan', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0)
  let reads = 0
  fault.directoryRead = () => { reads++; return { name: 'fixture-unrelated' } as Dirent }
  await expect(catalog().readOutbox(3)).rejects.toThrow('work limit')
  expect(reads).toBeLessThanOrEqual(16_384)
  expect(readdirSync(root)).toEqual([])
})

it.each([
  ['empty', 'remove', 'snapshot'], ['empty', 'replace', 'snapshot'],
  ['populated', 'remove', 'snapshot'], ['populated', 'replace', 'snapshot'],
  ['populated', 'remove', 'confirm'], ['populated', 'replace', 'confirm'],
])('retains selected receipt authority for %s history across seal %s before %s', async (contents, change, step) => {
  const store = catalog(), journal = await store.effects(processKey)
  if (contents === 'populated') await journal.retain(intake())
  else await journal.snapshot()
  const read = (await catalog().readEffects([processKey])).get(processKey)!
  const snapshot = step === 'confirm' ? await read.snapshot() : undefined
  const file = allocated() + '.seal', original = readlinkSync(file)
  unlinkSync(file)
  if (change === 'replace') symlinkSync(original, file)
  const before = readdirSync(root, { recursive: true }).map(String).sort()
  await expect(snapshot ? snapshot.confirm() : read.snapshot()).rejects.toThrow()
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
  expect(existsSync(file)).toBe(change === 'replace')
})

it('recovers only existing client outboxes and exposes no fresh-intake capability', async () => {
  const store = catalog(), input = clientInput(), shard = nativeHookOutboxShard(input.id)
  expect(await store.readOutbox(shard)).toBeUndefined()
  expect(readdirSync(root)).toEqual([])
  const original = await store.outbox(shard)
  await original.retain(input)
  const before = allocationFiles(), read = (await catalog().readOutbox(shard))!
  expect(Object.keys(read).sort()).toEqual(['acknowledge', 'close', 'snapshot'])
  const snapshot = await read.snapshot(), delivery = snapshot.deliveries.get(input.id)!
  expect(delivery.phases[0].acknowledged).toBe(false)
  await read.acknowledge(delivery, 'registration')
  expect((await original.snapshot()).deliveries.get(input.id)?.phases[0].acknowledged).toBe(true)
  expect(allocationFiles()).toEqual(before)
  expect(await catalog().readOutbox((shard + 1) % 16)).toBeUndefined()
  expect(allocationFiles()).toEqual(before)
  await read.close()
  await expect(read.snapshot()).rejects.toThrow('owner changed')
})

it.each(['allocation', 'seal', 'history.authority'])('does not repair missing client outbox %s during recovery lookup', async suffix => {
  const input = clientInput(), shard = nativeHookOutboxShard(input.id), store = catalog()
  await (await store.outbox(shard)).retain(input)
  const file = allocated(`native-hook-client:v1:shard:${shard}`) + '.' + suffix
  unlinkSync(file)
  const before = readdirSync(root, { recursive: true }).map(String).sort()
  await expect(catalog().readOutbox(shard)).rejects.toThrow()
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
})

it.each(['remove', 'replace'])('retains original outbox seal authority through ACK after seal %s', async change => {
  const input = clientInput(), shard = nativeHookOutboxShard(input.id), store = catalog()
  await (await store.outbox(shard)).retain(input)
  const read = (await catalog().readOutbox(shard))!, snapshot = await read.snapshot()
  const file = allocated(`native-hook-client:v1:shard:${shard}`) + '.seal', text = readlinkSync(file)
  unlinkSync(file)
  if (change === 'replace') symlinkSync(text, file)
  const before = readdirSync(root, { recursive: true }).map(String).sort()
  await expect(read.acknowledge(snapshot.deliveries.get(input.id)!, 'registration')).rejects.toThrow()
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
  await read.close()
})

it('retains the outbox recovery handle until actual confirmation finishes after revocation', async () => {
  const input = clientInput(), shard = nativeHookOutboxShard(input.id), store = catalog()
  await (await store.outbox(shard)).retain(input)
  const read = (await catalog().readOutbox(shard))!, callbacks: ((error: Error | null) => void)[] = []
  fault.sync = (_fd, done) => { callbacks.push(done); return true }
  const pending = read.snapshot().then(() => undefined, error => error)
  await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0))
  let closed = false
  const closing = read.close().then(() => { closed = true })
  await new Promise<void>(done => setImmediate(done))
  expect(closed).toBe(false)
  fault.sync = undefined; callbacks.forEach(done => done(null))
  expect(await pending).toBeInstanceOf(Error)
  await closing; expect(closed).toBe(true)
})

it('rejects invalid shards and expired client outbox recovery before allocating', async () => {
  const store = catalog()
  for (const shard of [-1, 16, 0.5, NaN]) await expect(store.readOutbox(shard)).rejects.toThrow('invalid outbox shard')
  await expect(store.readOutbox(0, () => false)).rejects.toThrow('lookup expired')
  expect(readdirSync(root)).toEqual([])
})

it('replays a real client outbox across registration ACK, reconstruction and interrupted Stop confirmation', async () => {
  const first = clientInput(), input: NativeHookClientInput = { ...first, phases: [...first.phases,
    { name: 'stop', path: '/api/hook/turn-stop', body: { ...first.phases[0].body, status: 'completed' } }] }
  const shard = nativeHookOutboxShard(input.id), original = await catalog().outbox(shard)
  await original.retain(input)
  const received: NativeHookClientRequest[] = [], held = vi.fn()
  const replays: ReturnType<typeof createNativeHookReplay>[] = [], callbacks: ((error: Error | null) => void)[] = []
  const ack = (request: NativeHookClientRequest) => nativeHookAcknowledgement(request,
    { name: request.path.endsWith('session-start') ? 'registration' : 'stop',
      path: request.path.endsWith('session-start') ? '/api/hook/session-start' : '/api/hook/turn-stop', body: request.body }, 'owned')
  const make = (send: (request: NativeHookClientRequest) => Promise<unknown>) => {
    const replay = createNativeHookReplay({
    readOutbox: catalog().readOutbox, onHeld: held, timeoutMs: 8000, intervalMs: 10,
    send: async request => { received.push(request); return send(request) },
    })
    replays.push(replay); return replay
  }
  try {
  const before = allocationFiles(), firstReplay = make(async request => request.path.endsWith('session-start') ? ack(request) : undefined)
  firstReplay.start()
  await vi.waitFor(() => expect(received.some(request => request.path.endsWith('turn-stop'))).toBe(true), { timeout: 8000 })
  await firstReplay.close()
  expect((await original.snapshot()).deliveries.get(input.id)!.phases.map(phase => phase.acknowledged)).toEqual([true, false])
  received.length = 0
  const second = make(async request => {
    fault.sync = (_fd, done) => { callbacks.push(done); return true }
    return ack(request)
  })
  second.start()
  await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0), { timeout: 8000 })
  let closed = false
  const closing = second.close().then(() => { closed = true })
  await new Promise<void>(done => setImmediate(done))
  expect(closed).toBe(false)
  fault.sync = undefined; callbacks.splice(0).forEach(done => done(null)); await closing
  expect(received.every(request => request.path.endsWith('turn-stop'))).toBe(true)
  expect((await original.snapshot()).deliveries.get(input.id)!.phases.map(phase => phase.acknowledged)).toEqual([true, false])
  const third = make(async request => ack(request))
  held.mockClear(); third.start()
  await vi.waitFor(() => expect(held).toHaveBeenCalledWith(shard, input.id, undefined), { timeout: 8000 })
  await third.close()
  expect((await original.snapshot()).deliveries.get(input.id)!.phases.map(phase => phase.acknowledged)).toEqual([true, true])
  expect(allocationFiles()).toEqual(before)
  expect(received.every(request => request.id === input.id && request.firedAt === input.firedAt
    && request.body === JSON.stringify(input.phases[1].body))).toBe(true)
  } finally {
    fault.sync = undefined; callbacks.splice(0).forEach(done => done(null))
    await Promise.all(replays.map(replay => replay.close()))
  }
}, 30_000)

it('holds new intake at normal exhaustion while every previously accepted effect can finish', async () => {
  await pool.close(); pool = stagingPool({ maxGenerations: 4, terminalGenerations: 3 })
  const journal = await catalog().effects(processKey), bodies = [intake(), intake('fixture-delivery-0002')]
  for (const body of bodies) await journal.retain(body)
  // Each intake, including initial bootstrap and both mirrors, uses one lease.
  for (let index = bodies.length; index < 8; index++) { const lease = await pool.acquire(); await lease.close() }
  await expect(journal.retain(intake('fixture-delivery-0003'))).rejects.toThrow('generation capacity')
  for (const body of bodies) {
    const claimed = journal.claim(body.id, body.agentId)
    await expect(claimed).resolves.toMatchObject({ id: body.id })
    await expect((await claimed).finish({ status: 200 })).resolves.toBeUndefined()
  }
  const recovered = await (await catalog().effects(processKey)).snapshot()
  expect([...recovered.deliveries.values()].map(delivery => delivery.result?.status)).toEqual([200, 200])
  await expect(journal.retain(intake('fixture-delivery-0003'))).rejects.toThrow('generation capacity')
  expect(readdirSync(root, { recursive: true }).map(String).filter(name => name.endsWith('.tmp'))).toEqual([])
}, 30_000)

it('keeps matching native Stop and Cancel possible after normal staging fills', async () => {
  await pool.close(); pool = stagingPool({ maxGenerations: 4, terminalGenerations: 3 })
  const journal = await catalog().effects(processKey)
  await journal.recordGeneration(generationFact('activity'))
  await journal.recordGeneration(generationFact('activity', 'fixture-second-activity', 'generation-two'))
  for (let index = 2; index < 8; index++) { const lease = await pool.acquire(); await lease.close() }
  await expect(journal.recordGeneration(generationFact('activity', 'fixture-third-activity', 'generation-three'))).rejects.toThrow('generation capacity')
  // An unrelated Stop cannot borrow either running generation's terminal lane.
  await expect(journal.recordGeneration(generationFact('stopped', 'fixture-unseen-stop', 'unseen-generation'))).rejects.toThrow('generation capacity')
  await journal.recordGeneration(generationFact('stopped'))
  await journal.recordGeneration(generationFact('cancelled', 'fixture-second-cancel', 'generation-two'))
  const snapshot = await journal.snapshot()
  expect([...snapshot.generations.values()].map(fact => fact.kind)).toEqual(['activity', 'activity', 'stopped', 'cancelled'])
  // The late event cannot reopen the completed generation or take its former
  // reservation; only duplicate confirmation needs no new scratch generation.
  await expect(journal.recordGeneration(generationFact('activity', 'fixture-late-activity'))).rejects.toThrow('generation capacity')
  await journal.recordGeneration(generationFact('stopped'))
}, 30_000)

it('cannot reuse a terminal mirror-repair lease for an unreserved generation fact', async () => {
  await pool.close(); pool = stagingPool({ maxGenerations: 4, terminalGenerations: 3 })
  const journal = await catalog().effects(processKey)
  await journal.recordGeneration(generationFact('activity'))
  await journal.recordGeneration(generationFact('activity', 'fixture-second-activity', 'generation-two'))
  const directory = allocated() + '.history'
  // Reproduce the outside-selected tail of an interrupted writer. Only this
  // fixture's journal mirror is removed; recovery must restore the same bytes.
  unlinkSync(join(directory, '00000001.json'))
  for (let index = 2; index < 8; index++) { const lease = await pool.acquire(); await lease.close() }
  await expect(journal.recordGeneration(generationFact('submitted', 'fixture-unreserved-prompt', 'generation-three')))
    .rejects.toThrow('terminal capacity cannot initialize a journal')
  expect(existsSync(join(directory, '00000001.json'))).toBe(true)
  expect(existsSync(join(directory, '00000002.json'))).toBe(false)
  expect(existsSync(join(directory + '.witnesses', '00000002.json'))).toBe(false)
  expect((await journal.snapshot()).generations.size).toBe(2)
  await journal.recordGeneration(generationFact('stopped'))
  expect((await journal.snapshot()).generations.get(generationFact('stopped').id)?.kind).toBe('stopped')
}, 30_000)

it('keeps the original first-version publication identity until its flat proof is retained', async () => {
  const publish = nativeHookMetadata.publish, version = join(root, '.native-hook-catalog')
  let replaced = false
  vi.spyOn(nativeHookMetadata, 'publish').mockImplementation((file, text, verify, exclusive, created) => {
    const proof = publish(file, text, verify, exclusive, created)
    if (!replaced && file === version + '.witness') {
      replaced = true; unlinkSync(file); symlinkSync(text, file)
    }
    return proof
  })
  await expect(catalog().effects(processKey)).rejects.toThrow('metadata changed')
  expect(existsSync(version)).toBe(false)
  expect(allocationFiles()).toEqual([])
})

it('reserves a separate successful mirror repair while a terminal publisher is alive at cutover', async () => {
  await pool.close(); pool = stagingPool({ maxGenerations: 4, terminalGenerations: 3 })
  const journal = await catalog().effects(processKey), body = intake()
  await journal.retain(body)
  // Independent module state models a second writer's preparation reservations;
  // the process suite separately covers this boundary with real OS children.
  vi.resetModules()
  const independent = await import('./nativeHookCatalog.js')
  const observing = independent.createNativeHookCatalog({ root, verifyRoot, pool }); catalogs.push(observing)
  const observer = await observing.effects(processKey)
  for (let index = 1; index < 8; index++) { const lease = await pool.acquire(); await lease.close() }
  const directory = allocated() + '.history'
  let paused = false, resume!: () => void
  fault.sync = (fd, done) => {
    if (paused || !fstatSync(fd).isDirectory() || !existsSync(join(directory + '.witnesses', '00000001.json'))
      || existsSync(join(directory, '00000001.json'))) return false
    paused = true; resume = () => done(null); return true
  }
  const pending = journal.claim(body.id, body.agentId)
  try {
    await vi.waitFor(() => expect(paused).toBe(true))
    expect((await observer.snapshot()).active?.id).toBe(body.id)
  } finally { resume?.(); await pending.catch(() => {}) }
  const claim = await pending
  const claims = readdirSync(root, { recursive: true }).map(String).filter(name => /^\.native-hook-stage-\d\/\d{8}\.claim$/.test(name))
  expect(claims).toHaveLength(10)
  await claim.finish({ status: 200 })
  expect((await observer.snapshot()).deliveries.get(body.id)?.result?.status).toBe(200)
}, 30_000)

it('holds intake until the catalog seal has actually been confirmed', async () => {
  const journal = await catalog().effects(processKey)
  let sealed = false, paused = false, resume!: () => void
  fault.afterPublish = (_text, path) => { if (path === allocated() + '.seal.witness') sealed = true }
  fault.sync = (fd, done) => {
    if (!sealed || paused || !fstatSync(fd).isDirectory()) return false
    paused = true; resume = () => done(null); return true
  }
  const pending = journal.retain(intake())
  await vi.waitFor(() => expect(paused).toBe(true))
  expect(readdirSync(allocated() + '.history')).toEqual([])
  expect(readdirSync(allocated() + '.history.witnesses')).toEqual([])
  resume()
  await expect(pending).resolves.toMatchObject({ intake: { id: intake().id } })
})

it('reuses only its own successful immutable seal confirmation while a reconstructed boundary flushes again', async () => {
  const journal = await catalog().effects(processKey), selected = allocated()
  const sync = nativeHookMetadata.syncDirectory
  let published = false, fail = true, confirmations = 0
  fault.afterPublish = (_text, path) => { if (path === selected + '.seal.witness') published = true }
  vi.spyOn(nativeHookMetadata, 'syncDirectory').mockImplementation(async (...args) => {
    if (published) {
      confirmations++
      if (fail) throw Error('fixture first seal flush unavailable')
    }
    await sync(...args)
  })
  await expect(journal.retain(intake())).rejects.toThrow('first seal flush')
  expect(confirmations).toBe(1)
  expect(readdirSync(selected + '.history')).toEqual([])
  fail = false
  await journal.retain(intake())
  expect(confirmations).toBe(2)
  await journal.snapshot(); await journal.snapshot()
  expect(confirmations).toBe(2)
  const reconstructed = await catalog().effects(processKey), before = confirmations
  await reconstructed.snapshot()
  expect(confirmations).toBe(before + 1)
})

it.each(['seal.witness', 'history.bootstrap'])('refuses same-byte replacement of confirmed %s', async suffix => {
  const journal = await catalog().effects(processKey)
  await journal.retain(intake())
  const file = allocated() + '.' + suffix
  if (suffix === 'seal.witness') {
    const text = readlinkSync(file); unlinkSync(file); symlinkSync(text, file)
  } else {
    const text = readFileSync(file); unlinkSync(file); writeFileSync(file, text, { mode: 0o600 })
  }
  await expect(journal.snapshot()).rejects.toThrow(/changed/)
})

it('retains the empty journal frontier until its first catalog seal is published', async () => {
  const journal = await catalog().effects(processKey), selected = allocated()
  const publish = nativeHookMetadata.publish
  let injected = false
  vi.spyOn(nativeHookMetadata, 'publish').mockImplementation((file, text, verify, exclusive, created) => {
    if (!injected && file === selected + '.seal.witness') {
      injected = true
      const record = JSON.stringify({ version: 1, processKey, index: 0, previous: null, event: { kind: 'intake', intake: intake() } })
      for (const directory of [selected + '.history', selected + '.history.witnesses']) writeFileSync(join(directory, '00000000.json'), record, { mode: 0o600 })
    }
    return publish(file, text, verify, exclusive, created)
  })
  await expect(journal.snapshot()).rejects.toThrow('changed during recovery')
  expect(existsSync(selected + '.seal.witness')).toBe(false)
})

it('retains initial catalog absence until its own authority is published', async () => {
  const publish = nativeHookMetadata.publish
  let injected = false
  vi.spyOn(nativeHookMetadata, 'publish').mockImplementation((file, text, verify, exclusive, created) => {
    if (!injected && file === join(root, '.native-hook-catalog.witness')) {
      injected = true
      put(join(root, '.native-hook-effects-000.allocation'), [1, 'effects', 0, hash('fixture-late-reservation')])
    }
    return publish(file, text, verify, exclusive, created)
  })
  await expect(catalog().effects(processKey)).rejects.toThrow('before catalog initialization')
  expect(existsSync(join(root, '.native-hook-catalog.witness'))).toBe(false)
})

it('recovers the exact reservation after its outside publication was interrupted', async () => {
  fault.afterPublish = (_text, path) => { if (path.endsWith('.allocation.witness')) throw Error('fixture crash after exclusive allocation') }
  await expect(catalog().effects(processKey)).rejects.toThrow('fixture crash')
  expect(allocationFiles()).toHaveLength(1)
  const reserved = allocated()
  expect(existsSync(reserved + '.history')).toBe(false)
  reset()
  await (await catalog().effects(processKey)).retain(intake())
  expect(allocationFiles()).toHaveLength(1)
  expect(allocated()).toBe(reserved)
  expect(readlinkSync(reserved + '.allocation')).toBe(readlinkSync(reserved + '.allocation.witness'))
})

it('holds retained legacy journals instead of treating an unrecognized root as new authority', async () => {
  const legacy = join(root, hash(processKey)); mkdirSync(legacy, { mode: 0o700 })
  writeFileSync(join(legacy, 'receipt'), 'retained fixture evidence', { mode: 0o600 })
  await expect(catalog().effects(processKey)).rejects.toThrow('unallocated storage remains')
  expect(readFileSync(join(legacy, 'receipt'), 'utf8')).toBe('retained fixture evidence')
  expect(existsSync(join(root, '.native-hook-catalog.witness'))).toBe(false)
})

it('keeps stage-free confirmation I/O alive beyond both reply deadlines and catalog close', async () => {
  const store = catalog(), journal = await store.effects(processKey), body = intake()
  await journal.retain(body)
  let paused: { fd: number; done(error: Error | null): void } | undefined
  fault.sync = (fd, done) => {
    if (paused || !fstatSync(fd).isFile()) return false
    paused = { fd, done }; return true
  }
  const outcome = journal.retain(body).then(() => ({ ok: true, error: '' }), error => ({ ok: false, error: String(error) }))
  await vi.waitFor(() => expect(paused).toBeTruthy())
  expect(await outcome).toMatchObject({ ok: false, error: expect.stringMatching(/deadline|expired/) })
  // The inner preparation's five-second reply also expires, but its syscall
  // remains live. Neither layer may release the surrounding storage lifetime.
  await new Promise<void>(done => setTimeout(done, 650))
  let closed = false
  const closing = store.close().then(() => { closed = true })
  await new Promise<void>(done => setImmediate(done))
  try {
    expect(closed).toBe(false)
    expect(fstatSync(paused!.fd).isFile()).toBe(true)
  } finally { fault.sync = undefined; paused!.done(null); await closing }
  expect(() => fstatSync(paused!.fd)).toThrow()
  expect((await (await catalog().effects(processKey)).retain(body)).intake.id).toBe(body.id)
}, 15_000)

it('rereads an EEXIST winner and retries a collision without borrowing its quota', async () => {
  const otherKey = 'fixture-colliding-process'
  let injected = false
  fault.beforePublish = (text, path, publish) => {
    if (injected || !path.endsWith('.allocation.witness')) return
    injected = true
    const value = JSON.parse(text); value[3] = hash(otherKey)
    publish(JSON.stringify(value), path)
  }
  const journal = await catalog().effects(processKey)
  await journal.retain(intake())
  expect(allocationFiles()).toHaveLength(2)
  expect(allocated(processKey)).not.toBe(allocated(otherKey))
  expect(existsSync(allocated(otherKey) + '.history')).toBe(false)
})

it('finds an existing key beyond an empty probe slot instead of allocating it again', async () => {
  await catalog().effects('fixture-seed')
  const start = Number.parseInt(hash(processKey).slice(0, 8), 16) % 256
  let index = (start + 3) % 256
  while (existsSync(join(root, `.native-hook-effects-${String(index).padStart(3, '0')}.allocation.witness`))) index = (index + 1) % 256
  const selected = join(root, `.native-hook-effects-${String(index).padStart(3, '0')}`)
  put(selected + '.allocation', [1, 'effects', index, hash(processKey)])
  await expect((async () => (await catalog().effects(processKey)).retain(intake()))()).resolves.toMatchObject({ intake: { id: intake().id } })
  expect(allocationFiles()).toHaveLength(2)
  expect(allocated()).toBe(selected)
})

it.each([false, true])('discards an ancestor redirection hiding an existing allocation (repeated=%s)', async repeated => {
  await catalog().effects('fixture-seed')
  const start = Number.parseInt(hash(processKey).slice(0, 8), 16) % 256
  let index = (start + 3) % 256
  while (existsSync(join(root, `.native-hook-effects-${String(index).padStart(3, '0')}.allocation.witness`))) index = (index + 1) % 256
  const selected = join(root, `.native-hook-effects-${String(index).padStart(3, '0')}.allocation`)
  put(selected, [1, 'effects', index, hash(processKey)])
  let redirected = false, hideMirror = false
  fault.stat = (path, read) => {
    if ((!redirected || repeated) && path === selected + '.witness') {
      redirected = true; hideMirror = true
      const parent = dirname(root), saved = parent + '.moved'
      renameSync(parent, saved); mkdirSync(parent, { mode: 0o700 }); mkdirSync(root, { mode: 0o700 })
      try { return read() } finally { rmSync(parent, { recursive: true }); renameSync(saved, parent) }
    }
    if (hideMirror && path === selected) { hideMirror = false; throw Object.assign(Error('fixture redirected absence'), { code: 'ENOENT' }) }
    return read()
  }
  if (repeated) await expect(catalog().effects(processKey)).rejects.toThrow('directory route changed')
  else {
    await expect((async () => (await catalog().effects(processKey)).retain(intake()))()).resolves.toMatchObject({ intake: { id: intake().id } })
    expect(allocated()).toBe(selected.replace(/\.allocation$/, ''))
  }
  expect(allocationFiles()).toHaveLength(2)
})

it('holds a changing allocation frontier without invalidating a separately retained journal', async () => {
  const store = catalog(), journal = await store.effects(processKey)
  await journal.retain(intake())
  const retained = await journal.snapshot()
  let queued = false
  fault.directoryRead = (path, read) => {
    const entry = read()
    if (!queued && path === root && !entry) {
      queued = true
      writeFileSync(join(root, 'fixture-sibling'), 'concurrent catalog-root publication')
    }
    return entry
  }
  await expect(catalog().effects('fixture-next-process')).rejects.toThrow('catalog changed during its scan')
  expect(allocationFiles()).toHaveLength(1)
  retained.verify()
  reset()
  await catalog().effects('fixture-next-process')
  retained.verify()
})

it('keeps repeated authority reads flat instead of retaining recursive confirmations', async () => {
  const journal = await catalog().effects(processKey)
  await journal.retain(intake())
  const costs: number[] = []
  for (let iteration = 0; iteration < 5; iteration++) {
    const before = rootChecks
    const snapshot = await journal.snapshot(); snapshot.verify()
    costs.push(rootChecks - before)
  }
  // Every iteration reads the same bytes. Old confirmation closures must not
  // multiply work even though each new observation still rechecks authority.
  expect(Math.max(...costs)).toBeLessThanOrEqual(2 * Math.min(...costs))
})

it('keeps recovered outbox owner checks free of repeated filesystem authority walks', async () => {
  const store = catalog(), input = clientInput(), shard = nativeHookOutboxShard(input.id)
  const original = await store.outbox(shard)
  await original.retain(input)
  const recovered = (await store.readOutbox(shard))!
  try {
    // Both boundaries have confirmed the same namespace before comparison.
    await original.snapshot(); await recovered.snapshot()
    const beforeOriginal = rootChecks
    await original.snapshot()
    const originalChecks = rootChecks - beforeOriginal, beforeRecovered = rootChecks
    await recovered.snapshot()
    const recoveredChecks = rootChecks - beforeRecovered
    // The existing-only handle adds its before/after selected authority fences.
    // Those constant wrappers must not double the full walk count. The broken
    // owner callback made 1,409 checks against the normal path's 489.
    expect(recoveredChecks).toBeLessThan(originalChecks * 2)
  } finally { original.close(); await recovered.close() }
})

it.each(['live', 'revocation', 'replacement'])('yields confirmed publication work to control callbacks and rechecks %s authority', async change => {
  const input = clientInput(), shard = nativeHookOutboxShard(input.id), store = catalog()
  const original = await store.outbox(shard)
  await original.retain(input)
  let current = true, elapsed = 0, finished = false, interleaved = false, scheduled = false
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  const prepare = files.runHookPreparation
  const base = allocated(`native-hook-client:v1:shard:${shard}`)
  vi.spyOn(files, 'runHookPreparation').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (!scheduled && args[0].includes(base + '.history.bootstrap')) {
      scheduled = true; elapsed += 30
      setImmediate(() => {
        interleaved = !finished
        if (change === 'revocation') current = false
        if (change === 'replacement') {
          const seal = base + '.seal', text = readlinkSync(seal)
          unlinkSync(seal); symlinkSync(text, seal)
        }
      })
    }
    return result
  })
  const recovered = (await store.readOutbox(shard, () => current))!
  try {
    let reason: unknown
    const result = await recovered.snapshot().then(() => 'confirmed', error => { reason = error; return 'held' })
    finished = true
    await new Promise<void>(done => setImmediate(done))
    expect(scheduled, String(reason)).toBe(true); expect(interleaved, String(reason)).toBe(true)
    expect(result).toBe(change === 'live' ? 'confirmed' : 'held')
  } finally { original.close(); await recovered.close() }
})

it.each(['intake', 'claim'])('retains the exact published witness across a yield before granting %s ownership', async kind => {
  const journal = await catalog().effects(processKey)
  if (kind === 'claim') await journal.retain(intake())
  else await journal.snapshot()
  const index = kind === 'claim' ? '00000001.json' : '00000000.json'
  const base = allocated(), witness = join(base + '.history.witnesses', index)
  let elapsed = 0, replaced = false
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  const prepare = files.runHookPreparation
  vi.spyOn(files, 'runHookPreparation').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (args[0].includes(witness) && !replaced) {
      elapsed += 30
      setImmediate(() => {
        // Identical bytes in another inode must not inherit the exclusive
        // publisher's authority when control returns from the cooperative yield.
        const replacement = join(root, 'fixture-replacement')
        writeFileSync(replacement, readFileSync(witness), { mode: 0o600 })
        renameSync(replacement, witness); replaced = true
      })
    }
    return result
  })
  const outcome = await (kind === 'claim' ? journal.claim(intake().id, intake().agentId) : journal.retain(intake()))
    .then(() => 'granted', () => 'held')
  expect(replaced).toBe(true)
  expect(outcome).toBe('held')
  expect(existsSync(join(base + '.history', index))).toBe(false)
})

it('bounds stalled replies while retaining actual operation slots and descriptors until cleanup', async () => {
  await catalog().effects('fixture-seed')
  const pending: { fd: number; done(error: Error | null): void }[] = []
  fault.sync = (fd, done) => { pending.push({ fd, done }); return true }
  const stalled = Array.from({ length: 16 }, () => catalog(200))
  const outcomes = await Promise.allSettled(stalled.map((value, index) => value.effects(`fixture-stalled-${index}`)))
  expect(outcomes.every(value => value.status === 'rejected')).toBe(true)
  expect(pending).toHaveLength(2)
  for (const operation of pending) expect(fstatSync(operation.fd).isDirectory()).toBe(true)
  await expect(catalog().effects('fixture-capacity-too-many')).rejects.toThrow('actual catalog operation slots are occupied')
  let closed = false
  const closing = Promise.all(stalled.map(value => value.close())).then(() => { closed = true })
  await new Promise<void>(done => setImmediate(done))
  expect(closed).toBe(false)
  const files = allocationFiles()
  fault.sync = undefined
  for (const operation of pending) operation.done(null)
  await closing
  for (const operation of pending) expect(() => fstatSync(operation.fd)).toThrow()
  expect(allocationFiles()).toEqual(files)
  await expect(catalog().effects('fixture-after-recovery')).resolves.toHaveProperty('retain')
})

it('holds a full catalog across restart while retaining recovery in an allocated namespace', async () => {
  const journal = await catalog().effects(processKey)
  await journal.retain(intake())
  for (let index = 0; index < 256; index++) {
    const file = join(root, `.native-hook-effects-${String(index).padStart(3, '0')}.allocation`)
    if (!existsSync(file + '.witness')) put(file, [1, 'effects', index, hash(`fixture-reservation-${index}`)])
  }
  await expect(catalog().effects('one-process-too-many')).rejects.toThrow('namespace capacity is exhausted')
  const recovered = await catalog().effects(processKey)
  expect((await recovered.retain(intake())).intake.id).toBe(intake().id)
  const claim = await recovered.claim(intake().id, intake().agentId)
  await claim.finish({ status: 200 })
  expect(allocationFiles()).toHaveLength(256)
})

it.each(['allocation-witness', 'orphan-seal', 'duplicate-key', 'version-witness', 'whole-version'] as const)('holds corrupt shared allocation authority: %s', async damage => {
  await (await catalog().effects(processKey)).retain(intake())
  const selected = allocated()
  if (damage === 'allocation-witness') unlinkSync(selected + '.allocation.witness')
  if (damage === 'orphan-seal') { unlinkSync(selected + '.allocation.witness'); unlinkSync(selected + '.allocation') }
  if (damage === 'duplicate-key') {
    const index = (JSON.parse(readlinkSync(selected + '.allocation'))[2] + 1) % 256
    put(join(root, `.native-hook-effects-${String(index).padStart(3, '0')}.allocation`), [1, 'effects', index, hash(processKey)])
  }
  if (damage === 'version-witness' || damage === 'whole-version') unlinkSync(join(root, '.native-hook-catalog.witness'))
  if (damage === 'whole-version') unlinkSync(join(root, '.native-hook-catalog'))
  const before = allocationFiles()
  await expect(catalog().effects('fixture-new-process')).rejects.toThrow()
  expect(allocationFiles()).toEqual(before)
})

it.each(['all-history', 'bootstrap', 'authority', 'seal', 'directory'] as const)('never recreates lost sealed journal authority: %s', async damage => {
  await (await catalog().effects(processKey)).retain(intake())
  const directory = allocated() + '.history'
  if (damage === 'all-history') for (const suffix of ['', '.witnesses', '.bootstrap', '.authority', '.seal']) rmSync(directory + suffix, { recursive: true })
  else if (damage === 'directory') rmSync(directory, { recursive: true })
  else unlinkSync(`${directory}.${damage}`)
  const before = readdirSync(root).sort()
  await expect((await catalog().effects(processKey)).snapshot()).rejects.toThrow()
  expect(readdirSync(root).sort()).toEqual(before)
})

it('does not adopt a populated journal whose catalog seal disappeared', async () => {
  await (await catalog().effects(processKey)).retain(intake())
  const selected = allocated()
  unlinkSync(selected + '.seal'); unlinkSync(selected + '.seal.witness')
  await expect((await catalog().effects(processKey)).snapshot()).rejects.toThrow('unsealed catalog allocation has journal history')
  expect(existsSync(selected + '.seal.witness')).toBe(false)
  expect(readdirSync(selected + '.history')).toHaveLength(1)
})

it('isolates a damaged journal from a separately allocated process', async () => {
  await (await catalog().effects(processKey)).retain(intake())
  unlinkSync(allocated() + '.history.authority')
  const unrelated = await catalog().effects('fixture-unrelated-process')
  await expect(unrelated.retain(intake('fixture-delivery-0002'))).resolves.toMatchObject({ intake: { id: 'fixture-delivery-0002' } })
})

it('counts effect metadata and both copies, reserving completion before a byte-cap hold', async () => {
  const journal = await catalog().effects(processKey)
  const body = intake('fixture-delivery-large', 280_000)
  await journal.retain(body)
  const directory = allocated() + '.history', snapshot = await journal.snapshot()
  const names = ['.bootstrap', '.authority', '.seal']
  const bytes = names.reduce((sum, suffix) => sum + Buffer.byteLength(readFileSync(directory + suffix)), 0)
    + 2 * Buffer.byteLength(readFileSync(join(directory, '00000000.json')))
  expect(snapshot.bytes).toBe(bytes)
  await expect(journal.retain(intake('fixture-next-too-large', 280_000))).rejects.toThrow('byte capacity')
  const claim = await journal.claim(body.id, body.agentId)
  await claim.finish({ status: 200, detail: 'x'.repeat(16_000) })
  expect((await (await catalog().effects(processKey)).retain(body)).result?.status).toBe(200)
  expect((await journal.snapshot()).bytes).toBeLessThanOrEqual(NATIVE_HOOK_STORAGE_LIMITS.effectBytes)
})

it('holds unbudgeted legacy staging instead of ignoring retained physical bytes', async () => {
  const journal = await catalog().effects(processKey)
  await journal.retain(intake())
  const directory = allocated() + '.history', file = join(directory, '.harness-hook-00000000-0000-4000-8000-000000000001.tmp')
  writeFileSync(file, 'legacy abandoned fixture', { mode: 0o600 })
  await expect(journal.snapshot()).rejects.toThrow('unbudgeted legacy staging')
  expect(readFileSync(file, 'utf8')).toBe('legacy abandoned fixture')
})

it('confirms known receipts with all staging lanes occupied', async () => {
  const journal = await catalog().effects(processKey)
  await journal.retain(intake())
  const leases = []
  for (let lane = 0; lane < 8; lane++) leases.push(await pool.acquire())
  try {
    await expect(journal.retain(intake())).resolves.toMatchObject({ intake: { id: intake().id } })
    await expect(journal.retain(intake('fixture-delivery-0002'))).rejects.toThrow('another writer owns this lane')
    expect((await journal.snapshot()).length).toBe(1)
  } finally { await Promise.all(leases.map(lease => lease.close())) }
})

it.each(['close', 'storage', 'owner'] as const)('revokes retained journal authority on %s changes', async reason => {
  let current = true
  const store = catalog(), journal = await store.effects(processKey, () => current)
  await journal.retain(intake())
  const saved = await journal.snapshot()
  if (reason === 'close') store.close()
  else if (reason === 'storage') local = false
  else current = false
  expect(() => saved.verify()).toThrow()
  await expect(journal.retain(intake())).rejects.toThrow()
})

it('reserves fixed outbox shards, including every remaining phase ACK under pressure', async () => {
  await pool.close(); pool = stagingPool({ maxGenerations: 4, terminalGenerations: 3 })
  const origin = { version: 1, boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', callerPid: 43,
    ancestry: [{ pid: 43, parentPid: 42, birth: '12346', identityV1: hash('caller') }] }
  const make = (id: string): NativeHookClientInput => ({ id, firedAt: 1791590400123, port: 19400,
    phases: [
      { name: 'registration', path: '/api/hook/session-start', body: { callerPid: 43, nativeOrigin: origin, prompt: 'x'.repeat(255_000) } },
      { name: 'stop', path: '/api/hook/turn-stop', body: { callerPid: 43, nativeOrigin: origin, detail: 'x'.repeat(255_000) } },
    ] })
  const shard = nativeHookOutboxShard('fixture-delivery-0001'), ids: string[] = []
  for (let value = 0; ids.length < 7; value++) {
    const id = `fixture-delivery-${String(value).padStart(5, '0')}`
    if (nativeHookOutboxShard(id) === shard) ids.push(id)
  }
  const outbox = await catalog().outbox(shard), deliveries = []
  for (const id of ids.slice(0, 6)) deliveries.push(await outbox.retain(make(id)))
  await expect(outbox.retain(make(ids[6]))).rejects.toThrow('byte capacity')
  for (let index = 6; index < 8; index++) { const lease = await pool.acquire(); await lease.close() }
  await expect(pool.acquire()).rejects.toThrow('generation capacity')
  for (const delivery of deliveries) {
    await expect(outbox.acknowledge(delivery, 'registration')).resolves.toBeUndefined()
    await expect(outbox.acknowledge(delivery, 'stop')).resolves.toBeUndefined()
  }
  const recovered = await (await catalog().outbox(shard)).snapshot()
  expect(recovered.deliveries.size).toBe(6)
  expect([...recovered.deliveries.values()].every(value => value.phases.every(phase => phase.acknowledged))).toBe(true)
  expect(allocationFiles()).toHaveLength(1)
}, 45_000)
