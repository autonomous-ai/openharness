import { expect, it } from 'vitest'
import { observedAgentId } from '../../cable/hosts/observed.js'
import { DIMENSIONS, WEIGHTS, agentIdOf, resultKey } from './types.js'

const id = '00000000-0000-4000-8000-0000000000e1'

it('agentIdOf gives the observed source\'s id for both apps', () => {
  expect(agentIdOf({ app: 'claude', id })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ app: 'chatgpt', id })).toBe(observedAgentId('codex', id))
})

it('the weights are the spec\'s and sum to 100', () => {
  expect(WEIGHTS).toEqual({ D1: 15, D2: 15, D3: 15, D4: 10, D5: 25, D6: 5, D7: 10, D8: 5 })
  expect(DIMENSIONS.reduce((sum, d) => sum + WEIGHTS[d], 0)).toBe(100)
})

it('resultKey joins tier, platform, scenario and check with /', () => {
  expect(resultKey({ tier: 'a', platform: 'linux', scenario: 'C1', check: 'ring.recall' })).toBe('a/linux/C1/ring.recall')
})
