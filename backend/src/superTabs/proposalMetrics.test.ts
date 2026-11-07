import { expect, it } from 'vitest'
import { metrics } from '../lib/metrics.js'
import { proposalMeasures } from './proposalMetrics.js'

it('counts only proposal events and bounded wait measures without identities or text', async () => {
  proposalMeasures([{ event: 'decided', seconds: 90 }, { event: 'defaulted', seconds: 30 }])
  const text = await metrics.registry.metrics()
  expect(text).toContain('swarm_proposal_events_total{event="decided"} 1')
  expect(text).toContain('swarm_proposal_wait_seconds_sum{event="decided"} 90')
  expect(text).toContain('swarm_proposal_wait_seconds_count{event="defaulted"} 1')
})
