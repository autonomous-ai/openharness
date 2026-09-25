/** Machine-local API connections. Only child tools receive credentials; model/subscription
 * selection and the daemon's own environment are never changed by saving a key. */
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const text = z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/)
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).refine(
  value => !/^(PATH|HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|NODE_OPTIONS|LD_.+|DYLD_.+|HARNESS_.+)$/.test(value),
)
const baseUrl = z.string().max(2048).url().refine(value => {
  const url = new URL(value)
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
})
const metadata = z.object({
  id,
  provider: id,
  name: text,
  baseUrl,
  keyEnv: environmentName,
  authHeader: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/).refine(value =>
    !['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'].includes(value.toLowerCase())),
  authPrefix: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/),
})
const stored = metadata.extend({ apiKey: z.string().trim().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/) })
const storeSchema = z.object({ version: z.literal(1), connections: z.array(stored).max(100) })
export type ApiConnection = z.infer<typeof metadata>
type StoredConnection = z.infer<typeof stored>
export type ApiPreset = Omit<ApiConnection, 'id'> & { keyUrl: string; docsUrl: string }

/** Defaults verified against each provider's public authentication docs. Custom APIs use the
 * same store and execution path; presets are conveniences, never a provider allowlist. */
export const API_PRESETS: ApiPreset[] = [
  { provider: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer', keyUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs/api/reference/authentication' },
  { provider: 'requesty', name: 'Requesty', baseUrl: 'https://router.requesty.ai/v1', keyEnv: 'REQUESTY_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer', keyUrl: 'https://app.requesty.ai/api-keys', docsUrl: 'https://docs.requesty.ai/api-reference/introduction' },
  { provider: 'fal', name: 'fal.ai', baseUrl: 'https://queue.fal.run', keyEnv: 'FAL_KEY', authHeader: 'Authorization', authPrefix: 'Key', keyUrl: 'https://fal.ai/dashboard/keys', docsUrl: 'https://fal.ai/docs' },
  { provider: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer', keyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://developers.openai.com/api/reference/overview' },
  { provider: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', authHeader: 'x-api-key', authPrefix: '', keyUrl: 'https://platform.claude.com/settings/keys', docsUrl: 'https://platform.claude.com/docs/en/api/overview' },
  { provider: 'replicate', name: 'Replicate', baseUrl: 'https://api.replicate.com/v1', keyEnv: 'REPLICATE_API_TOKEN', authHeader: 'Authorization', authPrefix: 'Bearer', keyUrl: 'https://replicate.com/account/api-tokens', docsUrl: 'https://replicate.com/docs/topics/security/api-tokens' },
]

export class ApiConnectionError extends Error {}
const message = (value: string): never => { throw new ApiConnectionError(value) }
const publicConnection = (value: StoredConnection): ApiConnection => metadata.parse(value)

export class ApiConnections {
  private readonly dir: string
  private readonly file: string
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'api-connections')
    this.file = join(this.dir, 'connections.json')
  }

  private read(): StoredConnection[] {
    try {
      if (!existsSync(this.dir)) return []
      if (!lstatSync(this.dir).isDirectory() || lstatSync(this.dir).isSymbolicLink()) throw new Error()
      if (!existsSync(this.file)) return []
      const stat = lstatSync(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error()
      const parsed = storeSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))).connections
      if (new Set(parsed.map(row => row.id)).size !== parsed.length) throw new Error()
      return parsed
    } catch { return message('Saved APIs could not be read. Your keys have not been changed.') }
  }

  private write(connections: StoredConnection[]): void {
    const temporary = join(this.dir, `.connections-${randomUUID()}.tmp`)
    let fd: number | undefined
    let created = false
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      if (lstatSync(this.dir).isSymbolicLink()) throw new Error()
      chmodSync(this.dir, 0o700)
      fd = openSync(temporary, 'wx', 0o600)
      created = true
      writeFileSync(fd, JSON.stringify({ version: 1, connections }))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, this.file)
    } catch { message('This API could not be saved. Try again.') }
    finally {
      if (fd !== undefined) closeSync(fd)
      if (created) rmSync(temporary, { force: true })
    }
  }

  list(): ApiConnection[] { return this.read().map(publicConnection) }

  save(input: Record<string, unknown>): ApiConnection {
    const connections = this.read()
    const previous = input.id === undefined ? undefined : connections.find(row => row.id === input.id)
    if (input.id !== undefined && !previous) return message('This API was removed. Add it again.')
    const preset = API_PRESETS.find(row => row.provider === input.provider)
    if (input.provider !== 'custom' && !preset) return message('Choose an API or Custom API.')
    const name = typeof input.name === 'string' ? input.name.trim() : preset?.name ?? ''
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
    const parsed = stored.safeParse({
      ...preset, ...previous, ...input,
      id: previous?.id ?? slug,
      name,
      baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/+$/, '') : preset?.baseUrl,
      keyEnv: input.keyEnv || preset?.keyEnv || `${slug.replace(/-/g, '_').toUpperCase()}_API_KEY`,
      authHeader: input.authHeader ?? preset?.authHeader ?? 'Authorization',
      authPrefix: input.authPrefix ?? preset?.authPrefix ?? 'Bearer',
      apiKey: typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : previous?.apiKey,
    })
    if (!parsed.success) return message('Check the name, URL, key, and authentication settings.')
    const value = parsed.data
    if (connections.some(row => row.id !== previous?.id && (row.id === value.id || row.name.toLowerCase() === value.name.toLowerCase()))) {
      return message('An API with this name already exists. Choose another name.')
    }
    if (!previous && connections.length >= 100) return message('Remove an API before adding another.')
    this.write(previous ? connections.map(row => row.id === value.id ? value : row) : [...connections, value])
    return publicConnection(value)
  }

  remove(connectionId: unknown): void {
    if (!id.safeParse(connectionId).success) return message('Choose a saved API.')
    this.write(this.read().filter(row => row.id !== connectionId))
  }

  private connection(connectionId: string): StoredConnection {
    return this.read().find(row => row.id === connectionId) ?? message('This API is not saved. Add it in Models → APIs.')
  }

  /** Never merge this into an agent's global environment: a vendor key can override its subscription.
   * It belongs ONLY to the explicitly requested tool process (harness api run). */
  toolEnvironment(connectionId: string): Record<string, string> {
    const connection = this.connection(connectionId)
    return { [connection.keyEnv]: connection.apiKey, HARNESS_API_BASE_URL: connection.baseUrl }
  }

  requestConfig(connectionId: string, path: string): { url: URL; headers: Record<string, string> } {
    const connection = this.connection(connectionId)
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(path)) return message('Use a path relative to this API.')
    const url = new URL(`${connection.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
    if (url.origin !== new URL(connection.baseUrl).origin || url.username || url.password) return message('Use a path relative to this API.')
    return { url, headers: {
      [connection.authHeader]: `${connection.authPrefix ? `${connection.authPrefix} ` : ''}${connection.apiKey}`,
      ...(connection.provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
    } }
  }
}

/** No credentials in replies, including validation, filesystem and unexpected failures. */
export function apiConnectionsRequest(store: ApiConnections, payload: Record<string, unknown>): Record<string, unknown> {
  try {
    if (payload.action === 'save') {
      if (!payload.connection || typeof payload.connection !== 'object' || Array.isArray(payload.connection)) return { error: 'API_CONNECTIONS_FAILED', detail: 'Choose an API to save.' }
      store.save(payload.connection as Record<string, unknown>)
    } else if (payload.action === 'remove') store.remove(payload.id)
    else if (payload.action !== 'list') return { error: 'API_CONNECTIONS_FAILED', detail: 'Choose an API action.' }
    return { connections: store.list(), presets: API_PRESETS }
  } catch (error) {
    return { error: 'API_CONNECTIONS_FAILED', detail: error instanceof ApiConnectionError ? error.message : 'APIs are unavailable. Try again.' }
  }
}
