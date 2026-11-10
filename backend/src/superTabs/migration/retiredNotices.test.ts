import { describe, expect, it } from 'vitest'
import { NOTICE_READERS, SuperTabError } from '../model.js'
import { CURSOR_ID, PAGE, removeRetiredNotices, RETIRED_NOTICE_KINDS, WALKED } from './retiredNotices.js'

type Doc = { _id: string; tabId: string; conversationId: string; text: string; source?: { kind: string; detail: string } }

/** The messages and the walk's cursor, answering the find the job sends in _id order, as Mongo would. */
class Database {
  readonly messages: Doc[] = []
  readonly commands: Array<Record<string, unknown>> = []
  cursor: string | undefined
  async $runCommandRaw(command: Record<string, unknown>): Promise<unknown> {
    this.commands.push(command)
    const after = ((command.filter as { _id: { $gt: string } })._id.$gt)
    const rows = [...this.messages].sort((a, b) => a._id < b._id ? -1 : 1).filter(doc => doc._id > after)
    return { cursor: { firstBatch: rows.slice(0, command.limit as number).map(({ _id, tabId, conversationId, source }) => ({ _id, tabId, conversationId,
      ...(source ? { source: { kind: source.kind } } : {}) })) } }
  }
  readonly superTabSweepCursor = {
    findUnique: async ({ where }: { where: { id: string } }) => where.id === CURSOR_ID && this.cursor !== undefined ? { after: this.cursor } : null,
    upsert: async ({ where, create }: { where: { id: string }; create: { after: string } }) => { if (where.id === CURSOR_ID) this.cursor = create.after },
  }
  message(id: string, tabId: string, kind?: string): this {
    this.messages.push({ _id: id, tabId, conversationId: `chat-${tabId}`, text: `text of ${id}`, ...(kind ? { source: { kind, detail: 'private words' } } : {}) })
    return this
  }
}
/** The store's delete: removes the row, or answers 'gone' for one already gone; [refuse] answers with an error. */
class Store {
  readonly calls: Array<[string, string, string]> = []
  refuse = new Map<string, Error>()
  constructor(private readonly db: Database) {}
  async removeRetiredNotice(tabId: string, conversationId: string, messageId: string): Promise<'removed' | 'gone'> {
    this.calls.push([tabId, conversationId, messageId])
    const refused = this.refuse.get(messageId)
    if (refused) throw refused
    const at = this.db.messages.findIndex(m => m._id === messageId)
    if (at < 0) return 'gone'
    this.db.messages.splice(at, 1)
    return 'removed'
  }
}
const asDb = (database: Database) => database as unknown as Parameters<typeof removeRetiredNotices>[0]
const ids = (db: Database) => db.messages.map(m => m._id).sort()

describe('removing stored notices of retired kinds', () => {
  it('lists no kind that is still written', () => {
    expect(RETIRED_NOTICE_KINDS.filter(kind => Object.hasOwn(NOTICE_READERS, kind))).toEqual([])
    expect(RETIRED_NOTICE_KINDS).toEqual(expect.arrayContaining(['terminal-alert', 'terminal-input']))
  })

  it('removes each retired notice through the store, by its Swarm and chat, and keeps every v4 message', async () => {
    const db = new Database().message('m1', 't1', 'terminal-alert').message('m2', 't1').message('m3', 't2', 'terminal-input')
      .message('m4', 't2', 'system').message('m5', 't1', 'work-stalled').message('m6', 't1', 'github').message('m7', 't2', 'a-kind-from-later')
    const store = new Store(db)
    expect(await removeRetiredNotices(asDb(db), store)).toEqual({ examined: 7, removed: 3, gone: 0, failed: 0, codes: {}, done: true })
    expect(store.calls).toEqual([['t1', 'chat-t1', 'm1'], ['t2', 'chat-t2', 'm3'], ['t1', 'chat-t1', 'm5']])
    expect(ids(db)).toEqual(['m2', 'm4', 'm6', 'm7'])
    expect(db.cursor).toBe(WALKED)
  })

  it('reads by the _id index, PAGE at a time with a pause between pages, and carries on from its stored cursor', async () => {
    const db = new Database()
    for (let i = 0; i < 2 * PAGE + 10; i++) db.message(`m${String(i).padStart(5, '0')}`, 't', i % 2 ? 'route' : undefined)
    let paused = 0
    const first = await removeRetiredNotices(asDb(db), new Store(db), { pages: 1, pause: async () => { paused++ } })
    expect(first).toMatchObject({ examined: PAGE, removed: PAGE / 2, done: false })
    expect(paused).toBe(0)
    expect(db.cursor).toBe(`m${String(PAGE - 1).padStart(5, '0')}`)
    // A worker that starts again goes on from there, not from the first message.
    const rest = await removeRetiredNotices(asDb(db), new Store(db), { pause: async () => { paused++ } })
    expect(rest).toMatchObject({ examined: PAGE + 10, removed: PAGE / 2 + 5, done: true })
    expect(paused).toBe(1)
    for (const find of db.commands) expect(find).toMatchObject({ find: 'SuperTabMessage', hint: '_id_', sort: { _id: 1 }, limit: PAGE })
    expect(db.messages.filter(doc => doc.source)).toEqual([])
    expect(db.messages).toHaveLength(PAGE + 5)
  })

  it('does not walk again once it has walked to the end', async () => {
    const db = new Database().message('m1', 't', 'idle').message('m2', 't')
    await removeRetiredNotices(asDb(db), new Store(db))
    const reads = db.commands.length
    db.message('m0', 't', 'idle')
    expect(await removeRetiredNotices(asDb(db), new Store(db))).toEqual({ examined: 0, removed: 0, gone: 0, failed: 0, codes: {}, done: true })
    expect(db.commands).toHaveLength(reads)
  })

  it('counts a notice already gone, and one the store refuses by its code, and goes on', async () => {
    const db = new Database().message('m1', 't', 'ship').message('m2', 't', 'ship').message('m3', 't', 'idle')
    const store = new Store(db)
    store.refuse.set('m1', new SuperTabError('SWARM_BUSY', 'busy', 503))
    const removing = store.removeRetiredNotice.bind(store)
    store.removeRetiredNotice = async (tabId, conversationId, messageId) => messageId === 'm2' ? 'gone' : removing(tabId, conversationId, messageId)
    expect(await removeRetiredNotices(asDb(db), store)).toEqual({ examined: 3, removed: 1, gone: 1, failed: 1, codes: { SWARM_BUSY: 1 }, done: true })
    expect(ids(db)).toEqual(['m1', 'm2'])
  })

  it('reports counts only: no id, Swarm, kind or text', async () => {
    const db = new Database().message('m-secret', 'tab-secret', 'terminal-input')
    const pass = await removeRetiredNotices(asDb(db), new Store(db))
    expect(JSON.stringify(pass)).not.toMatch(/secret|terminal|text|private/)
  })

  it('stops at once when aborted', async () => {
    const db = new Database().message('m1', 't', 'idle')
    const control = new AbortController()
    control.abort()
    expect(await removeRetiredNotices(asDb(db), new Store(db), { signal: control.signal })).toMatchObject({ examined: 0, done: false })
    expect(ids(db)).toEqual(['m1'])
    expect(db.cursor).toBeUndefined()
  })
})
