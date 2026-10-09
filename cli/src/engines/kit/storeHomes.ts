/**
 * The homes of an engine that keeps one store per home, as its contract declares them: the default, then each
 * profile folder below it that has a store (Hermes: `~/.hermes` and `~/.hermes/profiles/<name>`). Listed for
 * optional readers, which may reuse a listing for its `ttlMs`. Session control uses storePool.ts:
 * a home listing by itself cannot prove a fresh, complete set of database claims.
 *
 * Moved from engines/hermes/home.ts (`listHermesHomes`), unchanged but for the declaration it reads.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface StoreHomes {
  /** The folder below the default home whose folders are the other homes. */
  profiles: string
  /** A home's store. A profile counts as a home only once it has one: before that there is nothing to read. */
  store: (home: string) => string
  /** How many profile folders are looked at, at most: hundreds would be a different problem. */
  max: number
  /** How long a listing is reused. A profile is made by hand, minutes apart; this is a `readdir`. */
  ttlMs: number
}

const listings = new WeakMap<StoreHomes, { at: number; homes: string[] }>()

/** Compatibility listing; even complete listings need database evidence before session control. */
export async function readStoreHomes(declared: StoreHomes, defaultHome: string): Promise<{ homes: string[]; complete: boolean }> {
  const homes = [defaultHome]
  let complete = true
  try {
    const entries = await readdir(join(defaultHome, declared.profiles), { withFileTypes: true })
    if (entries.length > declared.max) complete = false
    for (const entry of entries.slice(0, declared.max)) {
      if (!entry.isDirectory()) continue
      const home = join(defaultHome, declared.profiles, entry.name)
      try {
        if ((await stat(declared.store(home))).isFile()) homes.push(home)
        else complete = false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false
  }
  return { homes, complete }
}

/** Every home, the default first. */
export async function listStoreHomes(declared: StoreHomes, defaultHome: string): Promise<string[]> {
  const now = Date.now()
  const listed = listings.get(declared)
  if (listed && now - listed.at < declared.ttlMs) return listed.homes
  const homes = [defaultHome]
  try {
    const entries = await readdir(join(defaultHome, declared.profiles), { withFileTypes: true })
    for (const entry of entries.slice(0, declared.max)) {
      if (!entry.isDirectory()) continue
      const home = join(defaultHome, declared.profiles, entry.name)
      try {
        if ((await stat(declared.store(home))).isFile()) homes.push(home)
      } catch { /* a profile whose first session has not started */ }
    }
  } catch { /* no profiles folder — the single-home machine, which is most of them */ }
  listings.set(declared, { at: now, homes })
  return homes
}

/** Forget the listing — for a test, and for an installer that has just made a profile. */
export function forgetStoreHomes(declared: StoreHomes): void {
  listings.delete(declared)
}
