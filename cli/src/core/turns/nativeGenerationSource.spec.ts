import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNativeHookJournal } from '../../engines/kit/nativeHookJournal.js'
import { fixtureNativeGenerationFact as fact } from '../../testing/nativeGenerationFactFixture.js'
import { createNativeGenerations } from './nativeGenerations.js'
import { createNativeGenerationSource } from './nativeGenerationSource.js'

const fault = vi.hoisted(() => ({ fail: false }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(),
  fsync: (_fd: number, done: (error: Error | null) => void) => queueMicrotask(() => done(fault.fail ? Error('fixture disk unavailable') : null)),
}))
const owner = { agentId: 'agent-one', sessionId: 'conversation-one', processKey: 'linux:fixture\u0000cursor\u00005100\u000012345' }
const cancellation = () => ({ requestId: 'fixture-cancellation-request', nonce: 'fixture-cancellation-nonce',
  agentId: owner.agentId, conversationId: owner.sessionId, frontier: { index: -1, digest: null } })
let root: string, journal: ReturnType<typeof createNativeHookJournal>
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-generation-source-')))
  journal = createNativeHookJournal({ directory: join(root, 'history'), processKey: owner.processKey })
})
afterEach(() => { fault.fail = false; journal.close(); rmSync(root, { recursive: true, force: true }) })

it('restores an empty cancellation barrier across late first activity and conversation rebinding', async () => {
  const request = cancellation()
  await journal.recordCancellation(request)
  journal.close(); journal = createNativeHookJournal({ directory: join(root, 'history'), processKey: owner.processKey })
  const source = createNativeGenerationSource({ owner, read: journal.snapshot })
  const empty = await source.read()
  expect(empty.facts).toEqual([])
  expect(empty.cancellations).toEqual([request])
  expect(empty.frontier?.index).toBe(0)
  await journal.recordGeneration(fact('activity'))
  expect((await createNativeGenerations({ owner, current: () => true, read: source.read }).inspect()).selection).toBe('cancelled')
  const rebound = { ...owner, agentId: 'replacement-agent', sessionId: 'replacement-conversation' }
  const newSource = createNativeGenerationSource({ owner: rebound, read: journal.snapshot })
  const view = await createNativeGenerations({ owner: rebound, current: () => true, read: newSource.read }).inspect()
  expect(view.selection).toBe('cancelled')
  expect(view.cancellations).toEqual([request])
  expect(() => empty.verify()).toThrow('changed during recovery')
})

it.each(['collection', 'capacity', 'key', 'shape', 'frontier'] as const)('rejects invalid cancellation %s before disk confirmation', async problem => {
  const snapshot = await journal.snapshot(), request = cancellation()
  if (problem === 'collection') snapshot.cancellations = null as any
  else if (problem === 'capacity') snapshot.cancellations = new Map(Array.from({ length: 4097 }, (_, index) => [String(index), request]))
  else if (problem === 'frontier') snapshot.frontier = { index: 5, digest: null }
  else {
    if (problem === 'shape') Object.assign(request, { nonce: '' })
    snapshot.cancellations.set(problem === 'key' ? 'wrong-key' : request.requestId, request)
  }
  const confirm = snapshot.confirm = vi.fn(snapshot.confirm)
  await expect(createNativeGenerationSource({ owner, read: async () => snapshot }).read()).rejects.toThrow('retained')
  expect(confirm).not.toHaveBeenCalled()
})

it('copies the original barrier and prefix before confirmation yields', async () => {
  const request = cancellation()
  await journal.recordCancellation(request)
  const snapshot = await journal.snapshot(), expectedFrontier = { ...snapshot.frontier }, confirm = snapshot.confirm
  snapshot.confirm = async () => {
    Object.assign(snapshot.cancellations.get(request.requestId)!, { nonce: 'replacement-nonce' })
    snapshot.cancellations.clear(); snapshot.frontier = { index: -1, digest: null }
    await confirm()
  }
  const source = await createNativeGenerationSource({ owner, read: async () => snapshot }).read()
  expect(source.cancellations).toEqual([request])
  expect(source.frontier).toEqual(expectedFrontier)
  expect(Object.isFrozen(source.cancellations![0].frontier)).toBe(true)
})

it('reconstructs scoped Stop and Cancel tombstones from confirmed durable facts', async () => {
  await journal.recordGeneration(fact('stopped'))
  await journal.recordGeneration(fact('activity'))
  await journal.recordGeneration(fact('cancelled', 'fixture-cancelled-second', 'generation-two'))
  await journal.recordGeneration(fact('activity', 'fixture-activity-second', 'generation-two'))
  await journal.recordGeneration({ ...fact('activity', 'fixture-foreign-agent'), agentId: 'another-agent' })
  await journal.recordGeneration({ ...fact('activity', 'fixture-foreign-session'), conversationId: 'another-conversation' })
  journal.close()
  journal = createNativeHookJournal({ directory: join(root, 'history'), processKey: owner.processKey })
  const source = createNativeGenerationSource({ owner, read: journal.snapshot })
  const view = await createNativeGenerations({ owner, current: () => true, read: source.read }).inspect()
  expect(view.selection).toBe('idle')
  expect(view.generations.map(turn => [turn.id, turn.terminal])).toEqual([
    ['generation-one', 'completed'], ['generation-two', 'cancelled'],
  ])
  const retained = await source.read()
  expect(retained.facts).toHaveLength(4)
  expect(Object.isFrozen(retained)).toBe(true)
})

it.each(['agentId', 'conversationId'] as const)('does not let a foreign terminal fact close the same generation through %s', async field => {
  await journal.recordGeneration(fact('activity'))
  await journal.recordGeneration({ ...fact('stopped'), [field]: 'another-owner' })
  const source = createNativeGenerationSource({ owner, read: journal.snapshot })
  const view = await createNativeGenerations({ owner, current: () => true, read: source.read }).inspect()
  expect(view.selection).toBe('one')
  expect(view.running[0].id).toBe('generation-one')
})

it.each(['stopped', 'cancelled', 'activity'] as const)('revokes the real complete frontier when %s is appended', async kind => {
  await journal.recordGeneration(fact('activity'))
  const source = createNativeGenerationSource({ owner, read: journal.snapshot })
  const view = await createNativeGenerations({ owner, current: () => true, read: source.read }).inspect()
  view.verify()
  await journal.recordGeneration(fact(kind, `fixture-successor-${kind}`, kind === 'activity' ? 'generation-two' : 'generation-one'))
  expect(() => view.verify()).toThrow('changed during recovery')
  const current = await createNativeGenerations({ owner, current: () => true, read: source.read }).inspect()
  expect(current.selection).toBe(kind === 'activity' ? 'ambiguous' : 'idle')
})

it('does not credit visible native facts while disk confirmation is unavailable', async () => {
  await journal.recordGeneration(fact('stopped'))
  fault.fail = true
  const source = createNativeGenerationSource({ owner, read: journal.snapshot })
  await expect(source.read()).rejects.toThrow('fixture disk unavailable')
  fault.fail = false
  expect((await source.read()).facts).toHaveLength(1)
})

it('retains the original owner and original frontier verifier', async () => {
  await journal.recordGeneration(fact('activity'))
  const snapshot = await journal.snapshot(), mutable = { ...owner }
  const source = createNativeGenerationSource({ owner: mutable, read: async () => snapshot })
  mutable.agentId = 'replacement'
  const before = await source.read()
  snapshot.verify = () => {}
  await journal.recordGeneration(fact('stopped'))
  expect(before.owner).toEqual(owner)
  expect(() => before.verify()).toThrow('changed during recovery')
})

it.each(['replace', 'delete', 'insert', 'mutate'] as const)('does not project a mutable snapshot %s during confirmation', async mutation => {
  const activity = fact('activity')
  await journal.recordGeneration(activity)
  const snapshot = await journal.snapshot(), confirm = snapshot.confirm
  let release!: () => void, entered = false
  snapshot.confirm = async () => { entered = true; await new Promise<void>(done => { release = done }); await confirm() }
  const reading = createNativeGenerationSource({ owner, read: async () => snapshot }).read()
  await vi.waitFor(() => expect(entered).toBe(true))
  if (mutation === 'replace') snapshot.generations = new Map([[fact('stopped').id, fact('stopped')]])
  else if (mutation === 'delete') snapshot.generations.clear()
  else if (mutation === 'insert') snapshot.generations.set(fact('cancelled').id, fact('cancelled'))
  else Object.assign(snapshot.generations.get(activity.id)!, fact('stopped'))
  release()
  const source = await reading
  expect(source.facts).toEqual([{ id: activity.id, generationId: activity.generationId, kind: 'activity' }])
  source.verify()
})

it.each(['invalid', 'oversized'] as const)('bounds an %s fact collection before waiting for confirmation', async problem => {
  const snapshot = await journal.snapshot()
  snapshot.generations = (problem === 'invalid' ? null : new Map(Array.from({ length: 4609 }, (_, index) => [String(index), fact('activity')]))) as any
  const confirm = snapshot.confirm = vi.fn(snapshot.confirm)
  await expect(createNativeGenerationSource({ owner, read: async () => snapshot }).read()).rejects.toThrow('fact capacity')
  expect(confirm).not.toHaveBeenCalled()
})

it.each(['before', 'during'] as const)('refuses another process incarnation %s the full proof', async when => {
  const snapshot = await journal.snapshot(), original = snapshot.verify
  snapshot.verify = () => { original(); if (when === 'during') snapshot.processKey = 'replacement' }
  if (when === 'before') snapshot.processKey = 'replacement'
  await expect(createNativeGenerationSource({ owner, read: async () => snapshot }).read()).rejects.toThrow('process incarnation changed')
})

it('rechecks incarnation after the effect-time source proof', async () => {
  const snapshot = await journal.snapshot(), original = snapshot.verify
  let calls = 0
  snapshot.verify = () => { original(); if (++calls === 3) snapshot.processKey = 'replacement' }
  const source = await createNativeGenerationSource({ owner, read: async () => snapshot }).read()
  expect(() => source.verify()).toThrow('process incarnation changed')
})

it('retains the original confirmation callback when another callback replaces it', async () => {
  await journal.recordGeneration(fact('stopped'))
  const snapshot = await journal.snapshot(), original = snapshot.verify
  snapshot.verify = () => { original(); snapshot.confirm = async () => {} }
  fault.fail = true
  await expect(createNativeGenerationSource({ owner, read: async () => snapshot }).read()).rejects.toThrow('fixture disk unavailable')
})

it('refuses a frontier changed after confirmation returns its original proof', async () => {
  await journal.recordGeneration(fact('activity'))
  const snapshot = await journal.snapshot(), confirm = snapshot.confirm
  snapshot.confirm = async () => { await confirm(); await journal.recordGeneration(fact('stopped')) }
  await expect(createNativeGenerationSource({ owner, read: async () => snapshot }).read()).rejects.toThrow('changed during recovery')
})

it.each(['key', 'shape'] as const)('refuses invalid retained fact %s', async problem => {
  const snapshot = await journal.snapshot(), retained = fact('activity')
  if (problem === 'shape') retained.generationId = ''
  snapshot.generations.set(problem === 'key' ? 'different-key' : retained.id, retained)
  await expect(createNativeGenerationSource({ owner, read: async () => snapshot }).read()).rejects.toThrow('retained generation fact is invalid')
})
