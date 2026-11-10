import { describe, expect, it } from 'vitest'
import { NOTICE_READERS } from '../model.js'
import { PAGE, removeRetiredNotices, RETIRED_NOTICE_KINDS } from './retiredNotices.js'

type Doc = Record<string, unknown> & { _id: string }
const matches = (doc: Doc, q: Record<string, unknown>): boolean => Object.entries(q).every(([key, want]) => {
  const have = key === 'source.kind' ? (doc.source as { kind?: unknown } | undefined)?.kind : doc[key]
  if (want && typeof want === 'object' && '$in' in want) return (want.$in as unknown[]).includes(have)
  return have === want
})

/** A database that answers the find and deletes the job sends, in _id order, as Mongo would. */
class Database {
  readonly collections = new Map<string, Doc[]>([['SuperTabMessage', []], ['SuperTabDelivery', []], ['SuperTabReceipt', []]])
  readonly commands: Array<Record<string, unknown>> = []
  failDelete = new Set<string>()
  async $runCommandRaw(command: Record<string, unknown>): Promise<unknown> {
    this.commands.push(command)
    if ('find' in command) {
      const after = ((command.filter as { _id: { $gt: string } })._id.$gt)
      const rows = [...this.collections.get(command.find as string)!].sort((a, b) => a._id < b._id ? -1 : 1).filter(doc => doc._id > after)
      return { cursor: { firstBatch: rows.slice(0, command.limit as number).map(({ _id, tabId, source }) => ({ _id, tabId,
        ...(source ? { source: { kind: (source as { kind?: unknown }).kind } } : {}) })) } }
    }
    if ('delete' in command) {
      const name = command.delete as string
      if (this.failDelete.has(name)) throw new Error('the database is busy')
      const q = (command.deletes as Array<{ q: Record<string, unknown> }>)[0]!.q
      const rows = this.collections.get(name)!
      const kept = rows.filter(doc => !matches(doc, q))
      this.collections.set(name, kept)
      return { n: rows.length - kept.length, ok: 1 }
    }
    throw new Error(`unexpected command ${Object.keys(command)[0]}`)
  }
  message(id: string, tabId: string, kind?: string): this {
    this.collections.get('SuperTabMessage')!.push({ _id: id, tabId, text: `text of ${id}`, ...(kind ? { source: { kind, detail: 'private words' } } : {}) })
    this.collections.get('SuperTabDelivery')!.push({ _id: `d-${id}`, tabId, messageId: id })
    this.collections.get('SuperTabReceipt')!.push({ _id: id, tabId })
    return this
  }
  ids(name: string) { return this.collections.get(name)!.map(doc => doc._id).sort() }
}
const asDb = (database: Database) => database as unknown as Parameters<typeof removeRetiredNotices>[0]

describe('removing stored notices of retired kinds', () => {
  it('lists no kind that is still written', () => {
    expect(RETIRED_NOTICE_KINDS.filter(kind => Object.hasOwn(NOTICE_READERS, kind))).toEqual([])
    expect(RETIRED_NOTICE_KINDS).toEqual(expect.arrayContaining(['terminal-alert', 'terminal-input']))
  })

  it('removes each retired notice with its deliveries and receipt, and keeps every v4 message with its own', async () => {
    const db = new Database().message('m1', 't1', 'terminal-alert').message('m2', 't1').message('m3', 't2', 'terminal-input')
      .message('m4', 't2', 'system').message('m5', 't1', 'work-stalled').message('m6', 't1', 'github').message('m7', 't2', 'a-kind-from-later')
    const pass = await removeRetiredNotices(asDb(db), { after: '' })
    expect(pass).toEqual({ examined: 7, removed: 3, deliveries: 3, receipts: 3, done: true })
    expect(db.ids('SuperTabMessage')).toEqual(['m2', 'm4', 'm6', 'm7'])
    expect(db.ids('SuperTabDelivery')).toEqual(['d-m2', 'd-m4', 'd-m6', 'd-m7'])
    expect(db.ids('SuperTabReceipt')).toEqual(['m2', 'm4', 'm6', 'm7'])
  })

  it('reads by the _id index, PAGE at a time, and stops a pass after its pages with the cursor where it left off', async () => {
    const db = new Database()
    for (let i = 0; i < 2 * PAGE + 10; i++) db.message(`m${String(i).padStart(5, '0')}`, 't', i % 2 ? 'route' : undefined)
    const cursor = { after: '' }
    let paused = 0
    const first = await removeRetiredNotices(asDb(db), cursor, { pages: 1, pause: async () => { paused++ } })
    expect(first).toMatchObject({ examined: PAGE, removed: PAGE / 2, done: false })
    expect(paused).toBe(1)
    for (const find of db.commands.filter(c => 'find' in c)) expect(find).toMatchObject({ hint: '_id_', sort: { _id: 1 }, limit: PAGE })
    const rest = await removeRetiredNotices(asDb(db), cursor)
    expect(rest).toMatchObject({ examined: PAGE + 10, removed: PAGE / 2 + 5, done: true })
    expect(db.collections.get('SuperTabMessage')!.filter(doc => doc.source)).toEqual([])
    expect(db.collections.get('SuperTabMessage')).toHaveLength(PAGE + 5)
  })

  it('finds nothing to remove when it walks again from the start', async () => {
    const db = new Database().message('m1', 't', 'idle').message('m2', 't')
    await removeRetiredNotices(asDb(db), { after: '' })
    const deletes = db.commands.filter(c => 'delete' in c).length
    expect(await removeRetiredNotices(asDb(db), { after: '' })).toEqual({ examined: 1, removed: 0, deliveries: 0, receipts: 0, done: true })
    expect(db.commands.filter(c => 'delete' in c)).toHaveLength(deletes)
  })

  it('keeps the message when its deliveries could not go, so the next walk finds it again and finishes it', async () => {
    const db = new Database().message('m1', 't', 'ship')
    db.failDelete.add('SuperTabDelivery')
    await expect(removeRetiredNotices(asDb(db), { after: '' })).rejects.toThrow('busy')
    expect(db.ids('SuperTabMessage')).toEqual(['m1'])
    db.failDelete.clear()
    expect(await removeRetiredNotices(asDb(db), { after: '' })).toMatchObject({ removed: 1, deliveries: 1, receipts: 1 })
    expect(db.ids('SuperTabMessage')).toEqual([])
  })

  it('reports counts only: no id, Swarm, kind or text', async () => {
    const db = new Database().message('m-secret', 'tab-secret', 'terminal-input')
    const pass = await removeRetiredNotices(asDb(db), { after: '' })
    expect(JSON.stringify(pass)).not.toMatch(/secret|terminal|text|private/)
  })

  it('stops at once when aborted', async () => {
    const db = new Database().message('m1', 't', 'idle')
    const control = new AbortController()
    control.abort()
    expect(await removeRetiredNotices(asDb(db), { after: '' }, { signal: control.signal })).toMatchObject({ examined: 0, done: false })
    expect(db.ids('SuperTabMessage')).toEqual(['m1'])
  })
})
