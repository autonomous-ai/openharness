import { log } from '../../../lib/logger-v1.js'

export function createCache(limit) {
  const entries = new Map()
  return {
    get(key) {
      log.debug('cache %s for %s', entries.has(key) ? 'hit' : 'miss', key)
      return entries.get(key)
    },
    set(key, value) {
      entries.set(key, value)
      if (entries.size > limit) {
        const oldest = entries.keys().next().value
        entries.delete(oldest)
        log.debug('evicted', { key: oldest, size: entries.size })
      }
    },
  }
}
