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
