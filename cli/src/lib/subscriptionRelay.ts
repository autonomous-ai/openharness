/**
 * The owner subscription relay: a guest's harness, running as the guest's own OS user on the
 * owner's machine, spends the OWNER's Claude or ChatGPT subscription without ever holding the
 * owner's token (docs/plans/2026-10-19-guest-machine-sharing-plan.md, "Owner subscription relay").
 *
 * - Loopback only (127.0.0.1, a random port). Every request carries a **guest token** minted here,
 *   as `Authorization: Bearer` (what Claude Code sends for `ANTHROPIC_AUTH_TOKEN` and Codex for a
 *   provider's `env_key`) or `x-api-key`. Tokens are random, held in memory, compared in constant
 *   time, and revoked per guest the moment sharing with them ends.
 * - `/claude/*` goes to the Anthropic API with the owner's OAuth bearer and the OAuth beta.
 *   `/codex/*` goes to the ChatGPT Codex backend with the owner's access token and account id.
 * - Bodies stream back as they come (SSE). An expired token is refreshed before it is spent; an
 *   upstream 401 is refreshed and retried once (`ownerSubscriptions.ts`).
 *
 * Integration seams: `startSubscriptionRelay` (the daemon starts one and keeps it), and the launch
 * contract at the bottom (`claudeRelayEnv`, `codexRelayArgs`, `codexRelayEnv`), which a guest's
 * launch merges the way `gridLaunch.ts` merges a grid's.
 *
 * ⚠️ No token — the owner's or a guest's — is ever logged or put in an error a client sees.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  expired,
  type OwnerCredential,
  type OwnerSubscriptions,
  type SubscriptionProvider,
} from './ownerSubscriptions.js'

export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com'
/**
 * Where Codex's ChatGPT sign-in sends its Responses requests. **Assumed** (not verified on this
 * machine): `https://chatgpt.com/backend-api/codex`, with `Authorization: Bearer <access token>` and
 * `ChatGPT-Account-Id`. A Codex pointed at this relay through a custom provider asks
 * `<base_url>/responses`, which lands on `<upstream>/responses`.
 */
export const CODEX_UPSTREAM = 'https://chatgpt.com/backend-api/codex'
/** The beta Anthropic requires for a Claude Code OAuth token (verified in Claude Code 2.1.283). */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'

/** The provider id a guest's Codex is pointed at, and the variable its relay token travels in. */
export const OWNER_CODEX_PROVIDER = 'harness_owner'
export const RELAY_TOKEN_VAR = 'HARNESS_RELAY_TOKEN'

/** A request body this large is not a model request. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length',
])

export interface SubscriptionRelayDeps {
  owner: OwnerSubscriptions
  fetchImpl?: typeof fetch
  upstream?: Partial<Record<SubscriptionProvider, string>>
  now?: () => number
  /** One line per request: provider, status, a short guest fingerprint. Never a token. */
  log?: (line: string) => void
}

export interface SubscriptionRelay {
  port: number
  /** `http://127.0.0.1:<port>` — the base the launch contract builds on. */
  url: string
  /** A new token for [guestEmail]; a guest may hold several (one per harness). */
  mintToken(guestEmail: string): string
  /** Every token [guestEmail] holds stops working at once. */
  revoke(guestEmail: string): void
  close(): Promise<void>
}

export async function startSubscriptionRelay(deps: SubscriptionRelayDeps): Promise<SubscriptionRelay> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const upstream = { claude: deps.upstream?.claude ?? ANTHROPIC_UPSTREAM, codex: deps.upstream?.codex ?? CODEX_UPSTREAM }
  // sha256(token) -> guest. Keyed by the digest so the secret itself is never a map key, and the
  // match is confirmed with timingSafeEqual on the digests.
  const tokens = new Map<string, { guest: string; digest: Buffer }>()

  const guestFor = (presented: string | null): string | null => {
    if (!presented) return null
    const digest = createHash('sha256').update(presented).digest()
    const entry = tokens.get(digest.toString('hex'))
    return entry && timingSafeEqual(entry.digest, digest) ? entry.guest : null
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Never the error's message: a fetch failure can carry a URL, and nothing here may echo a token.
      if (!res.headersSent) fail(res, 502, 'The subscription relay could not reach the vendor.')
      else res.destroy()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay')
    const [, first, ...rest] = url.pathname.split('/')
    const provider: SubscriptionProvider | null = first === 'claude' || first === 'codex' ? first : null
    if (!provider) return fail(res, 404, 'Unknown relay route.')
    const guest = guestFor(presentedToken(req))
    if (!guest) {
      deps.log?.(`${provider} ${req.method} ${url.pathname} → 401 · no guest`)
      return fail(res, 401, 'Not a valid guest token for this relay.')
    }

    const body = await readBody(req)
    if (body === null) return fail(res, 413, 'Request too large.')
    const target = `${upstream[provider].replace(/\/$/, '')}/${rest.join('/')}${url.search}`

    let credential = await deps.owner.read(provider)
    if (credential && expired(credential, now())) credential = await deps.owner.refresh(provider, credential)
    if (!credential) {
      // Said in the owner's log too: a guest's harness retrying this is the owner's sign-in to fix.
      deps.log?.(`${provider} ${req.method} ${url.pathname} → 503 · owner not signed in · guest ${fingerprint(guest)}`)
      return fail(res, 503, provider === 'claude'
        ? 'The owner of this computer is not signed in to Claude.'
        : 'The owner of this computer is not signed in to ChatGPT.')
    }

    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const send = (spend: OwnerCredential): Promise<Response> => fetchImpl(target, {
      method: req.method ?? 'GET',
      headers: upstreamHeaders(provider, req.headers, spend),
      body: body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? new Uint8Array(body) : undefined,
      signal: abort.signal,
    })

    let response = await send(credential)
    if (response.status === 401) {
      // Once: the owner's CLI may have rotated the token, or it lapsed early.
      const fresh = await deps.owner.refresh(provider, credential)
      if (fresh && fresh.accessToken !== credential.accessToken) {
        await response.body?.cancel().catch(() => {})
        response = await send(fresh)
      }
    }
    deps.log?.(`${provider} ${req.method} ${url.pathname} → ${response.status} · guest ${fingerprint(guest)}`)
    await pipe(response, res)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    mintToken(guestEmail) {
      const token = randomBytes(32).toString('base64url')
      const digest = createHash('sha256').update(token).digest()
      tokens.set(digest.toString('hex'), { guest: guestEmail.toLowerCase(), digest })
      return token
    },
    revoke(guestEmail) {
      const guest = guestEmail.toLowerCase()
      for (const [key, entry] of tokens) if (entry.guest === guest) tokens.delete(key)
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/** The guest token, from a bearer or an API-key header. */
function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim() || null
  const key = req.headers['x-api-key']
  return typeof key === 'string' && key.trim() ? key.trim() : null
}

/** The guest's request headers with its token taken out and the owner's put in. */
export function upstreamHeaders(
  provider: SubscriptionProvider,
  incoming: IncomingMessage['headers'],
  owner: OwnerCredential,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) || key === 'authorization' || key === 'x-api-key' || value === undefined) continue
    if (provider === 'codex' && key === 'chatgpt-account-id') continue
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }
  // Uncompressed, so the stream can be passed through as it arrives.
  headers['accept-encoding'] = 'identity'
  headers.authorization = `Bearer ${owner.accessToken}`
  if (provider === 'claude') {
    const betas = (headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean)
    if (!betas.includes(CLAUDE_OAUTH_BETA)) betas.push(CLAUDE_OAUTH_BETA)
    headers['anthropic-beta'] = betas.join(',')
  } else if (owner.accountId) {
    headers['chatgpt-account-id'] = owner.accountId
  }
  return headers
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** The vendor's answer, status and headers first, then each chunk as it arrives. */
async function pipe(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    const key = name.toLowerCase()
    if (!HOP_BY_HOP.has(key) && key !== 'content-encoding') headers[key] = value
  })
  res.writeHead(response.status, headers)
  res.flushHeaders()
  if (!response.body) { res.end(); return }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve))
    }
  } finally {
    res.end()
  }
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'harness_relay_error', message } }))
}

/** A short, stable, non-reversible label for a guest in logs. */
function fingerprint(guest: string): string {
  return createHash('sha256').update(guest).digest('hex').slice(0, 8)
}

// ── The launch contract ───────────────────────────────────────────────────────────────────────

/**
 * Claude Code pointed at the relay: `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer`, the
 * variable `gridLaunch.ts` uses for the same reason. Unlike a grid launch, web tools stay on: the
 * relay reaches the real Anthropic API. The integrator must also clear the owner-side variables a
 * guest pane might inherit (`GRID_CONFLICTING_ENV_VARS`) — the guest helper's `env -i` does.
 */
export function claudeRelayEnv(relayUrl: string, token: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: `${relayUrl.replace(/\/$/, '')}/claude`, ANTHROPIC_AUTH_TOKEN: token }
}

/**
 * Codex pointed at the relay through a provider of its own, mirroring the grid contract
 * (`gridLaunch.ts`) but WITHOUT disabling web search. The token travels in the environment under
 * `env_key`, never in argv.
 *
 * ⚠️ Codex records the provider per thread; `engines/codex/launch.ts`'s `ownProvider` handling must
 * learn `harness_owner`, as it learned `grid`, or a resume names the wrong provider.
 */
export function codexRelayArgs(relayUrl: string): string[] {
  const p = OWNER_CODEX_PROVIDER
  return [
    '-c', `model_provider="${p}"`,
    '-c', `model_providers.${p}.name="Owner subscription"`,
    '-c', `model_providers.${p}.base_url="${relayUrl.replace(/\/$/, '')}/codex"`,
    '-c', `model_providers.${p}.env_key="${RELAY_TOKEN_VAR}"`,
    '-c', `model_providers.${p}.wire_api="responses"`,
    '-c', `model_providers.${p}.supports_websockets=false`,
  ]
}

export function codexRelayEnv(token: string): Record<string, string> {
  return { [RELAY_TOKEN_VAR]: token }
}

/** The account id CLI 0.5.1 wrote into a Harness Team account's Codex `auth.json` for the relay, a sign-in Codex's own
 *  screen could not start with (`workspace routing discovery unauthorized (401)`, 2026-10-29). Read only to remove it. */
export const CODEX_RELAY_ACCOUNT = 'harness-relay'

/** Whether a parsed `auth.json` is that left-over sign-in: the relay's, not one of the account's own. */
export function isCodexRelayAuth(auth: unknown): boolean {
  const tokens = auth && typeof auth === 'object' ? (auth as { tokens?: unknown }).tokens : null
  return !!tokens && typeof tokens === 'object' && (tokens as { account_id?: unknown }).account_id === CODEX_RELAY_ACCOUNT
}
