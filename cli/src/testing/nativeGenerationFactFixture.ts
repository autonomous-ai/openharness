import { nativeGenerationFactId, type NativeGenerationFactRecord } from '../engines/kit/nativeGenerationFact.js'
import { nativeHookWireIdentity } from '../engines/kit/nativeHookClientProtocol.js'

export function fixtureNativeGenerationFact(
  kind: NativeGenerationFactRecord['kind'], deliveryId = `fixture-${kind}-delivery`, generationId = 'generation-one',
): NativeGenerationFactRecord {
  const fields = { agentId: 'agent-one', conversationId: 'conversation-one', generationId }
  if (kind === 'cancelled') {
    const source = { type: 'core' as const, requestId: deliveryId }
    const fact = { ...fields, kind, source }
    return { ...fact, id: nativeGenerationFactId(fact) }
  }
  const path = kind === 'submitted' ? '/api/hook/session-start' : kind === 'stopped' ? '/api/hook/turn-stop' : '/api/hook/turn-start'
  const source = { type: 'native' as const, deliveryId, firedAt: 1234, wire: nativeHookWireIdentity(path, JSON.stringify({ kind, generationId })) }
  const fact = { ...fields, kind, ...(kind === 'stopped' ? { status: 'completed' as const } : {}), source }
  return { ...fact, id: nativeGenerationFactId(fact) } as NativeGenerationFactRecord
}
