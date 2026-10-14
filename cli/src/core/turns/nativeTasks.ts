/** A native Task hook observes a request, not child execution. Cursor can resume
 * a child store for another run, so that store's last text/terminal marker cannot
 * complete this observation. Only exact native task results may do that later. */
import { createHash } from 'node:crypto'
import type { NativeGenerationObservation } from './nativeGenerationContent.js'
import type { NativeGeneration, NativeGenerationOwner } from './nativeGenerations.js'

type TaskInput = { readonly state: 'available'; readonly json: string }
  | { readonly state: 'pending' | 'ambiguous' }
export interface NativeTaskSnapshot {
  readonly id: string
  readonly owner: NativeGenerationOwner
  readonly generationId: string
  readonly toolUseId: string
  readonly factIds: readonly string[]
  /** Retired means the parent turn closed, never that its child succeeded. */
  readonly state: 'observed' | 'retired'
  readonly input: TaskInput
  readonly result: 'unconfirmed'
  readonly reason: string
}
export interface NativeTaskProjection {
  readonly tasks: readonly NativeTaskSnapshot[]
  readonly held: readonly { readonly factIds: readonly string[]; readonly reason: string }[]
}
const identity = (owner: NativeGenerationOwner) => JSON.stringify([owner.agentId, owner.sessionId, owner.processKey])

/** Presentation only: no timers, child reads, legacy session events or effects.
 * The caller verifies the complete native source before publishing this copy.
 * Native content validation already bounds bytes, field shapes and identities. */
export function nativeTasks(owner: NativeGenerationOwner, generation: NativeGeneration,
  observations: readonly NativeGenerationObservation[], cancelled: boolean,
): NativeTaskProjection {
  if (observations.length > 4096) throw Error('Waiting for native task observation capacity.')
  const original = Object.freeze({ ...owner }), scope = identity(original), knownFacts = new Set(generation.factIds)
  const groups = new Map<string, NativeGenerationObservation[]>(), unidentified: string[] = []
  for (const observation of observations) {
    if (identity(observation.owner) !== scope || observation.generationId !== generation.id
      || observation.event !== 'preToolUse' || !knownFacts.has(observation.factId)) {
      throw Error('Waiting for the original native task observation.')
    }
    if (!observation.toolUseId) {
      if (!observation.toolName || observation.toolName === 'Task') unidentified.push(observation.factId)
      continue
    }
    const group = groups.get(observation.toolUseId) ?? []
    group.push(observation)
    groups.set(observation.toolUseId, group)
  }
  const tasks: NativeTaskSnapshot[] = [], held: Array<{ factIds: readonly string[]; reason: string }> = []
  if (unidentified.length) held.push(Object.freeze({ factIds: Object.freeze(unidentified.sort()), reason: 'Waiting for the native task identity.' }))
  for (const [toolUseId, group] of [...groups].sort(([left], [right]) => left < right ? -1 : 1)) {
    const names = new Set(group.map(value => value.toolName))
    const factIds = Object.freeze([...new Set(group.map(value => value.factId))].sort())
    if (!names.has('Task')) {
      if (names.has(undefined)) held.push(Object.freeze({ factIds, reason: 'Waiting for the native tool identity.' }))
      continue
    }
    const inputs = new Set(group.map(value => value.inputJson))
    const ambiguous = names.size > 1 || inputs.size > 1
    const first = group[0].inputJson
    const input: TaskInput = Object.freeze(ambiguous ? { state: 'ambiguous' }
      : first === undefined ? { state: 'pending' } : { state: 'available', json: first })
    const reason = ambiguous ? 'Conflicting native task observations.' : input.state === 'pending'
      ? 'Waiting for the native task input.' : 'Waiting for a result linked to this task.'
    const id = `native-task:${createHash('sha256').update(JSON.stringify([scope, generation.id, toolUseId])).digest('hex')}`
    tasks.push(Object.freeze({ id, owner: original, generationId: generation.id, toolUseId, factIds,
      state: generation.terminal || cancelled ? 'retired' : 'observed', input, result: 'unconfirmed', reason }))
  }
  return Object.freeze({ tasks: Object.freeze(tasks), held: Object.freeze(held) })
}
