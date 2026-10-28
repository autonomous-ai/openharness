import { describe, expect, it } from 'vitest'
import { MemoryAvatarStore } from './attachments.js'
import { AvatarLinks } from './avatarLinks.js'

describe('avatar links', () => {
  const now = Date.UTC(2026, 9, 28, 6, 0)

  // In the shared attachments bucket a link opens whatever key it names: only the avatar folder is ever signed.
  it('signs only pictures in the avatar folder', async () => {
    const bucket = new MemoryAvatarStore('https://bucket.example.test')
    const links = await new AvatarLinks(bucket, 'avatars').forReader(
      { people: [{ id: 'p1', avatar: { kind: 'upload', key: 'avatars/tab/0123/avatar' } },
        { id: 'p2', avatar: { kind: 'upload', key: 'super-tabs/tab/4567/contract.pdf' } },
        { id: 'p3', avatar: { kind: 'upload', key: 'avatarsx/tab/89ab/avatar' } }] } as never,
      [{ id: 'a1', avatar: { kind: 'upload', key: 'super-tabs/tab/cdef/notes.txt' } }], now)
    expect(Object.keys(links)).toEqual(['person:p1'])
    expect(links['person:p1']).toMatch(/^https:\/\/bucket\.example\.test\/avatars\/tab\/0123\/avatar\?/)
  })
})
