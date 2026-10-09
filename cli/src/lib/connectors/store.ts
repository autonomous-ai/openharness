/**
 * Connected services: one private tokens.json per user, shared by every local agent (Grid's format,
 * ~/.grid/connectors/tokens.json). Agents never read it: MCP clients reach a service through the bridge
 * (bridge.ts) and `harness connections call` reads a token for one request.
 *
 * Kept at the product root (`~/.harness/connections`), beside the computer id and outside cli/data:
 * `harness reset` must not sign a person out of their services. No zod: the edge host loads this.
 */
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, constants, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cleanRestEntry, transport, type RestEntry, type Transport } from './rest.js'

export const MAX_BYTES = 1024 * 1024
/** A token is renewed this long before it expires, as Grid does. */
export const REFRESH_MARGIN = 300
export const CODE = /^[a-z0-9][a-z0-9_-]{0,47}$/
/** Codes saved before the catalog followed Grid's, and Grid's code for them now. */
export const RENAMED: Record<string, string> = { apollo: 'apollo_io', supermetrics_marketing: 'supermetrics' }

export class ConnectorError extends Error {}

export type Source = 'dcr' | 'gateway' | 'custom'
export interface McpEntry { url: string, headers: Record<string, string> }
export interface Token {
  access_token?: string
  refresh_token?: string
  token_type?: string
  scope?: string
  account_name?: string
  source?: Source
  issuer?: string
  label?: string
  expires_at?: number
  obtained_at?: number
  refresh?: boolean
  needs_reconnect?: boolean
  mcp_entry?: McpEntry
  /** A service with no usable MCP server: its REST tools, served as MCP by the bridge (rest.ts). */
  rest_entry?: RestEntry
  /** The gateway's word on which of the two agents use. */
  transport?: Transport
}
export interface Client {
  client_id: string
  client_secret: string
  token_endpoint_auth_method: string
  authorization_endpoint: string
  token_endpoint: string
  redirect_uri: string
  registered_at: number
}

export function connectorsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARNESS_CONNECTIONS_DIR || join(env.HOME || homedir(), '.harness', 'connections')
}

/** Harness OS 0.1.2 kept them here, before the CLI did; read once, then the CLI's copy is the one. */
function legacyDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'harness-os', 'connections')
}

export function validateCode(code: unknown): string {
  if (typeof code !== 'string' || !CODE.test(code)) throw new ConnectorError('Unknown connection.')
  return code
}

function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const info = lstatSync(dir)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new ConnectorError('Connections must be stored in your own directory, without a symlink.')
  }
  chmodSync(dir, 0o700)
}

export function readPrivate(path: string): Record<string, unknown> | null {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ConnectorError('Cannot read connection settings.')
  }
  try {
    const info = fstatSync(fd)
    const foreign = process.getuid ? info.uid !== process.getuid() : false
    if (!info.isFile() || foreign || (process.platform !== 'win32' && (info.mode & 0o077)) || info.size > MAX_BYTES) {
      throw new ConnectorError('Connection settings must be private, regular files owned by you.')
    }
    let data: unknown
    try { data = JSON.parse(readFileSync(fd, 'utf8')) } catch { throw new ConnectorError('Cannot read connection settings.') }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConnectorError('Invalid connection settings.')
    return data as Record<string, unknown>
  } finally { closeSync(fd) }
}

export function writePrivate(path: string, data: unknown): void {
  const dir = join(path, '..')
  privateDirectory(dir)
  const raw = JSON.stringify(data, null, 2) + '\n'
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new ConnectorError('Connection settings are too large.')
  const temporary = join(dir, `.incoming-${randomUUID()}`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, raw)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

/** One writer at a time across agents, the bridge and the page: an exclusive lock file, waited for. */
export function locked<T>(dir: string, work: () => T): T {
  privateDirectory(dir)
  const lock = join(dir, '.lock')
  const deadline = Date.now() + 35_000
  for (;;) {
    try { closeSync(openSync(lock, 'wx', 0o600)); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConnectorError('Invalid connection lock.')
      // A holder that died leaves its lock: one older than a minute is stale.
      try { if (Date.now() - lstatSync(lock).mtimeMs > 60_000) { rmSync(lock, { force: true }); continue } } catch { continue }
      if (Date.now() > deadline) throw new ConnectorError('Another connection operation is still running. Try again.')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try { return work() } finally { rmSync(lock, { force: true }) }
}

export function text(value: unknown, limit = 8192): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new ConnectorError('Invalid connection fields.')
  return value
}

export function cleanHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined || headers === null) return {}
  if (typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 20) throw new ConnectorError('Invalid connection headers.')
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new ConnectorError('Invalid connection headers.')
    result[name] = text(value)
  }
  return result
}

export function cleanUrl(value: unknown): string {
  const raw = text(value, 2048)
  let url: URL
  try { url = new URL(raw) } catch { throw new ConnectorError('Use an https:// address for the server.') }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || local) || url.username || url.password) throw new ConnectorError('Use an https:// address for the server.')
  return raw
}

/** A tokens.json entry, as Grid writes it, with nothing unexpected kept. */
export function cleanToken(entry: unknown): Token {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ConnectorError('Invalid connection.')
  const raw = entry as Record<string, unknown>
  const result: Token = {}
  for (const key of ['access_token', 'refresh_token', 'token_type', 'scope', 'account_name', 'source', 'issuer', 'label'] as const) {
    const value = text(raw[key])
    if (value) (result as Record<string, unknown>)[key] = value
  }
  if (!['dcr', 'gateway', 'custom'].includes(result.source ?? 'dcr')) throw new ConnectorError('Unsupported connection source.')
  for (const key of ['expires_at', 'obtained_at'] as const) {
    const value = raw[key] ?? 0
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new ConnectorError('Invalid connection expiry.')
    if (value) result[key] = value
  }
  if (raw.refresh === true) result.refresh = true
  if (raw.needs_reconnect === true) result.needs_reconnect = true
  const mcp = raw.mcp_entry
  if (mcp) {
    if (typeof mcp !== 'object' || Array.isArray(mcp)) throw new ConnectorError('Invalid connection server.')
    const entryRaw = mcp as Record<string, unknown>
    result.mcp_entry = { url: cleanUrl(entryRaw.url), headers: cleanHeaders(entryRaw.headers) }
  }
  const rest = cleanRestEntry(raw.rest_entry)
  if (rest) result.rest_entry = rest
  if (raw.transport === 'mcp' || raw.transport === 'rest' || raw.transport === 'none') result.transport = raw.transport
  if (!result.access_token && !result.mcp_entry) throw new ConnectorError('No access token was supplied.')
  return result
}

/** The Authorization value for a token, its scheme normalised as Grid does. */
export function bearer(token: Token): string {
  const scheme = token.token_type || 'Bearer'
  return `${scheme.toLowerCase() === 'bearer' ? 'Bearer' : scheme} ${token.access_token}`
}

export function refreshable(token: Token): boolean {
  return token.source === 'gateway' ? token.refresh === true : Boolean(token.refresh_token)
}

export function needsRefresh(token: Token, now = Date.now() / 1000): boolean {
  const expires = token.expires_at ?? 0
  return Boolean(expires) && expires - REFRESH_MARGIN <= now && refreshable(token) && !token.needs_reconnect
}

export interface Status {
  connector: string
  name: string
  state: 'not_connected' | 'connected' | 'reconnect'
  account?: string
  source?: Source
  scopes?: string[]
  expires_at?: number | null
  auto_refresh?: boolean
  tools?: boolean
}

export class Store {
  readonly root: string
  constructor(root?: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.root = root ?? connectorsDir(env)
    if (!root) this.adoptLegacy()
  }

  /** Harness OS kept connections in its own folder before the CLI did: moved here once. */
  private adoptLegacy(): void {
    const old = legacyDir(this.env)
    if (existsSync(join(this.root, 'tokens.json')) || !existsSync(join(old, 'tokens.json'))) return
    try {
      for (const name of ['tokens.json', 'clients.json', 'bridge.json']) {
        const data = readPrivate(join(old, name))
        if (data) writePrivate(join(this.root, name), data)
      }
    } catch { /* An unreadable old store is left where it is; nothing is lost. */ }
  }

  file(name: string): Record<string, unknown> {
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw new ConnectorError('Connection storage must not be a symlink.')
    return readPrivate(join(this.root, name)) ?? {}
  }

  tokens(): Record<string, Token> {
    const result: Record<string, Token> = {}
    for (const [code, entry] of Object.entries(this.file('tokens.json'))) {
      if (!CODE.test(code)) continue
      const name = RENAMED[code] ?? code
      if (!(name in result)) result[name] = cleanToken(entry)
    }
    return result
  }

  token(code: string): Token | undefined {
    validateCode(code)
    return this.tokens()[RENAMED[code] ?? code]
  }

  /** Save one connection, replacing it. Call inside locked(). */
  put(code: string, entry: Token): void {
    validateCode(code)
    const data = this.file('tokens.json')
    for (const [old, now] of Object.entries(RENAMED)) if (now === code) delete data[old]
    data[code] = cleanToken(entry)
    writePrivate(join(this.root, 'tokens.json'), data)
  }

  save(code: string, entry: Token): void { locked(this.root, () => this.put(code, entry)) }

  disconnect(code: string): void {
    validateCode(code)
    const names = [code, ...Object.entries(RENAMED).filter(([, now]) => now === code).map(([old]) => old)]
    locked(this.root, () => {
      const data = this.file('tokens.json')
      if (names.some(name => name in data)) {
        for (const name of names) delete data[name]
        writePrivate(join(this.root, 'tokens.json'), data)
      }
    })
  }

  client(issuer: string): Client | undefined {
    const entry = this.file('clients.json')[issuer]
    return entry && typeof entry === 'object' ? entry as Client : undefined
  }

  saveClient(issuer: string, client: Client): void {
    locked(this.root, () => {
      const data = this.file('clients.json')
      data[issuer] = client
      writePrivate(join(this.root, 'clients.json'), data)
    })
  }

  status(code: string, label: string, token?: Token): Status {
    const base = { connector: code, name: token?.label || label }
    if (!token) return { ...base, state: 'not_connected' }
    const expires = token.expires_at ?? 0
    const expired = Boolean(expires) && expires <= Date.now() / 1000
    const state = token.needs_reconnect || (expired && !refreshable(token)) ? 'reconnect' : 'connected'
    return {
      ...base, state, account: token.account_name ?? '', source: token.source ?? 'dcr',
      scopes: (token.scope ?? '').split(/\s+/).filter(Boolean), expires_at: expires || null,
      auto_refresh: refreshable(token), tools: transport(token) !== 'none',
    }
  }
}
