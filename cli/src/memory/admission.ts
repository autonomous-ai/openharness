import { createHash } from 'node:crypto'
import { hasInjection, hasSecret } from '../pair/learn/guard.js'
import { hasPointer, MemoryError, type MemoryDraft, type MemoryState, type SourceEvent } from './types.js'

/** Stable serialization for identity and comparison; object insertion order is not meaningful. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')

export function assertSafe(value: unknown): void {
  const serialized = JSON.stringify(value)
  if (hasSecret(serialized) || hasInjection(serialized)) throw new MemoryError('unsafe_content')
}

/** These checks establish structural provenance, not a proof that an LLM paraphrase is faithful. */
export function admission(draft: MemoryDraft, sources: Map<string, SourceEvent>): MemoryState {
  assertSafe(draft)
  if (!draft.scope.projectId && (!['working_preference', 'reference'].includes(draft.kind)
    || ['project_constraint', 'accepted_decision', 'verified_finding', 'temporary_state'].includes(draft.assertionType))) {
    throw new MemoryError('project_scope_required')
  }
  for (const evidence of draft.evidence) {
    const source = sources.get(evidence.sourceEventId)
    if (!source) throw new MemoryError('evidence_missing')
    if (source.profileId !== draft.scope.profileId
      || (source.projectId !== null && source.projectId !== draft.scope.projectId)) throw new MemoryError('evidence_scope')
    for (const key of ['taskId', 'branchId'] as const) {
      if (source[key] !== undefined && source[key] !== draft.scope[key]) throw new MemoryError('evidence_scope')
    }
    if (!source.text.includes(evidence.quote)) throw new MemoryError('evidence_mismatch')
    if (evidence.paths.some(path => !hasPointer(draft, path))) throw new MemoryError('evidence_path')
    if (evidence.verification && canonical(evidence.verification) !== canonical(source.verification)) throw new MemoryError('verification_mismatch')
  }
  for (const field of ['/claim', '/futureAction', '/applicability', ...(draft.rationale === null ? [] : ['/rationale'])]) {
    if (!draft.evidence.some(evidence => evidence.paths.includes(field))) throw new MemoryError('evidence_coverage')
  }
  const material = [...(draft.details ? materialPaths(draft.details, '/details') : []),
    ...(draft.exceptions.length ? materialPaths(draft.exceptions, '/exceptions') : []),
    ...Object.entries(draft.validity).flatMap(([key, value]) => value !== null && (!Array.isArray(value) || value.length)
      ? materialPaths(value, `/validity/${key}`) : [])]
  for (const path of material) {
    if (!draft.evidence.some(e => e.paths.some(support => path === support || path.startsWith(`${support}/`)))) throw new MemoryError('evidence_coverage')
  }
  if (draft.details?.experiment?.runs && !draft.evidence.some(e => e.verification && sources.get(e.sourceEventId)?.role === 'tool'
    && e.paths.some(path => ['/details', '/details/experiment', '/details/experiment/runs'].includes(path)))) throw new MemoryError('unsupported_measurement')
  const claimSources = draft.evidence.filter(e => e.paths.includes('/claim')).map(e => sources.get(e.sourceEventId)!)
  if (['stated_preference', 'project_constraint', 'accepted_decision', 'learning_goal'].includes(draft.assertionType)
    && (draft.evidenceClass !== 'user_stated' || !claimSources.some(source => source.role === 'user'))) {
    throw new MemoryError('unsupported_assertion')
  }
  if (draft.evidenceClass === 'user_stated' && !claimSources.some(source => source.role === 'user')) throw new MemoryError('unsupported_assertion')
  if (draft.assertionType === 'verified_finding' && (draft.evidenceClass !== 'observed_verified'
    || !draft.evidence.some(e => e.paths.includes('/claim') && e.verification && sources.get(e.sourceEventId)?.role === 'tool'))) {
    throw new MemoryError('unsupported_assertion')
  }
  if (draft.evidenceClass === 'observed_verified' && !claimSources.some(source => ['user', 'tool'].includes(source.role))
    && draft.assertionType !== 'temporary_state') throw new MemoryError('unsupported_assertion')
  if (draft.evidenceClass === 'inferred' || draft.evidenceClass === 'imported'
    || claimSources.every(source => source.role === 'derived' || source.role === 'reference')) return 'tentative'
  return 'active'
}

function materialPaths(value: unknown, path: string): string[] {
  if (value && typeof value === 'object' && Object.keys(value).length) return Object.entries(value)
    .flatMap(([key, child]) => materialPaths(child, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`))
  return [path]
}

export function proposalFingerprint(draft: MemoryDraft): string {
  const { evidence: _evidence, ...meaning } = draft
  return digest(meaning)
}
