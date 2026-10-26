import type { WifiAddon, WifiAddonOp } from '../core/api.js'

/** Local HTTP validation only. Pairing and device state stay behind the gateway and Wi-Fi ports. */
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
  machineAddonProposals(target: { after: number; waitMs: number }): unknown | Promise<unknown>
}

export interface AutonomousDeviceLocalResponse { status: number; body: unknown }

/** The add-on routes over the Wi-Fi device service's one `addon` door (core/api.ts `WifiPort.addon`). */
export function deviceAddonRoutes(ask: (op: WifiAddonOp, input: Record<string, unknown>) => Promise<WifiAddon>):
  Pick<AutonomousDeviceManagement, 'addonState' | 'addonPropose' | 'addonProposal'> {
  const call = async (op: WifiAddonOp, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const answer = await ask(op, input)
    if ('unavailable' in answer) throw Object.assign(new Error('The Wi-Fi device service is not running on this computer. See the daemon\'s log.'), { code: 'UNAVAILABLE' })
    if ('error' in answer) throw Object.assign(new Error(answer.error.message), { code: answer.error.code })
    return answer.result
  }
  return {
    addonState: (target) => call('state', target),
    addonPropose: (proposal) => call('propose', proposal),
    addonProposal: (target) => call('proposal', target),
  }
}

/** The routes of the device that is this machine, over its add-ons' one `machine_addon` door (services/machineAddons.ts). */
export function machineAddonRoutes(ask: (op: string, input: Record<string, unknown>, waitMs: number) => Promise<Record<string, unknown>>):
  Pick<AutonomousDeviceManagement, 'machineAddonHello' | 'machineAddonPublish' | 'machineAddonDecision' | 'machineAddonProposals'> {
  const call = async (op: string, input: Record<string, unknown>, waitMs = 0): Promise<Record<string, unknown>> => {
    const answer = await ask(op, input, waitMs)
    const error = answer.error
    if (typeof error === 'string') throw Object.assign(new Error('The add-ons of this machine are not running. See the daemon\'s log.'), { code: 'UNAVAILABLE' })
    if (object(error)) throw Object.assign(new Error(String(error.message)), { code: String(error.code) })
    return object(answer.result) ? answer.result : {}
  }
  return {
    machineAddonHello: () => call('hello', {}),
    machineAddonPublish: ({ values }) => call('publish', { values }),
    machineAddonDecision: (input) => call('decision', input),
    machineAddonProposals: ({ after, waitMs }) => call('proposals', { after, waitMs }, waitMs),
  }
}

const routes: Record<string, string> = {
  '/api/autonomous-device/discover': 'GET',
  '/api/autonomous-device/pair/start': 'POST',
  '/api/autonomous-device/pair/status': 'GET',
  '/api/autonomous-device/list': 'GET',
  '/api/autonomous-device/status': 'GET',
  '/api/autonomous-device/revoke': 'POST',
  '/api/autonomous-device/receipt': 'GET',
  '/api/autonomous-device/addon/state': 'GET',
  '/api/autonomous-device/addon/propose': 'POST',
  '/api/autonomous-device/addon/proposal': 'GET',
  '/api/autonomous-device/machine-addon/hello': 'POST',
  '/api/autonomous-device/machine-addon/publish': 'POST',
  '/api/autonomous-device/machine-addon/decision': 'POST',
  '/api/autonomous-device/machine-addon/proposals': 'GET',
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

/** The caller must enforce loopback, Origin refusal, and the hook credential first. */
export async function autonomousDeviceLocalRequest(
  service: AutonomousDeviceManagement, method: string, requestTarget: string, body?: unknown,
): Promise<AutonomousDeviceLocalResponse> {
  const bad = () => failure(400, 'BAD_REQUEST', 'Invalid device management request')
  let url: URL
  try {
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) return bad()
    url = new URL(requestTarget, 'http://localhost')
  } catch { return bad() }
  if (url.hash) return bad()
  const expected = routes[url.pathname]
  if (!expected) return failure(404, 'NOT_FOUND', 'Unknown device management endpoint')
  if (method !== expected) return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (method === 'GET' && body !== undefined) return bad()
  if (url.pathname !== '/api/autonomous-device/receipt' && url.pathname !== '/api/autonomous-device/machine-addon/proposals'
    && !Object.hasOwn(queries, url.pathname) && url.search) return bad()
  const input = body === undefined ? {} : body
  if (!object(input)) return bad()
  const keys = Object.keys(input)
  let call: () => unknown | Promise<unknown>
  switch (url.pathname) {
    case '/api/autonomous-device/pair/start':
      if (keys.some(key => !['code', 'device'].includes(key)) || typeof input.code !== 'string' || input.code.length > 32 || typeof input.device !== 'string' || !input.device || input.device.length > 255) return bad()
      call = () => service.pairStart({ code: input.code as string, device: input.device as string })
      break
    case '/api/autonomous-device/revoke':
      if (keys.length !== 1 || keys[0] !== 'id' || typeof input.id !== 'string' || !/^[A-F0-9]{4}(?:·[A-F0-9]{4}){3}$/.test(input.id)) return bad()
      const id = input.id
      call = () => service.revoke({ id })
      break
    case '/api/autonomous-device/receipt': {
      const query = url.searchParams
      if ([...query.keys()].some(key => key !== 'deviceId' && key !== 'idempotencyKey')
        || query.getAll('deviceId').length !== 1 || query.getAll('idempotencyKey').length !== 1) return bad()
      const id = query.get('deviceId')
      const key = query.get('idempotencyKey')
      if (!deviceId(id) || !key || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return bad()
      call = () => service.receipt({ deviceId: id, idempotencyKey: key })
      break
    }
    case '/api/autonomous-device/addon/propose':
      call = () => service.addonPropose(input)
      break
    case '/api/autonomous-device/machine-addon/publish':
      if (keys.length !== 1 || keys[0] !== 'values') return bad()
      call = () => service.machineAddonPublish({ values: input.values })
      break
    case '/api/autonomous-device/machine-addon/decision':
      if (keys.some(key => !['proposalId', 'decision', 'reason'].includes(key))) return bad()
      call = () => service.machineAddonDecision({ proposalId: input.proposalId, decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}) })
      break
    case '/api/autonomous-device/machine-addon/proposals': {
      const query = url.searchParams
      if ([...query.keys()].some(key => key !== 'after' && key !== 'waitMs') || query.getAll('after').length > 1 || query.getAll('waitMs').length > 1) return bad()
      const after = query.get('after') ?? '0', waitMs = query.get('waitMs') ?? '0'
      if (!/^\d{1,15}$/.test(after) || !/^\d{1,5}$/.test(waitMs)) return bad()
      call = () => service.machineAddonProposals({ after: Number(after), waitMs: Number(waitMs) })
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
        ? () => service.addonState(value ? { deviceId: value } : {})
        : () => service.addonProposal({ proposalId: value })
      break
    }
    default:
      if (keys.length) return bad()
      switch (url.pathname) {
        case '/api/autonomous-device/discover': call = () => service.discover(); break
        case '/api/autonomous-device/pair/status': call = () => service.pairStatus(); break
        case '/api/autonomous-device/list': call = () => service.list(); break
        case '/api/autonomous-device/machine-addon/hello': call = () => service.machineAddonHello(); break
        default: call = () => service.status()
      }
  }
  try {
    return { status: 200, body: await call() }
  } catch (error) {
    if (object(error) && typeof error.code === 'string' && Object.hasOwn(errorStatus, error.code)) {
      return failure(errorStatus[error.code], error.code,
        typeof error.message === 'string' ? error.message : 'Autonomous device management request failed')
    }
    return failure(500, 'INTERNAL_ERROR', 'Autonomous device management request failed')
  }
}
