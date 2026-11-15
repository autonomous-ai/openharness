/** The saved APIs without their keys, as every launch reads them for its saved-API instructions (./apiInstructions.ts).
 * A file of their own, `list.json`, beside the store with the keys (`connections.json`, ./apiConnections.ts), which
 * only the models service, `harness api` and the engine probe open. Until 15 November every launch parsed the store,
 * keys included, to learn whether one was saved (core audit, section 1). The store keeps the list in step. */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

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

/** Strict: a list that carries anything more than the metadata, a key above all, is refused, never read. */
const listSchema = z.object({ version: z.literal(1), connections: z.array(metadata.strict()).max(100) }).strict()

export class ApiConnectionError extends Error {}

export const API_CONNECTIONS_DIR = 'api-connections'
export const API_LIST_FILE = 'list.json'
export const UNREADABLE = 'Saved APIs could not be read. Your keys have not been changed.'

/** Its only capability is whether an API is saved, from the list without keys; it never opens the store. */
export class ApiConnectionMetadata {
  constructor(private readonly dataDir: string) {}
  saved(): boolean {
    const dir = join(this.dataDir, API_CONNECTIONS_DIR)
    const file = join(dir, API_LIST_FILE)
    try {
      if (!existsSync(dir)) return false
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error()
      // A store an older build wrote has no list until the store is first read in this one (models reads it as it
      // starts, and so does `harness api`). Until then its being there answers, unread: it holds an API, or did. Until
      // 2026-12-15, when the builds without the list are a month old.
      if (!existsSync(file)) return existsSync(join(dir, 'connections.json'))
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error()
      const parsed = listSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      if (new Set(parsed.connections.map(row => row.id)).size !== parsed.connections.length) throw new Error()
      return parsed.connections.length > 0
    } catch { throw new ApiConnectionError(UNREADABLE) }
  }
}
