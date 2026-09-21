/**
 * `/api/store/*` on the local hook server: the Harness Store's ratings and reviews live in the backend,
 * and the app reaches them the way it reaches its machine list — through this daemon's own session, so
 * a local GUI never holds a token. The path is forwarded as given (query included) so the backend's own
 * validation is the one that answers.
 *
 * The rules, decided here and nowhere else: reads are ungated, like the machine list; writes (PUT and
 * DELETE) need the `x-adapter-local` header, the CSRF guard a cross-origin page cannot set without a
 * preflight this server never allows; anything else is 405.
 */

export type StoreMethod = 'GET' | 'PUT' | 'DELETE'
export type StoreOutcome = { status: number; body: unknown }
export type StoreHandler = (method: StoreMethod, path: string, body?: unknown) => Promise<StoreOutcome>

/**
 * A store path the daemon will forward: /api/store/… with nothing but id characters, slashes and a
 * query — and no `.` or `..` segment. The backend URL is built by concatenation and a `..` there is
 * resolved by fetch, so `/api/store/../machines` would reach a backend route that is not the store's.
 */
export const STORE_PATH_RE = /^\/api\/store\/(?!(?:[^?]*\/)?\.{1,2}(?:[/?]|$))[A-Za-z0-9_\-./]{1,200}(?:\?[A-Za-z0-9_\-.=&%]{0,200})?$/

export interface StoreRequest {
  method: string | undefined
  /** The request's full path, query included. */
  url: string
  /** Whether the request carries the local CSRF header. */
  localOk: boolean
  readBody: () => Promise<string>
}

/** Either the answer to send now, or the backend call to make (the caller turns a throw into a 502). */
export type StoreRoute = StoreOutcome | { forward: () => Promise<StoreOutcome> }

export async function routeStoreRequest(request: StoreRequest, store: StoreHandler | undefined): Promise<StoreRoute> {
  if (!store) return { status: 503, body: { error: 'UNAVAILABLE' } }
  const path = request.url
  if (!STORE_PATH_RE.test(path)) return { status: 400, body: { error: 'BAD_PATH' } }
  const method = request.method
  if (method === 'GET') return { forward: () => store('GET', path) }
  if (method !== 'PUT' && method !== 'DELETE') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
  if (!request.localOk) return { status: 403, body: { error: 'FORBIDDEN' } }
  if (method === 'DELETE') return { forward: () => store('DELETE', path, undefined) }
  let body: unknown
  try { body = JSON.parse(await request.readBody()) } catch { return { status: 400, body: { error: 'bad json' } } }
  return { forward: () => store('PUT', path, body) }
}
