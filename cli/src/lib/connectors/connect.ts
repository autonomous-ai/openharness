/**
 * What the Connectors page and the desktop app share: which sign-in connects a service, sign-ins in
 * progress, disconnecting, and the cards they show.
 */
import { randomBytes } from 'node:crypto'
import { services, type CatalogItem, type GatewayRow } from './catalog.js'
import { cleanHeaders, cleanUrl, CODE, ConnectorError, text, validateCode, type Status, type Store, type Token } from './store.js'
import * as gateway from './gateway.js'
import { LocalSignIn, type SignIn } from './oauth.js'
import { sync } from './agents.js'

/** The sign-in that connects CODE: the gateway's or this computer's own. */
export function signInFor(vault: Store, code: string, items: Record<string, CatalogItem>): SignIn {
  const item = items[code]
  if (!item) throw new ConnectorError('This service is not available. Run harness login to see every service.')
  return item.auth === 'app' ? new gateway.GatewaySignIn(code) : new LocalSignIn(vault, item.mcp_url!)
}

export function finish(vault: Store, code: string, token: Token, label?: string, env: NodeJS.ProcessEnv = process.env): void {
  if (label) { token.label = label; token.source = 'custom' }
  vault.save(code, token)
  try { sync(vault, env) } catch { /* An agent config that cannot be written leaves the connection saved. */ }
}

export async function disconnect(vault: Store, code: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (vault.token(code)?.source === 'gateway') await gateway.disconnect(code)
  vault.disconnect(code)
  try { sync(vault, env) } catch { /* As above. */ }
}

export function customCode(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server'
  let code = taken.has(base) ? `custom-${base}` : base
  for (let n = 2; taken.has(code); n++) code = `${base}-${n}`
  return validateCode(code)
}

interface Flow { connector: string, state: 'pending' | 'connected' | 'failed', error: string, cancel: boolean }

/** Browser sign-ins in progress, each finishing on its own. */
export class Flows {
  private readonly items = new Map<string, Flow>()
  constructor(private readonly vault: Store, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async start(code: string, signIn: SignIn, label?: string): Promise<{ flow: string, authorize_url: string | null }> {
    const authorize = await signIn.prepare()
    const flow = randomBytes(12).toString('base64url')
    const record: Flow = { connector: code, state: 'pending', error: '', cancel: false }
    // One sign-in per service: a newer one replaces a forgotten tab.
    for (const other of this.items.values()) if (other.connector === code && other.state === 'pending') other.cancel = true
    this.items.set(flow, record)
    signIn.wait(() => record.cancel).then(token => {
      finish(this.vault, code, token, label, this.env)
      record.state = 'connected'
    }, (error: Error) => {
      record.state = 'failed'
      record.error = error instanceof ConnectorError ? error.message : 'The sign-in did not finish. Try again.'
    })
    return { flow, authorize_url: authorize }
  }

  get(flow: string): { connector: string, state: string, error: string } {
    const record = this.items.get(flow)
    if (!record) throw new ConnectorError('This sign-in has ended. Try again.')
    return { connector: record.connector, state: record.state, error: record.error }
  }

  get pending(): boolean { return [...this.items.values()].some(flow => flow.state === 'pending') }
}

export type Card = Status & { description: string, auth: string, custom: boolean, reason: string }

/** The cards: every service, then connections no list names (custom servers, or ones Grid dropped). */
export function cards(vault: Store, offered: Record<string, GatewayRow>): { connections: Card[], signed_in: boolean } {
  const tokens = vault.tokens()
  const known = services(offered)
  const signedIn = gateway.backend.signedIn()
  const result: Card[] = []
  for (const [code, item] of Object.entries(known)) {
    result.push({ ...vault.status(code, item.label, tokens[code]), name: item.label, description: item.description, auth: item.auth, custom: false,
      reason: item.auth === 'dcr' || signedIn ? '' : 'Needs harness login' })
  }
  for (const [code, token] of Object.entries(tokens)) {
    if (code in known) continue
    const custom = token.source === 'custom'
    result.push({ ...vault.status(code, code, token), description: token.mcp_entry?.url ?? '', auth: custom ? 'custom' : token.source ?? 'dcr', custom, reason: '' })
  }
  return { connections: result, signed_in: signedIn }
}

/** Add custom: a remote MCP server, signed in like any other when it asks, or saved with its own headers. */
export async function addCustom(vault: Store, flows: Flows, data: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const name = text(data.name, 64).trim()
  const url = cleanUrl(typeof data.url === 'string' ? data.url.trim() : data.url)
  const headers = cleanHeaders(data.headers)
  if (!name) throw new ConnectorError('Give the server a name.')
  const taken = new Set([...Object.keys(vault.tokens()), ...Object.keys(services())])
  const code = customCode(name, taken)
  if (Object.keys(headers).length) {
    finish(vault, code, { mcp_entry: { url, headers }, obtained_at: Math.floor(Date.now() / 1000) }, name, env)
    return { connector: code, state: 'connected' }
  }
  return { connector: code, ...(await flows.start(code, new LocalSignIn(vault, url), name)) }
}

export { CODE }
