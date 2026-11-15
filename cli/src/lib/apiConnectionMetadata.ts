/** The saved APIs without their keys, as every launch reads them for its saved-API instructions (./apiInstructions.ts).
 * A file of their own, `list.json`, beside the store with the keys (`connections.json`, ./apiConnections.ts), which
 * only the models service, `harness api` and the engine probe open. Until 15 November every launch parsed the store,
 * keys included, to learn whether one was saved (core audit, section 1). The store keeps the list in step. */
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'

const text = z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/)
export const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).refine(
  value => !/^(PATH|HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|NODE_OPTIONS|LD_.+|DYLD_.+|HARNESS_.+)$/.test(value),
)
export const baseUrl = z.string().max(2048).url().refine(value => {
  const url = new URL(value)
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
})
export const metadata = z.object({
  id,
  provider: id,
  name: text,
  baseUrl,
  keyEnv: environmentName,
  authHeader: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/).refine(value =>
    !['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'].includes(value.toLowerCase())),
  authPrefix: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/),
})
export type ApiConnection = z.infer<typeof metadata>

/** Strict: a list that carries anything more than metadata, a key above all, is refused. */
const listSchema = z.object({ version: z.literal(1), connections: z.array(metadata.strict()).max(100) }).strict()

export class ApiConnectionError extends Error {}

export const API_CONNECTIONS_DIR = 'api-connections'
export const API_LIST_FILE = 'list.json'
export const API_LIST_MAX_BYTES = 1024 * 1024
export const UNREADABLE = 'Saved APIs could not be read. Your keys have not been changed.'

/** Its only capability is whether an API is saved, from the list without keys; it never opens the store. */
export class ApiConnectionMetadata {
  constructor(private readonly dataDir: string) {}
  saved(): boolean {
    const dir = join(this.dataDir, API_CONNECTIONS_DIR)
    const file = join(dir, API_LIST_FILE)
    try {
      const directory = lstatSync(dir, { throwIfNoEntry: false })
      if (!directory) return false
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error()
      secureStateDirectory(dir, false)
      // A store an older build wrote has no list until the store is first read in this one (models reads it as it
      // starts, and so does `harness api`). Until then its being there answers, unread: it holds an API, or did. Until
      // 2026-12-15, when the builds without the list are a month old.
      const stat = lstatSync(file, { throwIfNoEntry: false })
      if (!stat) {
        const legacy = lstatSync(join(dir, 'connections.json'), { throwIfNoEntry: false })
        if (!legacy) return false
        if (!legacy.isFile() || legacy.nlink !== 1 || legacy.size > 2 * 1024 * 1024
          || (process.getuid && legacy.uid !== process.getuid())
          || (process.platform !== 'win32' && (legacy.mode & 0o022) !== 0)) throw new Error()
        return true
      }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > API_LIST_MAX_BYTES) throw new Error()
      const parsed = listSchema.parse(JSON.parse(readPrivateStateFile(file, API_LIST_MAX_BYTES)))
      if (new Set(parsed.connections.map(row => row.id)).size !== parsed.connections.length) throw new Error()
      return parsed.connections.length > 0
    } catch { throw new ApiConnectionError(UNREADABLE) }
  }
}
