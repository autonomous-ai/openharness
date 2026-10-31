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

  // Review 1 of #2460: one picture the cloud would not sign (a missing permission, a brief error) failed every member's read.
  it('leaves out a picture it cannot sign, keeps the rest, shares signatures in flight and tries again on the next read', async () => {
    const calls: string[] = []
    let failing = true
    const bucket = { signedUrl: async (key: string) => {
      calls.push(key)
      await new Promise(resolve => setTimeout(resolve, 5))
      if (failing && key.endsWith('/bad/avatar')) throw Object.assign(new Error(`signBlob denied for ${key}`), { code: 403 })
      return `https://bucket.example.test/${key}?signed`
    } }
    const links = new AvatarLinks(bucket as never, 'avatars')
    const state = { people: [{ id: 'p1', avatar: { kind: 'upload', key: 'avatars/tab/good/avatar' } },
      { id: 'p2', avatar: { kind: 'upload', key: 'avatars/tab/bad/avatar' } }] } as never
    const [first, second] = await Promise.all([links.forReader(state, [], now), links.forReader(state, [], now)])
    expect(first).toEqual({ 'person:p1': 'https://bucket.example.test/avatars/tab/good/avatar?signed' })
    expect(second).toEqual(first)
    expect(calls.sort()).toEqual(['avatars/tab/bad/avatar', 'avatars/tab/good/avatar'])
    failing = false
    expect(Object.keys(await links.forReader(state, [], now)).sort()).toEqual(['person:p1', 'person:p2'])
    expect(calls).toHaveLength(3)
  })
})
