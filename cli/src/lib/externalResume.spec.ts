import { expect, it } from 'vitest'
import { externalReservations, externalResumeIds, externalResumePending, parseExternalResume, type ExternalResumeIntent } from './externalResume.js'
const request = { sessionId: 'alias', engine: 'hermes' as const }
const session = { sessionId: 'canonical', engine: 'hermes' as const, cwd: '/fixture/work', transcriptPath: null,
  aliases: ['alias', 'second'], title: 'Conversation', origin: 'terminal' as const, mtime: 1, launchArgs: ['-p', 'work'] }
const waiting: ExternalResumeIntent = { token: '12345678-1234-1234-1234-123456789012', request, phase: 'waiting', takeOver: 'wait' }
const owner = { process: { pid: 7, engine: 'hermes' as const, record: '/fixture/record', tty: '/dev/fixture-terminal' }, generation: 'ps:1' }
it('clones only valid durable data and preserves reservations until a real conversation change', () => {
  const value = { ...waiting, session, owner, ignored: 'discard' }
  const parsed = parseExternalResume(value)!
  expect(parsed).toEqual({ ...waiting, session, owner })
  session.aliases.push('new-alias')
  expect(parsed.session?.aliases).toEqual(['alias', 'second'])
  session.aliases.pop()
  expect(externalResumeIds(parsed)).toEqual(['alias', 'canonical', 'second'])
  const admitted: ExternalResumeIntent = { ...parsed, phase: 'admitted', signal: 'sent', continue: true, dispatched: true }
  expect(parseExternalResume(admitted)).toEqual(admitted)
  expect(externalResumePending(admitted)).toBe(false)
  for (const sessionId of ['', 'canonical']) expect(externalReservations({ sessionId, externalResume: admitted })).toContain('alias')
  expect(externalReservations({ sessionId: 'new-conversation', externalResume: admitted })).toEqual(['new-conversation'])
  expect(externalResumeIds({ ...parsed, phase: 'cancelled' })).toEqual([])
  expect(externalResumePending({ ...parsed, phase: 'cancelled' })).toBe(true)
  expect(externalResumeIds(undefined)).toEqual([])
  expect(externalResumePending(undefined)).toBe(false)
})
it('refuses malformed, oversize and contradictory journal states instead of creating a fresh launch', () => {
  const cyclic: Record<string, unknown> = { ...waiting }; cyclic.loop = cyclic
  for (const value of [null, [], cyclic, { ...waiting, extra: 'x'.repeat(65_536) },
    { ...waiting, token: 'unsafe;token' }, { ...waiting, phase: 'unknown' }, { ...waiting, request: {} },
    { ...waiting, takeOver: 'new-choice' }, { ...waiting, continue: false }, { ...waiting, continue: true },
    { ...waiting, dispatched: true }, { ...waiting, signal: 'sent', session, owner },
    { ...waiting, session: { ...session, engine: 'claude' } }, { ...waiting, session: { ...session, aliases: [] } },
    { ...waiting, session: {} }, { ...waiting, phase: 'admitted' }, { ...waiting, phase: 'quitting' },
    { ...waiting, phase: 'quitting', session, owner, takeOver: null }, { ...waiting, owner: {} },
    { ...waiting, owner: { ...owner, generation: 'unknown' } }, { ...waiting, owner: { ...owner, process: { ...owner.process, harness: true } } },
  ]) expect(parseExternalResume(value), JSON.stringify(value === cyclic ? 'cyclic' : value)).toBeNull()
  expect(parseExternalResume({ ...waiting, phase: 'quitting', session, owner })).not.toBeNull()
  expect(parseExternalResume({ ...waiting, phase: 'quitting', session, owner, signal: 'prepared', continue: true })).not.toBeNull()
})
