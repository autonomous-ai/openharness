import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { followAccountNamesOnce, PAGE } from './accountNamesJob.js'

/** Swarms by id, as the job pages them: those after `id.gt`, in id order, at most `take`. */
function swarms(ids: string[]) {
  const asked: Array<string | undefined> = []
  const db = { superTab: { findMany: async ({ where, take }: { where: { id?: { gt: string } }; take: number }) => {
    asked.push(where.id?.gt)
    return ids.filter(id => !where.id || id > where.id.gt).slice(0, take).map(id => ({ id }))
  } } } as unknown as PrismaClient
  return { db, asked }
}

describe('the one-time pass that makes every Swarm follow its people\'s account names', () => {
  it('visits every Swarm once, a page at a time, and counts what changed, what was gone and what failed', async () => {
    const ids = Array.from({ length: PAGE + 3 }, (_, i) => `tab-${String(i).padStart(4, '0')}`)
    const { db, asked } = swarms(ids)
    const seen: string[] = []
    const store = { followAccountNames: async (id: string) => {
      seen.push(id)
      if (id === ids[1]) throw new Error('busy')
      if (id === ids[2]) return 'gone' as const
      return id === ids[0] ? 2 : 0
    } }
    expect(await followAccountNamesOnce(db, store)).toEqual({ swarms: PAGE + 2, changed: 2, failed: 1 })
    expect(seen).toEqual(ids)
    expect(asked).toEqual([undefined, ids[PAGE - 1]])
  })

  it('stops at once when asked to', async () => {
    const control = new AbortController()
    const { db } = swarms(['a', 'b', 'c'])
    const seen: string[] = []
    const store = { followAccountNames: async (id: string) => { seen.push(id); control.abort(); return 0 } }
    await followAccountNamesOnce(db, store, { signal: control.signal })
    expect(seen).toEqual(['a'])
  })
})
