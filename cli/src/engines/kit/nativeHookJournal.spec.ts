import { createHash } from 'node:crypto'
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, type opendirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNativeHookJournal, type NativeHookIntake } from './nativeHookJournal.js'
import { fixtureNativeGenerationFact as generationFact } from '../../testing/nativeGenerationFactFixture.js'

const fault = vi.hoisted(() => ({ fail: false, onSync: undefined as ((fd: number) => void) | undefined,
  beforeOpen: undefined as ((path: string) => void) | undefined,
  openDirectory: undefined as ((path: string, open: typeof opendirSync) => ReturnType<typeof opendirSync>) | undefined,
  deferSync: undefined as ((fd: number, callback: (error: Error | null) => void) => boolean) | undefined,
  afterMkdir: undefined as ((path: string) => void) | undefined,
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
  openSync: (path: string, flags: number, mode?: number) => { fault.beforeOpen?.(path); return fs.openSync(path, flags, mode) },
  opendirSync: (path: string, options: Parameters<typeof opendirSync>[1]) => fault.openDirectory?.(path, fs.opendirSync) ?? fs.opendirSync(path, options),
  mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => { const result = fs.mkdirSync(...args); fault.afterMkdir?.(String(args[0])); return result },
  fsync: (_fd: number, callback: (error: Error | null) => void) => {
    fault.onSync?.(_fd)
    if (fault.deferSync?.(_fd, callback)) return
    queueMicrotask(() => callback(fault.fail ? Error('fixture disk confirmation unavailable') : null))
  },
}})
let root: string, directory: string
const processKey = 'linux:fixture-boot\u0000codex\u00005100\u0000t:1234'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const intake = (id = 'fixture-delivery-0001', agentId = 'agent-one'): NativeHookIntake => ({
  id, agentId, fingerprint: hash(id), conversationId: 'conversation-one', firedAt: 1791590400123,
  payload: { prompt: 'fixture prompt', runtimeHints: [{ backend: 'tmux', paneId: '%1' }] },
})
const journal = (options: Partial<Parameters<typeof createNativeHookJournal>[0]> = {}) => createNativeHookJournal({ directory, processKey, ...options })
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-journal-')))
  directory = join(root, 'history'); fault.fail = false; fault.onSync = undefined
  fault.beforeOpen = undefined; fault.openDirectory = undefined; fault.deferSync = undefined; fault.afterMkdir = undefined
})
afterEach(() => {
  fault.fail = false; fault.onSync = undefined; fault.beforeOpen = undefined; fault.openDirectory = undefined; fault.deferSync = undefined; fault.afterMkdir = undefined
  rmSync(root, { recursive: true, force: true })
})

it('retains immutable generation facts without granting or clearing effect ownership', async () => {
  const owner = journal(), body = intake(), fact = generationFact('activity')
  await owner.retain(body)
  const claim = await owner.claim(body.id, body.agentId), before = await owner.snapshot()
  const saving = owner.recordGeneration(fact)
  fact.generationId = 'caller changed its generation'
  await saving
  const recovered = await journal().snapshot()
  expect(recovered.processKey).toBe(processKey)
  expect(recovered.generations.get(fact.id)?.generationId).toBe('generation-one')
  expect(recovered.active?.token).toBe(claim.token)
  expect(recovered.lastResult).toBe(before.lastResult)
  expect(() => before.verify()).toThrow('changed during recovery')
  expect(() => claim.verify()).not.toThrow()
  await expect(journal().claim(body.id, body.agentId)).rejects.toThrow('earlier native hook effect')
  await claim.finish({ status: 200 })
  expect((await owner.snapshot()).generations.size).toBe(1)
})

it('deduplicates exact generation phases and refuses changed content under their original identity', async () => {
  const owner = journal(), first = generationFact('submitted', 'fixture-shared-delivery')
  const stop = generationFact('stopped', 'fixture-shared-delivery')
  expect(first.id).not.toBe(stop.id)
  await owner.recordGeneration(first)
  await owner.recordGeneration(stop)
  await journal().recordGeneration(stop)
  expect((await owner.snapshot()).length).toBe(2)
  await expect(owner.recordGeneration({ ...stop, generationId: 'replacement' })).rejects.toThrow('NATIVE_GENERATION_CONFLICT')
  if (stop.kind !== 'stopped') throw Error('fixture source')
  await expect(owner.recordGeneration({ ...stop, source: { ...stop.source, wire: { ...stop.source.wire, bodySha256: hash('replacement') } } }))
    .rejects.toThrow('NATIVE_GENERATION_CONFLICT')
})

it('reserves Stop capacity only for actual execution, not rejected submissions', async () => {
  const owner = journal({ maxBytes: 135_000 })
  for (let index = 0; index < 30; index++) await owner.recordGeneration(generationFact('submitted', `fixture-submitted-${index}`, `generation-${index}`))
  await expect(owner.recordGeneration(generationFact('activity'))).resolves.toBeUndefined()
  await expect(owner.recordGeneration(generationFact('activity', 'fixture-activity-second', 'generation-two'))).rejects.toThrow('terminal outcomes')
  await owner.recordGeneration(generationFact('stopped'))
  await expect(owner.recordGeneration(generationFact('activity', 'fixture-activity-second', 'generation-two'))).resolves.toBeUndefined()
})

it.each(['intake', 'direct'])('keeps the original %s representation exclusive across generation retries', async first => {
  const body = intake(), fact = generationFact('stopped', body.id)
  if (fact.kind !== 'stopped') throw Error('fixture Stop')
  fact.source.identityV1 = hash('fixture original image')
  const owner = journal()
  if (first === 'intake') {
    await owner.retain(body)
    await expect(journal().recordGeneration(fact)).rejects.toThrow('already has an original intake')
    expect((await journal().snapshot()).generations.size).toBe(0)
  } else {
    await owner.recordGeneration(fact)
    await expect(journal().retain(body)).rejects.toThrow('already has a direct receipt')
    expect((await journal().snapshot()).deliveries.size).toBe(0)
  }
})

it('shares record and byte reservations between legacy effects, native generations and the cancellation barrier', async () => {
  const owner = journal({ maxRecords: 9, maxBytes: 135_000 }), body = intake()
  await owner.retain(body)
  await owner.recordGeneration(generationFact('activity'))
  await expect(owner.retain(intake('fixture-second-intake'))).rejects.toThrow('terminal outcomes')
  await expect(owner.recordGeneration(generationFact('activity', 'fixture-activity-second', 'generation-two'))).rejects.toThrow('terminal outcomes')
  await (await owner.claim(body.id, body.agentId)).finish({ status: 200 })
  await owner.recordGeneration(generationFact('stopped'))
  const after = await owner.snapshot()
  expect(after.deliveries.get(body.id)?.result).toEqual({ status: 200 })
  expect(after.generations.get(generationFact('stopped').id)?.kind).toBe('stopped')
})

it('does not acknowledge an unconfirmed visible generation fact', async () => {
  const owner = journal(), fact = generationFact('stopped')
  await owner.snapshot()
  fault.onSync = fd => {
    if (fstatSync(fd).isDirectory() && existsSync(join(directory, '00000000.json'))) fault.fail = true
  }
  await expect(owner.recordGeneration(fact)).rejects.toThrow('fixture disk confirmation unavailable')
  fault.onSync = undefined
  expect((await journal().snapshot()).generations.get(fact.id)).toEqual(fact)
  await expect(journal().recordGeneration(fact)).rejects.toThrow('fixture disk confirmation unavailable')
  fault.fail = false
  await journal().recordGeneration(fact)
  expect((await journal().snapshot()).length).toBe(1)
})

it('keeps native input from manufacturing core Cancel authority', async () => {
  const owner = journal(), fact = generationFact('activity')
  await expect(owner.recordGeneration({ ...fact, kind: 'cancelled' } as any)).rejects.toThrow('invalid native generation fact')
  const cancelled = generationFact('cancelled')
  await expect(owner.recordGeneration({ ...cancelled, kind: 'activity' } as any)).rejects.toThrow('invalid native generation fact')
  await expect(owner.recordGeneration({ ...fact, id: generationFact('stopped').id })).rejects.toThrow('invalid native generation fact')
  expect((await owner.snapshot()).generations.size).toBe(0)
})

it('retains one core Cancel request for each independently scoped generation', async () => {
  const owner = journal(), first = generationFact('cancelled', 'fixture-shared-cancel', 'generation-one')
  const second = generationFact('cancelled', 'fixture-shared-cancel', 'generation-two')
  expect(first.id).not.toBe(second.id)
  await owner.recordGeneration(first)
  await owner.recordGeneration(second)
  expect([...((await journal().snapshot()).generations.values())].map(fact => fact.generationId)).toEqual(['generation-one', 'generation-two'])
})

it('enforces the generation projection limit before retaining a new identity', async () => {
  const owner = journal()
  await owner.snapshot()
  let previous: string | null = null
  for (let index = 0; index < 512; index++) {
    const fact = generationFact('submitted', `fixture-generation-${index}`, `generation-${index}`)
    const text = JSON.stringify({ version: 1, processKey, index, previous, event: { kind: 'generation', fact } })
    for (const dir of [directory, `${directory}.witnesses`]) writeFileSync(join(dir, `${String(index).padStart(8, '0')}.json`), text, { mode: 0o600 })
    previous = hash(text)
  }
  await expect(owner.recordGeneration(generationFact('activity'))).rejects.toThrow('generation capacity')
  await owner.recordGeneration(generationFact('stopped', 'fixture-existing-stop', 'generation-0'))
  expect((await owner.snapshot()).generations.size).toBe(513)
})

it('retains immutable intake and completed receipts across reconstructed cores', async () => {
  const original = journal(), body = intake()
  const pending = original.retain(body)
  body.payload.prompt = 'caller changed its object'
  expect((await pending).intake.payload.prompt).toBe('fixture prompt')
  const recovered = journal()
  expect((await recovered.snapshot()).deliveries.get(body.id)?.intake.payload.prompt).toBe('fixture prompt')
  const claim = await recovered.claim(body.id, body.agentId)
  claim.verify()
  await claim.finish({ status: 200, reply: { ok: true }, promptAt: body.firedAt })
  expect(() => claim.verify()).toThrow('already completed')
  expect((await journal().retain(intake())).result).toEqual({ status: 200, reply: { ok: true }, promptAt: body.firedAt })
  await expect(journal().claim(body.id, body.agentId)).rejects.toThrow('cannot dispatch')
  await expect(journal().retain({ ...intake(), fingerprint: hash('changed') })).rejects.toThrow('HOOK_DELIVERY_CONFLICT')
})

it('shares effect order between different agent views of the same native process', async () => {
  const a = journal(), b = journal()
  const first = intake(), second = intake('fixture-delivery-0002', 'agent-two')
  await a.retain(first); await b.retain(second)
  const claimed = await a.claim(first.id, first.agentId)
  await expect(b.claim(second.id, second.agentId)).rejects.toThrow('earlier native hook effect')
  await expect(journal().claim(first.id, first.agentId)).rejects.toThrow('earlier native hook effect')
  await claimed.finish({ status: 200, reply: { ok: true } })
  const next = await b.claim(second.id, second.agentId)
  next.verify()
  await next.finish({ status: 200, reply: { ok: true } })
  expect((await journal().snapshot()).active).toBeUndefined()
})

it('shares in-flight namespace initialization between background recovery and admission', async () => {
  const active = journal()
  let release!: () => void, delayed = false
  fault.deferSync = (_fd, callback) => {
    if (delayed) return false
    delayed = true; release = () => callback(null); return true
  }
  const recovery = active.snapshot()
  await vi.waitFor(() => expect(delayed).toBe(true))
  const admission = active.snapshot()
  const combined = Promise.allSettled([recovery, admission])
  release()
  const results = await combined
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
  for (const result of results) if (result.status === 'fulfilled') {
    expect(result.value.deliveries.size).toBe(0)
    result.value.verify()
  }
  // A completed read is never a cache: removed authority must hold the next read.
  unlinkSync(`${directory}.seal`)
  writeFileSync(join(directory, 'unrecognized'), 'fixture')
  await expect(active.snapshot()).rejects.toThrow()
})

it.each([false, true])('joins identical immutable confirmations during admission and recovery (separate journal=%s)', async separate => {
  const first = journal(), second = separate ? journal() : first
  await first.retain(intake())
  const inspected = await first.snapshot()
  let delayed = false, release!: () => void
  fault.deferSync = (_fd, done) => {
    if (delayed) return false
    delayed = true; release = () => done(null); return true
  }
  const confirming = inspected.confirm()
  await vi.waitFor(() => expect(delayed).toBe(true))
  const recovering = second.snapshot()
  const duplicate = inspected.confirm()
  const completed = Promise.allSettled([confirming, recovering, duplicate])
  release()
  const outcomes = await completed
  expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
  inspected.verify()
  const snapshot = await second.snapshot()
  expect(snapshot.deliveries.size).toBe(1)
  expect(snapshot.active).toBeUndefined()
})

it('revokes a joining confirmation without revoking the original journal owner', async () => {
  const first = journal(), joining = journal()
  await first.retain(intake())
  const original = await first.snapshot(), joined = await joining.snapshot()
  let delayed = false, release!: () => void
  fault.deferSync = (_fd, done) => {
    if (delayed) return false
    delayed = true; release = () => done(null); return true
  }
  const firstConfirmation = original.confirm()
  await vi.waitFor(() => expect(delayed).toBe(true))
  const joinedConfirmation = joined.confirm(), completed = Promise.allSettled([firstConfirmation, joinedConfirmation])
  joining.close(); release()
  const outcomes = await completed
  expect(outcomes[0].status).toBe('fulfilled')
  expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('owner changed') }) })
  original.verify()
})

it('rejects every joined confirmation when the inspected immutable record changes', async () => {
  const owner = journal()
  await owner.retain(intake())
  const before = await owner.snapshot()
  let delayed = false, release!: () => void
  fault.deferSync = (_fd, done) => {
    if (delayed) return false
    delayed = true; release = () => done(null); return true
  }
  const first = before.confirm()
  await vi.waitFor(() => expect(delayed).toBe(true))
  const second = before.confirm(), completed = Promise.allSettled([first, second])
  writeFileSync(`${directory}.bootstrap`, 'changed fixture record', { mode: 0o600 })
  release()
  expect((await completed).map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
  expect(() => before.verify()).toThrow()
})

it('revokes shared confirmation when its producer closes and lets a surviving observer retry', async () => {
  const first = journal(), surviving = journal()
  const body = intake()
  await first.retain(body)
  const claim = await first.claim(body.id, body.agentId)
  const original = await first.snapshot(), joined = await surviving.snapshot()
  let delayed = false, release!: () => void
  fault.deferSync = (_fd, done) => {
    if (delayed) return false
    delayed = true; release = () => done(null); return true
  }
  const producer = original.confirm()
  await vi.waitFor(() => expect(delayed).toBe(true))
  const observer = joined.confirm(), completed = Promise.allSettled([producer, observer])
  first.close(); release()
  const outcomes = await completed
  for (const outcome of outcomes) expect(outcome).toMatchObject({ status: 'rejected',
    reason: expect.objectContaining({ message: expect.stringContaining('owner changed') }) })
  const fresh = await surviving.snapshot()
  await fresh.confirm()
  expect(fresh.active?.token).toBe(claim.token)
  await expect(surviving.claim(body.id, body.agentId)).rejects.toThrow('earlier native hook effect')
})

it.each(['close', 'owner change'] as const)('revokes every initialization waiter after %s', async reason => {
  let current = true, release!: () => void, delayed = false
  const active = journal({ current: () => current })
  fault.deferSync = (_fd, callback) => {
    if (delayed) return false
    delayed = true; release = () => callback(null); return true
  }
  const recovery = active.snapshot()
  await vi.waitFor(() => expect(delayed).toBe(true))
  const admission = active.snapshot(), combined = Promise.allSettled([recovery, admission])
  if (reason === 'close') active.close()
  else current = false
  release()
  const results = await combined
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
  for (const result of results) if (result.status === 'rejected') expect(String(result.reason)).toContain('owner changed')
})

it('never transfers a crashed publisher’s claim to a new caller', async () => {
  const original = journal(), body = intake()
  await original.retain(body)
  const claimed = await original.claim(body.id, body.agentId)
  original.close()
  expect(() => claimed.verify()).toThrow('owner changed')
  await expect(claimed.finish({ status: 200 })).rejects.toThrow('owner changed')
  const recovered = journal()
  expect((await recovered.snapshot()).active?.token).toBe(claimed.token)
  await expect(recovered.claim(body.id, body.agentId)).rejects.toThrow('earlier native hook effect')
})

it('refuses an effect inspected before another core advanced the accepted frontier', async () => {
  const a = journal(), b = journal(), first = intake(), second = intake('fixture-delivery-0002')
  await a.retain(first); await b.retain(second)
  const inspected = await a.snapshot()
  await (await b.claim(second.id, second.agentId)).finish({ accepted: true })
  await expect(a.claim(first.id, first.agentId, { previous: inspected.previous })).rejects.toThrow('order changed after inspection')
  expect((await a.snapshot()).active).toBeUndefined()
  const current = await a.snapshot()
  const claimed = await a.claim(first.id, first.agentId, { previous: current.previous })
  await claimed.finish({ accepted: false, reply: { ignored: true, reason: 'stale_hook' } })
})

it('includes an unclaimed intake from another core in the effect frontier', async () => {
  const a = journal(), b = journal(), first = intake()
  await a.retain(first)
  const inspected = await a.snapshot()
  await b.retain(intake('fixture-delivery-0002'))
  await expect(a.claim(first.id, first.agentId, { previous: inspected.previous })).rejects.toThrow('order changed after inspection')
  expect((await a.snapshot()).active).toBeUndefined()
})

it('allows only the exclusive effect publisher to dispatch under contention', async () => {
  const a = journal(), b = journal(), body = intake()
  await a.retain(body)
  const attempts = await Promise.allSettled([a.claim(body.id, body.agentId), b.claim(body.id, body.agentId)])
  const owned = attempts.filter(attempt => attempt.status === 'fulfilled')
  expect(owned).toHaveLength(1)
  expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
  expect((await journal().snapshot()).active?.token).toBe(owned[0]!.value.token)
})

it.each(['witness', 'authority', 'directory', 'bootstrap', 'seal'])('holds a missing %s without making completed delivery new', async lost => {
  const original = journal(), body = intake()
  await original.retain(body)
  const claim = await original.claim(body.id, body.agentId)
  await claim.finish({ status: 200, reply: { ok: true } })
  if (lost === 'directory') {
    renameSync(directory, `${directory}.preserved`); mkdirSync(directory, { mode: 0o700 })
  } else unlinkSync(['authority', 'bootstrap', 'seal'].includes(lost) ? `${directory}.${lost}`
    : join(lost === 'witness' ? `${directory}.witnesses` : directory, '00000002.json'))
  await expect(journal().retain(body)).rejects.toThrow()
  expect(readdirSync(`${directory}.witnesses`).filter(name => /^\d/.test(name)).length).toBe(lost === 'witness' ? 2 : 3)
})

it('recovers only the last exact mirror without granting an interrupted claim to its reader', async () => {
  const original = journal(), body = intake()
  await original.retain(body)
  const claim = await original.claim(body.id, body.agentId)
  const file = join(directory, '00000001.json'), bytes = readFileSync(file, 'utf8')
  unlinkSync(file)
  const recovered = await journal().snapshot()
  expect(recovered.active?.token).toBe(claim.token)
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  await expect(journal().claim(body.id, body.agentId)).rejects.toThrow('earlier native hook effect')
  unlinkSync(join(directory, '00000000.json'))
  await expect(journal().snapshot()).rejects.toThrow()
})

it.each(['bytes', 'mode', 'alias', 'process'])('holds changed %s authority without rewriting it', async changed => {
  await journal().retain(intake())
  const file = join(directory, '00000000.json')
  if (changed === 'bytes') writeFileSync(file, readFileSync(file, 'utf8') + ' ')
  if (changed === 'mode') chmodSync(file, 0o666)
  if (changed === 'alias') { renameSync(file, join(root, 'foreign')); symlinkSync(join(root, 'foreign'), file) }
  const bytes = readFileSync(file, 'utf8')
  await expect(journal(changed === 'process' ? { processKey: 'another-boot-and-process' } : {}).snapshot()).rejects.toThrow()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it('does not create a journal for a revoked owner', async () => {
  await expect(journal({ current: () => false }).retain(intake())).rejects.toThrow('owner changed')
  expect(existsSync(directory)).toBe(false)
})

it('checks fresh ownership after every asynchronous disk confirmation', async () => {
  let current = true
  const original = journal({ current: () => current })
  await original.retain(intake())
  fault.onSync = () => { current = false }
  await expect(original.claim(intake().id, intake().agentId)).rejects.toThrow()
  fault.onSync = undefined
  expect((await journal().snapshot()).deliveries.get(intake().id)?.result).toBeUndefined()
})

it('retains publication authority through a held claim flush without borrowing an equal replacement', async () => {
  const original = journal({ current: () => true })
  const body = intake()
  await original.retain(body)
  const before = [readdirSync(directory), readdirSync(`${directory}.witnesses`)]
  let staging = false, delayed = false, release!: () => void
  fault.beforeOpen = path => { if (path.startsWith(`${directory}.witnesses/.harness-hook-`)) staging = true }
  fault.deferSync = (_fd, done) => {
    if (!staging || delayed) return false
    delayed = true; release = () => done(null); return true
  }
  const claim = original.claim(body.id, body.agentId).then(value => ({ value }), error => ({ error }))
  try {
    await vi.waitFor(() => expect(delayed).toBe(true))
    const authority = `${directory}.authority`, replacement = join(root, 'replacement')
    writeFileSync(replacement, readFileSync(authority), { mode: 0o600 })
    renameSync(replacement, authority)
  } finally { release?.() }
  expect(await claim).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/changed/) }) })
  expect([readdirSync(directory), readdirSync(`${directory}.witnesses`)]).toEqual(before)
})

it('does not acknowledge an intake whose durability cannot be confirmed', async () => {
  const original = journal()
  await original.snapshot()
  fault.fail = true
  await expect(original.retain(intake())).rejects.toThrow('fixture disk confirmation unavailable')
  fault.fail = false
  expect((await original.snapshot()).deliveries.size).toBe(0)
})

it('counts concurrent reservations before acknowledging its pending capacity', async () => {
  const a = journal({ pendingCapacity: 1 }), b = journal({ pendingCapacity: 1 })
  await a.snapshot()
  const accepted = await Promise.allSettled([a.retain(intake()), b.retain(intake('fixture-delivery-0002'))])
  expect(accepted.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  await expect(b.retain(intake('fixture-delivery-0003'))).rejects.toThrow('too many pending')
})

it('holds bounded history without deleting an older delivery', async () => {
  const original = journal({ maxRecords: 3 })
  await original.retain(intake())
  await (await original.claim(intake().id, intake().agentId)).finish({ status: 200 })
  await expect(original.retain(intake('fixture-delivery-0002'))).rejects.toThrow('record capacity')
  expect((await journal().snapshot()).deliveries.get(intake().id)?.result).toEqual({ status: 200 })
})

it('holds oversized history before publishing any intake', async () => {
  const original = journal({ maxBytes: 100 })
  await expect(original.retain(intake())).rejects.toThrow('byte capacity')
  expect((await journal().snapshot()).deliveries.size).toBe(0)
})

it('reserves claim and terminal slots before acknowledging intake', async () => {
  await expect(journal({ maxRecords: 2 }).retain(intake())).rejects.toThrow('terminal outcomes')
  expect((await journal().snapshot()).length).toBe(0)
  const full = journal({ maxRecords: 6 })
  await full.retain(intake()); await full.retain(intake('fixture-delivery-0002'))
  await expect(full.retain(intake('fixture-delivery-0003'))).rejects.toThrow('terminal outcomes')
  await (await full.claim(intake().id, intake().agentId)).finish({ status: 200 })
  await (await full.claim('fixture-delivery-0002', intake().agentId)).finish({ status: 200 })
  expect((await full.snapshot()).length).toBe(6)
})

it('keeps terminal byte capacity and refuses oversized results before publication', async () => {
  const full = journal({ maxBytes: 48_000 })
  await full.retain(intake())
  await expect(full.retain(intake('fixture-delivery-0002'))).rejects.toThrow('terminal outcomes')
  const claimed = await full.claim(intake().id, intake().agentId)
  await expect(claimed.finish({ content: 'x'.repeat(16_384) })).rejects.toThrow('byte limit')
  await claimed.finish({ content: 'x'.repeat(16_000) })
  expect((await full.snapshot()).deliveries.get(intake().id)?.result?.content).toHaveLength(16_000)
})

it('allows a later intake to be inspected and resolved while an earlier one lacks evidence', async () => {
  await journal().retain(intake()); await journal().retain(intake('fixture-delivery-0002'))
  const claimed = await journal().claim('fixture-delivery-0002', intake().agentId)
  await claimed.finish({ status: 200, reply: { ignored: true, reason: 'delegated' } })
  expect((await journal().snapshot()).deliveries.get(intake().id)?.result).toBeUndefined()
})

it.each(['authority', 'record'])('refuses a %s leaf redirected between observation and descriptor acquisition', async leaf => {
  await journal().retain(intake())
  const file = leaf === 'authority' ? `${directory}.authority` : join(directory, '00000000.json')
  fault.beforeOpen = path => {
    if (path !== file) return
    fault.beforeOpen = undefined
    renameSync(file, join(root, 'foreign')); symlinkSync(join(root, 'foreign'), file)
  }
  await expect(journal().snapshot()).rejects.toThrow()
  expect(readFileSync(file, 'utf8')).toBe(readFileSync(join(root, 'foreign'), 'utf8'))
})

it.each(['authority', 'record'])('refuses a %s made public between observation and descriptor acquisition', async leaf => {
  await journal().retain(intake())
  const file = leaf === 'authority' ? `${directory}.authority` : join(directory, '00000000.json')
  fault.beforeOpen = path => { if (path === file) { fault.beforeOpen = undefined; chmodSync(file, 0o666) } }
  await expect(journal().snapshot()).rejects.toThrow('unsafe journal record')
})

it('discards a journal enumeration invalidated by ancestor sibling churn before returning its frontier', async () => {
  await journal().retain(intake())
  let interrupted = false
  fault.openDirectory = (path, open) => {
    const iterator = open(path)
    if (path === directory && !interrupted) {
      interrupted = true
      writeFileSync(join(root, 'unrelated-sibling'), 'fixture activity')
    }
    return iterator
  }
  const observed = await journal().snapshot().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  expect(observed.error).toBeUndefined()
  const recovered = observed.value!
  expect(interrupted).toBe(true)
  expect(recovered.length).toBe(1)
  expect([...recovered.deliveries.keys()]).toEqual([intake().id])
  expect(readdirSync(directory)).toEqual(['00000000.json'])
})

it('bounds discarded journal enumeration to three attempts without writing from an invalidated read', async () => {
  await journal().retain(intake())
  let attempts = 0
  fault.openDirectory = (path, open) => {
    const iterator = open(path)
    if (path === directory) writeFileSync(join(root, `sibling-${++attempts}`), 'fixture activity')
    return iterator
  }
  await expect(journal().snapshot()).rejects.toThrow('journal directory ancestor changed')
  expect(attempts).toBe(3)
  expect(readdirSync(directory)).toEqual(['00000000.json'])
})

it('refuses an actual directory iterator acquired through a temporary ancestor redirect', async () => {
  await journal().retain(intake())
  const old = join(root, 'old'); mkdirSync(old, { mode: 0o700 })
  fault.openDirectory = (path, open) => {
    if (path !== directory) return open(path)
    fault.openDirectory = undefined
    renameSync(directory, `${directory}.original`); renameSync(old, directory)
    const iterator = open(directory)
    renameSync(directory, old); renameSync(`${directory}.original`, directory)
    return iterator
  }
  await expect(journal().snapshot()).rejects.toThrow()
  expect(readdirSync(directory)).toEqual(['00000000.json'])
})

it('refuses earlier record versions changed during a later recovery slice', async () => {
  await journal().snapshot()
  let previous: string | null = null
  for (let index = 0; index < 65; index++) {
    const bytes = JSON.stringify({ version: 1, processKey, index, previous,
      event: { kind: 'intake', intake: intake(`fixture-delivery-${String(index).padStart(4, '0')}`) } })
    for (const dir of [directory, `${directory}.witnesses`]) writeFileSync(join(dir, `${String(index).padStart(8, '0')}.json`), bytes, { mode: 0o600 })
    previous = hash(bytes)
  }
  fault.beforeOpen = path => {
    if (path !== join(directory, '00000032.json')) return
    fault.beforeOpen = undefined
    setImmediate(() => {
      for (const dir of [directory, `${directory}.witnesses`]) {
        const file = join(dir, '00000000.json'); writeFileSync(file, readFileSync(file, 'utf8') + ' ')
      }
    })
  }
  await expect(journal().snapshot()).rejects.toThrow('changed after recovery')
})

it('keeps private interrupted staging files without mistaking them for receipt authority', async () => {
  await journal().retain(intake())
  const stage = join(directory, '.harness-hook-00000000-0000-0000-0000-000000000000.tmp')
  writeFileSync(stage, 'incomplete stage', { mode: 0o600 })
  expect((await journal().snapshot()).length).toBe(1)
  expect(readFileSync(stage, 'utf8')).toBe('incomplete stage')
})

it('requires a fresh durable confirmation before returning a visible completed result', async () => {
  const original = journal(), body = intake()
  await original.retain(body)
  const claim = await original.claim(body.id, body.agentId)
  fault.onSync = fd => {
    if (fstatSync(fd).isDirectory() && existsSync(join(directory, '00000002.json'))) fault.fail = true
  }
  await expect(claim.finish({ status: 200 })).rejects.toThrow('fixture disk confirmation unavailable')
  expect(() => claim.verify()).toThrow('completing')
  fault.onSync = undefined
  expect((await journal().snapshot()).deliveries.get(body.id)?.result).toEqual({ status: 200 })
  await expect(journal().retain(body)).rejects.toThrow('fixture disk confirmation unavailable')
  await expect(journal().retain(intake('fixture-delivery-0002'))).rejects.toThrow('fixture disk confirmation unavailable')
  fault.fail = false
  await journal().retain(intake('fixture-delivery-0002'))
  const successor = await journal().claim('fixture-delivery-0002', body.agentId)
  successor.verify()
  expect(() => claim.verify()).toThrow('completing')
  await expect(claim.finish({ status: 201 })).rejects.toThrow('original hook result cannot change')
  await claim.finish({ status: 200 })
  expect(() => claim.verify()).toThrow('already completed')
  expect((await journal().retain(body)).result).toEqual({ status: 200 })
})

it('keeps a visible result behind disk confirmation while another reader arrives', async () => {
  const original = journal(), body = intake()
  await original.retain(body)
  const claim = await original.claim(body.id, body.agentId)
  let release: ((error: Error | null) => void) | undefined
  let reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  fault.deferSync = (fd, callback) => {
    if (!release && fstatSync(fd).isDirectory() && existsSync(join(directory, '00000002.json'))) {
      release = callback; reached(); return true
    }
    return false
  }
  const finishing = claim.finish({ status: 200 })
  expect(() => claim.verify()).toThrow('completing')
  await waiting
  try { await expect(journal().retain(body)).rejects.toThrow() }
  finally { fault.deferSync = undefined; release!(null); await finishing }
  expect((await journal().retain(body)).result).toEqual({ status: 200 })
})

it('captures the immutable terminal value before its first asynchronous boundary', async () => {
  await journal().retain(intake())
  const claim = await journal().claim(intake().id, intake().agentId)
  const result = { status: 200, nested: { outcome: 'original' } }
  const finishing = claim.finish(result)
  result.nested.outcome = 'x'.repeat(32_000)
  await finishing
  expect((await journal().retain(intake())).result).toEqual({ status: 200, nested: { outcome: 'original' } })
})

it('recovers an interrupted first initialization at every file and directory confirmation', async () => {
  let syncs = 0
  fault.onSync = () => { syncs++ }
  await journal().snapshot()
  fault.onSync = undefined
  expect(syncs).toBeGreaterThan(10)
  for (let failAt = 1; failAt <= syncs; failAt++) {
    const isolated = join(root, `interrupted-${failAt}`)
    let attempted = 0
    fault.onSync = () => { if (++attempted === failAt) fault.fail = true }
    await expect(journal({ directory: isolated }).snapshot(), `confirmation ${failAt}`).rejects.toThrow('fixture disk confirmation unavailable')
    fault.onSync = undefined; fault.fail = false
    const recovered = journal({ directory: isolated })
    expect((await recovered.retain(intake())).intake.id).toBe(intake().id)
    expect((await recovered.snapshot()).length).toBe(1)
  }
}, 30_000)

it.each(['history', 'witnesses'])('recovers a first initialization interrupted after creating %s', async which => {
  fault.afterMkdir = path => {
    if (path === (which === 'history' ? directory : `${directory}.witnesses`)) throw Error('fixture initializer exited')
  }
  await expect(journal().snapshot()).rejects.toThrow('fixture initializer exited')
  fault.afterMkdir = undefined
  expect((await journal().retain(intake())).intake.id).toBe(intake().id)
})

it('adopts the same exclusive bootstrap when two initializers compete', async () => {
  const attempts = await Promise.allSettled([journal().snapshot(), journal().snapshot()])
  expect(attempts.some(result => result.status === 'fulfilled')).toBe(true)
  const token = readFileSync(`${directory}.bootstrap`, 'utf8')
  await journal().retain(intake())
  expect(readFileSync(`${directory}.bootstrap`, 'utf8')).toBe(token)
  expect((await journal().snapshot()).length).toBe(1)
})

it('can finish and reconstruct a retained delivery at the actual per-process history limit', async () => {
  await journal().snapshot()
  let previous: string | null = null, lastResult: string | null = null
  for (let index = 0; index < 4_092; index++) {
    const delivery = intake(`fixture-delivery-${String(Math.floor(index / 3)).padStart(4, '0')}`)
    const event = index % 3 === 0 ? { kind: 'intake', intake: delivery }
      : index % 3 === 1 ? { kind: 'claim', id: delivery.id, agentId: delivery.agentId, token: delivery.id, predecessor: lastResult }
      : { kind: 'result', id: delivery.id, token: delivery.id, value: { status: 200 } }
    const bytes = JSON.stringify({ version: 1, processKey, index, previous, event })
    for (const dir of [directory, `${directory}.witnesses`]) writeFileSync(join(dir, `${String(index).padStart(8, '0')}.json`), bytes, { mode: 0o600 })
    previous = hash(bytes)
    if (index % 3 === 2) lastResult = previous
  }
  const full = journal({ maxRecords: 196_608 }), last = intake('fixture-final-delivery')
  await full.retain(last)
  await expect(full.retain(intake('fixture-capacity-held'))).rejects.toThrow('terminal outcomes')
  await (await full.claim(last.id, last.agentId)).finish({ status: 200 })
  const recovered = await journal().snapshot()
  expect(recovered.length).toBe(4_095)
  expect(recovered.deliveries.get(last.id)?.result).toEqual({ status: 200 })
}, 30_000)
