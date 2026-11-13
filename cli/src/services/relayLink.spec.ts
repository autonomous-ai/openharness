import { describe, expect, it, vi } from 'vitest'
import { relayLink } from './relayLink.js'

describe('a service\'s side of the relays, in a process of its own', () => {
  it('asks the core to pass its words on, never waiting on or throwing from it', async () => {
    const query = vi.fn(async (_query: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> => { throw new Error('gone') })
    relayLink(query).relay.tell('swarm_cards', [])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(query).toHaveBeenCalledWith('relay', { kind: 'swarm_cards', payload: [] })
  })

  it('hands what the core passes it to whoever listens for that kind, and its partners coming and going', () => {
    const log = vi.fn()
    const link = relayLink(vi.fn(), log)
    const cards = vi.fn(), waits = vi.fn(), peers = vi.fn()
    const stopCards = link.relay.on('swarm_cards', cards)
    link.relay.on('swarm_waits', waits)
    link.relay.on('swarm_waits', () => { throw new Error('bad dial') })
    link.relay.on('swarm_waits', () => { throw 'not an error' })
    const stopPeers = link.relay.onPeer(peers)
    link.relay.onPeer(() => { throw new Error('bad peer') })
    expect(link.heard({ kind: 'relay', relay: 'swarm_cards', payload: [1] })).toBe(true)
    expect(link.heard({ kind: 'relay', relay: 'swarm_waits' })).toBe(true)
    expect(cards).toHaveBeenCalledWith([1])
    expect(waits).toHaveBeenCalledWith(null)
    expect(log).toHaveBeenCalledWith('[relays] a listener failed on swarm_waits · bad dial')
    expect(log).toHaveBeenCalledWith('[relays] a listener failed on swarm_waits · not an error')
    expect(link.heard({ kind: 'relay_peer', service: 'devices', up: false })).toBe(true)
    expect(peers).toHaveBeenCalledWith('devices', false)
    expect(log).toHaveBeenCalledWith('[relays] a listener failed on devices gone · bad peer')
    link.heard({ kind: 'relay_peer', service: 'devices', up: true })
    expect(log).toHaveBeenLastCalledWith('[relays] a listener failed on devices up · bad peer')
    // Not the relays': another kind of event, or one that names nothing.
    for (const payload of [{ kind: 'notice' }, { kind: 'relay' }, { kind: 'relay', relay: 7 }, { kind: 'relay_peer', service: 'devices' }, { kind: 'relay_peer', up: true }]) {
      expect(link.heard(payload), JSON.stringify(payload)).toBe(false)
    }
    // A kind nobody listens for is still the relays'.
    expect(link.heard({ kind: 'relay', relay: 'swarm_card_recap', payload: {} })).toBe(true)
    stopCards(); stopPeers()
    link.heard({ kind: 'relay', relay: 'swarm_cards', payload: [2] })
    link.heard({ kind: 'relay_peer', service: 'superTabs', up: true })
    expect(cards).toHaveBeenCalledOnce()
    expect(peers).toHaveBeenCalledTimes(2)
  })

  it('says a listener\'s fault on the console when it is given no log of its own', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const link = relayLink(vi.fn())
      link.relay.on('swarm_cards', () => { throw new Error('bad dial') })
      link.heard({ kind: 'relay', relay: 'swarm_cards', payload: [] })
      expect(warned).toHaveBeenCalledWith('[relays] a listener failed on swarm_cards · bad dial')
    } finally { warned.mockRestore() }
  })
})
