import { expect, it } from 'vitest'
import { nativeHookGeneration } from './nativeHookGeneration.js'
import { nativeHookWireIdentity } from './nativeHookClientProtocol.js'

const intake = (extra: Record<string, unknown> = {}) => ({
  id: 'fixture-generation-delivery', agentId: 'agent-one', conversationId: 'conversation-one', firedAt: 1_000,
  wire: nativeHookWireIdentity('/api/hook/session-start', 'exact native bytes'),
  payload: { engine: 'cursor', sessionId: 'conversation-one', generationId: 'generation-one',
    hookEvent: 'stop', status: 'completed', ...extra },
})

it.each([
  ['beforeSubmitPrompt', 'submitted'], ['preToolUse', 'activity'], ['afterAgentResponse', 'activity'], ['stop', 'stopped'],
])('maps native %s to %s without selecting a current turn', (hookEvent, kind) => {
  expect(nativeHookGeneration(intake({ hookEvent }))).toMatchObject({ kind, generationId: 'generation-one',
    source: { type: 'native', deliveryId: 'fixture-generation-delivery', firedAt: 1_000,
      wire: intake().wire } })
})
it.each(['completed', 'aborted', 'error'])('preserves the native %s terminal outcome', status => {
  expect(nativeHookGeneration(intake({ status }))).toMatchObject({ kind: 'stopped', status })
})
it('leaves legacy evidence out of generation control', () => {
  expect(nativeHookGeneration(intake({ generationId: undefined }))).toBeUndefined()
})
it.each([
  { engine: 'codex' }, { sessionId: 'other' }, { generationId: null }, { generationId: '' }, { generationId: 'bad\n' },
  { hookEvent: 'unknown' }, { hookEvent: 'cancelled' }, { status: 'waiting' }, { status: undefined }, { status: 'success' },
])('holds incomplete or unsupported generation evidence %j', extra => {
  expect(() => nativeHookGeneration(intake(extra))).toThrow('complete native generation evidence')
})
it('requires original native time and exact versioned wire provenance', () => {
  expect(() => nativeHookGeneration({ ...intake(), firedAt: undefined })).toThrow('complete native generation evidence')
  expect(() => nativeHookGeneration({ ...intake(), wire: undefined })).toThrow('complete native generation evidence')
})
it('retains the precise original image for a Stop spending existing terminal capacity', () => {
  const identity = 'a'.repeat(64)
  expect(nativeHookGeneration(intake(), identity)).toMatchObject({ source: { identityV1: identity } })
  expect(() => nativeHookGeneration(intake(), '')).toThrow('complete native generation evidence')
  expect(() => nativeHookGeneration(intake(), 'unproved image')).toThrow('complete native generation evidence')
  expect(() => nativeHookGeneration(intake({ hookEvent: 'preToolUse' }), identity)).toThrow('complete native generation evidence')
})
