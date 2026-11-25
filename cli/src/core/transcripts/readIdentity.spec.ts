import { expect, it } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { readStillCurrent, transcriptReadIdentity } from './readIdentity.js'

it('copies binding identity before yielding, ignoring ordinary activity updates', () => {
  const session = { agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: '/t', codexHome: '/home', boundAt: 1,
    processIdentity: { pid: 7, executable: 'claude', startMarker: 'one' }, touchedAt: 1 } as unknown as RegisteredSession
  const before = transcriptReadIdentity(session)
  expect(transcriptReadIdentity(undefined)).toBe('')
  session.touchedAt++
  expect(transcriptReadIdentity(session)).toBe(before)
  for (const field of ['agentId', 'sessionId', 'engine', 'transcriptPath', 'codexHome', 'boundAt']) {
    expect(transcriptReadIdentity({ ...session, [field]: 'changed' }), field).not.toBe(before)
  }
  expect(transcriptReadIdentity({ ...session, processIdentity: { ...session.processIdentity!, pid: 8 } })).not.toBe(before)
  expect(transcriptReadIdentity({ ...session, processIdentity: { ...session.processIdentity!, startMarker: 'two' } })).not.toBe(before)
  expect(transcriptReadIdentity({ ...session, processIdentity: null })).not.toBe(before)
  expect(transcriptReadIdentity({ ...session, identityHold: 'header incomplete' })).not.toBe(before)
})

it('keeps a Linux process bound across a wall-clock correction, but rejects pid reuse', () => {
  const session = { agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: '/t',
    processIdentity: { pid: 7, executable: 'claude', startMarker: 'one', startTicks: 42 } } as RegisteredSession
  const before = transcriptReadIdentity(session)
  session.processIdentity!.startMarker = 'two'
  expect(transcriptReadIdentity(session)).toBe(before)
  session.processIdentity!.startTicks = 43
  expect(transcriptReadIdentity(session)).not.toBe(before)
})

it('revokes old reads across a complete same-path hold and recovery', () => {
  const session = { agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: '/t' } as RegisteredSession
  const before = transcriptReadIdentity(session)
  session.identityHold = 'header incomplete'; session.evidenceRevision = 1
  expect(transcriptReadIdentity(session)).not.toBe(before)
  delete session.identityHold; session.evidenceRevision = 2
  expect(transcriptReadIdentity(session)).not.toBe(before)
})

it('answers a read once its resumed conversation is bound by the same process, and across nothing else', () => {
  const processIdentity = { pid: 7, executable: 'hermes', startMarker: 'one' }
  const resumed = { agentId: 'a', sessionId: 's', engine: 'hermes', transcriptPath: null, boundAt: null, processIdentity } as unknown as RegisteredSession
  const read = readStillCurrent(resumed)
  const bound = { ...resumed, boundAt: 5, lastHookAt: 5 }
  expect(read(bound)).toBe(true)
  expect(read({ ...bound, sessionId: 'other' })).toBe(false)
  expect(read({ ...bound, processIdentity: { ...processIdentity, pid: 8 } })).toBe(false)
  expect(read({ ...bound, identityHold: 'header incomplete' })).toBe(false)
  expect(read(undefined)).toBe(false)
  // A binding stamped again is another binding of the conversation: the row left it and came back.
  expect(readStillCurrent(bound)({ ...bound, boundAt: 6 })).toBe(false)
})
