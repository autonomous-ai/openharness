import { describe, expect, it, vi } from 'vitest'
import { PAGE, removeSwarmFiles, serviceAccountFrom, swarmFolders, type FileStore } from './swarmFiles.js'

/** A bucket as Cloud Storage answers a listing: names in order, from the start, after what was removed. */
class Bucket implements FileStore {
  readonly names = new Set<string>()
  readonly lists: Array<[string, number]> = []
  constructor(...names: string[]) { for (const name of names) this.names.add(name) }
  async list(prefix: string, max: number) {
    this.lists.push([prefix, max])
    return [...this.names].filter(name => name.startsWith(prefix)).sort().slice(0, max)
  }
  async delete(name: string) { this.names.delete(name) }
}
const settings = (over: Partial<Parameters<typeof swarmFolders>[0]> = {}) => ({ SUPER_TAB_ATTACHMENTS_BUCKET: 'files', SUPER_TAB_ATTACHMENTS_CREDENTIALS: '',
  SUPER_TAB_ATTACHMENTS_PREFIX: 'super-tabs', SUPER_TAB_AVATARS_BUCKET: '', ...over })

describe('the folders the Swarm wrote to', () => {
  it('are the chat folder and the avatars\' folder of the attachments bucket, and the avatars\' own bucket where there is one', () => {
    const storeFor = vi.fn((bucket: string) => new Bucket(bucket))
    expect(swarmFolders(settings({ SUPER_TAB_ATTACHMENTS_PREFIX: '/super-tabs/' }), storeFor).map(f => [f.bucket, f.prefix]))
      .toEqual([['files', 'super-tabs/'], ['files', 'avatars/']])
    expect(swarmFolders(settings({ SUPER_TAB_AVATARS_BUCKET: 'faces' }), storeFor).map(f => [f.bucket, f.prefix]))
      .toEqual([['files', 'super-tabs/'], ['files', 'avatars/'], ['faces', 'super-tabs/']])
    // The same folder twice is one.
    expect(swarmFolders(settings({ SUPER_TAB_AVATARS_BUCKET: 'files' }), storeFor)).toHaveLength(2)
  })

  it('are none where no bucket is set, and refused where the chat folder would be the whole bucket', () => {
    expect(swarmFolders(settings({ SUPER_TAB_ATTACHMENTS_BUCKET: '' }), () => new Bucket())).toEqual([])
    expect(() => swarmFolders(settings({ SUPER_TAB_ATTACHMENTS_PREFIX: '/' }), () => new Bucket())).toThrow(expect.objectContaining({ code: 'EMPTY_PREFIX' }))
  })
})

describe('removing the Swarm\'s stored files', () => {
  it('removes every object in each folder, a page at a time, and nothing outside them', async () => {
    const chat = Array.from({ length: PAGE + 5 }, (_, i) => `super-tabs/tab/${String(i).padStart(4, '0')}/notes.txt`)
    const bucket = new Bucket(...chat, 'super-tabs/tab/x/a.png.thumb.webp', 'avatars/tab/a.png', 'harness/cli/1.0.0/cli.js', 'super-tabs-not/a', 'avatarsx/b')
    let paused = 0
    const pass = await removeSwarmFiles([{ bucket: 'files', prefix: 'super-tabs/', store: bucket }, { bucket: 'files', prefix: 'avatars/', store: bucket }],
      { pause: async () => { paused++ } })
    expect(pass).toEqual({ objects: PAGE + 7, failed: 0, done: true })
    expect([...bucket.names].sort()).toEqual(['avatarsx/b', 'harness/cli/1.0.0/cli.js', 'super-tabs-not/a'])
    expect(bucket.lists.every(([, max]) => max === PAGE)).toBe(true)
    expect(paused).toBeGreaterThan(0)
  })

  it('never removes a name the store gives from outside the folder', async () => {
    const bucket = new Bucket('super-tabs/a')
    const store: FileStore = { list: async () => ['super-tabs/a', 'harness/cli/metadata.json'], delete: vi.fn(async (name: string) => { await bucket.delete(name) }) }
    store.list = vi.fn().mockResolvedValueOnce(['super-tabs/a', 'harness/cli/metadata.json']).mockResolvedValue([])
    await removeSwarmFiles([{ bucket: 'files', prefix: 'super-tabs/', store }])
    expect(store.delete).toHaveBeenCalledTimes(1)
    expect(store.delete).toHaveBeenCalledWith('super-tabs/a')
  })

  it('stops a pass at an object it could not remove, says so in counts only, and the next pass finishes', async () => {
    const bucket = new Bucket('super-tabs/a', 'super-tabs/b')
    const remove = vi.spyOn(bucket, 'delete').mockRejectedValueOnce(Object.assign(new Error('storage down'), { code: 503 }))
    const folders = [{ bucket: 'files', prefix: 'super-tabs/', store: bucket }]
    expect(await removeSwarmFiles(folders)).toEqual({ objects: 1, failed: 1, done: false })
    remove.mockRestore()
    expect(await removeSwarmFiles(folders)).toEqual({ objects: 1, failed: 0, done: true })
    expect(bucket.names.size).toBe(0)
  })

  it('fails the pass when a listing does not answer in time, and leaves a pass past its pages to the next', async () => {
    const bucket = new Bucket(...Array.from({ length: PAGE * 2 }, (_, i) => `super-tabs/${String(i).padStart(4, '0')}`))
    const list = vi.spyOn(bucket, 'list').mockReturnValueOnce(new Promise(() => {}))
    const folders = [{ bucket: 'files', prefix: 'super-tabs/', store: bucket }]
    await expect(removeSwarmFiles(folders, { callMs: 5 })).rejects.toMatchObject({ code: 'BUCKET_TIMEOUT' })
    list.mockRestore()
    expect(await removeSwarmFiles(folders, { pages: 1 })).toEqual({ objects: PAGE, failed: 0, done: false })
    expect(await removeSwarmFiles(folders)).toEqual({ objects: PAGE, failed: 0, done: true })
  })

  it('stops at once when aborted, removing nothing', async () => {
    const bucket = new Bucket('super-tabs/a')
    const control = new AbortController()
    control.abort()
    expect(await removeSwarmFiles([{ bucket: 'files', prefix: 'super-tabs/', store: bucket }], { signal: control.signal })).toEqual({ objects: 0, failed: 0, done: false })
    expect(bucket.names.size).toBe(1)
  })
})

describe('the bucket\'s credentials', () => {
  it('are none when empty, and a bad value throws without repeating any of it', () => {
    expect(serviceAccountFrom('  ')).toBeNull()
    const key = Buffer.from(JSON.stringify({ client_email: 'a@b.iam', private_key: '-----BEGIN PRIVATE KEY-----x', project_id: 'p' })).toString('base64')
    expect(serviceAccountFrom(key)).toEqual({ projectId: 'p', credentials: { client_email: 'a@b.iam', private_key: '-----BEGIN PRIVATE KEY-----x' } })
    for (const bad of ['not base64!', Buffer.from('{').toString('base64'), Buffer.from('{"client_email":"x"}').toString('base64')]) {
      expect(() => serviceAccountFrom(bad)).toThrow(expect.objectContaining({ code: 'BAD_CREDENTIALS' }))
      try { serviceAccountFrom(bad) } catch (error) { expect((error as Error).message).not.toContain(bad) }
    }
  })
})
