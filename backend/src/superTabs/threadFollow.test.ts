import { describe, expect, it } from 'vitest'
import { Prisma, type PrismaClient } from '@prisma/client'
import { writeThreadFollow } from './readMarks.js'
import { SuperTabError } from './model.js'

const duplicate = () => new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' })

/** A thread mark collection in memory, its calls logged; `race` creates the row from another device just before this one's
 *  first create. The cap's reads answer one row. */
function marks(options: { race?: boolean; failCreate?: Error } = {}) {
  const rows = new Map<string, Record<string, unknown>>()
  const calls: string[] = []
  const db = {
    superTabThreadMark: {
      async updateMany({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        calls.push('update')
        const row = rows.get(where.id)
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
      async create({ data }: { data: Record<string, unknown> & { id: string } }) {
        calls.push('create')
        if (options.failCreate) throw options.failCreate
        if (options.race && !rows.size) {
          rows.set(data.id, { ...data, sequence: 7, follow: null })
          throw duplicate()
        }
        rows.set(data.id, { ...data })
      },
    },
    async $runCommandRaw() { calls.push('cap-delete'); return {} },
  }
  // The cap counts by readBy (aggregateRaw): one mark, under the cap.
  Object.assign(db.superTabThreadMark, { aggregateRaw: async () => { calls.push('cap-count'); return [{ n: 1 }] } })
  return { db: db as unknown as PrismaClient, rows, calls }
}
const write = (follow: boolean | null) => ({ tabId: 'tab', personId: 'p', conversationId: 'c', threadId: 'root', follow, now: 1_000 })

describe('writeThreadFollow', () => {
  it('creates the row with no mark (0) on a first Follow, then checks the cap', async () => {
    const { db, rows, calls } = marks()
    expect(await writeThreadFollow(db, write(true))).toBe(true)
    expect([...rows.values()]).toEqual([expect.objectContaining({ sequence: 0, follow: true, threadId: 'root', updatedAt: new Date(1_000) })])
    expect(calls).toEqual(['update', 'create', 'cap-count'])
  })

  it('sets or clears the choice on a row that is there, keeping its mark', async () => {
    const { db, rows } = marks()
    await writeThreadFollow(db, write(true))
    ;[...rows.values()][0]!.sequence = 12
    expect(await writeThreadFollow(db, write(null))).toBeNull()
    expect([...rows.values()]).toEqual([expect.objectContaining({ sequence: 12, follow: null })])
  })

  it('goes on to update the row another device created first, keeping that mark', async () => {
    const { db, rows, calls } = marks({ race: true })
    expect(await writeThreadFollow(db, write(false))).toBe(false)
    expect([...rows.values()]).toEqual([expect.objectContaining({ sequence: 7, follow: false })])
    expect(calls).toEqual(['update', 'create', 'update'])
  })

  it('says a write it could not settle, and passes on any other failure', async () => {
    const busy = marks({ failCreate: duplicate() })
    await expect(writeThreadFollow(busy.db, write(true))).rejects.toBeInstanceOf(SuperTabError)
    expect(busy.calls.filter(c => c === 'create')).toHaveLength(4)
    await expect(writeThreadFollow(marks({ failCreate: new Error('connection reset') }).db, write(true))).rejects.toThrow('connection reset')
  })
})
