import { nativeHookGeneration } from '../engines/kit/nativeHookGeneration.js'
import { nativeHookWireIdentity } from '../engines/kit/nativeHookClientProtocol.js'
import type { NativeHookDelivery, NativeHookIntake } from '../engines/kit/nativeHookJournal.js'
import { captureNativeGenerationContent } from '../core/turns/nativeGenerationContent.js'
import type { NativeGenerationSource } from '../core/turns/nativeGenerations.js'

export const contentOwner = Object.freeze({ agentId: 'agent-one', sessionId: 'conversation-one', processKey: 'fixture-process' })
export function contentFixture(inputs: Array<Record<string, unknown>> = []) {
  const facts = new Map(), deliveries = new Map<string, NativeHookDelivery>()
  inputs.forEach((extra, index) => {
    const payload = { engine: 'cursor', sessionId: contentOwner.sessionId, generationId: 'generation-one',
      hookEvent: 'afterAgentResponse', responseText: 'A retained response.', ...extra }
    const intake: NativeHookIntake = { id: `fixture-content-delivery-${index}`, fingerprint: 'fixture', agentId: contentOwner.agentId,
      conversationId: contentOwner.sessionId, firedAt: index + 1, wire: nativeHookWireIdentity('/api/hook/session-start', JSON.stringify(payload)), payload }
    // Fields for one event cannot leak into another's shape.
    if (payload.hookEvent !== 'afterAgentResponse') delete (payload as any).responseText
    intake.wire = nativeHookWireIdentity('/api/hook/session-start', JSON.stringify(payload))
    const fact = nativeHookGeneration(intake)!
    facts.set(fact.id, fact); deliveries.set(intake.id, { intake, verify() {} })
  })
  const observations = captureNativeGenerationContent(contentOwner, facts, deliveries)
  const source: NativeGenerationSource = { owner: contentOwner, facts: [...facts.values()].map(({ id, generationId, kind, status }) =>
    ({ id, generationId, kind, ...(status ? { status } : {}) })), observations, verify() {} }
  return { facts, deliveries, observations, source }
}

