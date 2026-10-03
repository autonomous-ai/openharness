import { expect, it } from 'vitest'
import { MonitorCompletions } from './harnessMonitor.js'
import type { RegisteredSession } from './registry.js'
const session = { agentId: 'one', sessionId: 's' } as RegisteredSession

it('completion matches live tab events, clears on open/new turn and ignores replay/abort', () => {
  const states = new MonitorCompletions()
  states.observe({ type: 'turn_ended', agentId: 'one', dbSessionId: 's', replay: true })
  expect(states.state(session)).toBe('idle')
  states.observe({ type: 'turn_ended', agentId: 'one', dbSessionId: 's', payload: {} })
  expect(states.state(session)).toBe('done')
  states.observe({ type: 'turn_started', agentId: 'one', replay: true })
  expect(states.state(session)).toBe('done')
  expect(states.state({ ...session, lastOpenedAt: Date.now() + 1 })).toBe('idle')
  states.observe({ type: 'turn_started', agentId: 'one' }); expect(states.state(session)).toBe('idle')
  states.observe({ type: 'turn_ended', agentId: 'one', dbSessionId: 's', payload: { aborted: true } }); expect(states.state(session)).toBe('idle')
})
