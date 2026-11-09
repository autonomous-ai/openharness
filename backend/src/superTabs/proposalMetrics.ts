import { Counter, Histogram } from 'prom-client'
import { metrics } from '../lib/metrics.js'
import type { MessageDraft, SuperTabState } from './model.js'

type Event = 'created' | 'decided' | 'answered' | 'defaulted' | 'revisited' | 'merged'
interface Measure { event: Event; seconds?: number }
const events = new Counter({ name: 'swarm_proposal_events_total', help: 'Committed proposal transitions', labelNames: ['event'] as const, registers: [metrics.registry] })
const waits = new Histogram({ name: 'swarm_proposal_wait_seconds', help: 'Proposal decision and answer waits', labelNames: ['event'] as const,
  buckets: [1, 15, 60, 300, 900, 1800, 3600, 86400], registers: [metrics.registry] })

/** Called after commit; retries and receipt replays contribute no event. No content or identity leaves the transaction. */
export function proposalMeasures(values: Measure[]): void {
  for (const value of values) {
    events.inc({ event: value.event })
    if (value.seconds !== undefined) waits.observe({ event: value.event }, Math.max(0, value.seconds))
  }
}
export function proposalMessageMeasures(state: SuperTabState, messages: MessageDraft[], now: number): Measure[] {
  return messages.flatMap<Measure>(m => {
    const record = state.conversations.find(c => c.id === m.conversationId)?.proposal
    if (!record) return []
    const source = m.source, kind = source?.kind
    if (kind === 'proposal-card') return [{ event: record.waitSince ? 'revisited' : 'created' }]
    if (kind === 'proposal-decision') return [{ event: 'decided', seconds: (now - (record.waitSince ?? record.createdAt)) / 1000 }]
    if (kind === 'proposal-merged') return [{ event: 'merged' }]
    if (kind === 'proposal-answer' && source?.applied) {
      const q = record.questions.find(q => q.id === source.questionId)
      return [{ event: source.defaulted ? 'defaulted' : 'answered', seconds: q ? (now - record.createdAt) / 1000 : undefined }]
    }
    return []
  })
}
