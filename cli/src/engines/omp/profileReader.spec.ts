import { describe, expect, it } from 'vitest'
import { createRuntimeProfileReader } from './profileReader.js'
import type { InlineRuntimeContext } from '../facets/inlineRuntime.js'

function context(): InlineRuntimeContext {
  return {
    session: { agentId: 'a1', engine: 'omp' },
    state: { model: null, effort: null, mode: 'unknown', cliVersion: null, observedAt: null },
    control: { target: { model: 'fixture-model', effort: 'high' }, modelConfirmed: false, effortConfirmed: false },
    refreshConfig: () => {},
  } as unknown as InlineRuntimeContext
}

describe('omp profile reader', () => {
  it('reads the model and thinking level from the session file', () => {
    const reader = createRuntimeProfileReader()
    const ctx = context()
    reader.transcript!(ctx, { type: 'model_change', model: 'fixture-model' })
    reader.transcript!(ctx, { type: 'thinking_level_change', thinkingLevel: 'high' })
    expect(ctx.state.model).toBe('fixture-model')
    expect(ctx.state.effort).toBe('high')
    expect(ctx.control?.modelConfirmed).toBe(true)
    expect(ctx.control?.effortConfirmed).toBe(true)
  })
})
