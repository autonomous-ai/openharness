import { expect, it } from 'vitest'
import { gridAssignmentEvidence, gridAssignmentProcess, gridAssignmentProcessesIn, gridAssignmentAnswersIn } from './gridAssignmentWire.js'

it('carries argument fragments alone: no environment, no prompt', () => {
  const input = gridAssignmentProcess('a', 'codex', 'codex --prompt private -c model_providers.grid.base_url="https://grid.example/relay/v1" -m m')!
  // Two spaces, as today: the `-m` fragment carries the one before it.
  expect(input).toEqual({ key: 'a', engine: 'codex', args: 'model_providers.grid.base_url="https://grid.example/relay/v1"  -m m' })
  expect(gridAssignmentProcessesIn([input])).toEqual([input])
  expect(gridAssignmentProcessesIn([{ ...input, env: {} }])).toBeNull()
})

it('has no evidence for an engine whose grid is in no command line, and a finding for Codex', () => {
  const argv = '-c model_providers.grid.base_url="https://grid.example/relay/v1" -m m'
  for (const engine of ['claude', 'hermes', 'grok', 'copilot', 'opencode'] as const) expect(gridAssignmentEvidence('a', engine, argv)).toBeUndefined()
  expect(gridAssignmentEvidence('a', 'pi', '--model grid/m')).toBeUndefined()
  expect(gridAssignmentEvidence('a', 'pi', '-e /c/grid-provider.ts --model grid/m')).toEqual({ key: 'a', engine: 'pi', args: '-e /c/grid-provider.ts --model grid/m' })
  expect(gridAssignmentEvidence('a', 'codex', 'codex -m gpt-5')).toBeNull()
})

it('rejects malformed, duplicate or mismatched batches instead of turning them into no assignment', () => {
  const input = gridAssignmentProcess('a', 'codex', '-c model_providers.grid.base_url="https://grid.example/relay/v1"')!
  for (const value of [null, {}, Array(4097).fill(input), [null], [{ ...input, engine: 'unknown' }],
    [{ ...input, key: 1 }], [{ ...input, args: 1 }], [{ ...input, args: '' }], [{ ...input, engine: 'claude' }], [input, input]]) {
    expect(gridAssignmentProcessesIn(value)).toBeNull()
  }
  for (const value of [null, [], [null], [{ key: 'wrong', assignment: null }], [{ key: 'a' }],
    [{ key: 'a', assignment: { baseUrl: 1, model: null } }], [{ key: 'a', assignment: { baseUrl: 'url', model: 1 } }]]) {
    expect(gridAssignmentAnswersIn(value, [input])).toBeNull()
  }
  expect(gridAssignmentAnswersIn([{ key: 'a', assignment: null }], [input])).toEqual([{ key: 'a', assignment: null }])
})
