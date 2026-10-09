import { expect, it } from 'vitest'
import { externalSessionAnswer, externalSessionFact, externalSessionRequest } from './externalSessionWire.js'

const request = { engine: 'claude' as const, sessionId: 'conversation' }
const session = { ...request, cwd: '/workspace', title: 'A conversation', origin: 'terminal', mtime: 1, transcriptPath: '/store/conversation.jsonl' }
const answer = { ok: true, request, session, owner: null, generation: null, busy: false }

it('copies bounded facts, never history readers, and matches the exact request and canonical aliases', () => {
  const source = { ...answer, session: { ...session, aliases: ['old'], launchArgs: [], readHistory: () => ['private history'] } }
  const accepted = externalSessionAnswer(source, request)
  expect(accepted.ok).toBe(true)
  if (!accepted.ok) throw new Error('valid observation refused')
  expect(accepted.session).not.toHaveProperty('readHistory')
  source.session.aliases.push('later')
  expect(accepted.session?.aliases).toEqual(['old'])
  expect(externalSessionAnswer({ ...answer, request: { ...request, sessionId: 'old' }, session: source.session }, { ...request, sessionId: 'old' }).ok).toBe(true)
  expect(externalSessionRequest({ ...request, secret: 'discard' })).toEqual(request)
})

it('holds mismatched, oversized, malformed or unavailable answers instead of reporting free', () => {
  for (const value of [null, [], {}, { ...answer, request: { ...request, engine: 'codex' } },
    { ...answer, session: { ...session, sessionId: 'other' } }, { ...answer, extra: 'x'.repeat(65536) },
    { ...answer, busy: true }, { ...answer, busyConfirmed: true }, { ...answer, busyConfirmed: false }, { ...answer, generation: 'marker' }, { ...answer, session: undefined },
    { ...answer, owner: { pid: -1 } }, { ok: false, detail: '\u0000' }, { ...answer, owner: {}, session: null }]) {
    expect(externalSessionAnswer(value, request)).toMatchObject({ ok: false, error: 'SEARCH_UNAVAILABLE' })
  }
  const cyclic: any = { ...answer }; cyclic.self = cyclic
  expect(externalSessionAnswer(cyclic, request).ok).toBe(false)
  expect(externalSessionAnswer({ ok: false, detail: 'Waiting for the reader.' }, request)).toMatchObject({ detail: 'Waiting for the reader.' })
})

it('refuses invalid metadata and owner boundaries', () => {
  for (const patch of [{ cwd: 'relative' }, { transcriptPath: 'relative' }, { title: 'x'.repeat(4097) },
    { aliases: [''] }, { aliases: Array(257).fill('id') }, { launchArgs: ['\u0000'] }, { launchArgs: ['-p', 'work'] }, { archived: false },
    { engine: 'terminal' }, { origin: 'arbitrary' }, { mtime: NaN }]) expect(externalSessionFact({ ...session, ...patch })).toBeNull()
  const owner = { pid: 7, engine: 'claude', tty: '/dev/fixture-terminal', record: '/store/record', harness: true }
  const owned = { ...answer, owner, generation: 'ps:1000', busy: true }
  expect(externalSessionAnswer(owned, request)).toMatchObject({ ok: true, owner })
  expect(externalSessionAnswer({ ...owned, owner: { ...owner, harness: undefined }, busyConfirmed: true }, request)).toMatchObject({ ok: true, busyConfirmed: true })
  for (const patch of [{ harness: true }, { fromArgs: true }, { unverified: true }, { tty: null }])
    expect(externalSessionAnswer({ ...owned, owner: { ...owner, harness: undefined, ...patch }, busyConfirmed: true }, request).ok).toBe(false)
  for (const patch of [{ pid: 0 }, { pid: 2 ** 32 }, { tty: '/workspace' }, { record: '\u0000' },
    { harness: false }, { engine: 'codex' }]) expect(externalSessionAnswer({ ...owned, owner: { ...owner, ...patch } }, request).ok).toBe(false)
  expect(externalSessionAnswer({ ...owned, owner: { ...owner, harness: undefined }, generation: null }, request).ok).toBe(false)
})

it('accepts only the declarative Hermes profile launch option', () => {
  expect(externalSessionFact({ ...session, engine: 'hermes', launchArgs: ['-p', 'work'] })?.launchArgs).toEqual(['-p', 'work'])
  for (const launchArgs of [['--command', 'shell'], ['-p', '../escape'], ['-p', 'work', 'extra'], ['-p', 1]]) {
    expect(externalSessionFact({ ...session, engine: 'hermes', launchArgs })).toBeNull()
  }
})
