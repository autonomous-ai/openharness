import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayAccount } from '../core/api.js'
import { AuthSessionError } from '../lib/authSession.js'
import { createAccountHttp, retryAfterMs } from './accountHttp.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const body = { success: true, data: { machines: [{ machineId: 'remote', computerId: 'other', name: 'Desktop', status: 'online' }] } }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'gateway-account-')); roots.push(dataDir)
  let account: GatewayAccount = { machineId: 'account-a', signIn: null, autonomousEnv: 'test' }
  const request = vi.fn<typeof fetch>(async () => response(body))
  const tokens = { accessToken: vi.fn(async () => 'token') }
  const changed = vi.fn(), reachable = vi.fn(), listed = vi.fn()
  const deps = { dataDir, account: () => account, tokens, request, base: () => 'https://backend.invalid',
    computer: { id: 'computer', name: 'Laptop', hostname: 'host' }, environment: 'prod', changed, reachable, listed, log: vi.fn() }
  return { api: createAccountHttp(deps), deps, dataDir, request, tokens, changed, reachable, listed,
    account: (next: GatewayAccount) => { account = next } }
}

describe('account HTTP in the gateway', () => {
  it('does not send a queued report if sign-in changes while a token is being read', async () => {
    const { api, tokens, request, account } = setup()
    let resolve!: (token: string) => void
    tokens.accessToken.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = api.backend('POST', '/api/product-usage/report', { counters: { turns_started: 1 } })
    account({ machineId: 'account-b', signIn: null, autonomousEnv: 'test' })
    resolve('other-account-token')
    expect(await pending).toMatchObject({ status: 409, body: { error: { code: 'ACCOUNT_CHANGED' } } })
    expect(request).not.toHaveBeenCalled()
  })
  it('forwards response bodies, status, credentials and environment without holding a credential', async () => {
    const { api, request, tokens } = setup()
    request.mockResolvedValueOnce(response({ error: { code: 'CONFLICT' } }, 409))
    expect(await api.backend('PATCH', '/api/machines/local', { name: 'Renamed' })).toEqual({ status: 409, body: { error: { code: 'CONFLICT' } } })
    expect(request).toHaveBeenCalledWith('https://backend.invalid/api/machines/local', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }),
      headers: { authorization: 'Bearer token', 'x-autonomous-env': 'test', 'content-type': 'application/json' }, signal: expect.any(AbortSignal),
    }))
    await api.backend('GET', '/api/auth/me')
    expect(request.mock.calls[1][1]?.headers).not.toHaveProperty('content-type')
    expect(tokens.accessToken).toHaveBeenCalledTimes(2)
    request.mockResolvedValueOnce(new Response('not json', { status: 502 }))
    expect(await api.backend('GET', '/api/auth/me')).toEqual({ status: 502, body: {} })
  })
  it('says when a busy or failing backend asks to be tried again, for the usage reports\' backoff', async () => {
    const { api, request } = setup()
    const at = (status: number, retryAfter: string) => new Response('{}', { status, headers: { 'retry-after': retryAfter } })
    request.mockResolvedValueOnce(at(429, '120'))
    expect(await api.backend('POST', '/api/product-usage/report', {})).toEqual({ status: 429, body: {}, retryAfterMs: 120_000 })
    request.mockResolvedValueOnce(at(503, new Date(Date.now() + 60_000).toUTCString()))
    expect((await api.backend('POST', '/api/product-usage/report', {})).retryAfterMs).toBeGreaterThan(50_000)
    // Unreadable, or on an answer that is not a busy one: nothing said.
    request.mockResolvedValueOnce(at(429, 'soon'))
    expect(await api.backend('POST', '/api/product-usage/report', {})).toEqual({ status: 429, body: {} })
    request.mockResolvedValueOnce(at(200, '120'))
    expect(await api.backend('POST', '/api/product-usage/report', {})).toEqual({ status: 200, body: {} })
    expect(retryAfterMs(null)).toBeNull()
    expect(retryAfterMs(' 7 ', 0)).toBe(7_000)
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:01 GMT', 5_000)).toBe(0)
  })

  it.each([['MISSING', 401, 'NOT_SIGNED_IN'], ['INVALID_REFRESH', 401, 'NOT_SIGNED_IN'], ['UNAVAILABLE', 502, 'AUTH_UNAVAILABLE']] as const)(
    'distinguishes %s from an unreachable backend', async (code, status, answer) => {
      const { api, tokens, request } = setup()
      tokens.accessToken.mockRejectedValueOnce(new AuthSessionError('session error', code))
      expect(await api.backend('GET', '/api/auth/me')).toEqual({ status, body: { success: false, error: { code: answer, message: 'session error' } } })
      expect(request).not.toHaveBeenCalled()
    })

  it('answers network and timeout failures instead of abandoning a local HTTP request', async () => {
    const { api, request } = setup()
    request.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { message: 'connection refused' } }))
    expect(await api.backend('GET', '/api/auth/me')).toMatchObject({ status: 502, body: { error: { code: 'BACKEND_UNREACHABLE', message: expect.stringContaining('connection refused') } } })
    for (const name of ['TimeoutError', 'AbortError']) {
      request.mockRejectedValueOnce(Object.assign(new Error('late'), { name }))
      expect(await api.backend('GET', '/api/auth/me')).toMatchObject({ status: 504, body: { error: { code: 'BACKEND_TIMEOUT' } } })
    }
  })

  // Scholes 10-29: the banner read "Could not reach the Harness backend (). Check the connection and try again."
  it.each([
    ['an empty cause message', Object.assign(new Error('fetch failed'), { cause: { message: '' } }), 'fetch failed'],
    ['no message at all', new Error(''), null],
    ['a blank cause and message', Object.assign(new Error('  '), { cause: { message: ' ' } }), null],
  ])('never shows empty parentheses when the failure has %s', async (_name, failure, reason) => {
    const { api, request } = setup()
    request.mockRejectedValueOnce(failure)
    const answer = await api.backend('GET', '/api/auth/me')
    expect(answer.body).toMatchObject({ error: { message: reason === null
      ? 'Could not reach the Harness backend. Check the connection and try again.'
      : `Could not reach the Harness backend (${reason}). Check the connection and try again.` } })
  })

  // Diego 10-29: a body that timed out after the headers, or HTML from a proxy, read as '200 OK, {}'.
  it('answers a body that times out after the headers as a timeout, not as an empty success', async () => {
    const { api, request } = setup()
    for (const name of ['TimeoutError', 'AbortError']) {
      const stalled = new ReadableStream({ start(controller) { controller.error(new DOMException('late', name)) } })
      request.mockResolvedValueOnce(new Response(stalled, { status: 200 }))
      expect(await api.backend('GET', '/api/auth/me')).toEqual({ status: 504, body: { success: false, error: { code: 'BACKEND_TIMEOUT',
        message: 'The Harness backend did not answer GET /api/auth/me within 20s. Try again in a moment.' } } })
    }
  })
  // A refusal must keep its status whatever its body does: 401/403 sign out, 426 asks for an update, 429/5xx carry Retry-After.
  it('keeps a refusal\'s status with {} when its body stalls or is not JSON', async () => {
    const { api, request } = setup()
    const stalled = (status: number, headers: Record<string, string> = {}) => new Response(
      new ReadableStream({ start(controller) { controller.error(new DOMException('late', 'TimeoutError')) } }), { status, headers })
    request.mockResolvedValueOnce(stalled(401))
    expect(await api.backend('GET', '/api/auth/me')).toEqual({ status: 401, body: {} })
    request.mockResolvedValueOnce(stalled(503, { 'retry-after': '30' }))
    expect(await api.backend('POST', '/api/product-usage/report', {})).toEqual({ status: 503, body: {}, retryAfterMs: 30_000 })
    request.mockResolvedValueOnce(new Response('<html>Upgrade Required</html>', { status: 426 }))
    expect(await api.backend('GET', '/api/super-tabs/hosts/machine-1/changes?full=1')).toEqual({ status: 426, body: {} })
  })
  it('answers a success whose body is not JSON as a bad response, and an empty one as {}', async () => {
    const { api, request } = setup()
    request.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 200 }))
    expect(await api.backend('GET', '/api/auth/me')).toMatchObject({ status: 502, body: { success: false, error: { code: 'BACKEND_BAD_RESPONSE' } } })
    request.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await api.backend('POST', '/api/product-usage/report', {})).toEqual({ status: 204, body: {} })
    request.mockResolvedValueOnce(new Response('', { status: 200, headers: { 'content-length': '0' } }))
    expect(await api.backend('POST', '/api/product-usage/report', {})).toEqual({ status: 200, body: {} })
  })

  it('keeps the guest list local and never asks for a token', async () => {
    const { api, account, request, changed } = setup()
    account({ machineId: null, signIn: null })
    expect(await api.machines()).toMatchObject({ status: 200, body: { data: { guest: true, stale: false, machines: [{ machineId: 'computer', name: 'Laptop' }] } } })
    expect(request).not.toHaveBeenCalled()
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ owner: null }))
  })

  it('owns persistence, reports fresh lists, and uses stale rows during an outage after a restart', async () => {
    const { api, deps, dataDir, request, changed, reachable, listed } = setup()
    expect(await api.machines()).toEqual({ status: 200, body })
    expect(reachable).toHaveBeenLastCalledWith(['remote'])
    // The body as the backend answered it, for the trust group's team machines (lib/e2ee/machineKinds.ts); null once signed out.
    expect(listed).toHaveBeenLastCalledWith(body)
    request.mockResolvedValueOnce(response({}, 401))
    await api.machines()
    expect(listed).toHaveBeenLastCalledWith(null)
    request.mockResolvedValueOnce(response(body))
    await api.machines()
    expect(JSON.parse(readFileSync(join(dataDir, 'machines.json'), 'utf8')).bodyOwner).toBe('account-a')
    changed.mockClear()
    const restarted = createAccountHttp(deps)
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ owner: 'account-a', body }))
    request.mockResolvedValueOnce(response({}, 503))
    expect(await restarted.machines(true)).toMatchObject({ status: 200, body: { data: { ...body.data, stale: true } } })
    request.mockResolvedValueOnce(response({}, 503))
    expect((await restarted.machines()).status).toBe(503)
  })

  it('does not serve stale rows across accounts or after a real refusal', async () => {
    const { api, request, account } = setup()
    await api.machines(true)
    account({ machineId: 'account-b', signIn: null })
    request.mockResolvedValueOnce(response({}, 503))
    expect((await api.machines(true)).status).toBe(503)
    account({ machineId: 'account-a', signIn: null })
    for (const status of [401, 403]) {
      await api.machines(true)
      request.mockResolvedValueOnce(response({}, status))
      expect((await api.machines(true)).status).toBe(status)
      request.mockResolvedValueOnce(response({}, 503))
      expect((await api.machines(true)).status).toBe(503)
    }
  })

  it.each([false, true])('discards an account change during a machine read (fallback %s)', async fallback => {
    const { api, request, account, changed } = setup()
    request.mockImplementationOnce(async () => { account({ machineId: 'account-b', signIn: null }); return response(body) })
    expect((await api.machines(fallback)).status).not.toBe(200)
    expect(changed).not.toHaveBeenCalled()
  })

  it('mints the private grid name in the gateway, preserving the data envelope and errors', async () => {
    const { api, request } = setup()
    request.mockResolvedValueOnce(response({ success: true, data: { gridName: 'private-grid' } }))
    expect(await api.mintGridName()).toBe('private-grid')
    request.mockResolvedValueOnce(response({ data: {} }))
    expect(await api.mintGridName()).toBeNull()
    request.mockResolvedValueOnce(response({ success: false, error: { message: 'refused' } }, 403))
    await expect(api.mintGridName()).rejects.toThrow('refused')
  })
})
