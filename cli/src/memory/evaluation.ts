/** Diagnostic execution of frozen synthetic episodes through the real learner and store. */
import { MemoryLearner, type MemoryInference } from './learner.js'
import { CodingMemoryStore } from './store.js'
import { QUEUE_OPERATIONS, type Arguments, type MemoryPort, type Operation, type Result } from './operations.js'
import { MemoryError, type Conditions, type MemoryRecord, type RecallRequest, type SourceEvent } from './types.js'
import { MAX_EPISODES_PER_CALL } from './queue.js'

export interface ExtractionCase {
  id: string
  projectId: string | null
  boundary?: 'complete' | 'bounded'
  sources: Array<Pick<SourceEvent, 'role' | 'text'>>
  expected: {
    records: { min: number; max: number }
    scope: 'personal' | 'project' | 'none'
    rationale: 'unspecified' | 'null'
    review: string[]
  }
  probes: Array<{ id: string; query: string; projectIds: string[]; conditions: Conditions; expected: 'recall' | 'abstain' }>
}
export interface EvaluationCheck { name: string; passed: boolean | null }
export interface ExtractionBatchCase extends Omit<ExtractionCase, 'sources'> {
  episodes: Array<{ id: string; sources: ExtractionCase['sources'] }>
}
export type ExtractionScenario = ExtractionCase | ExtractionBatchCase

/** Expectations and probes are never included in captured text or extraction input. */
export async function evaluateExtractionCase(input: {
  fixture: ExtractionScenario; directory: string; inference: MemoryInference; engine: string
  /** Default to the packet delivered by native prompt recall; summary is an explicit comparison arm. */
  recallFormat?: RecallRequest['format']
}) {
  const { fixture } = input
  const recallFormat = input.recallFormat ?? 'source_excerpts'
  if (!['summary', 'source_excerpts'].includes(recallFormat)) throw new MemoryError('invalid_evaluation_recall_format')
  const boundary = fixture.boundary ?? 'complete'
  if (!['complete', 'bounded'].includes(boundary)) throw new MemoryError('invalid_evaluation_boundary')
  const batch = 'episodes' in fixture
  const episodes = batch ? fixture.episodes : [{ id: fixture.id, sources: fixture.sources }]
  if (!episodes.length || episodes.length > MAX_EPISODES_PER_CALL || new Set(episodes.map(episode => episode.id)).size !== episodes.length
    || episodes.some(episode => !episode.sources.length)) throw new MemoryError('invalid_evaluation_episodes')
  const profileId = 'synthetic-owner'
  const opened = CodingMemoryStore.open({ directory: input.directory, profileId })
  if (!opened.ok) throw new Error(opened.reason)
  const store = opened.store
  const startedAt = Date.now()
  const capturedSources: SourceEvent[] = []
  try {
    const projectIds = [...new Set([fixture.projectId, ...fixture.probes.flatMap(probe => probe.projectIds)].filter((id): id is string => id !== null))]
    for (const id of projectIds) store.registerProject(id)
    store.setControls({ learn: true, recall: true })
    for (const episode of episodes) {
      const id = batch ? `${fixture.id}-${episode.id}` : fixture.id
      const sessionId = `synthetic-${id}`
      const sources: SourceEvent[] = episode.sources.map((source, index) => ({
        ...source, id: `${id}-${index}`, nativeEventId: `${id}-${index}`, profileId,
        projectId: fixture.projectId, engine: input.engine, sessionId, eligibility: 'coding',
        observedAt: Date.now(), rootIds: [`${id}-${index}`],
      }))
      store.learning.capture({ streamId: id, episodeId: id, engine: input.engine, sessionId,
        projectId: fixture.projectId, from: null, to: '1', events: sources, boundary })
      for (const source of sources) {
        const captured = store.source(source.id, { profileId, projectIds, includeProfile: true })
        if (captured) capturedSources.push(captured)
      }
    }
    const memory: MemoryPort = { async request<K extends Operation>(operation: K, args: Arguments<K>): Promise<Result<K>> {
      const owner = (QUEUE_OPERATIONS as readonly string[]).includes(operation) ? store.learning : store
      return (owner as unknown as Record<string, (...args: unknown[]) => unknown>)[operation].apply(owner, args) as Result<K>
    } }
    const outcome = await new MemoryLearner(memory, input.inference).tick()
    const records = store.list({ profileId, projectIds, includeProfile: true })
    const jobs = store.learning.status().jobs
    const reviewed = (jobs.learned ?? 0) + (jobs.no_useful_memory ?? 0)
    const completed = ['learned', 'no_useful_memory'].includes(outcome.state) && reviewed === episodes.length
    const checks = extractionChecks(fixture, outcome.state, records, completed)
    const probes = fixture.probes.map(probe => {
      if (!completed) {
        checks.push({ name: `recall:${probe.id}`, passed: null })
        return { ...probe, status: 'not_run', returnedIds: [], passed: null, context: null }
      }
      const maxBytes = 3_000
      const result = store.recall({ query: probe.query, conditions: probe.conditions, maxBytes, format: recallFormat },
        { profileId, projectIds: probe.projectIds, includeProfile: true })
      const passed = result.status === 'ok' && (probe.expected === 'recall' ? result.items.length > 0 : result.items.length === 0)
      checks.push({ name: `recall:${probe.id}`, passed })
      return { ...probe, status: result.status, returnedIds: result.items.map(item => item.id), passed,
        measurement: 'presence_only' as const,
        context: { text: result.text, bytes: Buffer.byteLength(result.text, 'utf8'), maxBytes, estimatedTokens: result.estimatedTokens } }
    })
    return { id: fixture.id, durationMs: Date.now() - startedAt, recallFormat, capturedSources, outcome, checks, probes, records,
      episodes: { expected: episodes.length, reviewed, jobs, boundary },
      // Mechanical success never claims semantic entailment, usefulness or independent review.
      semanticReview: { status: completed ? 'pending' as const : 'not_reviewable' as const, criteria: fixture.expected.review } }
  } finally { store.close() }
}

export function extractionChecks(fixture: ExtractionScenario, state: string, records: MemoryRecord[],
  completed = ['learned', 'no_useful_memory'].includes(state)): EvaluationCheck[] {
  const { expected } = fixture
  return [
    { name: 'completed_extraction', passed: completed },
    { name: 'record_count', passed: completed ? records.length >= expected.records.min && records.length <= expected.records.max : null },
    { name: 'scope', passed: !completed ? null : expected.scope === 'none' ? records.length === 0 : records.every(record =>
      expected.scope === 'personal' ? record.scope.projectId === undefined : record.scope.projectId === fixture.projectId) },
    ...(expected.rationale === 'null' ? [{ name: 'no_invented_rationale', passed: completed ? records.every(record => record.rationale === null) : null }] : []),
  ]
}
