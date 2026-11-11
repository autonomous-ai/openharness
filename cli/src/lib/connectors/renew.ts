/** Renewing tokens before they expire, once across every agent and the bridge. */
import { ConnectorError, locked, needsRefresh, refreshable, type Store, type Token } from './store.js'
import * as gateway from './gateway.js'
import * as oauth from './oauth.js'

/** Serialises renewals in this process: the file lock (store.locked) is held only around each write. */
const inFlight = new Map<string, Promise<Token>>()

/**
 * The connection's token, renewed if it is due (or forced). A revoked grant marks the connection for
 * reconnecting instead of failing every request.
 */
export function refresh(vault: Store, code: string, force = false): Promise<Token> {
  const key = `${vault.root}\0${code}`
  const running = inFlight.get(key)
  if (running) return running
  const work = renewNow(vault, code, force).finally(() => inFlight.delete(key))
  inFlight.set(key, work)
  return work
}

async function renewNow(vault: Store, code: string, force: boolean): Promise<Token> {
  const token = vault.token(code)
  if (!token) throw new ConnectorError('Not connected. Open harness connections to connect an account.')
  if (!(force && refreshable(token)) && !needsRefresh(token)) return token
  let renewed: Token
  try {
    renewed = token.source === 'gateway' ? await gateway.refresh(code, token) : await oauth.refresh(vault, token)
  } catch (error) {
    if ((error as Error).message !== 'invalid_grant') throw error
    // Why a connection asks for Reconnect: without this, a grant the service dropped leaves no trace of when or why.
    const age = token.obtained_at ? `, issued ${new Date(token.obtained_at * 1000).toISOString()}` : ''
    console.warn(`[connections] ${code}: ${token.issuer || token.source || 'the service'} refused to renew it `
      + `(${(error as ConnectorError).detail ?? 'invalid_grant'}${age})`)
    locked(vault.root, () => {
      // Another process may have renewed it with a rotated refresh token meanwhile: keep that one.
      const now = vault.token(code)
      if (now && now.refresh_token === token.refresh_token) vault.put(code, { ...now, needs_reconnect: true })
    })
    const now = vault.token(code)
    if (now && !now.needs_reconnect) return now
    throw new ConnectorError('This account needs to be connected again in Connections.')
  }
  for (const field of ['label', 'account_name'] as const) if (token[field] && !renewed[field]) renewed[field] = token[field]
  vault.save(code, renewed)
  return vault.token(code)!
}

/** Renew every connection that is due; {code: error} for the ones that failed. */
export async function refreshDue(vault: Store): Promise<Record<string, string>> {
  const failed: Record<string, string> = {}
  for (const [code, token] of Object.entries(vault.tokens())) {
    if (!needsRefresh(token)) continue
    try { await refresh(vault, code) } catch (error) { failed[code] = (error as Error).message }
  }
  return failed
}

/** How long a self-signed-in token may go unrenewed before it is renewed unasked. */
export const KEEP_ALIVE_S = 24 * 3600

/**
 * Renew every `dcr` connection last issued longer than [after] seconds ago, used or not: a service drops a refresh
 * token left unused for long (Canva, Miro and Notion did, after four weeks), and a renewal is the only thing that
 * keeps one alive. The gateway's connections are kept by the gateway. A renewal reaches the account's other
 * computers (vaultSync.ts), whose own wait starts again from it; {code: error} for the ones that failed.
 */
export async function keepAlive(vault: Store, after = KEEP_ALIVE_S, now = Date.now() / 1000): Promise<Record<string, string>> {
  const failed: Record<string, string> = {}
  for (const [code, token] of Object.entries(vault.tokens())) {
    if (token.source !== 'dcr' || !refreshable(token) || token.needs_reconnect || !token.expires_at) continue
    if (now - (token.obtained_at ?? 0) < after) continue
    try { await refresh(vault, code, true) } catch (error) { failed[code] = (error as Error).message }
  }
  return failed
}

/** A usable token for one request, renewed first when it is about to expire. */
export async function ready(vault: Store, code: string): Promise<Token> {
  let token = vault.token(code)
  if (!token) throw new ConnectorError('Not connected. Open harness connections to connect an account.')
  if (needsRefresh(token)) token = await refresh(vault, code)
  const expires = token.expires_at ?? 0
  if (token.needs_reconnect || (expires && expires <= Date.now() / 1000)) throw new ConnectorError('This account has expired. Reconnect it in Connections.')
  if (!token.access_token) throw new ConnectorError('This connection has no account token.')
  return token
}
