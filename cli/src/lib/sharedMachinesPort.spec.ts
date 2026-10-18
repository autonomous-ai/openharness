import { describe, expect, it, vi } from 'vitest'
import { answerSharedMachinesOp, failed, inlineSharedMachinesPort, sharedMachinesPortOf, type SharedMachinesAccount } from './sharedMachinesPort.js'

const M = 'ab'.repeat(16)
const pub = Buffer.alloc(32, 1).toString('base64')

function account(machineId = M): SharedMachinesAccount & { backend: ReturnType<typeof vi.fn>; trust: ReturnType<typeof vi.fn> } {
  return {
    backend: vi.fn(async (method: string, path: string, body?: unknown) => ({ status: 200, body: { method, path, ...(body ? { sent: body } : {}) } })),
    machineId: () => machineId,
    trust: vi.fn(async () => ({ pins: 1, keys: 2 })),
  }
}

describe('answerSharedMachinesOp', () => {
  it('reaches only its own paths of the backend, signed in, for this machine', async () => {
    const a = account()
    expect(await answerSharedMachinesOp(a, { op: 'policy' })).toEqual({ status: 200, body: { method: 'GET', path: `/api/machines/${M}/share` } })
    expect(await answerSharedMachinesOp(a, { op: 'publish', emails: ['a@b.io'], sameDomain: 'yes' }))
      .toEqual({ status: 200, body: { method: 'PUT', path: `/api/machines/${M}/share`, sent: { emails: ['a@b.io'], sameDomain: false } } })
    expect(await answerSharedMachinesOp(a, { op: 'shared' })).toEqual({ status: 200, body: { method: 'GET', path: '/api/machine-shares' } })
    expect(await answerSharedMachinesOp(a, { op: 'add', machineId: M })).toMatchObject({ body: { method: 'POST', path: `/api/machine-shares/${M}/add` } })
    expect(await answerSharedMachinesOp(a, { op: 'remove', machineId: M })).toMatchObject({ body: { method: 'DELETE', path: `/api/machine-shares/${M}/add` } })
    expect(await answerSharedMachinesOp(a, { op: 'add', machineId: '../../api/admin' })).toEqual({ status: 400, body: { error: 'BAD_MACHINE' } })
    expect(await answerSharedMachinesOp(a, { op: 'nothing' })).toEqual({ error: 'UNKNOWN_OP' })
  })

  it('reads no policy signed out', async () => {
    const a = account('')
    expect(await answerSharedMachinesOp(a, { op: 'policy' })).toEqual({ status: 401, body: { error: 'NOT_SIGNED_IN' } })
    expect(await answerSharedMachinesOp(a, { op: 'publish' })).toEqual({ status: 401, body: { error: 'NOT_SIGNED_IN' } })
    expect(a.backend).not.toHaveBeenCalled()
  })

  it('hands the gateway only the parts it was sent, and answers a failure as an error', async () => {
    const a = account()
    expect(await answerSharedMachinesOp(a, { op: 'trust', pins: [], keys: 'no' })).toEqual({ pins: 1, keys: 2 })
    expect(a.trust).toHaveBeenLastCalledWith({ pins: [] })
    expect(await answerSharedMachinesOp(a, { op: 'trust', keys: [] })).toEqual({ pins: 1, keys: 2 })
    expect(a.trust).toHaveBeenLastCalledWith({ keys: [] })
    a.trust.mockRejectedValueOnce(new Error('the gateway is not running'))
    expect(await answerSharedMachinesOp(a, { op: 'trust' })).toEqual({ error: 'the gateway is not running' })
    a.backend.mockRejectedValueOnce('odd')
    expect(await answerSharedMachinesOp(a, { op: 'shared' })).toEqual({ error: 'odd' })
  })
})

describe('sharedMachinesPortOf', () => {
  const ok = (data: unknown) => ({ status: 200, body: { success: true, data } })

  it('reads the policy, its members and their machines', async () => {
    const call = vi.fn(async () => ok({ emails: ['a@b.io', 3], sameDomain: true, domain: 'b.io', members: [
      { email: 'a@b.io', name: 'A', via: 'email', machines: [{ machineId: M, pub, name: 'Mac' }, { machineId: M }, null, { machineId: 'm2', pub, label: 'Labelled' }] },
      { email: 'c@b.io', via: 'domain', machines: 'none' },
      { name: 'no email' }, null,
    ] }))
    const port = sharedMachinesPortOf(call)
    expect(await port.policy()).toEqual({ emails: ['a@b.io'], sameDomain: true, domain: 'b.io', members: [
      { email: 'a@b.io', name: 'A', via: 'email', machines: [{ machineId: M, pub, label: 'Mac' }, { machineId: 'm2', pub, label: 'Labelled' }] },
      { email: 'c@b.io', name: null, via: 'domain', machines: [] },
    ] })
    expect(call).toHaveBeenCalledWith('policy')
    call.mockResolvedValueOnce(ok({ emails: 'none', domain: '' }))
    expect(await port.publish(['a@b.io'], true)).toEqual({ emails: [], sameDomain: false, domain: null, members: [] })
    expect(call).toHaveBeenLastCalledWith('publish', { emails: ['a@b.io'], sameDomain: true })
  })

  it('reads the machines shared with this account', async () => {
    const call = vi.fn(async () => ok({ machines: [
      { machineId: M, name: 'Studio', hostname: 'studio.local', pub, share: { ownerName: 'Dee', ownerEmail: 'dee@b.io', via: 'domain', added: true } },
      { machineId: 'm2', name: 3, share: null },
      { name: 'no id' }, null,
    ] }))
    expect(await sharedMachinesPortOf(call).shared()).toEqual([
      { machineId: M, name: 'Studio', hostname: 'studio.local', pub, share: { ownerName: 'Dee', ownerEmail: 'dee@b.io', via: 'domain', added: true } },
      { machineId: 'm2', name: null, hostname: null, pub: null, share: { ownerName: '', ownerEmail: '', via: 'email', added: false } },
    ])
    call.mockResolvedValueOnce(ok({}))
    expect(await sharedMachinesPortOf(call).shared()).toEqual([])
  })

  it('adds, removes and asks for trust', async () => {
    const call = vi.fn(async (op: string) => op === 'trust' ? { pins: 1, keys: 0 } : ok({ added: true }))
    const port = sharedMachinesPortOf(call)
    expect(await port.add(M)).toBe(true)
    expect(call).toHaveBeenLastCalledWith('add', { machineId: M })
    expect(await port.remove(M)).toBe(true)
    expect(call).toHaveBeenLastCalledWith('remove', { machineId: M })
    expect(await port.trust({ pins: [] })).toEqual({ pins: 1, keys: 0 })
    expect(call).toHaveBeenLastCalledWith('trust', { pins: [] })
  })

  it('says why, in words an app can show, whenever there is no answer', async () => {
    const call = vi.fn()
    const port = sharedMachinesPortOf(call)
    call.mockResolvedValueOnce({ status: 400, body: { success: false, error: { code: 'PUBLIC_DOMAIN', message: 'It is a public email domain.' } } })
    expect(await port.publish([], true)).toEqual({ failed: { status: 400, code: 'PUBLIC_DOMAIN', message: 'It is a public email domain.' } })
    call.mockResolvedValueOnce({ status: 401, body: { error: 'NOT_SIGNED_IN' } })
    expect(await port.policy()).toEqual({ failed: { status: 401, code: 'NOT_SIGNED_IN', message: expect.stringContaining('could not be reached') } })
    call.mockResolvedValueOnce({ error: 'not connected to the core' })
    expect(await port.add(M)).toEqual({ failed: { status: 502, code: 'not connected to the core', message: expect.any(String) } })
    call.mockResolvedValueOnce({ status: 404, body: { success: false, error: { code: 'NOT_SHARED' } } })
    expect(await port.remove(M)).toMatchObject({ failed: { code: 'NOT_SHARED' } })
    call.mockResolvedValueOnce({ status: 200, body: { success: true } })
    expect(await port.shared()).toMatchObject({ failed: { code: 'UNAVAILABLE' } })
    call.mockResolvedValueOnce({})
    expect(await port.trust({})).toMatchObject({ failed: { code: 'UNAVAILABLE' } })
    expect(failed(null)).toBe(false)
    expect(failed(true)).toBe(false)
  })
})

describe('inlineSharedMachinesPort', () => {
  it('answers in line in the core’s own process, signed in, and is no port signed out', async () => {
    const a = account()
    expect(inlineSharedMachinesPort(a, false)).toBeNull()
    a.backend.mockResolvedValueOnce({ status: 200, body: { success: true, data: { machines: [] } } })
    expect(await inlineSharedMachinesPort(a, true)!.shared()).toEqual([])
    expect(a.backend).toHaveBeenCalledWith('GET', '/api/machine-shares')
  })
})
