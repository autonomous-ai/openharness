import { describe, expect, it, vi } from 'vitest'
import { OwnerCommands } from './ownerCommands.js'

describe('owner browser commands', () => {
  it('refuses anything but task delivery', async () => {
    const commands = new OwnerCommands()
    commands.onRouteTask = vi.fn()
    expect(await commands.request('one', 'agent_close', { text: 'Send a task' })).toEqual({ error: 'UNSUPPORTED' })
    expect(commands.onRouteTask).not.toHaveBeenCalled()
  })

  it('validates task delivery and preserves the daemon refusal', async () => {
    const commands = new OwnerCommands()
    const send = vi.fn().mockReturnValue({ ok: false, machine: 'fixture', reason: 'offline' })
    commands.onRouteSend = send
    for (const payload of [{}, { agentId: 'a', text: '' }, { agentId: 'a', text: 'x'.repeat(16_001) }]) {
      expect(await commands.request('one', 'route_send', payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(send).not.toHaveBeenCalled()
    expect(await commands.request('one', 'route_send', { agentId: 'a', text: 'hello' })).toEqual({ ok: false, machine: 'fixture', reason: 'offline' })
    expect(send).toHaveBeenCalledWith('a', 'hello')
    expect(await commands.request('one', 'route_task', { text: 'hello' })).toEqual({ error: 'UNSUPPORTED' })
    commands.onRouteSend = undefined
    expect(await commands.request('one', 'route_send', { agentId: 'a', text: 'hello' })).toEqual({ error: 'UNSUPPORTED' })
  })

  it('bounds pending deliveries per connection and in all, and answers a delivery that throws', async () => {
    const answers: Array<(value: never) => void> = []
    const commands = new OwnerCommands()
    commands.onRouteTask = vi.fn(() => new Promise<never>((resolve) => { answers.push(resolve) }))
    const one = commands.request('one', 'route_task', { text: 'a' })
    const two = commands.request('one', 'route_task', { text: 'b' })
    expect(await commands.request('one', 'route_task', { text: 'c' })).toEqual({ error: 'BUSY' })
    const others = Array.from({ length: 6 }, (_, i) => commands.request(`other-${i}`, 'route_task', { text: 'd' }))
    expect(await commands.request('last', 'route_task', { text: 'e' })).toEqual({ error: 'BUSY' })
    commands.closeConnection('one')
    commands.closeAll()
    for (const answer of answers) answer({ agentId: 'a' } as never)
    expect(await one).toEqual({ agentId: 'a' })
    await Promise.all([two, ...others])
    commands.onRouteTask = vi.fn(async () => { throw new Error('router down') })
    expect(await commands.request('one', 'route_task', { text: 'a' })).toEqual({ error: 'COMMAND_UNAVAILABLE', detail: 'This machine could not complete the command. Try again.' })
  })
})
