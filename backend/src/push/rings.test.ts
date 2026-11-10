import { describe, expect, it, vi } from 'vitest'
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
import { CHAT_RING_EVERY_MS, localRingMemory, quietRecent, redisRingMemory } from './rings.js'
import type { PhoneNotice } from './sender.js'

const notice = (key: string, quiet = false): PhoneNotice =>
  ({ personId: 'p', key, title: 't', subtitle: '', body: '', link: 'swarm:t/c', slot: key, ...quiet ? { quiet: true as const } : {} })

describe('an agent chat sounds once in five minutes on its person\'s phones (Tony, 2026-11-10)', () => {
  it('claims a key once a window, in one process', async () => {
    let at = 0
    const memory = localRingMemory(() => at)
    expect(await memory.claim('p:chat:t:oak')).toBe(true)
    expect(await memory.claim('p:chat:t:oak')).toBe(false)
    expect(await memory.claim('p:chat:t:ivy')).toBe(true)
    at = CHAT_RING_EVERY_MS - 1
    expect(await memory.claim('p:chat:t:oak')).toBe(false)
    at = CHAT_RING_EVERY_MS
    expect(await memory.claim('p:chat:t:oak')).toBe(true)
  })

  it('on every server: one Redis SET NX that ends by itself with the window', async () => {
    const set = vi.fn(async (..._args: unknown[]) => 'OK' as string | null)
    const memory = redisRingMemory({ set })
    expect(await memory.claim('p:chat:t:oak')).toBe(true)
    expect(set).toHaveBeenCalledWith('swarm:push-ring:p:chat:t:oak', '1', 'PX', CHAT_RING_EVERY_MS, 'NX')
    set.mockResolvedValueOnce(null)
    expect(await memory.claim('p:chat:t:oak')).toBe(false)
  })

  it('weighs only the agent chat notices that would sound, and claims each by person and chat', async () => {
    const claims: string[] = []
    const memory = { claim: async (key: string) => { claims.push(key); return key !== 'p:chat:t:ivy' } }
    const notices = [notice('chat:t:oak'), notice('chat:t:ivy'), notice('chat:t:quiet', true), notice('reply:t:r'), notice('mention:m')]
    expect(await quietRecent(memory, notices)).toEqual([notice('chat:t:oak'), notice('chat:t:ivy', true), notice('chat:t:quiet', true),
      notice('reply:t:r'), notice('mention:m')])
    expect(claims).toEqual(['p:chat:t:oak', 'p:chat:t:ivy'])
  })
})
