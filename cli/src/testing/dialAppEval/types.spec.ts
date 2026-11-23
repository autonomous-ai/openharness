import { expect, it } from 'vitest'
import { observedAgentId } from '../../cable/hosts/observed.js'
import { APPS, DIMENSIONS, EDITORS, PAGE, WEIGHTS, agentIdOf, engineOf, placeOf, resultKey } from './types.js'

const id = '00000000-0000-4000-8000-0000000000e1'

it('agentIdOf follows the session\'s engine', () => {
  expect(agentIdOf({ app: 'cursor', id, place: 'agent' })).toBe(observedAgentId('cursor', id))
  expect(agentIdOf({ app: 'vscode', id, engine: 'codex' })).toBe(observedAgentId('codex', id))
  expect(agentIdOf({ app: 'cursor', id, place: 'terminal', engine: 'codex' })).toBe(observedAgentId('codex', id))
  expect(agentIdOf({ app: 'vscode', id, place: 'panel' })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ app: 'cursor', id })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ app: 'claude', id })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ app: 'chatgpt', id })).toBe(observedAgentId('codex', id))
})

it('an editor session runs in a terminal unless it says otherwise; the base apps have no place', () => {
  expect(placeOf({ app: 'vscode' })).toBe('terminal')
  expect(placeOf({ app: 'cursor', place: 'agent' })).toBe('agent')
  expect(placeOf({ app: 'claude' })).toBeUndefined()
  expect(placeOf({ app: 'chatgpt' })).toBeUndefined()
  expect(engineOf({ app: 'cursor', place: 'agent', engine: 'claude' })).toBe('claude')
})

it("VS Code has no agent of its own: a session in place 'agent' that is not Cursor's is refused", () => {
  expect(() => placeOf({ app: 'vscode', place: 'agent' })).toThrow("vscode has no agent of its own: only Cursor's sessions run in place 'agent'")
  expect(() => engineOf({ app: 'vscode', place: 'agent' })).toThrow("vscode has no agent of its own")
  expect(() => agentIdOf({ app: 'vscode', id, place: 'agent', engine: 'claude' })).toThrow("vscode has no agent of its own")
})

it('PAGE names the editors\' pages by the wire\'s app ids', () => {
  expect(PAGE).toEqual({ claude: 'claude', chatgpt: 'codex', vscode: 'vscode', cursor: 'cursor' })
})

it('APPS is the four apps', () => {
  expect(APPS).toEqual(['claude', 'chatgpt', 'vscode', 'cursor'])
  expect(EDITORS).toEqual(['vscode', 'cursor'])
})

it('the weights are the spec\'s and sum to 100', () => {
  expect(WEIGHTS).toEqual({ D1: 15, D2: 15, D3: 15, D4: 10, D5: 25, D6: 5, D7: 10, D8: 5 })
  expect(DIMENSIONS.reduce((sum, d) => sum + WEIGHTS[d], 0)).toBe(100)
})

it('resultKey joins tier, platform, scenario and check with /', () => {
  expect(resultKey({ tier: 'a', platform: 'linux', scenario: 'C1', check: 'ring.recall' })).toBe('a/linux/C1/ring.recall')
})
