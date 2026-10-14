import { expect, it } from 'vitest'
import { contentFixture, contentOwner as owner } from '../../testing/nativeGenerationContentFixture.js'
import { nativeGenerationContent } from './nativeGenerationContent.js'
import { createNativeGenerations, type NativeGenerationOwner } from './nativeGenerations.js'
import { nativeTasks } from './nativeTasks.js'

const task = (input: Record<string, unknown> = {}) => ({ hookEvent: 'preToolUse', toolName: 'Task',
  toolUseId: 'task-tool', input: { prompt: 'Investigate the failure' }, ...input })
async function fixture(inputs: Array<Record<string, unknown>>) {
  const source = contentFixture(inputs).source
  const view = await createNativeGenerations({ owner, current: () => true, read: async () => source }).inspect()
  const contents = nativeGenerationContent(source)
  const generation = view.generations[0], tools = contents.get(generation.id)?.tools ?? []
  return { source, view, generation, tools,
    project: (cancelled = false) => nativeTasks(owner, generation, tools, cancelled) }
}

it('observes an exact task request without inventing child execution or a successful result', async () => {
  const t = await fixture([task()]), snapshot = t.project(), entry = snapshot.tasks[0]
  expect(snapshot.held).toEqual([])
  expect(entry).toMatchObject({ owner, generationId: 'generation-one', toolUseId: 'task-tool',
    state: 'observed', input: { state: 'available', json: '{"prompt":"Investigate the failure"}' },
    result: 'unconfirmed', reason: 'Waiting for a result linked to this task.' })
  expect(entry.factIds).toEqual([t.source.facts[0].id])
  expect(entry).not.toHaveProperty('output')
  expect(entry).not.toHaveProperty('succeeded')
  for (const value of [snapshot, snapshot.tasks, snapshot.held, entry, entry.owner, entry.input, entry.factIds]) {
    expect(Object.isFrozen(value)).toBe(true)
  }
})

it('coalesces identical native observations and keeps task order independent of delivery order', async () => {
  const t = await fixture([task({ toolUseId: 'z' }), task({ toolUseId: 'a' }), task({ toolUseId: 'z' })])
  const snapshot = t.project()
  expect(snapshot.tasks.map(entry => entry.toolUseId)).toEqual(['a', 'z'])
  expect(snapshot.tasks[1].factIds).toHaveLength(2)
  expect(snapshot.tasks[1].input.state).toBe('available')
  expect(nativeTasks(owner, t.generation, [...t.tools].reverse(), false)).toEqual(snapshot)
  expect(nativeTasks(owner, t.generation, [...t.tools, t.tools[0]], false)).toEqual(snapshot)
})

it.each(['generation', 'incarnation', 'conversation', 'agent'] as const)('separates identical tool IDs by original %s', async changed => {
  const t = await fixture([task()]), original = t.project().tasks[0]
  const replacement: NativeGenerationOwner = {
    agentId: changed === 'agent' ? 'another-agent' : owner.agentId,
    sessionId: changed === 'conversation' ? 'another-conversation' : owner.sessionId,
    processKey: changed === 'incarnation' ? 'another-incarnation' : owner.processKey,
  }, generation = { ...t.generation }
  if (changed === 'generation') generation.id = 'another-generation'
  const tools = t.tools.map(value => ({ ...value, owner: replacement, generationId: generation.id }))
  const next = nativeTasks(replacement, generation, tools, false).tasks[0]
  expect(next.id).not.toBe(original.id)
  expect(original.owner).toEqual(owner)
})

it.each(['input', 'tool', 'missing input'] as const)('holds conflicting %s evidence without selecting the latest arrival', async conflict => {
  const other = conflict === 'input' ? { input: { prompt: 'Different request' } }
    : conflict === 'tool' ? { toolName: 'Read' } : { input: undefined }
  const t = await fixture([task(), task(other)]), snapshot = t.project()
  expect(snapshot.tasks[0]).toMatchObject({ input: { state: 'ambiguous' }, result: 'unconfirmed',
    reason: 'Conflicting native task observations.' })
  expect(nativeTasks(owner, t.generation, [...t.tools].reverse(), false)).toEqual(snapshot)
})

it('holds incomplete task identity and input without preventing the parent Stop', async () => {
  const t = await fixture([task({ toolUseId: undefined }), task({ toolUseId: 'unnamed', toolName: undefined }),
    task({ input: undefined }), task({ toolUseId: undefined, toolName: undefined }),
    task({ toolUseId: undefined, toolName: 'Read' }), task({ toolUseId: 'read', toolName: 'Read' }),
    { hookEvent: 'stop', status: 'completed' }])
  expect(t.generation).toMatchObject({ terminal: 'completed', running: false })
  const snapshot = t.project()
  expect(snapshot.tasks).toHaveLength(1)
  expect(snapshot.tasks[0]).toMatchObject({ state: 'retired', input: { state: 'pending' }, result: 'unconfirmed',
    reason: 'Waiting for the native task input.' })
  expect(snapshot.held.map(entry => [entry.factIds.length, entry.reason])).toEqual([
    [2, 'Waiting for the native task identity.'], [1, 'Waiting for the native tool identity.'],
  ])
  expect(Object.isFrozen(snapshot.held[0])).toBe(true)
  expect(Object.isFrozen(snapshot.held[0].factIds)).toBe(true)
})

it.each(['completed', 'aborted', 'error'] as const)('keeps a task received after %s Stop retired with its result unconfirmed', async status => {
  const t = await fixture([{ hookEvent: 'stop', status }, task()])
  expect(t.project().tasks[0]).toMatchObject({ state: 'retired', result: 'unconfirmed' })
})

it('retires only the stopped generation and leaves the successor with the same tool ID intact', async () => {
  const t = await fixture([task(), { hookEvent: 'stop', status: 'completed' }, task({ generationId: 'generation-two' })])
  const second = t.view.generations[1], tools = nativeGenerationContent(t.source).get(second.id)!.tools
  expect(t.project().tasks[0].state).toBe('retired')
  expect(nativeTasks(owner, second, tools, false).tasks[0].state).toBe('observed')
  const cancelled = nativeTasks(owner, second, tools, true)
  expect(cancelled.tasks[0]).toMatchObject({ state: 'retired', result: 'unconfirmed' })
  expect(t.project().tasks[0].id).not.toBe(cancelled.tasks[0].id)
})

it.each(['owner', 'generation', 'event', 'fact'] as const)('refuses a task detached from its original %s', async changed => {
  const t = await fixture([task()]), observation = { ...t.tools[0] }
  if (changed === 'owner') observation.owner = { ...owner, processKey: 'replacement' }
  else if (changed === 'generation') observation.generationId = 'replacement'
  else if (changed === 'event') observation.event = 'afterAgentResponse'
  else observation.factId = 'missing'
  expect(() => nativeTasks(owner, t.generation, [observation], false)).toThrow('original native task observation')
})

it('bounds observation allocation and leaves an empty task projection for content-free Stop', async () => {
  const t = await fixture([{ hookEvent: 'stop', status: 'completed' }])
  expect(t.project()).toEqual({ tasks: [], held: [] })
  expect(() => nativeTasks(owner, t.generation, Array(4097).fill(null), false)).toThrow('task observation capacity')
})
