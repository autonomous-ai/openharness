/**
 * The account's routes of the daemon's local door (core/api.ts `SERVICE_HTTP_ROUTES`), answered here, by the gateway,
 * which holds the account's sign-in and makes every backend call: the desk and its tab edits, Agent Messages' tabs, the
 * account's name, the phone half of a sign-in, the product usage feedback, choice and reports, a machine's rename and
 * delete, and the Harness Store's ratings and reviews. They were the door's own (hookServer.ts) until the core audit of
 * 2026-11-12 (section 2) moved them, as they were: the core's door checks the caller and that a write carries the local
 * header (core/serviceRoutes.ts), and hands each on as it came; what each takes is checked here, what it forwards is
 * only what it took, and its answer is the backend's as it gave it. Each answers byte for byte as it did in the door, its
 * own words for a body that is not JSON included (e2e/accountRoutes.e2e.ts).
 */
import type { HttpAnswer, ServiceRequest } from '../core/api.js'
import { appProductUsageReport } from '../lib/appProductUsageReport.js'
import { PRODUCT_FEEDBACK } from '../lib/productUsageContract.js'

/** A call of the account's backend, as the gateway makes it (gateway/start.ts `ops.backend`). */
export type AccountBackend = (method: string, path: string, body?: unknown) => Promise<HttpAnswer>

/**
 * A Store path the daemon will forward: /api/store/… with nothing but id characters, slashes and a query, and no `.` or
 * `..` segment. The backend URL is built by concatenation and a `..` there is resolved by fetch, so `/api/store/../machines`
 * would reach a backend route that is not the Store's.
 */
export const STORE_PATH_RE = /^\/api\/store\/(?!(?:[^?]*\/)?\.{1,2}(?:[/?]|$))[A-Za-z0-9_\-./]{1,200}(?:\?[A-Za-z0-9_\-.=&%]{0,200})?$/

/** A usage report's body is read only up to 8 KiB, as the door read it: past it, it is no report. */
const REPORT_MAX_BYTES = 8192
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const TAB = /^\/api\/agent-messages\/tabs\/([A-Za-z0-9_-]{1,64})$/
const SIGN_IN = /^\/api\/auth\/qr\/(lookup|approve|deny)$/

const answer = (status: number, body: Record<string, unknown>): HttpAnswer => ({ status, body })
const NOT_FOUND = answer(404, { error: 'not found' })
const BAD_REQUEST = answer(400, { error: 'BAD_REQUEST' })
const BAD_JSON = answer(400, { error: 'bad json' })
const INVALID_JSON = answer(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } })

/** What a route does: answer now, or call the backend. */
type Route = HttpAnswer | (() => Promise<HttpAnswer>)

/** The body read as JSON, or none. */
const parsed = (text: string | undefined): { value: unknown } | null => {
  try { return { value: JSON.parse(text ?? '') } } catch { return null }
}

/** A backend's answer as the door wrote it from the gateway's process: a body that is no record (`null`, a list) as `{}`. */
const recorded = (result: HttpAnswer): HttpAnswer =>
  (result.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result : { ...result, body: {} })

function routeOf(backend: AccountBackend, method: string, target: string, text: string | undefined): Route {
  const path = target.split('?')[0]
  const forward = (to: string, body?: unknown): Route => async () => recorded(await backend(method, to, body))
  /** The body as JSON, then what [then] makes of it; [bad] when it is not JSON, in the route's own words. */
  const json = (bad: HttpAnswer, then: (value: unknown) => Route): Route => {
    const read = parsed(text)
    return read ? then(read.value) : bad
  }
  if (method === 'GET' && (path === '/api/desk' || path === '/api/agent-messages' || path === '/api/auth/me' || path === '/api/product-usage/settings')) return forward(path)
  // The window's tab edits (backend routes/desk.ts), which it hears everyone else's as `desk_changed`, and the account's
  // name (`{ name }`, task #2654), which the backend checks and answers as GET does.
  if ((method === 'POST' && path === '/api/desk/ops') || (method === 'PATCH' && path === '/api/auth/me')) return json(INVALID_JSON, (value) => forward(path, value))
  // An older window's tab switch for Agent Messages, passed on so it gets the answer it expects: the account's experiment
  // decides, so it wakes nothing.
  const tab = method === 'PATCH' ? TAB.exec(path) : null
  if (tab) return json(INVALID_JSON, (value) => forward(`/api/agent-messages/tabs/${tab[1]}`, value))
  // The phone half of a sign-in (backend routes/qrSignIn.ts) for a device that says its code aloud (a lamp, #1410): the
  // code and nothing else, since whose account approves is this computer's sign-in, never the caller's.
  const signIn = method === 'POST' ? SIGN_IN.exec(path) : null
  if (signIn) return json(BAD_REQUEST, (value) => {
    const code = (value as { code?: unknown } | null)?.code
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || typeof code !== 'string' || code.length < 1 || code.length > 128) return BAD_REQUEST
    return forward(`/api/auth/qr/${signIn[1]}`, { code })
  })
  // Voluntary fixed-choice feedback, and the choice itself: their own shapes, nothing else.
  if (method === 'POST' && path === '/api/product-usage/feedback') return json(BAD_REQUEST, (value) => {
    const feedback = value as { answer?: unknown; id?: unknown } | null
    if (!feedback || typeof feedback !== 'object' || Object.keys(feedback).length !== 2 || !PRODUCT_FEEDBACK.includes(feedback.answer as never)
      || typeof feedback.id !== 'string' || !UUID.test(feedback.id)) return BAD_REQUEST
    return forward(path, feedback)
  })
  if (method === 'POST' && path === '/api/product-usage/settings') return json(BAD_REQUEST, (value) => {
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || typeof (value as { enabled?: unknown }).enabled !== 'boolean') return BAD_REQUEST
    return forward(path, value)
  })
  if (method === 'POST' && path === '/api/product-usage/report') return report(backend, text)
  // A machine's rename and delete. A machine id that does not decode, or a rename's body of `null`, throws here as it did
  // in the door, and is answered as it was there (`accountRoutes`).
  if ((method === 'PATCH' || method === 'DELETE') && path.startsWith('/api/machines/')) {
    const machineId = decodeURIComponent(path.slice('/api/machines/'.length))
    if (!machineId) return answer(400, { error: 'MISSING_MACHINE_ID' })
    const to = `/api/machines/${encodeURIComponent(machineId)}`
    if (method === 'DELETE') return forward(to)
    return json(BAD_JSON, (value) => {
      const name = (value as { name?: unknown }).name
      return name ? forward(to, { name }) : answer(400, { error: 'MISSING_NAME' })
    })
  }
  // The Harness Store's ratings and reviews, its path forwarded as given, query included, so the backend's own checks
  // answer: reads, and a review put or deleted (the door asked a write's local header).
  if (path.startsWith('/api/store/')) {
    if (!STORE_PATH_RE.test(target)) return answer(400, { error: 'BAD_PATH' })
    if (method === 'GET' || method === 'DELETE') return forward(target)
    if (method !== 'PUT') return answer(405, { error: 'METHOD_NOT_ALLOWED' })
    return json(BAD_JSON, (value) => forward(target, value))
  }
  return NOT_FOUND
}

/**
 * The Desktop's usage report, forwarded without the names this contract does not know yet (lib/appProductUsageReport.ts),
 * and a busy backend's Retry-After with its answer, which the Desktop waits out (desktop/lib/measurement/
 * product_measurement.dart). Its route names the vocabulary on every answer (core/api.ts `APP_USAGE_VOCABULARY`).
 */
function report(backend: AccountBackend, text: string | undefined): Route {
  const read = parsed(text !== undefined && Buffer.byteLength(text) > REPORT_MAX_BYTES ? '' : text)
  const checked = read ? appProductUsageReport(read.value) : undefined
  if (!checked) return BAD_REQUEST
  return async () => {
    let result: HttpAnswer
    try { result = await backend('POST', '/api/product-usage/report', checked) } catch {
      return answer(502, { success: false, error: { code: 'USAGE_UNAVAILABLE', message: 'Product usage unavailable' } })
    }
    const retry = result.retryAfterMs
    return { ...recorded({ status: result.status, body: result.body }), ...(retry !== undefined ? { headers: { 'retry-after': String(Math.ceil(retry / 1000)) } } : {}) }
  }
}

/**
 * The account's routes, answered: [method] and [target] as the client sent them, [text] the body as the door read it.
 * Nothing is thrown: what threw in the door's own code (a machine id that does not decode) is the 500 its catch-all
 * gave, and a backend call that throws is the 502 its proxy gave, each said in this process's log.
 */
export function accountRoutes(backend: AccountBackend, log: (line: string) => void = (line) => console.error(line)) {
  return async (method: string, target: string, text?: string): Promise<HttpAnswer> => {
    const said = `${method} ${target.split('?')[0].slice(0, 80)}`
    let route: Route
    try { route = routeOf(backend, method, target, text) } catch (error) {
      log(`[gateway] ${said} failed: ${error instanceof Error ? error.message : String(error)}`)
      return answer(500, { error: 'INTERNAL' })
    }
    if (typeof route !== 'function') return route
    try { return await route() } catch (error) {
      log(`[gateway] ${said} failed: ${error instanceof Error ? error.message : String(error)}`)
      return answer(502, { success: false, error: { code: 'PROXY_FAILED', message: error instanceof Error ? error.message : 'INTERNAL' } })
    }
  }
}

/**
 * The gateway's one request for its routes of the door (`gateway_http`, core/api.ts `GATEWAY_REQUESTS`): the Wi-Fi
 * device's to their own handler (lib/autonomous-device/localHttp.ts), the account's to [account]. Only this computer's
 * owner, on this computer: the door's caller, or a client of the local WebSocket, whose door asks the same
 * (localWsServer.ts); a remote client or a guest is refused as the door refuses a write.
 */
export function gatewayHttp(device: ServiceRequest, account: ReturnType<typeof accountRoutes>): ServiceRequest {
  return async (payload, asker, closed) => {
    const target = typeof payload.target === 'string' ? payload.target : ''
    if (target.startsWith('/api/autonomous-device/')) return device(payload, asker, closed)
    if (!asker.local || !asker.owner || asker.guest !== undefined) return { status: 403, body: { error: 'FORBIDDEN' } }
    const method = typeof payload.method === 'string' ? payload.method : ''
    return { ...await account(method, target, typeof payload.body === 'string' ? payload.body : undefined) }
  }
}
