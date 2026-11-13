/**
 * The saved APIs' one file (Models ▸ APIs), read but not checked field by field: where it is, and what may not stand
 * in its place.
 *
 * Apart from ./apiConnectionMetadata.ts, whose every field is checked with zod, because the one question a probe of
 * this computer's engines asks of it (./engineAccount.ts) is asked in the edge host, which holds no zod
 * (leanEntry.spec.ts): the services there share one process.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The file's JSON, or undefined where nothing is saved (a file never parses to that). Throws where a link, or anything
 *  but a file of at most 2 MiB, stands there. */
export function readApiConnectionFile(dataDir: string): unknown {
  const dir = join(dataDir, 'api-connections')
  const file = join(dir, 'connections.json')
  if (!existsSync(dir)) return undefined
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error()
  if (!existsSync(file)) return undefined
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error()
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * Whether a saved API sends its key as `Authorization: Bearer`, which is what serves Claude Code with no subscription.
 * It looks at those two fields of each row alone. A file that cannot be read says no. A file the checked read
 * refuses for another field can still say yes here: the launch is then what says the saved APIs could not be read.
 */
export function savedBearerApi(dataDir: string): boolean {
  try {
    const store = readApiConnectionFile(dataDir) as { version?: unknown; connections?: unknown } | null | undefined
    if (store?.version !== 1 || !Array.isArray(store.connections)) return false
    return store.connections.some((row: { authHeader?: unknown; authPrefix?: unknown } | null) =>
      typeof row?.authHeader === 'string' && typeof row.authPrefix === 'string'
      && row.authHeader.toLowerCase() === 'authorization' && row.authPrefix.toLowerCase() === 'bearer')
  } catch { return false }
}
