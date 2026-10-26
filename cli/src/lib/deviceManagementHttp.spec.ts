import { describe, expect, it, vi } from 'vitest'
import { autonomousDeviceLocalRequest, deviceAddonRoutes, type AutonomousDeviceManagement } from './deviceManagementHttp.js'

const id = Buffer.alloc(32, 255).toString('base64')
function fixture() {
  return {
    discover: vi.fn().mockReturnValue({ devices: [] }),
    pairStart: vi.fn().mockResolvedValue({ state: 'running' }),
    pairStatus: vi.fn().mockReturnValue({ state: 'waiting' }),
    list: vi.fn().mockReturnValue({ devices: [] }),
    status: vi.fn().mockReturnValue({ proto: 1 }),
    revoke: vi.fn().mockReturnValue({ revoked: 1 }),
    receipt: vi.fn().mockReturnValue({ receipt: null }),
    addonState: vi.fn().mockReturnValue({ devices: [] }),
    addonPropose: vi.fn().mockReturnValue({ proposal: { proposalId: 'p' } }),
    addonProposal: vi.fn().mockReturnValue({ proposal: null }),
    machineAddonHello: vi.fn().mockReturnValue({ topics: 0 }),
    machineAddonPublish: vi.fn().mockReturnValue({ topics: 1 }),
    machineAddonDecision: vi.fn().mockReturnValue({ proposalId: 'p', state: 'kept' }),
    machineAddonProposals: vi.fn().mockResolvedValue({ proposals: [], next: 0 }),
  } satisfies AutonomousDeviceManagement
}

describe('the device that is this machine: its own add-on service', () => {
  it('takes a hello, a publish, a decision and a take of its proposals, and nothing else in their bodies or queries', async () => {
    const service = fixture()
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/machine-addon/hello')).toEqual({ status: 200, body: { topics: 0 } })
    const values = [{ topic: 'voice/state', value: { state: 'listening' } }]
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/machine-addon/publish', { values })).status).toBe(200)
    expect(service.machineAddonPublish).toHaveBeenCalledWith({ values })
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/machine-addon/publish', { values, extra: 1 })).status).toBe(400)
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/machine-addon/decision', { proposalId: 'p', decision: 'kept', reason: 'quiet' })).status).toBe(200)
    expect(service.machineAddonDecision).toHaveBeenCalledWith({ proposalId: 'p', decision: 'kept', reason: 'quiet' })
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/machine-addon/decision', { proposalId: 'p', decision: 'kept', who: 'x' })).status).toBe(400)
    expect(await autonomousDeviceLocalRequest(service, 'GET', '/api/autonomous-device/machine-addon/proposals?after=3&waitMs=20000')).toEqual({ status: 200, body: { proposals: [], next: 0 } })
    expect(service.machineAddonProposals).toHaveBeenLastCalledWith({ after: 3, waitMs: 20000 })
    await autonomousDeviceLocalRequest(service, 'GET', '/api/autonomous-device/machine-addon/proposals')
    expect(service.machineAddonProposals).toHaveBeenLastCalledWith({ after: 0, waitMs: 0 })
    for (const query of ['?after=-1', '?after=1&after=2', '?waitMs=123456', '?other=1']) {
      expect((await autonomousDeviceLocalRequest(service, 'GET', `/api/autonomous-device/machine-addon/proposals${query}`)).status).toBe(400)
    }
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/machine-addon/hello', { x: 1 })).status).toBe(400)
  })
})

describe('device local management validation', () => {
  it('passes the human-entered device code and returns service data without an extra envelope', async () => {
    const service = fixture()
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', { code: 'ABC234', device: 'os._autonomous._tcp.local' }))
      .toEqual({ status: 200, body: { state: 'running' } })
    expect(service.pairStart).toHaveBeenCalledWith({ code: 'ABC234', device: 'os._autonomous._tcp.local' })
  })

  it.each([null, [], true, { replace: 'true' }, { replace: 1 }, { replace: true, all: true }])(
    'never opens a pairing window for invalid input %j', async body => {
      const service = fixture()
      expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', body)).status).toBe(400)
      expect(service.pairStart).not.toHaveBeenCalled()
    },
  )

  it.each([{}, { all: false }, { all: 'true' }, { all: true, id }, { id: '' }, { id: 'unknown' }, { id, replace: true }])(
    'never revokes for ambiguous or invalid input %j', async body => {
      const service = fixture()
      expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/revoke', body)).status).toBe(400)
      expect(service.revoke).not.toHaveBeenCalled()
    },
  )

  it('revokes only a full existing-manager fingerprint and refuses blanket all', async () => {
    const service = fixture(), fingerprint = 'ABCD·1234·5678·90EF'
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/revoke', { id: fingerprint })).status).toBe(200)
    expect(service.revoke).toHaveBeenCalledWith({ id: fingerprint })
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/revoke', { all: true })).status).toBe(400)
  })

  it('decodes escaped identity characters and scopes receipt lookup to both identifiers', async () => {
    const service = fixture()
    const query = new URLSearchParams({ deviceId: id, idempotencyKey: 'device-1' })
    expect(await autonomousDeviceLocalRequest(service, 'GET', `/api/autonomous-device/receipt?${query}`))
      .toEqual({ status: 200, body: { receipt: null } })
    expect(service.receipt).toHaveBeenCalledWith({ deviceId: id, idempotencyKey: 'device-1' })
  })

  it.each([
    '', 'deviceId=x&idempotencyKey=y',
    `deviceId=${encodeURIComponent(id)}&idempotencyKey=x&idempotencyKey=y`,
    `deviceId=${encodeURIComponent(id)}&idempotencyKey=x&all=true`,
    `deviceId=${encodeURIComponent(id)}&idempotencyKey=${'x'.repeat(65)}`,
    `deviceId=${encodeURIComponent(id)}&idempotencyKey=a%20b`,
  ])('refuses malformed or duplicate receipt query %s', async query => {
    const service = fixture()
    expect((await autonomousDeviceLocalRequest(service, 'GET', `/api/autonomous-device/receipt?${query}`)).status).toBe(400)
    expect(service.receipt).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', '/api/autonomous-device/pair/start', undefined, 405],
    ['POST', '/api/autonomous-device/unknown', undefined, 404],
    ['GET', '/api/autonomous-device/status?all=true', undefined, 400],
    ['GET', '/api/autonomous-device/status', {}, 400],
    ['POST', '/api/autonomous-device/pair/cancel', { all: true }, 404],
    ['GET', '//other/api/autonomous-device/status', undefined, 400],
  ])('rejects unsupported routing %s %s', async (method, path, body, status) => {
    const service = fixture()
    expect((await autonomousDeviceLocalRequest(service, method as string, path as string, body)).status).toBe(status)
    for (const handler of Object.values(service)) expect(handler).not.toHaveBeenCalled()
  })

  it('maps already-paired to conflict and hides unexpected internal errors', async () => {
    const service = fixture()
    service.pairStart.mockRejectedValue(Object.assign(new Error('A device is already paired'), { code: 'ALREADY_PAIRED' }))
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', { code: 'ABC234', device: 'os._autonomous._tcp.local' }))
      .toEqual({ status: 409, body: { error: { code: 'ALREADY_PAIRED', message: 'A device is already paired' } } })
    service.pairStart.mockRejectedValue(new Error('secret-file-content'))
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', { code: 'ABC234', device: 'os._autonomous._tcp.local' }))
      .toEqual({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Autonomous device management request failed' } } })
  })

  it('names a blocked local network so the app can say where to allow it', async () => {
    const service = fixture()
    service.discover.mockRejectedValue(Object.assign(new Error('Harness is not allowed to use the local network.'), { code: 'LOCAL_NETWORK_BLOCKED' }))
    expect(await autonomousDeviceLocalRequest(service, 'GET', '/api/autonomous-device/discover'))
      .toEqual({ status: 503, body: { error: { code: 'LOCAL_NETWORK_BLOCKED', message: 'Harness is not allowed to use the local network.' } } })
  })

  it('routes all read-only and cancel operations', async () => {
    const service = fixture()
    for (const [method, path, name] of [
      ['GET', 'pair/status', 'pairStatus'],
      ['GET', 'list', 'list'], ['GET', 'status', 'status'],
    ] as const) {
      expect((await autonomousDeviceLocalRequest(service, method, `/api/autonomous-device/${path}`)).status).toBe(200)
      expect(service[name]).toHaveBeenCalledOnce()
    }
  })
})

describe('device add-on local routes', () => {
  it('reads state with an optional device, a proposal by id, and posts a proposal as given', async () => {
    const service = fixture()
    expect(await autonomousDeviceLocalRequest(service, 'GET', '/api/autonomous-device/addon/state')).toEqual({ status: 200, body: { devices: [] } })
    expect(service.addonState).toHaveBeenLastCalledWith({})
    await autonomousDeviceLocalRequest(service, 'GET', '/api/autonomous-device/addon/state?deviceId=lamp')
    expect(service.addonState).toHaveBeenLastCalledWith({ deviceId: 'lamp' })
    const id = '0b6c3c3e-8f3a-4f5a-9d2b-6f1e2a3b4c5d'
    expect((await autonomousDeviceLocalRequest(service, 'GET', `/api/autonomous-device/addon/proposal?proposalId=${id}`)).status).toBe(200)
    expect(service.addonProposal).toHaveBeenCalledWith({ proposalId: id })
    const body = { addon: 'x', idempotencyKey: 'k', act: 'light', holdsMs: 5000 }
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/addon/propose', body)).toEqual({ status: 200, body: { proposal: { proposalId: 'p' } } })
    expect(service.addonPropose).toHaveBeenCalledWith(body)
  })

  it('refuses a wrong method, a stray or repeated parameter, and a missing or malformed proposal id', async () => {
    const service = fixture()
    for (const [method, target] of [
      ['POST', '/api/autonomous-device/addon/state'],
      ['GET', '/api/autonomous-device/addon/propose'],
    ] as const) expect((await autonomousDeviceLocalRequest(service, method, target, method === 'POST' ? {} : undefined)).status).toBe(405)
    for (const target of [
      '/api/autonomous-device/addon/state?device=lamp',
      '/api/autonomous-device/addon/state?deviceId=a&deviceId=b',
      '/api/autonomous-device/addon/state?deviceId=',
      '/api/autonomous-device/addon/proposal',
      '/api/autonomous-device/addon/proposal?proposalId=nope',
    ]) expect((await autonomousDeviceLocalRequest(service, 'GET', target)).status).toBe(400)
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/addon/propose?x=1', {})).status).toBe(400)
    expect(service.addonState).not.toHaveBeenCalled()
    expect(service.addonPropose).not.toHaveBeenCalled()
    expect(service.addonProposal).not.toHaveBeenCalled()
  })

  it('maps the add-on layer and the service being down to HTTP answers', async () => {
    const answers = [
      { error: { code: 'RATE_LIMITED', message: 'slow down' } },
      { error: { code: 'MISSING_TARGET', message: 'name one' } },
      { error: { code: 'PAYLOAD_TOO_LARGE', message: 'too big' } },
      { unavailable: true as const },
      { error: { code: 'OUTCOME_UNKNOWN', message: 'maybe sent' } },
      { error: { code: 'PROPOSAL_UNKNOWN', message: 'aged out' } },
      { result: { proposal: null } },
    ]
    const routes = deviceAddonRoutes(async () => answers.shift()!)
    const service = { ...fixture(), ...routes }
    const post = () => autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/addon/propose', {})
    expect(await post()).toEqual({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } } })
    expect((await post()).status).toBe(409)
    expect((await post()).status).toBe(413)
    expect((await post()).body).toMatchObject({ error: { code: 'UNAVAILABLE' } })
    expect((await post()).status).toBe(504)
    expect((await post()).status).toBe(404)
    expect(await post()).toEqual({ status: 200, body: { proposal: null } })
  })
})
