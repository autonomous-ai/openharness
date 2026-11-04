import { describe, expect, it } from 'vitest'
import { foldFacet, type ThreadFacet } from './pageReads.js'

// A reply's rows folded into its thread's stored summary must give what threadFacet's $group gives every row (task #2974).
const author = (id: string) => ({ kind: 'person' as const, id, name: id, membershipGeneration: 'gen' })
const key = (id: string, extra: object = {}) => ({ thread: 't', root: false, to: false, author: { kind: 'person', id }, session: false, ...extra })
const place = (s: number, id: string, slot?: number) => ({ s, i: `m${s}`, at: { $date: new Date(s * 1000).toISOString() }, author: author(id),
  ...slot === undefined ? {} : { slot } })
type Part = ThreadFacet['parts'][number]
const part = (id: string, count: number, oldest: number, newest: number, extra: object = {}): Part =>
  ({ _id: key(id, extra), count, oldest: place(oldest, id), newest: place(newest, id), root: null })
const tag = (by: string, person: string, s: number, slot = 0) => ({ _id: { ...key(by), person }, first: place(s, by, slot) })
const stored: ThreadFacet = {
  parts: [{ _id: key('ann', { root: true }), count: 1,
    oldest: place(1, 'ann'), newest: place(1, 'ann'), root: { source: null, recipientIds: [] } }, part('bob', 3, 2, 9)],
  mentions: [tag('bob', 'cy', 4)],
}

describe('foldFacet', () => {
  it('adds a reply of a part already in the thread: its count grows, its newest row moves, its oldest stays', () => {
    expect(foldFacet(stored, { parts: [part('bob', 1, 12, 12)], mentions: [] })).toEqual({
      parts: [stored.parts[0], { ...part('bob', 4, 2, 12) }], mentions: stored.mentions })
  })

  it('adds a part new to the thread as its rows sum it up', () => {
    const route = part('bob', 2, 12, 13, { kind: 'route' })
    expect(foldFacet(stored, { parts: [route], mentions: [] }).parts).toEqual([...stored.parts, route])
  })

  it('keeps a person\'s first tag in a part, and adds one first tagged now', () => {
    const folded = foldFacet(stored, { parts: [part('bob', 1, 12, 12)], mentions: [tag('bob', 'cy', 12), tag('bob', 'dee', 12, 1)] })
    expect(folded.mentions).toEqual([tag('bob', 'cy', 4), tag('bob', 'dee', 12, 1)])
  })

  it('orders places as the database does, by sequence, then id, then a tag\'s slot', () => {
    const same = { parts: [part('bob', 1, 9, 9)], mentions: [tag('bob', 'cy', 4, 0)] }
    const earlier = { ...tag('bob', 'cy', 4, 0), first: { ...place(4, 'bob', 0), i: 'm3' } }
    expect(foldFacet(stored, same).parts[1]).toEqual(part('bob', 4, 2, 9))
    expect(foldFacet(stored, { parts: [], mentions: [earlier] }).mentions).toEqual([earlier])
    expect(foldFacet({ parts: [], mentions: [tag('bob', 'cy', 4, 2)] }, { parts: [], mentions: [tag('bob', 'cy', 4, 1)] }).mentions)
      .toEqual([tag('bob', 'cy', 4, 1)])
  })

  it('matches a part by its key\'s values, whatever order the stored key\'s fields came back in', () => {
    const { thread, root, ...rest } = key('bob')
    const reordered: ThreadFacet = { parts: [{ ...part('bob', 3, 2, 9), _id: { ...rest, root, thread } as Part['_id'] }], mentions: [] }
    expect(foldFacet(reordered, { parts: [part('bob', 1, 12, 12)], mentions: [] }).parts).toHaveLength(1)
    expect(foldFacet(reordered, { parts: [part('bob', 1, 12, 12)], mentions: [] }).parts[0]!.count).toBe(4)
  })

  it('leaves the stored summary as it was', () => {
    const before = structuredClone(stored)
    foldFacet(stored, { parts: [part('bob', 1, 12, 12)], mentions: [tag('bob', 'cy', 1)] })
    expect(stored).toEqual(before)
  })
})
