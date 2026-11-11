import { describe, expect, it } from 'vitest'
import { PERSONAL_SWARM_OPERATION } from '../deletion.js'
import { SuperTabError, stableId } from '../model.js'
import { ATTEMPTS, CURSOR_ID, PAGE, removePersonalProjects, WALKED } from './personalProjectJob.js'

type Row = { _id: string; ownerId: string; autonomousEnv: string; format: number; deletedAt: Date | null }

/** The Swarm rows and the walk's cursor, answering the find the job sends in _id order, as Mongo would. */
class Database {
  readonly rows: Row[] = []
  cursor: string | undefined
  async $runCommandRaw(command: Record<string, unknown>): Promise<unknown> {
    const after = (command.filter as { _id: { $gt: string } })._id.$gt
    return { cursor: { firstBatch: [...this.rows].sort((a, b) => a._id < b._id ? -1 : 1).filter(r => r._id > after).slice(0, command.limit as number) } }
  }
  readonly superTabSweepCursor = {
    findUnique: async ({ where }: { where: { id: string } }) => where.id === CURSOR_ID && this.cursor !== undefined ? { after: this.cursor } : null,
    upsert: async ({ where, create }: { where: { id: string }; create: { after: string } }) => { if (where.id === CURSOR_ID) this.cursor = create.after },
  }
  personal(owner: string, extra: Partial<Row> = {}): string {
    const id = stableId('super-tab', 'prod', owner, PERSONAL_SWARM_OPERATION)
    this.rows.push({ _id: id, ownerId: owner, autonomousEnv: 'prod', format: 2, deletedAt: null, ...extra })
    return id
  }
  team(id: string, owner: string): void { this.rows.push({ _id: id, ownerId: owner, autonomousEnv: 'prod', format: 2, deletedAt: null }) }
}
class Store {
  readonly calls: string[] = []
  readonly answers = new Map<string, 'removed' | 'kept' | 'gone' | Error>()
  async removePersonalProject({ id: tabId }: { id: string }): Promise<'removed' | 'kept' | 'gone'> {
    this.calls.push(tabId)
    const answer = this.answers.get(tabId) ?? 'removed'
    if (answer instanceof Error) throw answer
    return answer
  }
}
const asDb = (db: Database) => db as unknown as Parameters<typeof removePersonalProjects>[0]

describe('removing the "Personal" project from Personal Swarms', () => {
  it('hands each live Personal Swarm to the store, and no other Swarm, then is done for good', async () => {
    const db = new Database(), store = new Store()
    const a = db.personal('a'), b = db.personal('b'), gone = db.personal('d', { deletedAt: new Date() })
    db.personal('e', { format: 1 })
    db.team('team-1', 'a')
    store.answers.set(b, 'kept')
    expect(await removePersonalProjects(asDb(db), store)).toEqual({ examined: 5, removed: 1, kept: 1, gone: 0, failed: 0, codes: {}, done: true })
    expect(store.calls.sort()).toEqual([a, b].sort())
    expect(store.calls).not.toContain(gone)
    expect(db.cursor).toBe(WALKED)
    expect(await removePersonalProjects(asDb(db), store)).toMatchObject({ examined: 0, done: true })
    expect(store.calls).toHaveLength(2)
  })

  it('tries a Swarm that failed again on the next passes, and passes it after its last try', async () => {
    const db = new Database(), store = new Store(), attempts = new Map<string, number>()
    const ids = ['a', 'b', 'c'].map(owner => db.personal(owner)).sort()
    store.answers.set(ids[1]!, new SuperTabError('SWARM_BUSY', 'busy', 503))
    for (let pass = 1; pass < ATTEMPTS; pass++) {
      expect(await removePersonalProjects(asDb(db), store, { attempts })).toMatchObject({ failed: 1, codes: { SWARM_BUSY: 1 }, done: false })
      expect(db.cursor).toBe(ids[0])
    }
    expect(await removePersonalProjects(asDb(db), store, { attempts })).toMatchObject({ failed: 1, done: true })
    expect(store.calls).toEqual([ids[0], ids[1], ids[1], ids[1], ids[2]])
    expect(db.cursor).toBe(WALKED)
  })

  it('walks a page at a time and carries on from its cursor', async () => {
    const db = new Database(), store = new Store()
    for (let i = 0; i < PAGE + 3; i++) db.personal(`owner-${i}`)
    const first = await removePersonalProjects(asDb(db), store, { pages: 1 })
    expect(first).toMatchObject({ examined: PAGE, removed: PAGE, done: false })
    expect(await removePersonalProjects(asDb(db), store)).toMatchObject({ examined: 3, removed: 3, done: true })
    expect(new Set(store.calls).size).toBe(PAGE + 3)
  })
})
