import { describe, expect, it, vi } from 'vitest'
import { OwnerCommands } from './ownerCommands.js'
import { CommandBarError } from './commandBar.js'

describe('owner browser commands', () => {
  it('uses the desktop decision service without executing its choice', async () => {
    const decide = vi.fn().mockResolvedValue({ selectedId: 'send:a', autoExecute: false })
    const commands = new OwnerCommands({ decide }), send = vi.fn()
    commands.onRouteSend = send
    const request = { prompt: 'Send a task', candidates: [] }
    expect(await commands.request('one', 'command_bar', { request })).toEqual({ selectedId: 'send:a', autoExecute: false })
    expect(decide).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    expect(send).not.toHaveBeenCalled()
  })

  it('validates task delivery and preserves the daemon refusal', async () => {
    const commands = new OwnerCommands({ decide: vi.fn() })
    const send = vi.fn().mockReturnValue({ ok: false, machine: 'fixture', reason: 'offline' })
    commands.onRouteSend = send
    for (const payload of [{}, { agentId: 'a', text: '' }, { agentId: 'a', text: 'x'.repeat(16_001) }]) {
      expect(await commands.request('one', 'route_send', payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(send).not.toHaveBeenCalled()
    expect(await commands.request('one', 'route_send', { agentId: 'a', text: 'hello' })).toEqual({ ok: false, machine: 'fixture', reason: 'offline' })
    expect(send).toHaveBeenCalledWith('a', 'hello')
    expect(await commands.request('one', 'route_task', { text: 'hello' })).toEqual({ error: 'UNSUPPORTED' })
  })

  it('bounds pending decisions and aborts only the disconnecting connection', async () => {
    const decide = vi.fn().mockImplementation((_raw, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new CommandBarError(499, 'CANCELLED', 'Command cancelled.')))
    }))
    const commands = new OwnerCommands({ decide })
    const one = commands.request('one', 'command_bar', { request: {} })
    const two = commands.request('one', 'command_bar', { request: {} })
    const other = commands.request('other', 'command_bar', { request: {} })
    expect(await commands.request('one', 'command_bar', { request: {} })).toEqual({ error: 'BUSY' })
    commands.closeConnection('one')
    expect(await one).toMatchObject({ error: 'CANCELLED' })
    expect(await two).toMatchObject({ error: 'CANCELLED' })
    expect(decide.mock.calls[2][1].aborted).toBe(false)
    commands.closeAll()
    expect(await other).toMatchObject({ error: 'CANCELLED' })
  })
})
