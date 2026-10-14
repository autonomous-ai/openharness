import { expect, it } from 'vitest'
import { nativeHookGeneration } from '../../engines/kit/nativeHookGeneration.js'
import { fixtureNativeGenerationFact } from '../../testing/nativeGenerationFactFixture.js'
import { captureNativeGenerationContent, nativeGenerationContent, EMPTY_NATIVE_CONTENT } from './nativeGenerationContent.js'
import { contentFixture, contentOwner } from '../../testing/nativeGenerationContentFixture.js'

it('copies exact per-generation native prompt, response, and nested tool bytes', () => {
  const t = contentFixture([
    { hookEvent: 'beforeSubmitPrompt', prompt: 'Question é\n📘' },
    { hookEvent: 'preToolUse', toolUseId: 'tool-a', toolName: 'Task', input: { description: 'first', nested: [1, null, true] } },
    { responseText: 'Answer é\n📘' },
    { generationId: 'generation-two', responseText: 'A different answer.' },
    { hookEvent: 'stop', status: 'completed' },
  ])
  const content = nativeGenerationContent(t.source).get('generation-one')!
  expect(content.prompt).toEqual({ state: 'available', text: 'Question é\n📘' })
  expect(content.response).toEqual({ state: 'available', text: 'Answer é\n📘' })
  expect(content.tools[0]).toMatchObject({ owner: contentOwner, generationId: 'generation-one', toolUseId: 'tool-a', toolName: 'Task',
    inputJson: '{"description":"first","nested":[1,null,true]}' })
  expect(nativeGenerationContent(t.source).get('generation-two')!.response).toEqual({ state: 'available', text: 'A different answer.' })
  expect(t.observations).toHaveLength(4)
  const tool = [...t.deliveries.values()][1].intake.payload
  ;(tool.input as any).nested.push('mutated'); tool.toolName = 'changed'
  expect(content.tools[0].toolName).toBe('Task')
  expect(content.tools[0].inputJson).not.toContain('mutated')
  for (const value of [t.observations, t.observations[0], t.observations[0].owner, t.observations[0].wire,
    content, content.prompt, content.response, content.tools, content.tools[0], content.tools[0].owner, content.tools[0].wire]) expect(Object.isFrozen(value)).toBe(true)
})

it('keeps Stop without text closed while missing content remains pending', () => {
  const t = contentFixture([{ hookEvent: 'stop', status: 'completed' }])
  expect(t.source.facts[0]).toMatchObject({ kind: 'stopped', status: 'completed' })
  expect(nativeGenerationContent(t.source).size).toBe(0)
  expect(EMPTY_NATIVE_CONTENT).toEqual({ prompt: { state: 'pending' }, response: { state: 'pending' }, tools: [] })
  expect(nativeGenerationContent(contentFixture([
    { hookEvent: 'beforeSubmitPrompt' }, { responseText: undefined }, { hookEvent: 'preToolUse' },
  ]).source).get('generation-one')).toMatchObject({ prompt: { state: 'pending' }, response: { state: 'pending' }, tools: [{}] })
})

it('preserves empty native text and refuses to select among unordered distinct responses or prompts', () => {
  const inputs = [{ hookEvent: 'beforeSubmitPrompt', prompt: 'one' }, { hookEvent: 'beforeSubmitPrompt', prompt: 'two' },
    { responseText: 'one' }, { responseText: 'two' }]
  for (const values of [inputs, [...inputs].reverse()]) {
    expect(nativeGenerationContent(contentFixture(values).source).get('generation-one'))
      .toMatchObject({ prompt: { state: 'ambiguous' }, response: { state: 'ambiguous' } })
  }
  expect(nativeGenerationContent(contentFixture([{ responseText: '' }, { responseText: '' }]).source).get('generation-one')!.response)
    .toEqual({ state: 'available', text: '' })
})

it('excludes other owners and content-free core/direct terminal observations', () => {
  const t = contentFixture([{ hookEvent: 'stop', status: 'completed' }]), stop = [...t.facts.values()][0]
  for (const extra of [{ agentId: 'foreign-agent' }, { conversationId: 'foreign-conversation' }]) {
    expect(captureNativeGenerationContent(contentOwner, new Map([[stop.id, { ...stop, ...extra }]]), t.deliveries)).toEqual([])
  }
  const direct = nativeHookGeneration([...t.deliveries.values()][0].intake, 'a'.repeat(64))!
  const cancel = fixtureNativeGenerationFact('cancelled')
  expect(captureNativeGenerationContent(contentOwner, new Map([[direct.id, direct], [cancel.id, cancel]]), new Map())).toEqual([])
})

it.each(['missing', 'changed owner', 'changed fact', 'invalid body'] as const)('rejects %s original intake evidence', change => {
  const t = contentFixture([{}]), intake = [...t.deliveries.values()][0].intake
  if (change === 'missing') t.deliveries.clear()
  else if (change === 'changed owner') intake.agentId = 'foreign'
  else if (change === 'changed fact') intake.payload.generationId = 'another'
  else intake.payload.responseText = 'é'.repeat(65537)
  expect(() => captureNativeGenerationContent(contentOwner, t.facts, t.deliveries)).toThrow('original intake')
})

it.each(['map', 'facts', 'deliveries', 'delivery map', 'key', 'shape'] as const)('bounds and validates the retained %s', problem => {
  const t = contentFixture([{}]), fact = [...t.facts.values()][0]
  if (problem === 'map') t.facts = null as any
  else if (problem === 'facts') t.facts = new Map(Array.from({ length: 4609 }, (_, n) => [String(n), fact]))
  else if (problem === 'deliveries') t.deliveries = new Map(Array.from({ length: 4097 }, (_, n) => [String(n), [...t.deliveries.values()][0]]))
  else if (problem === 'delivery map') t.deliveries = null as any
  else if (problem === 'key') { t.facts.clear(); t.facts.set('wrong', fact) }
  else fact.generationId = ''
  expect(() => captureNativeGenerationContent(contentOwner, t.facts, t.deliveries)).toThrow('retained')
})

it('accepts the full native response limit and bounds the aggregate copied namespace', () => {
  const full = { responseText: 'é'.repeat(65536) }
  expect(nativeGenerationContent(contentFixture([full]).source).get('generation-one')!.response).toEqual({ state: 'available', text: full.responseText })
  expect(() => contentFixture(Array.from({ length: 8 }, () => full))).toThrow('content capacity')
  const t = contentFixture([full]), first = t.source.facts[0], observation = t.observations[0]
  t.source = { ...t.source,
    facts: Array.from({ length: 8 }, (_, n) => ({ ...first, id: `fact-${n}` })),
    observations: Array.from({ length: 8 }, (_, n) => ({ ...observation, factId: `fact-${n}` })),
  }
  expect(() => nativeGenerationContent(t.source)).toThrow('content capacity')
})

it.each(['absent', 'oversized', 'missing', 'duplicate', 'owner', 'generation', 'delivery', 'wire', 'kind', 'event', 'fields', 'type', 'field size'] as const)(
  'refuses a source with %s observation evidence', problem => {
    const t = contentFixture([{}]), first = t.observations[0], value = { ...first } as any
    t.source = { ...t.source, observations: [value] }
    if (problem === 'absent') t.source = { ...t.source, observations: undefined }
    else if (problem === 'oversized') t.source = { ...t.source, observations: Array(4097).fill(first) }
    else if (problem === 'missing') t.source = { ...t.source, observations: [] }
    else if (problem === 'duplicate') t.source = { ...t.source, observations: [first, first] }
    else if (problem === 'owner') value.owner = { ...contentOwner, processKey: 'replacement' }
    else if (problem === 'generation') value.generationId = 'different'
    else if (problem === 'delivery') value.deliveryId = '!'
    else if (problem === 'wire') value.wire = {}
    else if (problem === 'kind') t.source = { ...t.source, facts: [{ id: first.factId, generationId: first.generationId, kind: 'cancelled' }] }
    else if (problem === 'event') value.event = 'invented'
    else if (problem === 'fields') value.prompt = 'another event'
    else if (problem === 'type') value.responseText = 7
    else value.responseText = 'é'.repeat(65537)
    expect(() => nativeGenerationContent(t.source)).toThrow('native generation content')
  },
)

it('requires every original fact and the declared submission kind without ordering tools by arrival', () => {
  const t = contentFixture([{ hookEvent: 'preToolUse', toolUseId: 'z' }, { hookEvent: 'preToolUse', toolUseId: 'a' }])
  const content = nativeGenerationContent(t.source).get('generation-one')!
  expect(content.tools.map(tool => tool.factId)).toEqual(t.observations.map(tool => tool.factId).sort())
  expect(nativeGenerationContent({ ...t.source, observations: [...t.observations].reverse() }).get('generation-one')!.tools).toEqual(content.tools)
  expect(() => nativeGenerationContent({ ...t.source, facts: [] })).toThrow('identity')
  const submitted = contentFixture([{ hookEvent: 'beforeSubmitPrompt', prompt: 'question' }])
  expect(() => nativeGenerationContent({ ...submitted.source, facts: [{ ...submitted.source.facts[0], kind: 'activity' }] })).toThrow('native event')
})

it.each([null, Array(4609).fill(null)])('rejects an unbounded fact collection before allocating its lookup', facts => {
  const t = contentFixture([{}])
  expect(() => nativeGenerationContent({ ...t.source, facts } as any)).toThrow('fact capacity')
})
