/** On-demand GitHub observations shared by checks and Ready (#3731). The minute watch remains independent. */
import type { PullRequestReader, PullRequestWatch } from './pullRequestEvents.js'
import type { PullRequestHeads } from './checkVerdicts.js'

const COOLDOWN_MS = 30_000
const MAX_ENTRIES = 1_000
interface Entry<T> { at: number; pending: boolean; value: Promise<T | null> }

/** One backend process's bounded cooldown, including failures and in-flight reads. Each wrapper retains its caller's
 *  reader: cached observations contain no token, and done still revokes only the tokens that caller acquired. */
export function throttleHeadReads(now: () => number): (reader: PullRequestReader, known?: PullRequestHeads) => PullRequestReader {
  const watches = new Map<string, Entry<PullRequestWatch>>()
  const patches = new Map<string, Entry<string>>(), merges = new Map<string, Entry<string>>()
  const read = <T>(cache: Map<string, Entry<T>>, key: string, fetch: () => Promise<T | null>): Promise<T | null> => {
    const at = now(), known = cache.get(key)
    if (known && (known.pending || at - known.at < COOLDOWN_MS)) return known.value
    for (const [key, entry] of cache) if (!entry.pending && at - entry.at >= COOLDOWN_MS) cache.delete(key)
    if (cache.size >= MAX_ENTRIES) {
      // Never evict a pending read and start it twice. If every slot is busy, fail closed and leave the minute watch to read it.
      const oldest = [...cache].find(([, entry]) => !entry.pending)?.[0]
      if (oldest === undefined) return Promise.resolve(null)
      cache.delete(oldest)
    }
    const entry: Entry<T> = { at, pending: true, value: Promise.resolve(null) }
    entry.value = Promise.resolve().then(fetch).catch(() => null).finally(() => { entry.pending = false; entry.at = now() })
    cache.set(key, entry)
    return entry.value
  }
  const diffKey = (url: string, head: string, base: string) => JSON.stringify([url.toLowerCase(), head.toLowerCase(), base])
  return (reader, known) => ({
    watch: async url => {
      const key = url.toLowerCase(), cached = watches.get(key)
      const shared = cached && (cached.pending || now() - cached.at < COOLDOWN_MS)
      const value = await read(watches, key, () => reader.watch(url)), stored = known?.[url]
      // The independent minute watch may have moved this task beyond our cached observation. Replaying it could make an
      // obsolete Yes count again; keep the newer record and retry after the cooldown instead.
      return value && shared && stored && stored.at > cached!.at && (stored.head !== value.head || stored.base !== value.base) ? null : value
    },
    patch: (url, head, base) => read(patches, diffKey(url, head, base), () => reader.patch(url, head, base)),
    merge: (url, head, base) => read(merges, diffKey(url, head, base), () => reader.merge(url, head, base)),
    botLogin: () => reader.botLogin(),
    done: () => reader.done(),
  })
}
