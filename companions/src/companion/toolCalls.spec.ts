import { expect, it } from 'vitest'
import { CompanionToolCalls } from './toolCalls.js'

it('keeps exact pending inputs until their result or turn boundary, without a core recap service', () => {
  const calls = new CompanionToolCalls()
  calls.observe('s1', { type: 'tool_start', payload: { id: 't1', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' } } })
  calls.observe('s1', { type: 'tool_start', payload: { id: 't2', tool: 'Read', input: { file_path: '/w/a.ts' } } })
  calls.observe('s1', { type: 'tool_end', payload: { id: 't2', tool: 'Read', output: '', isError: false, summary: '' } })
  expect(calls.open('s1')).toEqual([{ name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }])
  calls.observe('s1', { type: 'turn_ended', payload: {} })
  expect(calls.open('s1')).toEqual([])
})
