import { describe, expect, it, vi } from 'vitest'
import { autonomousDeviceLocalRequest, deviceRefusal, deviceRoutes, type AutonomousDeviceManagement } from './localHttp.js'

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
    const instance = '0f8fad5b-d9cb-469f-a165-70867728950e'
    await autonomousDeviceLocalRequest(service, 'GET', `/api/autonomous-device/machine-addon/proposals?after=1&instance=${instance}`)
    expect(service.machineAddonProposals).toHaveBeenLastCalledWith({ after: 1, waitMs: 0, instance })
    for (const query of ['?after=-1', '?after=1&after=2', '?waitMs=123456', '?other=1', '?instance=nope', `?instance=${'a'.repeat(36)}&instance=x`]) {
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

  it('maps already-paired to conflict and hides what an internal failure says', async () => {
    const service = fixture()
    service.pairStart.mockRejectedValue(Object.assign(new Error('A device is already paired'), { code: 'ALREADY_PAIRED' }))
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', { code: 'ABC234', device: 'os._autonomous._tcp.local' }))
      .toEqual({ status: 409, body: { error: { code: 'ALREADY_PAIRED', message: 'A device is already paired' } } })
    service.pairStart.mockRejectedValue(deviceRefusal('INTERNAL', 'secret-file-content'))
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

  it('says a refusal under its code, an unknown code as internal, and throws on a failure with no code', async () => {
    const service = fixture()
    const post = () => autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/addon/propose', {})
    service.addonPropose.mockImplementationOnce(() => { throw deviceRefusal('RATE_LIMITED', 'slow down') })
    expect(await post()).toEqual({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } } })
    for (const [code, status] of [['MISSING_TARGET', 409], ['PAYLOAD_TOO_LARGE', 413], ['UNAVAILABLE', 503], ['OUTCOME_UNKNOWN', 504], ['PROPOSAL_UNKNOWN', 404]] as const) {
      service.addonPropose.mockImplementationOnce(() => { throw deviceRefusal(code, code) })
      expect((await post()).status, code).toBe(status)
    }
    service.addonPropose.mockImplementationOnce(() => { throw Object.assign({ message: 7 }, { code: 'UNAVAILABLE' }) })
    expect(await post()).toEqual({ status: 503, body: { error: { code: 'UNAVAILABLE', message: 'Autonomous device management request failed' } } })
    service.addonPropose.mockImplementationOnce(() => { throw deviceRefusal('EADDRINUSE', 'the port is taken') })
    expect(await post()).toEqual({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Autonomous device management request failed' } } })
    // What failed may have been done: its route answers for it, as for a service that is down.
    service.addonPropose.mockImplementationOnce(() => { throw new TypeError('a bug') })
    await expect(post()).rejects.toThrow('a bug')
    service.addonPropose.mockImplementationOnce(() => { throw 'not an error' })
    await expect(post()).rejects.toBe('not an error')
  })
})

describe('a service\'s device routes, as the door hands them on', () => {
  const owner = { local: true, owner: true }
  it('reads the body as the client sent it, and answers what its service answers', async () => {
    const service = fixture()
    const answer = deviceRoutes(service)
    expect(await answer({ method: 'POST', target: '/api/autonomous-device/pair/start', body: '{"code":"ABC234","device":"os._autonomous._tcp.local"}' }, owner))
      .toEqual({ status: 200, body: { state: 'running' } })
    expect(await answer({ method: 'GET', target: '/api/autonomous-device/list' }, owner)).toEqual({ status: 200, body: { devices: [] } })
    expect(await answer({ method: 'POST', target: '/api/autonomous-device/revoke', body: 'not json' }, owner))
      .toEqual({ status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } } })
    // An empty or cut body, as the door reads one past its bound, is no JSON.
    expect((await answer({ method: 'POST', target: '/api/autonomous-device/revoke', body: '' }, owner)).status).toBe(400)
    // A frame that says nothing of what it asks is no route.
    expect(await answer({}, owner)).toEqual({ status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Invalid device management request' } } })
    expect(service.revoke).not.toHaveBeenCalled()
  })

  it('is this computer\'s owner\'s alone: anyone else is refused as the door refuses', async () => {
    const service = fixture()
    const answer = deviceRoutes(service)
    const refused = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Authenticated native loopback client required' } } }
    for (const asker of [{ local: false, owner: true, accountOwner: true }, { local: true, owner: false }, { local: true, owner: true, guest: 'g@example.com' }]) {
      expect(await answer({ method: 'GET', target: '/api/autonomous-device/list' }, asker)).toEqual(refused)
    }
    expect(service.list).not.toHaveBeenCalled()
  })

  it('takes only the routes its service gives: another\'s is unknown here', async () => {
    const answer = deviceRoutes({ list: () => ({ devices: [] }) })
    expect(await answer({ method: 'GET', target: '/api/autonomous-device/receipt?deviceId=x&idempotencyKey=k' }, owner))
      .toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Unknown device management endpoint' } } })
    expect((await answer({ method: 'GET', target: '/api/autonomous-device/list' }, owner)).status).toBe(200)
  })
})
