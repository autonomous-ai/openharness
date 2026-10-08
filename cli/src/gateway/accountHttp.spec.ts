import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayAccount } from '../core/api.js'
import { AuthSessionError } from '../lib/authSession.js'
import { createAccountHttp } from './accountHttp.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const body = { success: true, data: { machines: [{ machineId: 'remote', computerId: 'other', name: 'Desktop', status: 'online' }] } }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'gateway-account-')); roots.push(dataDir)
  let account: GatewayAccount = { machineId: 'account-a', signIn: null, autonomousEnv: 'test' }
  const request = vi.fn<typeof fetch>(async () => response(body))
  const tokens = { accessToken: vi.fn(async () => 'token') }
  const changed = vi.fn(), reachable = vi.fn()
  const deps = { dataDir, account: () => account, tokens, request, base: () => 'https://backend.invalid',
    computer: { id: 'computer', name: 'Laptop', hostname: 'host' }, environment: 'prod', changed, reachable, log: vi.fn() }
  return { api: createAccountHttp(deps), deps, dataDir, request, tokens, changed, reachable,
    account: (next: GatewayAccount) => { account = next } }
}

describe('account HTTP in the gateway', () => {
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

  it('keeps the guest list local and never asks for a token', async () => {
    const { api, account, request, changed } = setup()
    account({ machineId: null, signIn: null })
    expect(await api.machines()).toMatchObject({ status: 200, body: { data: { guest: true, stale: false, machines: [{ machineId: 'computer', name: 'Laptop' }] } } })
    expect(request).not.toHaveBeenCalled()
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ owner: null }))
  })

  it('owns persistence, reports fresh lists, and uses stale rows during an outage after a restart', async () => {
    const { api, deps, dataDir, request, changed, reachable } = setup()
    expect(await api.machines()).toEqual({ status: 200, body })
    expect(reachable).toHaveBeenLastCalledWith(['remote'])
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
