import { expect, it } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { transcriptReadIdentity } from './readIdentity.js'

it('copies binding identity before yielding, ignoring ordinary activity updates', () => {
  const session = { agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: '/t', codexHome: '/home', boundAt: 1,
    processIdentity: { pid: 7, startTime: 'one' }, touchedAt: 1 } as unknown as RegisteredSession
  const before = transcriptReadIdentity(session)
  expect(transcriptReadIdentity(undefined)).toBe('')
  session.touchedAt++
  expect(transcriptReadIdentity(session)).toBe(before)
  for (const field of ['agentId', 'sessionId', 'engine', 'transcriptPath', 'codexHome', 'boundAt', 'processIdentity']) {
    expect(transcriptReadIdentity({ ...session, [field]: 'changed' }), field).not.toBe(before)
  }
})
