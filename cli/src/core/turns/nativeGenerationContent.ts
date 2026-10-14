/** Native payloads belong to their retained generation, never the parser's last
 * turn. Stop and response can arrive in either order; neither orders responses. */
import { nativeHookGeneration } from '../../engines/kit/nativeHookGeneration.js'
import { validNativeHookBody } from '../../engines/kit/nativeHookBody.js'
import { validNativeGenerationFact, type NativeGenerationFactRecord } from '../../engines/kit/nativeGenerationFact.js'
import { MAX_RETAINED_GENERATION_FACTS } from '../../engines/kit/nativeGenerationCancellation.js'
import { validNativeHookWireIdentity, type NativeHookWireIdentity } from '../../engines/kit/nativeHookClientProtocol.js'
import type { NativeHookDelivery } from '../../engines/kit/nativeHookJournal.js'
import type { NativeGenerationOwner, NativeGenerationSource } from './nativeGenerations.js'

export interface NativeGenerationObservation {
  readonly owner: NativeGenerationOwner
  readonly factId: string
  readonly generationId: string
  readonly deliveryId: string
  readonly wire: NativeHookWireIdentity
  readonly event: 'beforeSubmitPrompt' | 'preToolUse' | 'afterAgentResponse'
  readonly prompt?: string
  readonly responseText?: string
  readonly toolUseId?: string
  readonly toolName?: string
  /** Canonical retained JSON, rather than a mutable nested tool input object. */
  readonly inputJson?: string
}
export type NativeText = { readonly state: 'available'; readonly text: string }
  | { readonly state: 'pending' | 'ambiguous' }
export interface NativeGenerationContent {
  readonly prompt: NativeText
  readonly response: NativeText
  /** These observations have identities but no inferred execution order. */
  readonly tools: readonly NativeGenerationObservation[]
}

// Matches the production effect namespace's existing content ceiling. This is
// not a smaller per-response limit: each native field still admits 128 KiB.
const MAX_BYTES = 1024 * 1024
const MAX_OBSERVATIONS = 4096
const scope = (owner: NativeGenerationOwner) => JSON.stringify([owner.agentId, owner.sessionId, owner.processKey])
function held(reason: string): never { throw Error(`Waiting for native generation content: ${reason}.`) }

/** Copy before the source's confirmation awaits. The original journal proof
 * must cover both this intake and its joined fact at every later effect. */
export function captureNativeGenerationContent(owner: NativeGenerationOwner,
  facts: ReadonlyMap<string, NativeGenerationFactRecord>, deliveries: ReadonlyMap<string, NativeHookDelivery>,
): readonly NativeGenerationObservation[] {
  if (!(facts instanceof Map) || facts.size > MAX_RETAINED_GENERATION_FACTS
    || !(deliveries instanceof Map) || deliveries.size > MAX_OBSERVATIONS) held('the retained collection capacity was exceeded')
  const original = Object.freeze({ ...owner }), observations: NativeGenerationObservation[] = []
  let bytes = 0
  for (const [id, fact] of facts) {
    if (id !== fact.id || !validNativeGenerationFact(fact)) held('a retained fact is invalid')
    if (fact.agentId !== original.agentId || fact.conversationId !== original.sessionId || fact.source.type === 'core') continue
    // Direct Stop has no content. Its independent native owner proof is checked
    // by HookServer before the source is constructed.
    if (fact.source.identityV1 !== undefined) continue
    const intake = deliveries.get(fact.source.deliveryId)?.intake
    if (!intake || !validNativeHookBody(intake.payload, true)
      || JSON.stringify(nativeHookGeneration(intake)) !== JSON.stringify(fact)) held('the original intake is missing or changed')
    const body = intake.payload
    if (body.hookEvent === 'stop') continue
    const observation = Object.freeze({ owner: original, factId: fact.id, generationId: fact.generationId,
      deliveryId: intake.id, wire: Object.freeze({ ...intake.wire! }),
      event: body.hookEvent as NativeGenerationObservation['event'],
      ...(typeof body.prompt === 'string' && body.hookEvent === 'beforeSubmitPrompt' ? { prompt: body.prompt } : {}),
      ...(typeof body.responseText === 'string' && body.hookEvent === 'afterAgentResponse' ? { responseText: body.responseText } : {}),
      ...(body.hookEvent === 'preToolUse' ? {
        ...(typeof body.toolUseId === 'string' ? { toolUseId: body.toolUseId } : {}),
        ...(typeof body.toolName === 'string' ? { toolName: body.toolName } : {}),
        ...(body.input === undefined ? {} : { inputJson: JSON.stringify(body.input) }),
      } : {}),
    })
    bytes += Buffer.byteLength(JSON.stringify(observation))
    if (bytes > MAX_BYTES) held('the retained content capacity was exceeded')
    observations.push(observation)
  }
  return Object.freeze(observations)
}

/** Validate the complete copied source without reading a worker or transcript.
 * Missing content holds only its consumer; a missing required intake is instead
 * rejected by captureNativeGenerationContent before any source is published. */
export function nativeGenerationContent(source: NativeGenerationSource): ReadonlyMap<string, NativeGenerationContent> {
  const observations = source.observations
  if (!Array.isArray(observations) || observations.length > MAX_OBSERVATIONS) held('the complete observation collection is unavailable')
  if (!Array.isArray(source.facts) || source.facts.length > MAX_RETAINED_GENERATION_FACTS) held('the retained fact capacity was exceeded')
  const byFact = new Map(source.facts.map(fact => [fact.id, fact])), seen = new Set<string>()
  const groups = new Map<string, { prompts: Set<string>; responses: Set<string>; tools: NativeGenerationObservation[] }>()
  let bytes = 0
  for (const observation of observations) {
    const fact = byFact.get(observation.factId)
    if (!fact || seen.has(observation.factId) || scope(observation.owner) !== scope(source.owner)
      || observation.generationId !== fact.generationId || !/^[a-zA-Z0-9_-]{16,96}$/.test(observation.deliveryId)
      || !validNativeHookWireIdentity(observation.wire)) held('an observation lost its original identity')
    const event = observation.event
    if (event === 'beforeSubmitPrompt' ? fact.kind !== 'submitted'
      : event === 'preToolUse' || event === 'afterAgentResponse' ? fact.kind !== 'activity' : true) held('an observation changed its native event')
    const fields = ['owner', 'factId', 'generationId', 'deliveryId', 'wire', 'event',
      ...(event === 'beforeSubmitPrompt' ? ['prompt'] : event === 'afterAgentResponse' ? ['responseText'] : ['toolUseId', 'toolName', 'inputJson'])]
    if (Object.keys(observation).some(key => !fields.includes(key))) held('an observation has unsupported fields')
    for (const field of ['prompt', 'responseText', 'toolUseId', 'toolName', 'inputJson'] as const) {
      const value = observation[field]
      if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024)) held('an observation field is invalid')
    }
    bytes += Buffer.byteLength(JSON.stringify(observation))
    if (bytes > MAX_BYTES) held('the retained content capacity was exceeded')
    seen.add(observation.factId)
    let group = groups.get(fact.generationId)
    if (!group) { group = { prompts: new Set(), responses: new Set(), tools: [] }; groups.set(fact.generationId, group) }
    if (event === 'beforeSubmitPrompt' && observation.prompt !== undefined) group.prompts.add(observation.prompt)
    if (event === 'afterAgentResponse' && observation.responseText !== undefined) group.responses.add(observation.responseText)
    if (event === 'preToolUse') group.tools.push(Object.freeze({ ...observation,
      owner: Object.freeze({ ...observation.owner }), wire: Object.freeze({ ...observation.wire }) }))
  }
  for (const fact of source.facts) {
    if ((fact.kind === 'submitted' || fact.kind === 'activity') && !seen.has(fact.id)) held('a native payload observation is missing')
  }
  const text = (values: Set<string>): NativeText => Object.freeze(values.size === 1
    ? { state: 'available', text: [...values][0] } : { state: values.size ? 'ambiguous' : 'pending' })
  return new Map([...groups].map(([id, group]) => [id, Object.freeze({ prompt: text(group.prompts), response: text(group.responses),
    tools: Object.freeze(group.tools.sort((a, b) => a.factId < b.factId ? -1 : 1)) })]))
}

export const EMPTY_NATIVE_CONTENT: NativeGenerationContent = Object.freeze({
  prompt: Object.freeze({ state: 'pending' }), response: Object.freeze({ state: 'pending' }), tools: Object.freeze([]),
})
