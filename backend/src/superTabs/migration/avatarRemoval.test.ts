import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AVATAR_PURPOSE, MemoryAttachmentStore, SharedAvatarStore } from '../attachments.js'
import { PAGE, removeAvatars } from './avatarRemoval.js'

type Row = { _id: string; purpose: string | null }
/** The attachment records, answering the find and delete removeChunk sends. */
class Records {
  rows: Row[] = []
  readonly commands: Array<Record<string, unknown>> = []
  async $runCommandRaw(command: Record<string, unknown>): Promise<unknown> {
    this.commands.push(command)
    const purpose = (command.filter ?? (command.deletes as Array<{ q: Row }> | undefined)?.[0]?.q) as { purpose?: string }
    if ('find' in command) return { cursor: { firstBatch: this.rows.filter(r => r.purpose === purpose.purpose).slice(0, command.limit as number).map(({ _id }) => ({ _id })) } }
    const q = (command.deletes as Array<{ q: { _id: { $in: string[] }; purpose: string } }>)[0]!.q
    const before = this.rows.length
    this.rows = this.rows.filter(r => !(q._id.$in.includes(r._id) && r.purpose === q.purpose))
    return { n: before - this.rows.length, ok: 1 }
  }
}
const asDb = (records: Records) => records as unknown as Parameters<typeof removeAvatars>[0]
const put = (store: MemoryAttachmentStore, key: string) => store.put(key, { name: 'a.png', mime: 'image/png' }, Readable.from([Buffer.from('x')]), 10)

/** The attachments bucket as production has it: chat files under `super-tabs/`, avatars under `avatars/`. */
async function bucket(avatars: number) {
  const store = new MemoryAttachmentStore()
  const records = new Records()
  for (let i = 0; i < avatars; i++) {
    await put(store, `avatars/tab/${String(i).padStart(4, '0')}/a.png`)
    records.rows.push({ _id: `avatar-${i}`, purpose: AVATAR_PURPOSE })
  }
  await put(store, 'super-tabs/tab/file/notes.txt')
  await put(store, 'avatars-not/tab/file/b.png')
  records.rows.push({ _id: 'chat-file', purpose: null }, { _id: 'unsent', purpose: 'pending-upload' })
  return { store, records, folder: { store: new SharedAvatarStore(store), prefix: 'avatars' } }
}

describe('removing the avatars still stored', () => {
  it('removes every avatar object in their folder, then their records, and keeps every chat file and its record', async () => {
    const { store, records, folder } = await bucket(3)
    expect(await removeAvatars(asDb(records), folder)).toEqual({ objects: 3, failed: 0, records: 3, done: true })
    expect([...store.objects.keys()].sort()).toEqual(['avatars-not/tab/file/b.png', 'super-tabs/tab/file/notes.txt'])
    expect(records.rows.map(r => r._id)).toEqual(['chat-file', 'unsent'])
  })

  it('lists PAGE at a time and stops a pass after its pages; the next pass carries on and finishes', async () => {
    const { store, records, folder } = await bucket(PAGE + 5)
    const list = vi.spyOn(folder.store, 'list')
    let paused = 0
    expect(await removeAvatars(asDb(records), folder, { pages: 1, pause: async () => { paused++ } })).toEqual({ objects: PAGE, failed: 0, records: 0, done: false })
    expect(list.mock.calls).toEqual([['avatars/', PAGE]])
    expect(paused).toBe(1)
    expect(records.rows).toHaveLength(PAGE + 7)
    // The last, short page of objects, then a page of records.
    expect(await removeAvatars(asDb(records), folder, { pages: 1 })).toEqual({ objects: 5, failed: 0, records: PAGE, done: false })
    expect(await removeAvatars(asDb(records), folder, { pages: 1 })).toEqual({ objects: 0, failed: 0, records: 5, done: true })
    expect(store.objects.size).toBe(2)
    for (const find of records.commands.filter(c => 'find' in c)) expect(find).toMatchObject({ limit: PAGE, hint: 'SuperTabAttachment_purpose_createdAt_idx' })
  })

  it('finds nothing to do when it runs again', async () => {
    const { records, folder } = await bucket(2)
    await removeAvatars(asDb(records), folder)
    expect(await removeAvatars(asDb(records), folder)).toEqual({ objects: 0, failed: 0, records: 0, done: true })
  })

  it('keeps the records while an object could not be removed, and the next pass finishes', async () => {
    const { store, records, folder } = await bucket(2)
    const remove = vi.spyOn(store, 'delete').mockRejectedValueOnce(Object.assign(new Error('storage down'), { code: 503 }))
    expect(await removeAvatars(asDb(records), folder)).toEqual({ objects: 1, failed: 1, records: 0, done: false })
    expect(records.rows).toHaveLength(4)
    remove.mockRestore()
    expect(await removeAvatars(asDb(records), folder)).toEqual({ objects: 1, failed: 0, records: 2, done: true })
  })

  it('removes the records alone where no bucket is set', async () => {
    const { records } = await bucket(2)
    expect(await removeAvatars(asDb(records), null)).toEqual({ objects: 0, failed: 0, records: 2, done: true })
  })

  it('stops at once when aborted, removing nothing', async () => {
    const { store, records, folder } = await bucket(2)
    const control = new AbortController()
    control.abort()
    expect(await removeAvatars(asDb(records), folder, { signal: control.signal })).toMatchObject({ objects: 0, records: 0, done: false })
    expect(store.objects.size).toBe(4)
  })
})
