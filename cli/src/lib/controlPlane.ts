/**
 * The backend's REST control plane, as both the CLI's commands and the daemon call it: the base URL, one
 * bounded JSON call, and the signed-in headers. Moved out of cli.ts with the core's entry
 * (docs/design/2026-10-06-core-boundary-next.md, step 1), so the core reaches it without the CLI.
 */
import { env } from '../config/env.js'
import { AuthSessionManager, readAuthSession, type AuthSession } from './authSession.js'

// How long a control-plane call the daemon proxies for a local client (`/api/machines`, `/api/auth/me`)
// may wait on the backend. Under the desktop app's own 30s receive timeout, so a slow backend is
// reported by the daemon in words rather than by the app as a timeout.
export const PROXY_BACKEND_TIMEOUT_MS = 20_000

/** Bounds the `POST /api/grid/name` a grid set-up makes (`ensureGrid`, `harness grid login`), so a
 *  stalled control-plane connection cannot hold it open. */
export const GRID_MINT_TIMEOUT_MS = 10_000

// The REST base for control endpoints, derived from the WS URL (wss→https, ws→http).
export function backendHttpBase(): string {
  return env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

/** One control-plane call, returning the backend's `data` envelope; throws on a non-2xx / bad body.
 *  `signal` lets a caller bound the request — a bare `fetch` that accepts the TCP handshake and then
 *  never answers would otherwise await forever. */
export async function requestJson<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  // A GET/DELETE with no body must not carry a content-type — some proxies reject that pairing.
  // Always bounded: a caller that passes no signal gets the proxy's own bound, so a black-holed
  // backend (packets dropped, never refused) is an error in 20s and not a process that never exits —
  // `harness start` used to hang here, and the desktop app, waiting on that start, hung with it.
  const res = await fetch(`${backendHttpBase()}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(PROXY_BACKEND_TIMEOUT_MS),
  })
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string; code?: string } }
  if (!res.ok || json.success === false) {
    // `status` and the backend's `code` ride along, for a caller that answers a refusal differently
    // from a backend that is down.
    throw Object.assign(new Error(json.error?.message || `HTTP ${res.status}`), { status: res.status, code: json.error?.code })
  }
  return json.data as T
}

/** POST JSON to the backend and return its `data` envelope; throws on a non-2xx / bad body. */
export async function postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  return requestJson<T>('POST', path, body, headers, signal)
}

/**
 * Bearer + environment headers for a control-plane call, refreshing a stale SSO token first.
 *
 * Returns the session too, because every caller also needs `machineId` to tell THIS computer's
 * machine apart from the others in the answer.
 */
export async function controlPlaneAuth(): Promise<{ session: AuthSession; headers: Record<string, string> }> {
  const session = readAuthSession()
  if (!session) throw new Error('Not signed in. Run `harness login`.')
  const accessToken = await new AuthSessionManager(backendHttpBase()).accessToken()
  return {
    session,
    headers: { authorization: `Bearer ${accessToken}`, 'x-autonomous-env': session.autonomousEnv },
  }
}
