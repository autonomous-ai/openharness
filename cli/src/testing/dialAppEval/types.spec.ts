import { expect, it } from 'vitest'
import { frontAppId, FRONT_NONE } from '../../cable/hosts/frontApp.js'
import { observedAgentId } from '../../cable/hosts/observed.js'
import { APPS, DIMENSIONS, EDITORS, FRONT_NAMES, PAGE, WEIGHTS, agentIdOf, engineOf, hookHandle, orcaAgentSessionId, orcaPaneHandle,
  orcaTerminalHandle, orcaWorktreeId, placeOf, resultKey, type Platform } from './types.js'

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

it("a resting Orca chat's row is Orca's own, by its Orca session; a live one's is its engine's, as the hooked copy's", () => {
  expect(orcaAgentSessionId('c')).toBe('eval-orca-c')
  expect(agentIdOf({ key: 'c', app: 'orca', id, chat: 'resting' })).toBe(observedAgentId('orca', 'eval-orca-c'))
  expect(agentIdOf({ key: 'c', app: 'orca', id, chat: 'resting', engine: 'codex' })).toBe(observedAgentId('orca', 'eval-orca-c'))
  expect(agentIdOf({ key: 'c', app: 'orca', id, chat: 'live' })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ key: 'c', app: 'orca', id })).toBe(observedAgentId('claude', id))
  expect(() => agentIdOf({ app: 'orca', id, chat: 'resting' })).toThrow('a resting Orca chat is named by its key')
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
  expect(PAGE).toMatchObject({ claude: 'claude', chatgpt: 'codex', vscode: 'vscode', cursor: 'cursor' })
})

it("PAGE names Orca's page orca", () => {
  expect(PAGE.orca).toBe('orca')
})

it('APPS is the five apps, Orca last', () => {
  expect(APPS).toEqual(['claude', 'chatgpt', 'vscode', 'cursor', 'orca'])
  expect(EDITORS).toEqual(['vscode', 'cursor'])
})

it("orcaPaneHandle gives the session's handle at its first launch and 8d0n at its nth; a session whose hooks name none is laid out on its key's handle, and hookHandle gives it none", () => {
  // o1's bytes are 6f31.
  expect(orcaTerminalHandle('o1')).toBe('term_00000000-0000-4000-8d00-000000006f31')
  expect(orcaPaneHandle({ key: 'o1' }, 0)).toBe('term_00000000-0000-4000-8d00-000000006f31')
  expect(orcaPaneHandle({ key: 'o1' }, 2)).toBe('term_00000000-0000-4000-8d02-000000006f31')
  expect(hookHandle({ key: 'o1' }, 1)).toBe('term_00000000-0000-4000-8d01-000000006f31')
  expect(orcaPaneHandle({ key: 'o1', handle: 'none' }, 0)).toBe(orcaTerminalHandle('o1'))
  expect(orcaPaneHandle({ key: 'o1', handle: 'none' }, 1)).toBe('term_00000000-0000-4000-8d01-000000006f31')
  expect(hookHandle({ key: 'o1', handle: 'none' }, 0)).toBeUndefined()
  expect(hookHandle({ key: 'o1', handle: 'none' }, 1)).toBeUndefined()
  // A chat's hooks name no handle: no terminal holds it.
  expect(hookHandle({ key: 'o1', chat: 'live' }, 0)).toBeUndefined()
})

it('orcaWorktreeId is eval-repo::/work/eval-<key>', () => {
  expect(orcaWorktreeId('w1')).toBe('eval-repo::/work/eval-w1')
})

it("every app but Orca maps through frontAppId to its own page from its FRONT_NAMES name on every platform; Orca's macOS name maps to orca", () => {
  for (const platform of ['darwin', 'linux', 'win32'] as Platform[]) {
    for (const app of APPS.filter((a) => a !== 'orca')) expect(frontAppId(FRONT_NAMES[platform][app]), `${platform} ${app}`).toBe(PAGE[app])
    expect(frontAppId(FRONT_NAMES[platform].other), platform).toBe(FRONT_NONE)
  }
  expect(frontAppId(FRONT_NAMES.darwin.orca)).toBe('orca')
  // Linux's and Windows' own names for Orca, which the dial is graded on there whether or not the product tells them.
  expect(FRONT_NAMES.linux.orca).toBe('orca-ide')
  expect(FRONT_NAMES.win32.orca).toBe('orca.exe')
})

it('the weights are the spec\'s and sum to 100', () => {
  expect(WEIGHTS).toEqual({ D1: 15, D2: 15, D3: 15, D4: 10, D5: 25, D6: 5, D7: 10, D8: 5 })
  expect(DIMENSIONS.reduce((sum, d) => sum + WEIGHTS[d], 0)).toBe(100)
})

it('resultKey joins tier, platform, scenario and check with /', () => {
  expect(resultKey({ tier: 'a', platform: 'linux', scenario: 'C1', check: 'ring.recall' })).toBe('a/linux/C1/ring.recall')
})
