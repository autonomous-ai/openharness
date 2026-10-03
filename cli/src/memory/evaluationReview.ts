/** Offline semantic review of native diagnostic output. Never invokes a model or changes memory. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonical } from './admission.js'
import { conditionsSchema, draftSchema, MemoryError, sourceSchema } from './types.js'
import { reviewRecallContext } from './evaluationContext.js'

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().safe()
const source = z.object({ role: z.enum(['user', 'assistant', 'tool', 'reference', 'derived']), text: z.string().min(1).max(32_000) })
const probe = z.object({ id, query: z.string().max(4_000), projectIds: z.array(id), conditions: conditionsSchema,
  expected: z.enum(['recall', 'abstain']) })
const fixture = z.object({ id, projectId: id.nullable(), sources: z.array(source).min(1).optional(),
  boundary: z.enum(['complete', 'bounded']).optional(),
  episodes: z.array(z.object({ id, sources: z.array(source).min(1) })).min(1).max(4).optional(),
  expected: z.object({ review: z.array(z.string().max(2_000)) }), probes: z.array(probe) })
  .refine(row => !!row.sources !== !!row.episodes, 'choose sources or episodes')
const suiteSchema = z.object({ schemaVersion: z.literal(1), suite: id, cases: z.array(fixture).min(1).max(100) })
const recordSchema = draftSchema.safeExtend({ schemaVersion: z.literal(1), id, revision: count.positive(),
  state: z.enum(['active', 'tentative', 'needs_verification', 'superseded', 'archived']), createdAt: count, updatedAt: count })
const contextSchema = z.object({ text: z.string().max(16_000), bytes: count, maxBytes: count.max(16_000), estimatedTokens: count })
const resultSchema = z.object({ id, outcome: z.object({ state: z.string() }),
  recallFormat: z.enum(['summary', 'source_excerpts']).optional(), capturedSources: z.array(sourceSchema).max(512).optional(),
  episodes: z.object({ expected: count, reviewed: count, jobs: z.record(z.string(), count),
    boundary: z.enum(['complete', 'bounded']).optional() }).optional(),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean().nullable() })),
  records: z.array(recordSchema).max(100),
  probes: z.array(probe.extend({ status: z.string(), returnedIds: z.array(id).max(6), passed: z.boolean().nullable(),
    context: contextSchema.nullable().optional() })) })
const reportSchema = z.object({ schemaVersion: z.literal(1), suite: id, suiteSha256: hash,
  status: z.enum(['running', 'stopped', 'completed']), cases: z.array(resultSchema).max(100) })
const note = z.string().trim().min(1).max(2_000).nullable()
const recordReview = z.object({ id, revision: count.positive(), supported: z.boolean().nullable(),
  specific: z.boolean().nullable(), useful: z.boolean().nullable(), note }).strict()
const probeReview = z.object({ id, relevantIds: z.array(id).max(100).nullable(),
  requiredIds: z.array(id).max(100).nullable(), missingRequiredMemory: z.boolean().nullable(),
  faithfulContext: z.boolean().nullable(), note }).strict()
const reviewSchema = z.object({ schemaVersion: z.literal(1), reportSha256: hash, suiteSha256: hash,
  reviewer: z.object({ id, kind: z.enum(['human', 'agent']), independent: z.boolean() }).strict().nullable(),
  cases: z.array(z.object({ id, records: z.array(recordReview).max(100), probes: z.array(probeReview).max(100) }).strict()).max(100),
}).strict()
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
function decode<T>(schema: z.ZodType<T>, text: string): T {
  try { return schema.parse(JSON.parse(text)) } catch { throw new MemoryError('invalid_evaluation_review') }
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) throw new MemoryError('duplicate_evaluation_id')
}

/** Raw-byte binding preserves the exact source and result files; it does not authenticate authors. */
export function prepareEvaluationReview(suiteText: string, reportText: string) {
  const suite = decode(suiteSchema, suiteText), report = decode(reportSchema, reportText)
  const suiteSha256 = sha256(suiteText), reportSha256 = sha256(reportText)
  if (report.suiteSha256 !== suiteSha256 || report.suite !== suite.suite) throw new MemoryError('evaluation_suite_changed')
  unique(suite.cases.map(row => row.id)); unique(report.cases.map(row => row.id))
  for (const row of report.cases) if (!suite.cases.some(f => f.id === row.id)) throw new MemoryError('unknown_evaluation_case')
  const cases = suite.cases.map(f => {
    unique(f.probes.map(p => p.id))
    const episodes = f.episodes ?? [{ id: f.id, sources: f.sources! }]
    unique(episodes.map(e => e.id))
    const originals = episodes.flatMap(e => e.sources.map((s, index) => ({
      id: `${f.id}${f.episodes ? `-${e.id}` : ''}-${index}`, projectId: f.projectId,
      episode: e.id, boundary: f.boundary ?? 'complete', ...s })))
    const result = report.cases.find(row => row.id === f.id)
    const formats = new Map<string, 'summary' | 'source_excerpts' | null>()
    if (result) {
      // Older diagnostics always captured complete episodes. A bounded fixture must have an
      // explicit matching observation; do not grade it as if omitted context had been supplied.
      if ((result.episodes?.boundary ?? 'complete') !== (f.boundary ?? 'complete')) {
        throw new MemoryError('evaluation_boundary_changed')
      }
      unique(result.records.map(record => record.id)); unique(result.probes.map(p => p.id))
      for (const p of result.probes) {
        const expected = f.probes.find(original => original.id === p.id)
        if (!expected || canonical(probe.parse(p)) !== canonical(expected)) throw new MemoryError('evaluation_probe_changed')
        unique(p.returnedIds)
        if (p.returnedIds.some(id => !result.records.some(record => record.id === id))) throw new MemoryError('unknown_recalled_memory')
        if (p.context) {
          const reviewed = reviewRecallContext({ text: p.context.text, records: result.records,
            declaredFormat: result.recallFormat, capturedSources: result.capturedSources, originals })
          const sent = reviewed.items
          formats.set(p.id, reviewed.format)
          if (p.context.bytes !== Buffer.byteLength(p.context.text, 'utf8') || p.context.bytes > p.context.maxBytes
            || canonical(sent.map(item => item.id)) !== canonical(p.returnedIds)
            || sent.some(item => !result.records.some(record => record.id === item.id && record.revision === item.revision))) {
            throw new MemoryError('invalid_recall_context')
          }
        }
      }
      if (result.probes.length !== f.probes.length) throw new MemoryError('missing_evaluation_probe')
    }
    const completed = !!result && ['learned', 'no_useful_memory'].includes(result.outcome.state)
      && result.episodes?.expected === episodes.length && result.episodes.reviewed === episodes.length
      && (result.episodes.jobs.learned ?? 0) + (result.episodes.jobs.no_useful_memory ?? 0) === episodes.length
      && result.checks.some(check => check.name === 'completed_extraction' && check.passed === true)
      && result.probes.every(p => p.status === 'ok')
    return { id: f.id, projectId: f.projectId, completed, criteria: f.expected.review,
      sources: originals,
      records: result?.records ?? [], probes: f.probes.map(p => {
        const actual = result?.probes.find(actual => actual.id === p.id)
        return { ...p, returnedIds: actual?.returnedIds ?? [],
          context: actual?.context ? { ...actual.context, format: formats.get(p.id) ?? null } : null }
      }),
      mechanicalFailures: result?.checks.filter(check => check.passed === false).map(check => check.name) ?? [] }
  })
  return { schemaVersion: 1 as const, reportSha256, suiteSha256, suite: suite.suite,
    evidence: 'development_diagnostic_only' as const,
    completed: report.status === 'completed' && cases.every(row => row.completed),
    // Hide model/arm labels in the review packet. Content itself can still reveal its origin.
    cases, review: { schemaVersion: 1 as const, reportSha256, suiteSha256, reviewer: null,
      cases: cases.filter(row => row.completed).map(row => ({ id: row.id,
        records: row.records.map(record => ({ id: record.id, revision: record.revision,
          supported: null, specific: null, useful: null, note: null })),
        probes: row.probes.map(p => ({ id: p.id, relevantIds: null, requiredIds: null, missingRequiredMemory: null,
          faithfulContext: null, note: null })) })) } }
}

type Metric = { passed: number; reviewed: number; total: number; rate: number | null }
function metric(values: Array<boolean | null>, complete: boolean): Metric {
  const reviewed = values.filter(v => v !== null).length, passed = values.filter(v => v === true).length
  return { passed, reviewed, total: values.length, rate: complete && reviewed === values.length && values.length ? passed / values.length : null }
}

/** Reviewer labels remain attributed judgements. Neither an agent nor a declared human is verified here. */
export function scoreEvaluationReview(suiteText: string, reportText: string, reviewText: string) {
  const packet = prepareEvaluationReview(suiteText, reportText), review = decode(reviewSchema, reviewText)
  if (packet.reportSha256 !== review.reportSha256 || packet.suiteSha256 !== review.suiteSha256) throw new MemoryError('evaluation_review_changed')
  unique(review.cases.map(row => row.id))
  for (const row of review.cases) if (!packet.cases.some(c => c.id === row.id && c.completed)) throw new MemoryError('case_not_reviewable')
  const memories: Array<boolean | null> = [], recalls: Array<boolean | null> = [], abstentions: Array<boolean | null> = []
  const cases = packet.cases.map(row => {
    if (!row.completed) return { id: row.id, status: 'not_reviewable' as const, probes: [] }
    const labels = review.cases.find(c => c.id === row.id)
    unique(labels?.records.map(r => r.id) ?? []); unique(labels?.probes.map(p => p.id) ?? [])
    for (const record of labels?.records ?? []) if (!row.records.some(r => r.id === record.id && r.revision === record.revision)) throw new MemoryError('review_record_changed')
    for (const p of labels?.probes ?? []) if (!row.probes.some(original => original.id === p.id)) throw new MemoryError('unknown_review_probe')
    const quality = new Map(row.records.map(record => {
      const label = labels?.records.find(r => r.id === record.id)
      const value = !review.reviewer || !label?.note || [label.supported, label.specific, label.useful].some(v => v === null)
        ? null : label.supported && label.specific && label.useful
      memories.push(value)
      return [record.id, value] as const
    }))
    const probes = row.probes.map(p => {
      const label = labels?.probes.find(v => v.id === p.id)
      for (const ids of [label?.relevantIds, label?.requiredIds]) if (ids) {
        unique(ids)
        if (ids.some(id => !quality.has(id))) throw new MemoryError('unknown_review_memory')
      }
      if (label?.relevantIds && label.requiredIds?.some(id => !label.relevantIds!.includes(id))) throw new MemoryError('invalid_required_memory')
      if (p.expected === 'abstain' && (label?.relevantIds?.length || label?.requiredIds?.length || label?.missingRequiredMemory === true)) throw new MemoryError('abstention_review_changed')
      const labelled = !!p.context && !!review.reviewer && !!label?.note && label.relevantIds !== null && label.requiredIds !== null
        && label.missingRequiredMemory !== null && label.faithfulContext !== null
        && [...(label.relevantIds ?? []), ...p.returnedIds].every(id => quality.get(id) !== null)
      const passed = !labelled ? null : !label!.faithfulContext ? false : p.expected === 'abstain' ? p.returnedIds.length === 0
        : !label!.missingRequiredMemory && p.returnedIds.some(id => label!.relevantIds!.includes(id) && quality.get(id) === true)
          && label!.requiredIds!.every(id => p.returnedIds.includes(id))
          && p.returnedIds.every(id => label!.relevantIds!.includes(id) && quality.get(id) === true)
      ;(p.expected === 'recall' ? recalls : abstentions).push(passed)
      return { id: p.id, passed }
    })
    return { id: row.id, status: 'reviewable' as const, probes }
  })
  return { schemaVersion: 1, reportSha256: packet.reportSha256, suiteSha256: packet.suiteSha256,
    evidence: packet.evidence, reviewer: review.reviewer,
    contextFormats: [...new Set(packet.cases.flatMap(row => row.probes.flatMap(p => p.context?.format ? [p.context.format] : [])))],
    coverage: { completedCases: packet.cases.filter(row => row.completed).length, expectedCases: packet.cases.length },
    memories: metric(memories, packet.completed), recall: metric(recalls, packet.completed), abstention: metric(abstentions, packet.completed),
    cases, taskBenefit: 'not_measured', nativeDelivery: 'not_measured',
    limitations: ['Ratings are attributed judgements, not authenticated independent review.',
      'Exact source and metadata checks do not establish faithful meaning or complete surrounding context.',
      'These diagnostics do not satisfy the held-out-history or paired coding-task release gates.',
      'Older reports without captured recall context can be reviewed for memory content but receive no recall-quality rate.',
      'Empty, unfinished or partially reviewed denominators never receive a passing rate.'] }
}
