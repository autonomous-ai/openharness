import { expect, it } from 'vitest'
import { creationObservation } from './creationObservation.js'

const id = 'creation-fixture-1234'
it('projects only an exact known creation receipt without native launch details', () => {
  for (const state of ['missing', 'pending', 'unconfirmed', 'failed', 'cancelled']) {
    expect(creationObservation(id, { creationId: id, state, request: { private: 'omitted' } })).toEqual({ creationId: id, state })
  }
  expect(creationObservation(id, { creationId: id, state: 'created', agentId: 'native', extra: true })).toEqual({ creationId: id, state: 'created', agentId: 'native' })
})
it('keeps unknown, mismatched and malformed replies distinct from a missing launch', () => {
  expect(creationObservation('short', {})).toBeNull()
  for (const value of [null, 'missing', {}, { creationId: 'another', state: 'cancelled' },
    { creationId: id, state: 'future' }, { creationId: id, state: 'created' },
    { creationId: id, state: 'created', agentId: '../outside' }]) {
    expect(creationObservation(id, value)).toBeNull()
  }
})
