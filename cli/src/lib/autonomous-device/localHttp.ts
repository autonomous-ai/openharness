/**
 * The Wi-Fi device's local routes (`/api/autonomous-device/*`, docs/autonomous-device-integration.md), checked by the
 * service that answers each of them: the gateway its pairings and direct links (gateway/start.ts), the Wi-Fi device's
 * service its receipts and add-ons (services/wifi.ts), and the add-ons of a device that is this machine theirs
 * (services/machineAddons.ts). The core's door checks who is calling and hands each request on as it came, to the
 * service its route names (core/serviceRoutes.ts); nothing of what a route means is the core's.
 */
import type { ServiceRequest } from '../../core/api.js'

/** What each route does. A service gives the routes it answers; one it does not is no route of its. */
export interface AutonomousDeviceManagement {
  discover(): unknown | Promise<unknown>
  pairStart(options: { code: string; device: string }): unknown | Promise<unknown>
  pairStatus(): unknown | Promise<unknown>
  list(): unknown | Promise<unknown>
  status(): unknown | Promise<unknown>
  revoke(target: { id: string }): unknown | Promise<unknown>
  receipt(target: { deviceId: string; idempotencyKey: string }): unknown | Promise<unknown>
  /** Device add-ons (lib/autonomous-device/addons.ts), which validates the proposal itself. */
  addonState(target: { deviceId?: string }): unknown | Promise<unknown>
  addonPropose(proposal: Record<string, unknown>): unknown | Promise<unknown>
  addonProposal(target: { proposalId: string }): unknown | Promise<unknown>
  /** A device that is this machine: its own add-on service (lib/autonomous-device/machineAddons.ts). */
  machineAddonHello(): unknown | Promise<unknown>
  machineAddonPublish(input: { values: unknown }): unknown | Promise<unknown>
  machineAddonDecision(input: { proposalId: unknown; decision: unknown; reason?: unknown }): unknown | Promise<unknown>
  machineAddonProposals(target: { after: number; waitMs: number; instance?: string }): unknown | Promise<unknown>
}

export interface AutonomousDeviceLocalResponse { status: number; body: unknown }

const routes: Record<string, { method: string; member: keyof AutonomousDeviceManagement }> = {
  '/api/autonomous-device/discover': { method: 'GET', member: 'discover' },
  '/api/autonomous-device/pair/start': { method: 'POST', member: 'pairStart' },
  '/api/autonomous-device/pair/status': { method: 'GET', member: 'pairStatus' },
  '/api/autonomous-device/list': { method: 'GET', member: 'list' },
  '/api/autonomous-device/status': { method: 'GET', member: 'status' },
  '/api/autonomous-device/revoke': { method: 'POST', member: 'revoke' },
  '/api/autonomous-device/receipt': { method: 'GET', member: 'receipt' },
  '/api/autonomous-device/addon/state': { method: 'GET', member: 'addonState' },
  '/api/autonomous-device/addon/propose': { method: 'POST', member: 'addonPropose' },
  '/api/autonomous-device/addon/proposal': { method: 'GET', member: 'addonProposal' },
  '/api/autonomous-device/machine-addon/hello': { method: 'POST', member: 'machineAddonHello' },
  '/api/autonomous-device/machine-addon/publish': { method: 'POST', member: 'machineAddonPublish' },
  '/api/autonomous-device/machine-addon/decision': { method: 'POST', member: 'machineAddonDecision' },
  '/api/autonomous-device/machine-addon/proposals': { method: 'GET', member: 'machineAddonProposals' },
}

/** The routes that take a query string, and the one parameter each may carry. */
const queries: Record<string, { name: string; required: boolean; valid: (value: string) => boolean }> = {
  '/api/autonomous-device/addon/state': { name: 'deviceId', required: false, valid: v => v.length > 0 && v.length <= 64 },
  '/api/autonomous-device/addon/proposal': { name: 'proposalId', required: true, valid: v => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) },
}

const errorStatus: Record<string, number> = {
  BAD_REQUEST: 400, UNKNOWN_DEVICE: 404, ALREADY_PAIRED: 409, BUSY: 409,
  DEVICE_NOT_FOUND: 404, BAD_CODE: 400, NO_INTENT: 409, STALE_PAIR: 409, CODE_MISMATCH: 403, BACKEND_DOWN: 503, TIMEOUT: 504, RATE_LIMITED: 429, EXPIRED: 410, CANCELLED: 409,
  LOCAL_NETWORK_BLOCKED: 503, UNAVAILABLE: 503,
  INVALID_REQUEST: 400, PAYLOAD_TOO_LARGE: 413, MISSING_TARGET: 409, DEVICE_OFFLINE: 409, IDEMPOTENCY_CONFLICT: 409, BACKPRESSURE: 429,
  PROPOSAL_UNKNOWN: 404, OUTCOME_UNKNOWN: 504,
}

function failure(status: number, code: string, message: string): AutonomousDeviceLocalResponse {
  return { status, body: { error: { code, message } } }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deviceId(value: unknown): value is string {
  // Autonomous device identities are canonical base64 Ed25519 public keys (32 bytes).
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value
}

/**
 * One route's answer. A refusal is an error with a code: its status by that code, or a 500 for a code this table does
 * not know. An error with no code is the service failing, and is thrown on: its route answers for it as it does for a
 * service that is down (core/api.ts `SERVICE_HTTP_ROUTES`), since what failed may have been done.
 */
export async function autonomousDeviceLocalRequest(
  service: Partial<AutonomousDeviceManagement>, method: string, requestTarget: string, body?: unknown,
): Promise<AutonomousDeviceLocalResponse> {
  const bad = () => failure(400, 'BAD_REQUEST', 'Invalid device management request')
  let url: URL
  try {
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) return bad()
    url = new URL(requestTarget, 'http://localhost')
  } catch { return bad() }
  if (url.hash) return bad()
  const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined
  if (!route || !service[route.member]) return failure(404, 'NOT_FOUND', 'Unknown device management endpoint')
  if (method !== route.method) return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (method === 'GET' && body !== undefined) return bad()
  if (url.pathname !== '/api/autonomous-device/receipt' && url.pathname !== '/api/autonomous-device/machine-addon/proposals'
    && !Object.hasOwn(queries, url.pathname) && url.search) return bad()
  const input = body === undefined ? {} : body
  if (!object(input)) return bad()
  const keys = Object.keys(input)
  const own = service as AutonomousDeviceManagement
  let call: () => unknown | Promise<unknown>
  switch (url.pathname) {
    case '/api/autonomous-device/pair/start':
      if (keys.some(key => !['code', 'device'].includes(key)) || typeof input.code !== 'string' || input.code.length > 32 || typeof input.device !== 'string' || !input.device || input.device.length > 255) return bad()
      call = () => own.pairStart({ code: input.code as string, device: input.device as string })
      break
    case '/api/autonomous-device/revoke':
      if (keys.length !== 1 || keys[0] !== 'id' || typeof input.id !== 'string' || !/^[A-F0-9]{4}(?:·[A-F0-9]{4}){3}$/.test(input.id)) return bad()
      const id = input.id
      call = () => own.revoke({ id })
      break
    case '/api/autonomous-device/receipt': {
      const query = url.searchParams
      if ([...query.keys()].some(key => key !== 'deviceId' && key !== 'idempotencyKey')
        || query.getAll('deviceId').length !== 1 || query.getAll('idempotencyKey').length !== 1) return bad()
      const id = query.get('deviceId')
      const key = query.get('idempotencyKey')
      if (!deviceId(id) || !key || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return bad()
      call = () => own.receipt({ deviceId: id, idempotencyKey: key })
      break
    }
    case '/api/autonomous-device/addon/propose':
      call = () => own.addonPropose(input)
      break
    case '/api/autonomous-device/machine-addon/publish':
      if (keys.length !== 1 || keys[0] !== 'values') return bad()
      call = () => own.machineAddonPublish({ values: input.values })
      break
    case '/api/autonomous-device/machine-addon/decision':
      if (keys.some(key => !['proposalId', 'decision', 'reason'].includes(key))) return bad()
      call = () => own.machineAddonDecision({ proposalId: input.proposalId, decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}) })
      break
    case '/api/autonomous-device/machine-addon/proposals': {
      const query = url.searchParams
      if ([...query.keys()].some(key => !['after', 'waitMs', 'instance'].includes(key))
        || ['after', 'waitMs', 'instance'].some(key => query.getAll(key).length > 1)) return bad()
      const after = query.get('after') ?? '0', waitMs = query.get('waitMs') ?? '0', instance = query.get('instance')
      if (!/^\d{1,15}$/.test(after) || !/^\d{1,5}$/.test(waitMs) || (instance !== null && !/^[0-9a-f-]{36}$/i.test(instance))) return bad()
      call = () => own.machineAddonProposals({ after: Number(after), waitMs: Number(waitMs), ...(instance ? { instance } : {}) })
      break
    }
    case '/api/autonomous-device/addon/state':
    case '/api/autonomous-device/addon/proposal': {
      const rule = queries[url.pathname]
      const query = url.searchParams
      const values = query.getAll(rule.name)
      if ([...query.keys()].some(key => key !== rule.name) || values.length > 1 || (rule.required && !values.length)
        || (values.length && !rule.valid(values[0]))) return bad()
      const value = values[0]
      call = url.pathname === '/api/autonomous-device/addon/state'
        ? () => own.addonState(value ? { deviceId: value } : {})
        : () => own.addonProposal({ proposalId: value })
      break
    }
    default:
      if (keys.length) return bad()
      call = () => own[route.member as 'discover' | 'pairStatus' | 'list' | 'status' | 'machineAddonHello']()
  }
  try {
    return { status: 200, body: await call() }
  } catch (error) {
    if (!object(error) || typeof error.code !== 'string') throw error
    if (Object.hasOwn(errorStatus, error.code)) {
      return failure(errorStatus[error.code], error.code,
        typeof error.message === 'string' ? error.message : 'Autonomous device management request failed')
    }
    return failure(500, 'INTERNAL_ERROR', 'Autonomous device management request failed')
  }
}

/** A refusal a route's answer carries, by its code (`errorStatus`). */
export function deviceRefusal(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * A service's answer to the device routes it gives, as the core's door hands them on (core/serviceRoutes.ts): the
 * method, the target as the client sent it, and the body as text, for a method that carries one. Only this computer's
 * owner, on this computer: the door's caller, or a client of the local WebSocket, whose door asks the same (the private
 * socket, or loopback with no Origin and the daemon's local credential, from this account: localWsServer.ts). A frame
 * of this type from a remote client or a guest is refused as the door refuses.
 */
export function deviceRoutes(service: Partial<AutonomousDeviceManagement>): ServiceRequest {
  return async (payload, asker) => {
    if (!asker.local || !asker.owner || asker.guest !== undefined) return { ...failure(403, 'FORBIDDEN', 'Authenticated native loopback client required') }
    let body: unknown
    if (typeof payload.body === 'string') {
      try { body = JSON.parse(payload.body) } catch { return { ...failure(400, 'BAD_REQUEST', 'Invalid JSON body') } }
    }
    const method = typeof payload.method === 'string' ? payload.method : ''
    const target = typeof payload.target === 'string' ? payload.target : ''
    return { ...await autonomousDeviceLocalRequest(service, method, target, body) }
  }
}
