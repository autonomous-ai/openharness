import { describe, expect, it } from 'vitest'
import { ENGINES } from '../engines/types.js'
import { gridCapableEngines } from './gridLaunch.js'
import { parseNewAgentModel } from './newAgentModel.js'

const choice = { gridModel: 'Qwen-35B', gridName: 'my-grid' }
const target = { networkId: 'g', networkName: 'my-grid', baseUrl: 'https://fixture.invalid/relay/v1', apiKey: 'fixture-key', model: 'Qwen-35B' }

describe('new-session model routing', () => {
  it('keeps ordinary launches absent and normalizes the explicit selection', () => {
    expect(parseNewAgentModel('codex', {})).toEqual({ state: 'absent' })
    expect(parseNewAgentModel('codex', { gridModel: ' Qwen-35B ', gridName: ' my-grid ' })).toEqual({ state: 'ok', selection: { model: 'Qwen-35B', grid: 'my-grid' } })
  })
  it.each(ENGINES)('uses the actual launch contract for %s', engine => {
    expect(parseNewAgentModel(engine, choice).state).toBe(gridCapableEngines().includes(engine) ? 'ok' : 'invalid')
  })
  it.each([null, undefined, 4, {}, '', ' ', '\nQwen', 'a'.repeat(2049)])('refuses invalid model/grid identities: %j', bad => {
    expect(parseNewAgentModel('codex', { ...choice, gridModel: bad }).state).toBe('invalid')
    expect(parseNewAgentModel('codex', { ...choice, gridName: bad }).state).toBe('invalid')
  })
  it.each([{ grid: null }, { grid: target }, { codexHome: '/profiles/work' }])('refuses conflicting routing: %j', conflict => {
    expect(parseNewAgentModel('codex', { ...choice, ...conflict }).state).toBe('invalid')
  })
})
