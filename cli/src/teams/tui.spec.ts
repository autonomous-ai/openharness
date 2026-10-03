import { expect, it } from 'vitest'
import { teamTerminalView } from './tui.js'

it('shows an explicit answer separately from delivery and sanitizes terminal control sequences', () => {
  const text = teamTerminalView({ name: '\x1b[2JTeam', state: 'active', members: [
    { id: 'a', name: 'mobile', enabled: true, runtime: { engine: 'claude' }, role: 'Phone' },
    { id: 'b', name: 'daemon', enabled: true, runtime: { engine: 'codex' }, role: 'API' },
  ], exchanges: [{ id: 'c'.repeat(32), from: 'a', to: 'b', text: 'Which endpoint?', state: 'answered', origin: 'agent', delivery: { state: 'started' },
    answer: { text: 'GET /api/daemons', evidence: ['routes.ts:42'], origin: 'agent' }, continuation: { state: 'queued' } }] }, 100, 30)
  expect(text).not.toContain('\x1b')
  expect(text).toContain('@mobile → @daemon')
  expect(text).toContain('GET /api/daemons')
  expect(text).toContain('Return to @mobile: queued')
  expect(text.split('\n').every(line => line.length <= 100)).toBe(true)
})

it('keeps the selected question and its identity visible with a full roster and long roles', () => {
  const id = 'd'.repeat(32)
  const text = teamTerminalView({ name: 'Team', state: 'active',
    members: Array.from({ length: 32 }, (_, n) => ({ id: String(n), name: `peer${n}`, enabled: true, role: 'Long role '.repeat(50) })),
    exchanges: [{ id, from: '30', to: '31', text: 'Which endpoint?', state: 'pending', delivery: { state: 'queued' } }],
  }, 80, 24)
  expect(text).toContain(id)
  expect(text).toContain('@peer30 → @peer31')
  expect(text).toContain('Which endpoint?')
  expect(text.split('\n').length).toBeLessThanOrEqual(24)
})
