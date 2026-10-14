import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNativeHookJournal, createNativeHookOutboxLog, type NativeHookIntake } from './nativeHookJournal.js'
import { createNativeHookOutbox, nativeHookOutboxShard, type NativeHookClientInput } from './nativeHookOutbox.js'

const fault = vi.hoisted(() => ({ fail: false, defer: undefined as ((fd: number, done: (error: Error | null) => void) => boolean) | undefined }))
vi.mock('node:fs', async original => ({ ...await original<object>(),
  fsync: (fd: number, done: (error: Error | null) => void) => {
    if (fault.defer?.(fd, done)) return
    queueMicrotask(() => done(fault.fail ? Error('fixture disk unavailable') : null))
  },
}))
let root: string, directory: string
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const origin = () => ({ version: 1, boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', callerPid: 43,
  ancestry: [{ pid: 43, parentPid: 42, birth: '12346', identityV1: hash('caller') },
    { pid: 42, parentPid: 1, birth: '12345', identityV1: hash('engine') }] })
const input = (): NativeHookClientInput => ({ id: 'fixture-delivery-0001', firedAt: 1791590400123, port: 19400,
  phases: [
    { name: 'registration', path: '/api/hook/session-start', body: { sessionId: 'fixture-session', prompt: 'original prompt', callerPid: 43, nativeOrigin: origin() } },
    { name: 'stop', path: '/api/hook/turn-stop', body: { sessionId: 'fixture-session', status: 'completed', callerPid: 43, nativeOrigin: origin() } },
  ] })
const options = () => ({ directory, shard: nativeHookOutboxShard(input().id) })
const outbox = () => createNativeHookOutbox(options())
const processKey = 'fixture-client-namespace'
const raw = (id = input().id): NativeHookIntake => ({ id, fingerprint: hash(id), agentId: 'fixture-client', conversationId: '',
  phases: ['registration', 'stop'], payload: { original: 'bytes' } })
const journal = (extra: Partial<Parameters<typeof createNativeHookOutboxLog>[0]> = {}) => createNativeHookOutboxLog({ directory, processKey, ...extra })
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-outbox-')))
  directory = join(root, 'history'); fault.fail = false; fault.defer = undefined
})
afterEach(() => { fault.fail = false; fault.defer = undefined; rmSync(root, { recursive: true, force: true }) })

it('retains original bytes before awaiting and restores separate phases after the caller exits', async () => {
  const client = outbox(), body = input(), pending = client.retain(body)
  body.port++; body.firedAt++; body.phases[0].body.prompt = 'mutated prompt'
  body.phases[1].body.nativeOrigin = { ...origin(), callerPid: 99 }
  await expect(pending).resolves.toMatchObject({ id: input().id, port: input().port, firedAt: input().firedAt })
  const retained = await pending
  expect(retained).toMatchObject({ id: input().id, port: input().port, firedAt: input().firedAt })
  expect(retained.phases.map(phase => phase.acknowledged)).toEqual([false, false])
  expect(JSON.parse(retained.phases[0].body).prompt).toBe('original prompt')
  expect(Object.isFrozen(retained)).toBe(true)
  expect(Object.isFrozen(retained.phases)).toBe(true)
  expect(Object.isFrozen(retained.phases[0])).toBe(true)
  await client.acknowledge(retained, 'registration'); client.close()
  const restarted = outbox(), snapshot = await restarted.snapshot()
  await snapshot.confirm(); snapshot.verify()
  const recovered = snapshot.deliveries.get(retained.id)!
  expect(recovered.phases.map(phase => phase.acknowledged)).toEqual([true, false])
  expect(recovered.phases[0].body).toBe(retained.phases[0].body)
  await restarted.acknowledge(recovered, 'stop')
  expect((await outbox().retain(input())).phases.map(phase => phase.acknowledged)).toEqual([true, true])
})

it.each(['origin', 'time', 'body', 'port', 'endpoint', 'phases'] as const)('same ID with changed %s conflicts in the original shard', async change => {
  const client = outbox(), body = input()
  await client.retain(body)
  if (change === 'origin') for (const phase of body.phases) (phase.body.nativeOrigin as ReturnType<typeof origin>).ancestry[1].identityV1 = hash('replacement')
  if (change === 'time') body.firedAt++
  if (change === 'body') body.phases[0].body.prompt = 'replacement prompt'
  if (change === 'port') body.port++
  if (change === 'endpoint') body.phases = [{ name: 'event', path: '/api/hook/turn-start', body: body.phases[0].body }]
  if (change === 'phases') body.phases = [body.phases[0]]
  expect(nativeHookOutboxShard(body.id)).toBe(options().shard)
  await expect(client.retain(body)).rejects.toThrow('HOOK_DELIVERY_CONFLICT')
  expect((await client.snapshot()).deliveries.size).toBe(1)
})

it.each(['body', 'time'] as const)('fingerprint binds %s to the original delivery even across independent stores', async change => {
  const first = await outbox().retain(input()), body = input()
  if (change === 'body') body.phases[0].body.prompt = 'different original prompt'
  else body.firedAt++
  const second = await createNativeHookOutbox({ ...options(), directory: join(root, 'second') }).retain(body)
  expect(second.fingerprint).not.toBe(first.fingerprint)
})

it.each(['duplicate', 'snapshot'] as const)('a %s delivery keeps namespace and close authority without freezing sibling appends', async mode => {
  const client = outbox(), first = await client.retain(input())
  const observed = mode === 'duplicate' ? await client.retain(input()) : (await client.snapshot()).deliveries.get(first.id)!
  const second = input()
  for (let suffix = 2; suffix < 4096; suffix++) {
    second.id = `fixture-delivery-${String(suffix).padStart(4, '0')}`
    if (nativeHookOutboxShard(second.id) === options().shard) break
  }
  await client.retain(second)
  expect(() => observed.verify()).not.toThrow()
  client.close()
  expect(() => observed.verify()).toThrow('owner changed')
  const reopened = outbox(), recovered = mode === 'duplicate' ? await reopened.retain(input()) : (await reopened.snapshot()).deliveries.get(first.id)!
  unlinkSync(directory + '.seal')
  expect(() => recovered.verify()).toThrow()
})

it.each(['duplicate', 'snapshot'] as const)('a %s delivery respects a revoked destination owner', async mode => {
  let current = true
  const client = createNativeHookOutbox({ ...options(), current: () => current })
  await client.retain(input())
  const observed = mode === 'duplicate' ? await client.retain(input()) : (await client.snapshot()).deliveries.get(input().id)!
  current = false
  expect(() => observed.verify()).toThrow('owner changed')
})

it('rejects mismatched linked origin, caller and endpoint before retaining anything', async () => {
  const client = outbox(), body = input()
  body.phases[1].body.callerPid = 99
  await expect(client.retain(body)).rejects.toThrow('caller changed')
  body.phases[1].body.callerPid = 43
  ;(body.phases[1].body.nativeOrigin as ReturnType<typeof origin>).ancestry[1].identityV1 = hash('different engine')
  await expect(client.retain(body)).rejects.toThrow('different origins')
  const incorrect = input()
  incorrect.phases = [{ name: 'registration', path: '/api/hook/turn-stop', body: incorrect.phases[0].body }]
  await expect(client.retain(incorrect)).rejects.toThrow('invalid native client phase')
  expect(readdirSync(root)).toEqual([])
})

it('normalizes ownership ACKs once and never lets registration acknowledge Stop', async () => {
  const client = outbox(), retained = await client.retain(input())
  await expect(client.acknowledge(retained, 'stop')).rejects.toThrow('cannot be acknowledged')
  await client.acknowledge(retained, 'registration')
  const count = readdirSync(directory).length
  // Both owned-pending and completed HTTP responses call this same API. No
  // changing reply body is persisted and no duplicate consumes another record.
  await outbox().acknowledge(retained, 'registration')
  expect(readdirSync(directory).length).toBe(count)
  expect((await outbox().snapshot()).deliveries.get(retained.id)?.phases.map(phase => phase.acknowledged)).toEqual([true, false])
  await expect(client.acknowledge({ ...retained, fingerprint: hash('other delivery') }, 'stop')).rejects.toThrow('HOOK_DELIVERY_CONFLICT')
  expect('claim' in client).toBe(false)
  expect('finish' in client).toBe(false)
})

it('seals the explicit outbox kind in every authority and record', async () => {
  const log = journal(), intake = raw()
  await log.retain(intake); await log.acknowledge(intake.id, intake.fingerprint, 'registration')
  expect('claim' in log).toBe(false)
  for (const suffix of ['.bootstrap', '.authority', '.seal']) expect(JSON.parse(readFileSync(directory + suffix, 'utf8')).log).toBe('native-hook-outbox')
  for (const folder of [directory, directory + '.witnesses']) for (const name of readdirSync(folder)) {
    expect(JSON.parse(readFileSync(join(folder, name), 'utf8')).log).toBe('native-hook-outbox')
  }
  await expect(createNativeHookJournal({ directory, processKey }).snapshot()).rejects.toThrow('bootstrap changed')
})

it('never interprets an effects namespace as a fresh outbox', async () => {
  const original = createNativeHookJournal({ directory, processKey })
  await original.retain({ ...raw(), phases: undefined })
  await expect(journal().snapshot()).rejects.toThrow('bootstrap changed')
})

it.each(['.bootstrap', '.authority', '.seal', '/00000000.json', '.witnesses/00000000.json'])('holds missing established %s without recreating history', async suffix => {
  await outbox().retain(input())
  unlinkSync(directory + suffix)
  // A missing final mirror may be completed from its outside witness, which
  // retains all original bytes. Losing anything else may never become empty.
  if (suffix === '/00000000.json') {
    const recovered = (await outbox().snapshot()).deliveries.get(input().id)!
    expect(JSON.parse(recovered.phases[0].body).prompt).toBe('original prompt')
  } else await expect(outbox().snapshot()).rejects.toThrow()
})

it('reserves both phase ACKs before admitting another delivery at a full frontier', async () => {
  const log = journal({ maxRecords: 3 }), first = raw(), second = raw('fixture-delivery-0002')
  await log.retain(first)
  await expect(log.retain(second)).rejects.toThrow('capacity cannot retain terminal outcomes')
  await log.acknowledge(first.id, first.fingerprint, 'registration')
  await expect(log.retain(second)).rejects.toThrow('capacity cannot retain terminal outcomes')
  await log.acknowledge(first.id, first.fingerprint, 'stop')
  await log.acknowledge(first.id, first.fingerprint, 'registration')
  expect((await log.snapshot()).length).toBe(3)
  expect((await log.snapshot()).deliveries.size).toBe(1)
})

it.each([2, 5])('reserves new and already outstanding ACK records at limit %s', async maxRecords => {
  const log = journal({ maxRecords }), first = raw(), second = raw('fixture-delivery-0002')
  if (maxRecords === 5) await log.retain(first)
  await expect(log.retain(maxRecords === 2 ? first : second)).rejects.toThrow('capacity cannot retain terminal outcomes')
  expect((await log.snapshot()).length).toBe(maxRecords === 2 ? 0 : 1)
})

it('reserves both copies of every ACK and counts metadata in the byte budget', async () => {
  const unrestricted = journal(), before = await unrestricted.snapshot()
  expect(before.bytes).toBeGreaterThan(0)
  const log = journal({ maxBytes: before.bytes + 8_000 })
  await expect(log.retain(raw())).rejects.toThrow('byte capacity cannot retain terminal outcomes')
  expect((await unrestricted.snapshot()).length).toBe(0)
})

it('counts linked Stop as pending after registration ACK and releases capacity only after both', async () => {
  const log = journal({ pendingCapacity: 1 }), first = raw(), second = raw('fixture-delivery-0002')
  await log.retain(first); await log.acknowledge(first.id, first.fingerprint, 'registration')
  await expect(log.retain(second)).rejects.toThrow('too many pending')
  await log.acknowledge(first.id, first.fingerprint, 'stop')
  await log.retain(second)
  expect((await log.snapshot()).deliveries.size).toBe(2)
})

it('does not acknowledge a response before its disk confirmation succeeds', async () => {
  const client = outbox(), retained = await client.retain(input())
  fault.fail = true
  await expect(client.acknowledge(retained, 'registration')).rejects.toThrow('fixture disk unavailable')
  fault.fail = false
  expect((await outbox().snapshot()).deliveries.get(retained.id)?.phases[0].acknowledged).toBe(false)
  await client.acknowledge(retained, 'registration')
  expect((await outbox().snapshot()).deliveries.get(retained.id)?.phases[0].acknowledged).toBe(true)
})

it('does not expose recovered ACKs before confirming their durability', async () => {
  const client = outbox(), retained = await client.retain(input())
  await client.acknowledge(retained, 'registration')
  fault.fail = true
  await expect(outbox().snapshot()).rejects.toThrow('fixture disk unavailable')
  fault.fail = false
  expect((await outbox().snapshot()).deliveries.get(retained.id)?.phases.map(phase => phase.acknowledged)).toEqual([true, false])
})

it('serializes competing ACKs and confirms the winner without another phase record', async () => {
  const a = outbox(), b = outbox(), retained = await a.retain(input())
  const attempts = await Promise.allSettled([a.acknowledge(retained, 'registration'), b.acknowledge(retained, 'registration')])
  expect(attempts.some(attempt => attempt.status === 'fulfilled')).toBe(true)
  await b.acknowledge(retained, 'registration')
  expect(readdirSync(directory)).toHaveLength(2)
  expect((await outbox().snapshot()).deliveries.get(retained.id)?.phases.map(phase => phase.acknowledged)).toEqual([true, false])
})

it('rejects an outbox ACK disguised as an effect claim', async () => {
  const log = journal(), body = raw()
  await log.retain(body); await log.acknowledge(body.id, body.fingerprint, 'registration')
  const path = join(directory, '00000001.json'), record = JSON.parse(readFileSync(path, 'utf8'))
  record.event = { kind: 'claim', id: body.id, token: 'fixture-effect-token', agentId: body.agentId, predecessor: null }
  for (const folder of [directory, directory + '.witnesses']) writeFileSync(join(folder, '00000001.json'), JSON.stringify(record), { mode: 0o600 })
  await expect(log.snapshot()).rejects.toThrow('invalid hook effect order')
})

it('rejects changed on-disk body even when the immutable framing is internally consistent', async () => {
  const client = outbox(), retained = await client.retain(input())
  for (const folder of [directory, directory + '.witnesses']) {
    const path = join(folder, '00000000.json'), record = JSON.parse(readFileSync(path, 'utf8'))
    const body = JSON.parse(Buffer.from(record.event.intake.payload.phases[0].bodyBase64, 'base64').toString('utf8'))
    body.prompt = 'changed after retention'
    record.event.intake.payload.phases[0].bodyBase64 = Buffer.from(JSON.stringify(body)).toString('base64')
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 })
  }
  await expect(client.snapshot()).rejects.toThrow('retained native client delivery changed')
  expect(() => retained.verify()).toThrow()
})

it('holds a wrong shard without creating a second delivery authority', async () => {
  const wrong = createNativeHookOutbox({ directory, shard: (options().shard + 1) % 16 })
  await expect(wrong.retain(input())).rejects.toThrow('another shard')
  expect(readdirSync(root)).toEqual([])
})

it('retains a formerly valid large escaped prompt without double JSON expansion', async () => {
  const body = input(); body.phases = [body.phases[0]]
  body.phases[0].body.prompt = '\\'.repeat(100_000)
  const expected = JSON.stringify(body.phases[0].body)
  expect(Buffer.byteLength(expected)).toBeLessThan(256 * 1024)
  const pending = outbox().retain(body)
  await expect(pending).resolves.toMatchObject({ phases: [{ body: expected, acknowledged: false }] })
  const retained = await pending
  expect((await outbox().snapshot()).deliveries.get(body.id)?.phases[0].body).toBe(expected)
  await outbox().acknowledge(retained, 'registration')
  expect((await outbox().retain(body)).phases[0].acknowledged).toBe(true)
})

it('fits two maximum HTTP bodies and both durable ACKs within the bounded record format', async () => {
  const body = input()
  for (const phase of body.phases) {
    phase.body.prompt = ''
    const padding = 256 * 1024 - Buffer.byteLength(JSON.stringify(phase.body))
    phase.body.prompt = '\\'.repeat(Math.floor(padding / 2)) + 'x'.repeat(padding % 2)
    expect(Buffer.byteLength(JSON.stringify(phase.body))).toBe(256 * 1024)
  }
  const client = createNativeHookOutbox({ ...options(), maxBytes: 1_500_000, maxRecords: 3 })
  const pending = client.retain(body)
  await expect(pending).resolves.toMatchObject({ id: body.id })
  const retained = await pending
  for (const [index, phase] of retained.phases.entries()) {
    expect(phase.body).toBe(JSON.stringify(body.phases[index].body))
    await client.acknowledge(retained, phase.name)
  }
  expect((await outbox().retain(body)).phases.map(phase => phase.acknowledged)).toEqual([true, true])
  for (const file of readdirSync(directory)) expect(Buffer.byteLength(readFileSync(join(directory, file)))).toBeLessThan(1024 * 1024)
})

it.each(['noncanonical', 'invalid-utf8', 'oversized'] as const)('rejects %s persisted wire encoding before returning a request', async corruption => {
  await outbox().retain(input())
  for (const folder of [directory, directory + '.witnesses']) {
    const path = join(folder, '00000000.json'), record = JSON.parse(readFileSync(path, 'utf8'))
    const phase = record.event.intake.payload.phases[0]
    if (corruption === 'noncanonical') phase.bodyBase64 += '\n'
    if (corruption === 'invalid-utf8') phase.bodyBase64 = Buffer.from([0xff]).toString('base64')
    if (corruption === 'oversized') phase.bodyBase64 = Buffer.alloc(256 * 1024 + 1, 0x20).toString('base64')
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 })
  }
  await expect(outbox().snapshot()).rejects.toThrow()
})
