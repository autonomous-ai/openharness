import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: m.warn, info: vi.fn(), error: m.warn } }))
import { dropMuted } from './muted.js'
import type { PhoneNotice } from './sender.js'

const notice = (key: string, setting?: string): PhoneNotice =>
  ({ personId: 'p', key, title: 't', subtitle: '', body: '', link: 'swarm:t/c/message/m', slot: key, ...setting ? { setting } : {} })
/** A database whose muted settings are `muted`, or whose read fails with it. */
const settings = (muted: string[] | Error) => {
  const aggregateRaw = vi.fn(async () => {
    if (muted instanceof Error) throw muted
    return muted.map(_id => ({ _id }))
  })
  return { db: { superTabChatSetting: { aggregateRaw } } as never, aggregateRaw }
}

describe('dropMuted: a tag in a chat its person muted rings no phone (anh Dee, 2026-11-09)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('drops the tags whose chat their person muted, in one read of the settings by id, and keeps every other notice', async () => {
    const { db, aggregateRaw } = settings(['setting-muted'])
    const notices = [notice('mention:a', 'setting-muted'), notice('mention:b', 'setting-all'), notice('reply:r'), notice('decision:d')]
    expect((await dropMuted(db, notices)).map(n => n.key)).toEqual(['mention:b', 'reply:r', 'decision:d'])
    expect(aggregateRaw).toHaveBeenCalledTimes(1)
    expect(aggregateRaw).toHaveBeenCalledWith({ pipeline: [{ $match: { _id: { $in: ['setting-muted', 'setting-all'] }, notify: 'muted' } },
      { $project: { _id: 1 } }] })
  })

  it('reads nothing when no tag is sent', async () => {
    const { db, aggregateRaw } = settings([])
    const notices = [notice('reply:r'), notice('decision:d')]
    expect(await dropMuted(db, notices)).toBe(notices)
    expect(aggregateRaw).not.toHaveBeenCalled()
  })

  it('sends every tag when the settings cannot be read, and says so: a tag is never lost to it', async () => {
    const { db } = settings(new Error('primary stepped down'))
    const notices = [notice('mention:a', 'setting-muted')]
    expect(await dropMuted(db, notices)).toBe(notices)
    expect(m.warn).toHaveBeenCalledWith('phone push mutes not read', { tags: 1, error: 'primary stepped down' })
  })
})
