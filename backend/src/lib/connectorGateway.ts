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
 * requests and answers: the account's tokens are kept here (ConnectorCredential), so any of its
 * computers renews them by naming the service, and disconnecting forgets them here. A sign-in in
 * progress (its state, PKCE verifier and, once exchanged, its one-time result for the computer) lives in
 * Redis for ten minutes, under hashed keys.
 *
 * The apps' config lives in MongoDB (`connector_apps`), edited directly or written from a file in the
 * Grid control plane's `config-connector-auth.json` shape by `npm run connectors:import <file>`. Like
 * the tokens, it is kept as it is: this database is private.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { Prisma } from '@prisma/client'
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
  /**
   * A service with no MCP server the grant can use (Gmail with gmail.send, Drive, Calendar, Figma): its
   * REST tools, which the computer serves to agents as MCP. Handed over verbatim, the token not filled in.
   */
  restEntry: Record<string, unknown> | null
  /** `mcp`, `rest`, or `''` when linking stores a credential nothing can act on: as Grid derives it. */
  transport: string
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value))

/** rest_entry and transport, as Grid reads them: the transport derived unless the config says it. */
function wiring(rest: unknown, transport: unknown, mcpUrl: string): { restEntry: Record<string, unknown> | null, transport: string } {
  const restEntry = rest && typeof rest === 'object' && !Array.isArray(rest) && Object.keys(rest).length ? rest as Record<string, unknown> : null
  return { restEntry, transport: str(transport).trim().toLowerCase() || (mcpUrl ? 'mcp' : restEntry ? 'rest' : '') }
}

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
    const mcpUrl = str(entry.mcp_url) || str(extra.mcp_url)
    apps[code] = {
      code, label: str(entry.label) || code, description: str(entry.description), imageUrl: str(entry.image_url),
      clientId: str(entry.client_id), clientSecret: str(entry.client_secret),
      authUrl: str(entry.auth_url), tokenUrl: str(entry.token_url), refreshUrl: str(entry.refresh_url), userinfoUrl: str(entry.userinfo_url),
      scopes: scopes.filter(Boolean), authStyle: str(entry.auth_style).toLowerCase(), pkce: entry.pkce === true, refresh: entry.refresh === true,
      authParams: Object.fromEntries(Object.entries((entry.auth_params ?? {}) as Record<string, unknown>).map(([k, v]) => [k, str(v)])),
      // As Grid reads them: these three live in `extra` (copied there from the device firmware's table).
      tokenField: str(entry.token_field) || str(extra.token_field), mcpUrl,
      mcpAuthHeader: str(entry.mcp_auth_header) || str(extra.mcp_auth_header),
      ...wiring(entry.rest_entry ?? extra.rest_entry, entry.transport ?? extra.transport, mcpUrl),
    }
  }
  return apps
}

const CONFIG_CACHE_MS = 60_000
let cached: { at: number, apps: Record<string, ConnectorApp> } | null = null

type AppRow = {
  code: string, label: string, description: string, imageUrl: string, clientId: string, clientSecret: string,
  authUrl: string, tokenUrl: string, refreshUrl: string, userinfoUrl: string, scopes: string[], authStyle: string,
  pkce: boolean, refresh: boolean, authParams: unknown, extra: unknown,
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

function fromRow(row: AppRow): ConnectorApp {
  const extra = record(row.extra)
  return {
    code: row.code, label: row.label || row.code, description: row.description, imageUrl: row.imageUrl,
    clientId: row.clientId, clientSecret: row.clientSecret,
    authUrl: row.authUrl, tokenUrl: row.tokenUrl, refreshUrl: row.refreshUrl, userinfoUrl: row.userinfoUrl,
    scopes: row.scopes, authStyle: row.authStyle, pkce: row.pkce, refresh: row.refresh,
    authParams: Object.fromEntries(Object.entries(record(row.authParams)).map(([k, v]) => [k, str(v)])),
    tokenField: str(extra.token_field), mcpUrl: str(extra.mcp_url), mcpAuthHeader: str(extra.mcp_auth_header),
    ...wiring(extra.rest_entry, extra.transport, str(extra.mcp_url)),
  }
}

/**
 * The services this gateway signs in to: the enabled rows of `connector_apps`, read a minute at a time
 * (a row edited in Compass or written by `npm run connectors:import` is live within a minute, no deploy).
 */
export async function apps(): Promise<Record<string, ConnectorApp>> {
  if (cached && Date.now() - cached.at < CONFIG_CACHE_MS) return cached.apps
  const rows = await prisma.connectorApp.findMany({ where: { enabled: true } }) as AppRow[]
  const loaded: Record<string, ConnectorApp> = {}
  for (const row of rows) loaded[row.code] = fromRow(row)
  cached = { at: Date.now(), apps: loaded }
  return loaded
}

/** Forget the cached apps: after an import, and in tests. */
export function resetConfig(): void { cached = null }

/**
 * Write a config-connector-auth.json document's `app` entries into `connector_apps`. Replaces a service
 * already there; leaves the others. Returns the codes written.
 */
export async function importApps(raw: string): Promise<string[]> {
  const parsed = parseConfig(raw)
  const document = record(JSON.parse(raw))
  for (const [code, config] of Object.entries(parsed)) {
    const entry = record(record(document.connectors)[code])
    const fields = {
      enabled: true, label: config.label, description: config.description, imageUrl: config.imageUrl,
      clientId: config.clientId, clientSecret: config.clientSecret,
      authUrl: config.authUrl, tokenUrl: config.tokenUrl, refreshUrl: config.refreshUrl, userinfoUrl: config.userinfoUrl,
      scopes: config.scopes, authStyle: config.authStyle, pkce: config.pkce, refresh: config.refresh,
      authParams: config.authParams,
      extra: { ...record(entry.extra), ...(config.tokenField ? { token_field: config.tokenField } : {}),
        ...(config.mcpUrl ? { mcp_url: config.mcpUrl } : {}), ...(config.mcpAuthHeader ? { mcp_auth_header: config.mcpAuthHeader } : {}),
        ...(config.restEntry ? { rest_entry: config.restEntry as Prisma.InputJsonObject } : {}), ...(str(entry.transport) ? { transport: config.transport } : {}) },
    }
    await prisma.connectorApp.upsert({ where: { code }, create: { code, ...fields }, update: fields })
  }
  resetConfig()
  return Object.keys(parsed).sort()
}

async function app(code: unknown): Promise<ConnectorApp> {
  const found = typeof code === 'string' ? (await apps())[code] : undefined
  if (!found) throw new GatewayError('This service does not sign in through Harness.', 'UNKNOWN_CONNECTOR', 404)
  return found
}

/** What the account's Connectors page lists for these services, with its own state. Never a secret. */
export async function list(userId: string): Promise<Record<string, unknown>[]> {
  const rows = await prisma.connectorCredential.findMany({ where: { userId }, select: { connector: true, accountName: true, expiresAt: true, connectedAt: true } })
  const mine = new Map(rows.map(row => [row.connector, row]))
  return Object.values(await apps()).map(a => {
    const row = mine.get(a.code)
    return {
      code: a.code, label: a.label, description: a.description, image_url: a.imageUrl,
      auth_type: 'app', mcp_url: a.mcpUrl, transport: a.transport, refresh: a.refresh, scopes: a.scopes,
      status: row ? 'connected' : 'not_connected', account_name: row?.accountName ?? '',
      expires_at: row?.expiresAt ?? 0, connected_at: row ? Math.floor(row.connectedAt.getTime() / 1000) : 0,
    }
  })
}

async function keep(userId: string, connector: string, token: Record<string, unknown>): Promise<void> {
  const fields = {
    accessToken: str(token.access_token), refreshToken: str(token.refresh_token), tokenType: str(token.token_type) || 'Bearer',
    scope: str(token.scope), accountName: str(token.account_name), expiresAt: Number(token.expires_at) || 0,
  }
  await prisma.connectorCredential.upsert({ where: { userId_connector: { userId, connector } }, create: { userId, connector, ...fields }, update: fields })
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const stateKey = (state: string): string => `cgw:state:${sha(state)}`
const pickupKey = (pickup: string): string => `cgw:pickup:${sha(pickup)}`

interface FlowState { userId: string, connector: string, pickup: string, verifier: string }
interface PickupRecord { userId: string, connector: string, status: 'pending' | 'ready' | 'failed', error?: string, token?: Record<string, unknown> }

export async function start(userId: string, connector: unknown): Promise<Record<string, unknown>> {
  const config = await app(connector)
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
  // Verbatim, the token not filled in (Grid's rest_entry_for_client): the computer fills it per call, so a
  // renewal never leaves it a stale copy. A fresh copy, since the apps are cached across requests.
  token.rest_entry = config.restEntry ? structuredClone(config.restEntry) : null
  token.transport = config.transport
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
  const config = await app(flow.connector)
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
  const config = await app(connector)
  const row = await prisma.connectorCredential.findUnique({ where: { userId_connector: { userId, connector: config.code } } })
  if (!row) throw new GatewayError('This service is not connected. Connect it again.', 'NOT_CONNECTED', 404)
  const refreshToken = row.refreshToken
  if (!refreshToken || !config.refresh) {
    const held = { access_token: row.accessToken, token_type: row.tokenType, scope: row.scope }
    return tokenFor(config, held, refreshToken, row.accountName, row.expiresAt)
  }
  const payload = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, true)
  const token = tokenFor(config, payload, refreshToken, row.accountName)
  await keep(userId, config.code, token)
  return token
}

/** Forget the account's sign-in here. Revoking access at the service is the service's own setting. */
export async function disconnect(userId: string, connector: unknown): Promise<Record<string, unknown>> {
  const config = await app(connector)
  const { count } = await prisma.connectorCredential.deleteMany({ where: { userId, connector: config.code } })
  return { connector: config.code, disconnected: count > 0 }
}
