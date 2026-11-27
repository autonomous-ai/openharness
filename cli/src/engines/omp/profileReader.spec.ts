import { describe, expect, it } from 'vitest'
import { applyProfileEvidence } from '../kit/runtime.js'
import { transcriptEvidence } from './profileReader.js'
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
    const ctx = context()
    for (const raw of [{ type: 'model_change', model: 'fixture-model' }, { type: 'thinking_level_change', thinkingLevel: 'high' }, { type: 'message' }]) {
      const evidence = transcriptEvidence(raw)
      if (evidence) applyProfileEvidence(ctx, evidence)
    }
    expect(ctx.state.model).toBe('fixture-model')
    expect(ctx.state.effort).toBe('high')
    expect(ctx.control?.modelConfirmed).toBe(true)
    expect(ctx.control?.effortConfirmed).toBe(true)
  })
})
