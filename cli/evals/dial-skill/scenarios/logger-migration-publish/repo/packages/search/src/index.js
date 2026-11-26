import { log, timed } from '../../../lib/logger-v1.js'

export function search(items, query) {
  const q = query.trim().toLowerCase()
  log.debug('search query', { query: q, items: items.length })
  return timed('search', () => items.filter((item) => item.toLowerCase().includes(q)))
}
