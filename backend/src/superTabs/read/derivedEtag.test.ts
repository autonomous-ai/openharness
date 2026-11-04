import { describe, expect, it } from 'vitest'
import type { Derived } from './contract.js'
import { derivedEtag, MARK_FIELDS } from './derivedEtag.js'

const summary = (): Derived => ({
  agents: { a1: { downSince: null, limitedUntil: null, workDecision: null, roleId: null, roleName: 'Engineer' } },
  machines: { m1: { availableSlots: 2, teamWork: { allowed: true } } },
  mentionsWaiting: 1, mentionsDigest: 'd1', avatars: { 'person:p1': 'https://example.test/a?sig=1' },
})

// Task #2906: the etag a client echoes so an unchanged poll leaves the summary out.
describe('derivedEtag', () => {
  it('is short and URL-safe', () => {
    expect(derivedEtag(summary())).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('is the same for the same summary built in another key order', () => {
    const s = summary()
    const reordered: Derived = { avatars: s.avatars, mentionsDigest: s.mentionsDigest, mentionsWaiting: s.mentionsWaiting,
      machines: { m1: { teamWork: { allowed: true }, availableSlots: 2 } }, agents: s.agents }
    expect(derivedEtag(reordered)).toBe(derivedEtag(s))
  })

  it('leaves out the reader\'s marks, which a change read sends only as they move', () => {
    expect(MARK_FIELDS).toEqual(['readMarks', 'unreadMarks', 'threadMarks', 'chatSettings'])
    const marked: Derived = { ...summary(), readMarks: { g1: 4 }, unreadMarks: { g1: 3 }, threadMarks: { g1: { r1: 2 } }, chatSettings: { g1: 'all' } }
    expect(derivedEtag(marked)).toBe(derivedEtag(summary()))
  })

  it('moves with any other value', () => {
    const base = derivedEtag(summary())
    const changes: Array<(d: Derived) => void> = [
      d => { d.agents.a1!.downSince = '2026-11-04T00:00:00.000Z' },
      d => { d.agents.a1!.roleName = 'Reviewer' },
      d => { d.machines.m1!.availableSlots = 1 },
      d => { d.machines.m1!.teamWork = { allowed: false, reason: 'full' } },
      d => { d.avatars = { 'person:p1': 'https://example.test/a?sig=2' } },
      d => { d.mentionsWaiting = 2 },
      d => { d.decisionsDigest = 'x' },
      d => { delete d.avatars },
    ]
    for (const change of changes) {
      const d = summary()
      change(d)
      expect(derivedEtag(d), change.toString()).not.toBe(base)
    }
  })
})
