/** Backend HTTP and the single writer of machines.json, owned by the gateway. */
import type { GatewayAccount, GatewayMachines, HttpAnswer } from '../core/api.js'
import { MachineListCache } from '../device/machineList.js'
import { AuthSessionError } from '../lib/authSession.js'
import { backendHttpBase, GRID_MINT_TIMEOUT_MS, PROXY_BACKEND_TIMEOUT_MS } from '../lib/controlPlane.js'
import { guestMachineList, withStaleMarker } from '../lib/machineListReply.js'

interface AccountHttpDeps {
  tokens: { accessToken(): Promise<string> }
  account(): GatewayAccount
  computer: { id: string; name: string; hostname: string }
  environment: string
  dataDir?: string
  request?: typeof fetch
  base?: () => string
  changed?(state: GatewayMachines): void
  reachable?(machineIds: string[] | null): void
  /** Every machine list the backend answered (its body), and null on a sign-out: the trust group reads which of the
   *  account's machines are team machines from it (lib/e2ee/machineKinds.ts). */
  listed?(body: Record<string, unknown> | null): void
  log?(line: string): void
}

const failure = (status: number, code: string, message: string): HttpAnswer =>
  ({ status, body: { success: false, error: { code, message } } })
const timedOut = (error: Error) => error?.name === 'TimeoutError' || error?.name === 'AbortError'

/** A Retry-After header as milliseconds from [now]: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  const value = header?.trim()
  if (!value) return null
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

export function createAccountHttp(deps: AccountHttpDeps) {
  const request = deps.request ?? fetch
  const accountFence = () => {
    const account = deps.account()
    return [account.machineId, account.autonomousEnv, account.signIn?.epoch, account.signIn?.acct]
  }
  /** `retryAfterMs` comes with a busy or failing answer (429, 5xx) that says when to try again: the usage
   *  reports' backoff honours it (gateway/productUsage.ts). */
  async function backend(method: string, path: string, body?: unknown, timeoutMs = PROXY_BACKEND_TIMEOUT_MS): Promise<HttpAnswer & { retryAfterMs?: number }> {
    const owner = accountFence()
    let accessToken: string
    try { accessToken = await deps.tokens.accessToken() } catch (error) {
      const signedOut = error instanceof AuthSessionError && error.code !== 'UNAVAILABLE'
      return failure(signedOut ? 401 : 502, signedOut ? 'NOT_SIGNED_IN' : 'AUTH_UNAVAILABLE', error instanceof Error ? error.message : String(error))
    }
    // Token refresh can overlap sign-out/sign-in. In particular, a queued usage report must not
    // be admitted under a different account's sharing choice after that await.
    if (accountFence().some((value, index) => value !== owner[index])) {
      return failure(409, 'ACCOUNT_CHANGED', 'The account changed. Refresh and try again.')
    }
    let res: Response
    try {
      res = await request(`${(deps.base ?? backendHttpBase)()}${path}`, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, 'x-autonomous-env': deps.account().autonomousEnv ?? deps.environment,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const e = error as Error & { cause?: { message?: string } }
      if (timedOut(e)) return timeout()
      return failure(502, 'BACKEND_UNREACHABLE', `Could not reach the Harness backend (${e.cause?.message ?? e.message}). Check the connection and try again.`)
    }
    // The timeout also covers the body: one that stalls after the headers, or a proxy's HTML page, is not an empty success.
    let answer: Record<string, unknown> = {}
    if (res.body !== null && res.headers?.get?.('content-length') !== '0') {
      try { answer = await res.json() as Record<string, unknown> } catch (error) {
        if (timedOut(error as Error)) return timeout()
        if (res.status >= 200 && res.status < 300) return failure(502, 'BACKEND_BAD_RESPONSE', `The Harness backend answered ${method} ${path} with an unreadable reply. Try again in a moment.`)
      }
    }
    const retry = res.status === 429 || res.status >= 500 ? retryAfterMs(res.headers?.get?.('retry-after') ?? null) : null
    return { status: res.status, body: answer, ...(retry !== null ? { retryAfterMs: retry } : {}) }

    function timeout(): HttpAnswer {
      return failure(504, 'BACKEND_TIMEOUT', `The Harness backend did not answer ${method} ${path} within ${timeoutMs / 1000}s. Try again in a moment.`)
    }
  }

  const cache = new MachineListCache(() => backend('GET', '/api/machines'), () => deps.computer.id,
    deps.log ?? console.warn, deps.dataDir, () => deps.account().machineId)
  cache.listen((body) => {
    const { machines, source } = cache.list()
    deps.reachable?.(source !== 'backend' ? null : machines.filter(m => m.state !== 'offline').map(m => m.machineId))
    deps.listed?.(source === 'backend' ? body : null)
    deps.changed?.({ owner: deps.account().machineId, body, fetchedAt: cache.lastResponse()?.fetchedAt ?? Date.now() })
  })
  const restored = cache.lastResponse()
  if (restored) deps.changed?.({ owner: deps.account().machineId, ...restored })

  async function machines(fallback = false): Promise<HttpAnswer> {
    const owner = deps.account().machineId
    if (!deps.account().machineId) {
      const body = guestMachineList(deps.computer.id, deps.computer.name, deps.computer.hostname)
      cache.adopt(body)
      return { status: 200, body }
    }
    if (!fallback) return (await cache.refresh()) ?? { status: 502, body: { error: { code: 'BACKEND_UNREACHABLE' } } }
    const res = await backend('GET', '/api/machines')
    if (owner !== deps.account().machineId) return failure(409, 'ACCOUNT_CHANGED', 'The account changed. Refresh and try again.')
    if (res.status === 200) { cache.adopt(res.body); return res }
    if (res.status === 401 || res.status === 403) { cache.signedOut(); return res }
    const cached = cache.lastResponse()
    return cached ? { status: 200, body: withStaleMarker(cached.body, cached.fetchedAt) } : res
  }

  async function mintGridName(): Promise<string | null> {
    const res = await backend('POST', '/api/grid/name', {}, GRID_MINT_TIMEOUT_MS)
    if (res.status < 200 || res.status >= 300 || res.body.success === false) {
      const error = res.body.error as { message?: string } | undefined
      throw new Error(error?.message || `HTTP ${res.status}`)
    }
    return (res.body.data as { gridName?: string } | undefined)?.gridName ?? null
  }

  return { backend, machines, mintGridName }
}
