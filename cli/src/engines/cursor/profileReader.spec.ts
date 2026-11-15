import { expect, it } from 'vitest'
import type { InlineRuntimeContext } from '../facets/inlineRuntime.js'
import { blankRuntimeState, encodeRuntimeProfile } from '../kit/runtime.js'
import { createRuntimeProfileReader } from './profileReader.js'

it('bounds retained footer targets while reconstructing an evicted observation exactly', () => {
  const reader = createRuntimeProfileReader()
  const context = { session: { agentId: 'agent', sessionId: 'session', engine: 'cursor' },
    state: blankRuntimeState(), refreshConfig: () => {} } as InlineRuntimeContext
  const id = (index: number) => encodeRuntimeProfile({ sessionId: 'agent', engine: 'cursor', model: `model-${index}`, effort: 'high' })
  for (let index = 0; index < 200; index++) reader.pane!(context, `Model ${index} High · 1%`)
  expect(reader.target('session', id(0))).toBeNull()
  expect(reader.target('session', id(199))).not.toBeNull()
  reader.pane!(context, 'Model 0 High · 1%')
  expect(context.state.model).toBe('model-0')
  expect(context.state.effort).toBe('high')
  expect(reader.target('session', id(0))).not.toBeNull()
  reader.forget!('session')
  expect(reader.target('session', id(0))).toBeNull()
})
