/**
 * The pool options every backend process connects with, unless its connection string sets its own (roadmap 2.8). Without
 * them Prisma's MongoDB driver keeps its defaults: a pool of 10 per process, and 30 s waiting for a primary, so a request
 * during a failover hangs for half a minute before it fails.
 */
export interface PoolDefaults { maxPoolSize: number; serverSelectionTimeoutMS: number }

/** The Swarm benchmark's one process reached 10 server connections at its peak, the default pool's size (roadmap 2.8). A
 *  request that finds no primary fails after 10 s instead of 30, so its client retries rather than requests piling up. */
export const POOL_DEFAULTS: PoolDefaults = { maxPoolSize: 20, serverSelectionTimeoutMS: 10_000 }

/** `url` with each of `defaults` it does not already set (MongoDB option names are case-insensitive). Never parsed as a
 *  URL: a seed list (`h1:27017,h2:27017`) is not one. */
export function withPoolDefaults(url: string, defaults: PoolDefaults): string {
  const query = url.indexOf('?')
  const present = new Set((query < 0 ? '' : url.slice(query + 1)).split('&').map(pair => pair.split('=')[0]!.toLowerCase()))
  const missing = Object.entries(defaults).filter(([name]) => !present.has(name.toLowerCase())).map(([name, value]) => `${name}=${value}`)
  if (!missing.length) return url
  if (query >= 0) return `${url}&${missing.join('&')}`
  // Options follow the database path; a string with no path needs its slash first.
  const hosts = url.indexOf('://') + 3
  return `${url}${url.indexOf('/', hosts) < 0 ? '/' : ''}?${missing.join('&')}`
}

/** What the second client's reads ask for (task #2970): any secondary no more than 90 s behind (the least MongoDB allows),
 *  the primary when none is, and a name of its own in Atlas's connection and slow-query views. */
export const SECONDARY_READS = { readPreference: 'secondaryPreferred', maxStalenessSeconds: '90', appName: 'autonomous-code-prod-secondary' } as const

/** The main connection string with SECONDARY_READS set: each replaces the same option where it stood (MongoDB option names
 *  are case-insensitive), the rest follow, and every other option stays. A `mongodb+srv` host already lists every member.
 *  Never parsed as a URL, as withPoolDefaults. */
export function secondaryReadsUrl(url: string): string {
  const query = url.indexOf('?')
  const wanted = new Map(Object.entries(SECONDARY_READS).map(([name, value]) => [name.toLowerCase(), `${name}=${value}`]))
  const pairs = (query < 0 ? '' : url.slice(query + 1)).split('&').filter(Boolean).flatMap(pair => {
    const name = pair.split('=')[0]!.toLowerCase(), set = wanted.get(name)
    if (!set) return [pair]
    wanted.delete(name)
    return [set]
  })
  const options = [...pairs, ...wanted.values()].join('&')
  if (query >= 0) return `${url.slice(0, query)}?${options}`
  const hosts = url.indexOf('://') + 3
  return `${url}${url.indexOf('/', hosts) < 0 ? '/' : ''}?${options}`
}
