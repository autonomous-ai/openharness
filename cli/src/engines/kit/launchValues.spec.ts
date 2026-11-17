import { expect, it, vi } from 'vitest'
import { launchSettingsArgs } from './launchValues.js'

it('selects one optional snapshot and joins its values with base settings and instructions', () => {
  const current = vi.fn(() => true)
  const base = ['--settings', '{"hooks":{"Stop":["owner"]},"permissions":{"allow":[]}}', '--append-system-prompt', 'grid', '--append-system-prompt', 'dsh']
  const args = launchSettingsArgs('claude', base, { current, values: {
    instructions: 'optional', settings: '{"statusLine":{"type":"command","command":"selected script"}}',
  } })
  expect(current).toHaveBeenCalledTimes(1)
  expect(args.filter(word => word === '--settings')).toHaveLength(1)
  expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ hooks: { Stop: ['owner'] }, permissions: { allow: [] }, statusLine: { type: 'command', command: 'selected script' } })
  expect(args.slice(-2)).toEqual(['--append-system-prompt', 'grid\n\ndsh\n\noptional'])
})

it('omits the entire optional addition when its final proof is stale and preserves base arguments', () => {
  const base = ['--settings', '{"statusLine":{"type":"command","command":"user"}}', '--append-system-prompt', 'grid']
  expect(launchSettingsArgs('claude', base, { current: () => false, values: { instructions: 'stale', settings: '{"statusLine":{"type":"command","command":"stale"}}' } })).toEqual(base)
})

it('derives Codex literal flags from its contract and JSON quotes the captured value', () => {
  expect(launchSettingsArgs('codex', ['-c', 'model="owner"'], { current: () => true,
    values: { instructions: 'keep "mine"\nand add', settings: null } })).toEqual(['-c', 'model="owner"', '-c', 'developer_instructions="keep \\"mine\\"\\nand add"'.replace(/\\\\/g, '\\')])
})
