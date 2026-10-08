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
  log?(line: string): void
}

const failure = (status: number, code: string, message: string): HttpAnswer =>
  ({ status, body: { success: false, error: { code, message } } })

export function createAccountHttp(deps: AccountHttpDeps) {
  const request = deps.request ?? fetch
  async function backend(method: string, path: string, body?: unknown, timeoutMs = PROXY_BACKEND_TIMEOUT_MS): Promise<HttpAnswer> {
    let accessToken: string
    try { accessToken = await deps.tokens.accessToken() } catch (error) {
      const signedOut = error instanceof AuthSessionError && error.code !== 'UNAVAILABLE'
      return failure(signedOut ? 401 : 502, signedOut ? 'NOT_SIGNED_IN' : 'AUTH_UNAVAILABLE', error instanceof Error ? error.message : String(error))
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
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        return failure(504, 'BACKEND_TIMEOUT', `The Harness backend did not answer ${method} ${path} within ${timeoutMs / 1000}s. Try again in a moment.`)
      }
      return failure(502, 'BACKEND_UNREACHABLE', `Could not reach the Harness backend (${e.cause?.message ?? e.message}). Check the connection and try again.`)
    }
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }

  const cache = new MachineListCache(() => backend('GET', '/api/machines'), () => deps.computer.id,
    deps.log ?? console.warn, deps.dataDir, () => deps.account().machineId)
  cache.listen((body) => {
    const { machines, source } = cache.list()
    deps.reachable?.(source !== 'backend' ? null : machines.filter(m => m.state !== 'offline').map(m => m.machineId))
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
