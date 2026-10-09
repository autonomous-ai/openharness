/** The synchronous, validated metadata read needed by every launch's saved-API instructions.
 * There is one atomic file, no service dependency and no secondary metadata copy to fall out of step. */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const text = z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/)
export const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).refine(
  value => !/^(PATH|HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|NODE_OPTIONS|LD_.+|DYLD_.+|HARNESS_.+)$/.test(value),
)
const baseUrl = z.string().max(2048).url().refine(value => {
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
export const stored = metadata.extend({ apiKey: z.string().trim().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/) })
const storeSchema = z.object({ version: z.literal(1), connections: z.array(stored).max(100), recognizedBases: z.array(baseUrl).optional() })
export type ApiConnection = z.infer<typeof metadata>
export type StoredConnection = z.infer<typeof stored>

export class ApiConnectionError extends Error {}

export function readApiConnectionStore(dataDir: string): z.infer<typeof storeSchema> {
  const dir = join(dataDir, 'api-connections')
  const file = join(dir, 'connections.json')
  try {
    if (!existsSync(dir)) return { version: 1, connections: [] }
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error()
    if (!existsSync(file)) return { version: 1, connections: [] }
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error()
    const parsed = storeSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (new Set(parsed.connections.map(row => row.id)).size !== parsed.connections.length) throw new Error()
    return parsed
  } catch { throw new ApiConnectionError('Saved APIs could not be read. Your keys have not been changed.') }
}


/** Its only capability is a list without keys. Parse the same store and report the same errors. */
export class ApiConnectionMetadata {
  constructor(private readonly dataDir: string) {}
  list(): ApiConnection[] { return readApiConnectionStore(this.dataDir).connections.map(value => metadata.parse(value)) }
}
