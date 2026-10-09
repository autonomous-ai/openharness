/**
 * The connector gateway: sign-in to the services whose MCP or API lets no computer register its own
 * OAuth client (GitHub, Slack, Asana, HubSpot, Google, Figma). Autonomous registered an OAuth app with
 * each; this server holds those apps' client secrets and does the parts that need them, the code
 * exchange and the refresh. Every other service signs in from the computer (cli/src/lib/connectors).
 *
 *   computer → POST /api/connectors/start   (signed in) → { authorize_url, pickup_code }
 *   browser  → the service's consent → https://www.autonomous.ai/connector/callback?code&state
 *   web      → POST /api/connectors/callback (no auth: the state is the ticket) → exchange here
 *   computer → POST /api/connectors/poll    (signed in) → the token, once
 *   computer → POST /api/connectors/refresh (signed in) {connector} → a new token
 *
 * As the Grid control plane does it (autonomous-grid-be grid_networks/connectors.py), with the same
 * requests and answers: the account's tokens are kept here (ConnectorCredential, sealed with
 * CONNECTOR_ENCRYPTION_KEY), so any of its computers renews them by naming the service, and
 * disconnecting forgets them here. A sign-in in progress (its state, PKCE verifier and, once exchanged,
 * its one-time result for the computer) lives in Redis for ten minutes, under hashed keys.
 *
 * The apps' config is the Grid control plane's `config-connector-auth.json` shape, given as a file
 * (CONNECTOR_AUTH_FILE) or inline (CONNECTOR_AUTH_JSON): never in git.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { pub } from './bus.js'
import { prisma } from './prisma.js'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

const TTL_SEC = 600
const POLL_INTERVAL_SEC = 2
const HTTP_TIMEOUT_MS = 15_000
/** Every state this gateway mints starts so; the Autonomous web callback forwards those here. */
export const STATE_PREFIX = 'harness_'

export class GatewayError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) { super(message) }
}

export interface ConnectorApp {
  code: string
  label: string
  description: string
  imageUrl: string
  clientId: string
  clientSecret: string
  authUrl: string
  tokenUrl: string
  refreshUrl: string
  userinfoUrl: string
  scopes: string[]
  /** `header`: client credentials as HTTP Basic; otherwise in the form body. */
  authStyle: string
  pkce: boolean
  refresh: boolean
  /** Provider-specific consent parameters (Google's access_type=offline). */
  authParams: Record<string, string>
  /** Where the access token is in the token response, dotted (Slack's authed_user.access_token). */
  tokenField: string
  mcpUrl: string
  /** `header:<Name>` sends the raw token under that name; anything else is `Authorization: Bearer`. */
  mcpAuthHeader: string
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value))

/** The `app` entries of a config-connector-auth.json document; others sign in from the computer. */
export function parseConfig(raw: string): Record<string, ConnectorApp> {
  let document: unknown
  try { document = JSON.parse(raw) } catch { throw new Error('connector config is not valid JSON') }
  const entries = (document as { connectors?: unknown })?.connectors
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('connector config must have a "connectors" object')
  const apps: Record<string, ConnectorApp> = {}
  for (const [rawCode, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const code = rawCode.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(code) || (str(entry.auth_type) || 'app').toLowerCase() !== 'app') continue
    if (!str(entry.client_id) || !str(entry.auth_url) || !str(entry.token_url)) continue
    const scopes = Array.isArray(entry.scopes) ? entry.scopes.map(str) : str(entry.scopes).split(/[\s,]+/)
    const extra = (entry.extra && typeof entry.extra === 'object' ? entry.extra : {}) as Record<string, unknown>
    apps[code] = {
      code, label: str(entry.label) || code, description: str(entry.description), imageUrl: str(entry.image_url),
      clientId: str(entry.client_id), clientSecret: str(entry.client_secret),
      authUrl: str(entry.auth_url), tokenUrl: str(entry.token_url), refreshUrl: str(entry.refresh_url), userinfoUrl: str(entry.userinfo_url),
      scopes: scopes.filter(Boolean), authStyle: str(entry.auth_style).toLowerCase(), pkce: entry.pkce === true, refresh: entry.refresh === true,
      authParams: Object.fromEntries(Object.entries((entry.auth_params ?? {}) as Record<string, unknown>).map(([k, v]) => [k, str(v)])),
      // As Grid reads them: these three live in `extra` (copied there from the device firmware's table).
      tokenField: str(entry.token_field) || str(extra.token_field), mcpUrl: str(entry.mcp_url) || str(extra.mcp_url),
      mcpAuthHeader: str(entry.mcp_auth_header) || str(extra.mcp_auth_header),
    }
  }
  return apps
}

let cached: { apps: Record<string, ConnectorApp> } | null = null

/** The configured apps; none (the gateway off) when no config is given. Read once per process. */
export function apps(): Record<string, ConnectorApp> {
  if (cached) return cached.apps
  let raw = env.CONNECTOR_AUTH_JSON
  if (!raw && env.CONNECTOR_AUTH_FILE) {
    try { raw = readFileSync(env.CONNECTOR_AUTH_FILE, 'utf8') } catch (error) {
      logger.error('connector gateway: cannot read CONNECTOR_AUTH_FILE', { error: String(error) })
    }
  }
  try { cached = { apps: raw ? parseConfig(raw) : {} } } catch (error) {
    logger.error('connector gateway: invalid connector config', { error: String(error) })
    cached = { apps: {} }
  }
  return cached.apps
}

/** For tests: forget the parsed config. */
export function resetConfig(): void { cached = null }

function app(code: unknown): ConnectorApp {
  const found = typeof code === 'string' ? apps()[code] : undefined
  if (!found) throw new GatewayError('This service does not sign in through Harness.', 'UNKNOWN_CONNECTOR', 404)
  return found
}

/** AES-256-GCM, version.iv.tag.ciphertext, as lib/machineCredential.ts seals, under its own key. */
function sealKey(): Buffer {
  const value = Buffer.from(env.CONNECTOR_ENCRYPTION_KEY ?? '', 'base64')
  if (value.length !== 32) throw new GatewayError('Connections through Harness are not set up on this server.', 'GATEWAY_NOT_CONFIGURED', 503)
  return value
}

export function seal(value: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealKey(), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
}

export function unseal(envelope: string): Record<string, unknown> {
  const [version, iv, tag, body, extra] = envelope.split('.')
  if (version !== 'v1' || !iv || !tag || !body || extra) throw new Error('Invalid connector credential')
  const decipher = createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'))
}

/** What the account's Connectors page lists for these services, with its own state. Never a secret. */
export async function list(userId: string): Promise<Record<string, unknown>[]> {
  const rows = await prisma.connectorCredential.findMany({ where: { userId }, select: { connector: true, accountName: true, expiresAt: true, connectedAt: true } })
  const mine = new Map(rows.map(row => [row.connector, row]))
  return Object.values(apps()).map(a => {
    const row = mine.get(a.code)
    return {
      code: a.code, label: a.label, description: a.description, image_url: a.imageUrl,
      auth_type: 'app', mcp_url: a.mcpUrl, refresh: a.refresh, scopes: a.scopes,
      status: row ? 'connected' : 'not_connected', account_name: row?.accountName ?? '',
      expires_at: row?.expiresAt ?? 0, connected_at: row ? Math.floor(row.connectedAt.getTime() / 1000) : 0,
    }
  })
}

async function keep(userId: string, connector: string, token: Record<string, unknown>): Promise<void> {
  const sealed = seal({ access_token: token.access_token, refresh_token: token.refresh_token, token_type: token.token_type, scope: token.scope, expires_at: token.expires_at })
  const fields = { sealed, accountName: str(token.account_name), expiresAt: Number(token.expires_at) || 0 }
  await prisma.connectorCredential.upsert({ where: { userId_connector: { userId, connector } }, create: { userId, connector, ...fields }, update: fields })
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const stateKey = (state: string): string => `cgw:state:${sha(state)}`
const pickupKey = (pickup: string): string => `cgw:pickup:${sha(pickup)}`

interface FlowState { userId: string, connector: string, pickup: string, verifier: string }
interface PickupRecord { userId: string, connector: string, status: 'pending' | 'ready' | 'failed', error?: string, token?: Record<string, unknown> }

export async function start(userId: string, connector: unknown): Promise<Record<string, unknown>> {
  const config = app(connector)
  sealKey() // A sign-in this server could not keep is not started.
  const state = STATE_PREFIX + randomBytes(24).toString('base64url')
  const pickup = randomBytes(24).toString('base64url')
  const verifier = config.pkce ? randomBytes(48).toString('base64url') : ''
  const query = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: env.CONNECTOR_REDIRECT_URI, state })
  if (config.scopes.length) query.set('scope', config.scopes.join(' '))
  for (const [key, value] of Object.entries(config.authParams)) query.set(key, value)
  if (verifier) {
    query.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    query.set('code_challenge_method', 'S256')
  }
  const flow: FlowState = { userId, connector: config.code, pickup, verifier }
  const record: PickupRecord = { userId, connector: config.code, status: 'pending' }
  await pub.multi().set(stateKey(state), JSON.stringify(flow), 'EX', TTL_SEC).set(pickupKey(pickup), JSON.stringify(record), 'EX', TTL_SEC).exec()
  return {
    connector: config.code, authorize_url: `${config.authUrl}${config.authUrl.includes('?') ? '&' : '?'}${query}`,
    pickup_code: pickup, poll_interval: POLL_INTERVAL_SEC, expires_in: TTL_SEC,
  }
}

function dig(payload: Record<string, unknown>, dotted: string): unknown {
  let node: unknown = payload
  for (const part of dotted.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  return node
}

async function tokenRequest(config: ConnectorApp, form: Record<string, string>, refresh: boolean): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
  const body = { ...form }
  if (config.authStyle === 'header') {
    headers.Authorization = 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
  } else {
    body.client_id = config.clientId
    if (config.clientSecret) body.client_secret = config.clientSecret
  }
  let response: Response
  try {
    response = await fetch((refresh && config.refreshUrl) || config.tokenUrl, {
      method: 'POST', headers, body: new URLSearchParams(body).toString(), redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch {
    throw new GatewayError('The service could not be reached. Try again.', 'PROVIDER_UNREACHABLE', 502)
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  // GitHub answers 200 with {"error": …}: the error key is checked whatever the status.
  const error = payload && typeof payload.error === 'string' ? payload.error : ''
  if (error === 'invalid_grant') throw new GatewayError('This account needs to be connected again.', 'INVALID_GRANT', 401)
  if (!response.ok || error || !payload) {
    logger.warn('connector gateway: token endpoint refused', { connector: config.code, status: response.status, error })
    throw new GatewayError('The service did not issue a token. Try again.', 'TOKEN_REFUSED', 502)
  }
  return payload
}

/** The token the computer stores (cli/src/lib/connectors/gateway.ts tokenFrom). */
function tokenFor(config: ConnectorApp, payload: Record<string, unknown>, previousRefresh = '', account = '', expiresAt = 0): Record<string, unknown> {
  const access = str(config.tokenField ? dig(payload, config.tokenField) : '') || str(payload.access_token)
  if (!access) throw new GatewayError('The service did not issue a token. Try again.', 'TOKEN_REFUSED', 502)
  const expiresIn = Number(payload.expires_in) || 0
  // Providers that do not rotate it (Google) leave the refresh token out of a refresh: keep the one held.
  const refreshToken = str(payload.refresh_token) || previousRefresh
  const token: Record<string, unknown> = {
    connector: config.code, access_token: access, refresh_token: refreshToken, token_type: str(payload.token_type) || 'Bearer',
    expires_at: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : expiresAt,
    scope: Array.isArray(payload.scope) ? payload.scope.join(' ') : str(payload.scope) || config.scopes.join(' '),
    account_name: account, refresh: config.refresh && Boolean(refreshToken),
  }
  if (config.mcpUrl) {
    const custom = config.mcpAuthHeader.startsWith('header:') ? config.mcpAuthHeader.slice('header:'.length).trim() : ''
    const headers = custom && custom.toLowerCase() !== 'authorization' ? { [custom]: access } : { Authorization: `Bearer ${access}` }
    token.mcp_entry = { url: config.mcpUrl, headers }
  }
  return token
}

/** Best effort: which account was connected, for the Connectors page. Never fails a sign-in. */
async function accountName(config: ConnectorApp, access: string): Promise<string> {
  if (!config.userinfoUrl) return ''
  try {
    const response = await fetch(config.userinfoUrl, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    if (!response.ok) return ''
    const profile = await response.json() as Record<string, unknown>
    for (const key of ['email', 'name', 'login', 'username']) if (typeof profile[key] === 'string' && profile[key]) return profile[key] as string
  } catch { /* The tokens are already good. */ }
  return ''
}

/**
 * The service's redirect, forwarded by the Autonomous web callback: exchanged once (the state is taken
 * from Redis as it is read, so a replay finds nothing), its result left for the computer's poll.
 */
export async function callback(body: { code?: unknown, state?: unknown, error?: unknown }): Promise<Record<string, unknown>> {
  const state = str(body.state)
  if (!state.startsWith(STATE_PREFIX)) throw new GatewayError('This sign-in is not Harness\'s.', 'UNKNOWN_STATE', 400)
  // GET and DEL in one transaction (GETDEL needs Redis 6.2): a replayed callback finds nothing.
  const taken = await pub.multi().get(stateKey(state)).del(stateKey(state)).exec()
  const raw = taken?.[0]?.[1] as string | null | undefined
  if (!raw) throw new GatewayError('This sign-in has ended. Start it again from Harness.', 'STATE_EXPIRED', 410)
  const flow = JSON.parse(raw) as FlowState
  const config = app(flow.connector)
  const save = (record: PickupRecord) => pub.set(pickupKey(flow.pickup), JSON.stringify(record), 'EX', TTL_SEC)
  if (body.error || !str(body.code)) {
    await save({ userId: flow.userId, connector: config.code, status: 'failed', error: str(body.error) === 'access_denied' ? 'The sign-in was cancelled.' : 'The service did not complete the sign-in.' })
    return { connector: config.code }
  }
  try {
    const form: Record<string, string> = { grant_type: 'authorization_code', code: str(body.code), redirect_uri: env.CONNECTOR_REDIRECT_URI }
    if (flow.verifier) form.code_verifier = flow.verifier
    const payload = await tokenRequest(config, form, false)
    const first = tokenFor(config, payload)
    const token = { ...first, account_name: await accountName(config, first.access_token as string) }
    await keep(flow.userId, config.code, token)
    await save({ userId: flow.userId, connector: config.code, status: 'ready', token })
  } catch (error) {
    await save({ userId: flow.userId, connector: config.code, status: 'failed', error: error instanceof GatewayError ? error.message : 'The sign-in did not finish.' })
  }
  // Never the token: the browser that carried the code is not the computer that asked.
  return { connector: config.code }
}

/** The sign-in's result, to the account that started it, exactly once. */
export async function poll(userId: string, pickupCode: unknown): Promise<Record<string, unknown>> {
  const pickup = str(pickupCode)
  const raw = pickup ? await pub.get(pickupKey(pickup)) : null
  if (!raw) return { status: 'expired' }
  const record = JSON.parse(raw) as PickupRecord
  const mine = Buffer.from(sha(record.userId)), asker = Buffer.from(sha(userId))
  if (!timingSafeEqual(mine, asker)) return { status: 'expired' }
  if (record.status === 'pending') return { status: 'pending', connector: record.connector }
  // One-time: taken as it is answered; a second poll finds it consumed.
  if (!(await pub.del(pickupKey(pickup)))) return { status: 'consumed' }
  return record.status === 'ready'
    ? { status: 'ready', ...record.token }
    : { status: 'failed', connector: record.connector, error: record.error ?? 'The sign-in did not finish.' }
}

/**
 * A new access token for the account's sign-in, renewed with the refresh token kept here (Grid's
 * `/connectors/refresh {connector}`). A provider without refresh tokens answers what is kept, until it
 * expires; a revoked one asks for connecting again and leaves the row for the next sign-in to replace.
 */
export async function refresh(userId: string, connector: unknown): Promise<Record<string, unknown>> {
  const config = app(connector)
  const row = await prisma.connectorCredential.findUnique({ where: { userId_connector: { userId, connector: config.code } } })
  if (!row) throw new GatewayError('This service is not connected. Connect it again.', 'NOT_CONNECTED', 404)
  const held = unseal(row.sealed)
  const refreshToken = str(held.refresh_token)
  if (!refreshToken || !config.refresh) {
    return tokenFor(config, { ...held, expires_in: undefined }, refreshToken, row.accountName, Number(held.expires_at) || 0)
  }
  const payload = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, true)
  const token = tokenFor(config, payload, refreshToken, row.accountName)
  await keep(userId, config.code, token)
  return token
}

/** Forget the account's sign-in here. Revoking access at the service is the service's own setting. */
export async function disconnect(userId: string, connector: unknown): Promise<Record<string, unknown>> {
  const config = app(connector)
  const { count } = await prisma.connectorCredential.deleteMany({ where: { userId, connector: config.code } })
  return { connector: config.code, disconnected: count > 0 }
}
