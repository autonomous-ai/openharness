import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { externalUnavailable, type ExternalSessionObservation } from '../../lib/externalSessionWire.js'
import { adoptionDecision, createAdoption } from './adopt.js'

const cwd = mkdtempSync(join(tmpdir(), 'core-adopt-'))
afterAll(() => rmSync(cwd, { recursive: true, force: true }))
const request = { engine: 'claude' as const, sessionId: 'conversation' }
const fact = { ...request, cwd, title: '', origin: 'terminal' as const, mtime: 1, transcriptPath: join(cwd, 'conversation.jsonl') }
const owner = { pid: 7, engine: 'claude' as const, tty: '/dev/fixture-terminal', record: '/fixture/record' }
const answer = (over: Partial<ExternalSessionObservation> = {}): ExternalSessionObservation =>
  ({ ok: true, request, session: fact, owner: null, generation: null, busy: false, ...over })
const choose = (observation = answer(), takeOver: 'idle' | 'now' | 'wait' | null = null, held = (_: string) => false) =>
  adoptionDecision(request.sessionId, request.engine, takeOver, observation, held)

describe('core admission from search observations', () => {
  it('refuses existing reservations, archived/wrong/missing conversations and missing folders', () => {
    expect(choose(answer(), null, () => true)).toMatchObject({ error: 'SESSION_IN_HARNESS' })
    expect(choose(answer({ session: { ...fact, aliases: ['reserved'] } }), null, id => id === 'reserved')).toMatchObject({ error: 'SESSION_IN_HARNESS' })
    expect(choose(answer({ session: null }))).toMatchObject({ error: 'SESSION_NOT_FOUND' })
    expect(choose(answer({ session: { ...fact, engine: 'codex' } }))).toMatchObject({ error: 'INVALID_ENGINE' })
    expect(choose(answer({ session: { ...fact, archived: true } }))).toMatchObject({ error: 'SESSION_ARCHIVED' })
    expect(choose(answer({ session: { ...fact, cwd: join(cwd, 'gone') } }))).toMatchObject({ error: 'SESSION_FOLDER_GONE' })
    expect(adoptionDecision('conversation', 'claude', null, externalUnavailable(), () => false)).toMatchObject({ error: 'SEARCH_UNAVAILABLE' })
  })
  it('preserves metadata and profile arguments when no other process holds it', () => {
    expect(choose()).toEqual({ ok: true, cwd, title: '', owner: null, busy: false, launchArgs: [] })
    expect(choose(answer({ session: { ...fact, title: 'Named', launchArgs: [] } }))).toMatchObject({ title: 'Named', launchArgs: [] })
  })
  it.each([
    [{ ...owner, harness: true }, 'SESSION_IN_HARNESS'],
    [{ ...owner, fromArgs: true }, 'SESSION_OPEN_ELSEWHERE'],
    [{ ...owner, unverified: true }, 'SESSION_OPEN_ELSEWHERE'],
    [{ ...owner, tty: null }, 'SESSION_OPEN_ELSEWHERE'],
  ] as const)('never takes ownership class %j', (process, error) => {
    expect(choose(answer({ owner: process }), 'now')).toMatchObject({ error })
  })
  it('requires fresh idle consent unless takeover-now was explicitly chosen', () => {
    for (const takeOver of [null, 'idle'] as const) expect(choose(answer({ owner, busy: true }), takeOver)).toMatchObject({ error: 'SESSION_BUSY_IN_TERMINAL' })
    expect(choose(answer({ owner }), null)).toMatchObject({ error: 'SESSION_OPEN_IN_TERMINAL' })
    for (const takeOver of ['now', 'wait', 'idle'] as const) expect(choose(answer({ owner }), takeOver)).toMatchObject({ ok: true, owner })
    expect(choose(answer({ owner, busy: true }), 'wait')).toMatchObject({ ok: true, busy: true })
  })
  it('the facade always asks fresh and refuses an invalid engine or an unavailable/moved owner', async () => {
    let value = answer()
    const api = createAdoption({ inspect: async () => value, held: () => false })
    expect(await api.adoptableSession('conversation', 'terminal', null)).toMatchObject({ error: 'SEARCH_UNAVAILABLE' })
    expect(await api.adoptableSession('conversation', 'claude', null)).toMatchObject({ ok: true })
    expect(await api.heldBy('conversation', owner)).toBe('free')
    for (const change of [{ ...owner, pid: 8 }, { ...owner, tty: null }, { ...owner, fromArgs: true }, { ...owner, harness: true }, { ...owner, unverified: true }]) {
      value = answer({ owner: change }); expect(await api.heldBy('conversation', owner)).toBe('other')
    }
    value = answer({ owner }); expect(await api.heldBy('conversation', owner)).toBe('same')
    expect(await createAdoption({ inspect: async () => externalUnavailable(), held: () => false }).heldBy('conversation', owner)).toBe('other')
  })
})
