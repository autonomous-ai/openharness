import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../lib/ssoAuth.js'
import { messagesPollKey, redisMessagesPollMemory } from './quietMessages.js'

/** The two Redis commands the memory uses, with Redis' own expiry (`PX` milliseconds), on a clock the test moves. */
function fakeRedis() {
  let now = 0
  const keys = new Map<string, { value: string; until: number }>()
  return {
    tick: (ms: number) => { now += ms },
    keys,
    async get(key: string) {
      const entry = keys.get(key)
      return entry && entry.until > now ? entry.value : null
    },
    async set(key: string, value: string, mode: 'PX', ms: number) {
      if (mode !== 'PX') throw new Error('expected an expiry')
      keys.set(key, { value, until: now + ms })
      return 'OK' as const
    },
  }
}

const read = { at: 1_234, stamp: 7, reactionSeq: 2, swarm: { workspaceId: 'w1', environment: 'prod' } }
const agentRead = { ...read, grant: { contributorId: 'u1', machineId: 'm1', machineOwnerId: 'u1', hostGrant: null } }

describe('the messages poll memory every server shares', () => {
  it('gives back what a full read remembered, a person\'s or an agent\'s, to any server', async () => {
    const redis = fakeRedis()
    await redisMessagesPollMemory(redis).set('person', read)
    await redisMessagesPollMemory(redis).set('agent', agentRead)
    expect(await redisMessagesPollMemory(redis).get('person')).toEqual(read)
    expect(await redisMessagesPollMemory(redis).get('agent')).toEqual(agentRead)
    expect(await redisMessagesPollMemory(redis).get('other')).toBeUndefined()
    expect([...redis.keys.keys()]).toEqual(['swarm:messages-polled:person', 'swarm:messages-polled:agent'])
  })

  // One key per caller and conversation that never expired would grow Redis by one for every conversation ever polled.
  it('forgets each read 30 seconds after it was remembered', async () => {
    const redis = fakeRedis()
    await redisMessagesPollMemory(redis).set('person', read)
    redis.tick(29_999)
    expect(await redisMessagesPollMemory(redis).get('person')).toEqual(read)
    redis.tick(1)
    expect(await redisMessagesPollMemory(redis).get('person')).toBeUndefined()
  })

  // An answer the memory cannot vouch for must send the poll to the full read, never become an empty page.
  it('remembers nothing it cannot read in full', async () => {
    const redis = fakeRedis()
    const memory = redisMessagesPollMemory(redis)
    for (const value of ['not json', '1234', JSON.stringify({ at: 1 }), JSON.stringify({ ...read, stamp: 'x' }),
      JSON.stringify({ ...agentRead, grant: { machineId: 'm1' } })]) {
      redis.keys.set('swarm:messages-polled:k', { value, until: Infinity })
      expect(await memory.get('k'), value).toBeUndefined()
    }
  })
})

describe('whose read a key names', () => {
  const user: AuthUser = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' }
  it('keeps apart each conversation, each agent read as, each person, and a team session from its person', () => {
    const keys = new Set([
      messagesPollKey(user, 't', 'c1'), messagesPollKey(user, 't', 'c2'), messagesPollKey(user, 't', 'c1', 'a1'),
      messagesPollKey({ ...user, sub: 'u2' }, 't', 'c1'), messagesPollKey({ ...user, harnessSessionKind: 'team', harnessComputerId: 'mac' }, 't', 'c1'),
    ])
    expect(keys.size).toBe(5)
  })
})
