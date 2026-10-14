/** Only native generation fields establish Cursor turn identity. Transcript
 * positions, receipt times and a submitted prompt cannot establish execution. */
import { nativeGenerationFactId, validNativeGenerationFact, type NativeGenerationFactRecord } from './nativeGenerationFact.js'
import type { NativeHookIntake } from './nativeHookJournal.js'

export function nativeHookGeneration(intake: Pick<NativeHookIntake,
  'id' | 'agentId' | 'conversationId' | 'firedAt' | 'wire' | 'payload'>, identityV1?: string): NativeGenerationFactRecord | undefined {
  const body = intake.payload
  if (body.generationId === undefined) return
  const held = (): never => { throw Error('Waiting for complete native generation evidence.') }
  if (body.engine !== 'cursor' || !intake.wire || !intake.firedAt || body.sessionId !== intake.conversationId) return held()
  const kind = body.hookEvent === 'beforeSubmitPrompt' ? 'submitted'
    : body.hookEvent === 'preToolUse' || body.hookEvent === 'afterAgentResponse' ? 'activity'
      : body.hookEvent === 'stop' ? 'stopped' : undefined
  if (!kind) return held()
  const status = body.status === 'completed' ? 'completed' : body.status === 'aborted' ? 'aborted'
    : body.status === 'error' ? 'error' : undefined
  if (kind === 'stopped' && !status) return held()
  const fact = { agentId: intake.agentId, conversationId: intake.conversationId,
    generationId: body.generationId, kind, ...(kind === 'stopped' ? { status } : {}),
    source: { type: 'native', deliveryId: intake.id, firedAt: intake.firedAt, wire: intake.wire,
      ...(identityV1 === undefined ? {} : { identityV1 }) } } as Omit<NativeGenerationFactRecord, 'id'>
  const record = { ...fact, id: nativeGenerationFactId(fact) }
  if (!validNativeGenerationFact(record)) return held()
  return record
}
