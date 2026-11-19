import { describe, expect, it, vi } from 'vitest'
import { createOwnerCommands } from './ownerCommands.js'

const picked = { agentId: 'a', machineId: 'm', name: 'fixture', confidence: 1, reason: 'one agent', candidates: [], weighed: 1, machines: 1, via: 'one' }
const owner = { local: false, owner: true, connection: 'owner' }
const setup = () => {
  const task = vi.fn(async () => picked), send = vi.fn(async () => ({ ok: true as const })), log = vi.fn()
  return { task, send, log, request: createOwnerCommands({ task, send, log }) }
}

describe('owner commands in the devices process', () => {
  it('keeps the baseline RPC reply goldens and trims only task text at the exact limits', async () => {
    const { request, task, send } = setup()
    expect(JSON.stringify(await request('route_task', { text: '  fixture  ' }, owner))).toBe('{"agentId":"a","machineId":"m","name":"fixture","confidence":1,"reason":"one agent","candidates":[],"weighed":1,"machines":1,"via":"one"}')
    expect(task).toHaveBeenCalledWith('fixture')
    for (const text of [undefined, 2, '', '  ', 'x'.repeat(16_001)]) {
      expect(JSON.stringify(await request('route_task', { text }, owner))).toBe('{"error":"INVALID_REQUEST"}')
    }
    expect(await request('route_send', { agentId: 'a'.repeat(160), text: ` ${'x'.repeat(16_000)} ` }, owner)).toEqual({ ok: true })
    expect(send).toHaveBeenCalledWith('a'.repeat(160), 'x'.repeat(16_000))
    for (const agentId of [undefined, 2, '', 'a'.repeat(161)]) {
      expect(JSON.stringify(await request('route_send', { agentId, text: 'fixture' }, owner))).toBe('{"error":"INVALID_REQUEST"}')
    }
  })

  it('refuses unauthorized, closed and unknown commands before routing, and sanitizes an unexpected failure', async () => {
    const { request, task, send, log } = setup()
    expect(await request('agent_close', { text: 'fixture' }, owner)).toEqual({ error: 'UNSUPPORTED' })
    expect(await request('route_task', { text: 'fixture' }, { ...owner, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await request('route_task', { text: 'fixture' }, { ...owner, guest: 'guest' })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await request('route_send', { text: 'fixture', agentId: 'a' }, owner, AbortSignal.abort())).toEqual({ error: 'COMMAND_UNAVAILABLE', detail: 'This machine could not complete the command. Try again.' })
    expect(task).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    task.mockRejectedValueOnce(new Error('private-token-and-text'))
    expect(await request('route_task', { text: 'fixture' }, owner)).toEqual({ error: 'COMMAND_UNAVAILABLE', detail: 'This machine could not complete the command. Try again.' })
    expect(log).toHaveBeenCalledExactlyOnceWith('[devices] owner command COMMAND_UNAVAILABLE · Error')
  })

  it('bounds actual work globally and per connection, including callers from a core with no connection field', async () => {
    const { request, task } = setup()
    const resolve: Array<(value: typeof picked) => void> = []
    task.mockImplementation(() => new Promise(finish => resolve.push(finish)))
    const closed = new AbortController()
    const one = request('route_task', { text: 'a' }, owner, closed.signal)
    const two = request('route_task', { text: 'b' }, owner, closed.signal)
    expect(await request('route_task', { text: 'c' }, owner)).toEqual({ error: 'BUSY' })
    const others = Array.from({ length: 6 }, () => request('route_task', { text: 'd' }, { local: true, owner: true }))
    expect(await request('route_task', { text: 'e' }, { ...owner, connection: 'last' })).toEqual({ error: 'BUSY' })
    closed.abort()
    expect(await request('route_task', { text: 'f' }, owner)).toEqual({ error: 'BUSY' })
    for (const finish of resolve) finish(picked)
    await expect(Promise.all([one, two, ...others])).resolves.toHaveLength(8)
    task.mockResolvedValue(picked)
    expect(await request('route_task', { text: 'after settlement' }, owner)).toEqual(picked)
  })
})
