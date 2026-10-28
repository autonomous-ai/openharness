import { Redis } from 'ioredis'
import { configureSwarmStamps, redisStamps, type StampScope } from '../../src/superTabs/cache.js'
import { MemoryStamps } from '../../src/superTabs/cache.test-support.js'

/** Sets up the read cache's stamps for the run (config.ts `--cache`); returns what the report names and how to close it. */
export async function benchStamps(cache: string): Promise<{ label: string; close(): Promise<void> }> {
  if (cache === 'off') {
    configureSwarmStamps(new MemoryStamps(), { reads: false })
    return { label: 'off (SWARM_READ_CACHE=off: every read goes to MongoDB)', close: async () => configureSwarmStamps(null) }
  }
  if (cache === 'memory') {
    configureSwarmStamps(new MemoryStamps())
    return { label: 'on, stamps in this process', close: async () => configureSwarmStamps(null) }
  }
  const pub = new Redis(cache, { maxRetriesPerRequest: 1, enableOfflineQueue: false }), sub = new Redis(cache)
  await Promise.all([pub, sub].map(r => new Promise(resolve => r.once('ready', resolve))))
  const channel = 'swarm-stamp'
  await sub.subscribe(channel)
  configureSwarmStamps(redisStamps(pub, {
    publish: (tabId, scopes) => pub.publish(channel, JSON.stringify({ tabId, scopes })),
    subscribe: listener => {
      const heard = (from: string, payload: string) => {
        if (from !== channel) return
        const { tabId, scopes } = JSON.parse(payload) as { tabId: string; scopes: StampScope[] }
        listener(tabId, scopes)
      }
      sub.on('message', heard)
      return () => { sub.off('message', heard) }
    },
  }))
  return { label: `on, stamps in Redis (${new URL(cache).host})`, close: async () => { configureSwarmStamps(null); await Promise.all([pub.quit(), sub.quit()]) } }
}
