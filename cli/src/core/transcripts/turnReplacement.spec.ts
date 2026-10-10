import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LiveState } from '../../engines/facets/live.js'
import { createSessionNormalizers } from './normalizers.js'
import { createTurnReplacements } from './turnReplacement.js'
import * as transcriptBoundary from '../../lib/transcriptBoundary.js'

const dirs: string[] = []
const setup = (file = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'replacement-control-')); dirs.push(dir)
  const transcriptPath = join(dir, 'session.jsonl'); writeFileSync(transcriptPath, '{}\n')
  const session = { agentId: 'agent', engine: 'claude', sessionId: 'session', transcriptPath: file ? transcriptPath : null } as RegisteredSession
  const normalizers = createSessionNormalizers(), replacements = createTurnReplacements(normalizers)
  return { session, normalizers, replacements }
}
const parser = (): LiveState => ({ engine: 'claude', turnOpen: true,
  snapshot: () => ({ identity: 'old-turn', turnOpen: true, continued: true }), closeTurn: vi.fn() })
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

it('retains exact ordered cancellation boundaries through retries without closing the replacement turn', () => {
  const { session, normalizers, replacements } = setup(), old = parser(), next = parser()
  normalizers.liveParsers.set(session.sessionId, old)
  const pending = replacements.stage(session), initial = pending.plan()
  expect(pending.handle.snapshot()).toEqual(old.snapshot())
  pending.handle.closeTurn('cancel')
  expect(pending.handle.turnOpen).toBe(false)
  expect(() => pending.commit(initial, next)).toThrow('control changed')
  expect(pending.plan().closes.map(close => close.offset)).toEqual([3])
  expect(replacements.stage(session)).toBe(pending)
  pending.handle.closeTurn('cancel')
  expect(pending.plan().closes).toHaveLength(1)
  appendFileSync(session.transcriptPath!, '{}\n')
  pending.handle.closeTurn('cancel')
  const plan = pending.plan()
  expect(plan.closes.map(close => close.offset)).toEqual([3, 6])
  expect(pending.commit(plan, next)).toBe(true)
  expect(normalizers.liveParsers.get(session.sessionId)).toBe(next)
  expect(next.closeTurn).not.toHaveBeenCalled()
  expect(pending.commit(plan, next)).toBe(false)
})
it.each(['hook', 'abandoned', 'stop'] as const)('retains uncorrelated %s even when a cold parser has no open turn', reason => {
  const { session, normalizers, replacements } = setup(), pending = replacements.stage(session)
  expect(pending.handle.snapshot()).toMatchObject({ turnOpen: false, continued: false })
  if (reason === 'stop') pending.stop(); else pending.handle.closeTurn(reason)
  expect(() => pending.commit(pending.plan())).toThrow('Stop could not be matched')
  pending.handle.closeTurn('cancel')
  expect(pending.commit(pending.plan())).toBe(true)
  expect(normalizers.liveParsers.size).toBe(0)
})
it.each(['replace', 'truncate', 'prefix', 'partial', 'missing', 'no-file'] as const)('holds %s evidence without advancing the recorded boundary', kind => {
  const { session, replacements } = setup(kind !== 'no-file'), pending = replacements.stage(session)
  if (kind === 'partial') writeFileSync(session.transcriptPath!, '{')
  pending.handle.closeTurn('cancel')
  if (kind === 'replace') { renameSync(session.transcriptPath!, session.transcriptPath! + '.old'); writeFileSync(session.transcriptPath!, '{}\n') }
  if (kind === 'truncate') writeFileSync(session.transcriptPath!, '')
  if (kind === 'prefix') writeFileSync(session.transcriptPath!, '[]\n')
  if (kind === 'missing') renameSync(session.transcriptPath!, session.transcriptPath! + '.old')
  expect(() => pending.plan()).toThrow()
  if (kind === 'truncate') { pending.handle.closeTurn('cancel'); expect(pending.plan().closes.map(close => close.offset)).toEqual([0]) }
})
it('bounds retained control work without throwing through eager cancellation', () => {
  const { session, replacements } = setup(), pending = replacements.stage(session)
  for (let i = 0; i <= 128; i++) { pending.handle.closeTurn('cancel'); appendFileSync(session.transcriptPath!, '{}\n') }
  expect(() => pending.plan()).toThrow('too many')
})
it('revokes forgotten, rebound and replaced interpretation without closing another parser', () => {
  const { session, normalizers, replacements } = setup()
  const first = replacements.stage(session), next = parser()
  normalizers.liveParsers.set(session.sessionId, next)
  expect(first.commit(first.plan(), next)).toBe(false)
  const second = replacements.stage(session)
  expect(second).toBe(first)
  const third = replacements.stage({ ...session, transcriptPath: null })
  expect(third).toBe(second)
  replacements.forget(session.sessionId)
  expect(third.commit(third.plan(), next)).toBe(false)
  expect(next.closeTurn).not.toHaveBeenCalled()
})

it('contains a non-Error filesystem failure while eagerly closing the turn', () => {
  const { session, replacements } = setup(), pending = replacements.stage(session)
  vi.spyOn(transcriptBoundary, 'recoveryBoundary').mockImplementationOnce(() => { throw 'file service unavailable' })
  expect(() => pending.handle.closeTurn('cancel')).not.toThrow()
  expect(pending.handle.turnOpen).toBe(false)
  expect(() => pending.plan()).toThrow('file service unavailable')
})
it('retains a completed control record when its installed parser is later absent', () => {
  const { session, normalizers, replacements } = setup(), pending = replacements.stage(session)
  pending.handle.closeTurn('cancel')
  expect(pending.commit(pending.plan())).toBe(true)
  expect(normalizers.liveParsers.has(session.sessionId)).toBe(false)
  expect(replacements.stage(session)).toBe(pending)
  expect(pending.handle.turnOpen).toBe(false)
  expect(pending.plan().closes).toHaveLength(1)
})
