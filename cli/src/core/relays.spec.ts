import { describe, expect, it, vi } from 'vitest'
import { RELAY_MAX_BYTES } from './api.js'
import { createRelays, type RelaysDeps } from './relays.js'

/** Relays with the devices and the Swarm's service each in a process of its own, or in this one, as [own] says. */
function setup(own: string[] = ['devices', 'superTabs'], route: RelaysDeps['route'] = vi.fn(async () => ({ ok: true }))) {
  const notify = vi.fn((_service: string, _payload: Record<string, unknown>) => true)
  const log = vi.fn()
  const relays = createRelays({ ownProcess: (service) => own.includes(service), notify, route, log })
  return { relays, notify, route, log }
}

const cards = [{ id: 't1', name: 'openharness', count: 1, leads: [] }]

describe('the relays between two services, through the core', () => {
  it('passes a kind on unread from its sender to its receiver\'s process, and nothing from anyone else', () => {
    const { relays, notify } = setup()
    expect(relays.answer('superTabs', 'relay', { kind: 'swarm_cards', payload: cards })).toEqual({})
    expect(notify).toHaveBeenLastCalledWith('devices', { kind: 'relay', relay: 'swarm_cards', payload: cards })
    // Another service may not say the Swarm's word, nor a kind nobody lists, nor one named after the object's own members.
    notify.mockClear()
    for (const [service, kind] of [['devices', 'swarm_cards'], ['orchestrator', 'swarm_waits'], ['superTabs', 'swarm_secrets'], ['superTabs', 'constructor'], ['superTabs', 7]] as const) {
      expect(relays.answer(service, 'relay', { kind, payload: [] }), `${service} ${kind}`).toEqual({ error: 'NOT_A_RELAY' })
    }
    expect(notify).not.toHaveBeenCalled()
    // A query that is not the relays' is not answered here.
    expect(relays.answer('superTabs', 'shown', {})).toBeNull()
  })

  it('answers the Swarm\'s names from before 2026-11-13, for a Swarm process of an older build', () => {
    const { relays, notify } = setup()
    const recap = { tabId: 't1', leadId: 'l1', text: 'Shipped', at: 1, none: false }
    expect(relays.answer('superTabs', 'super_tab_cards', { items: cards })).toEqual({})
    expect(relays.answer('superTabs', 'super_tab_card_recap', { recap })).toEqual({})
    expect(relays.answer('superTabs', 'super_tab_attention', { items: [] })).toEqual({})
    expect(notify.mock.calls.map(([, payload]) => [payload.relay, payload.payload])).toEqual([['swarm_cards', cards], ['swarm_card_recap', recap], ['swarm_waits', []]])
    expect(relays.answer('orchestrator', 'super_tab_cards', { items: cards })).toEqual({ error: 'NOT_A_RELAY' })
  })

  it('refuses a word over its bound, or one that is no data, and says so', () => {
    const { relays, notify, log } = setup()
    expect(relays.answer('superTabs', 'relay', { kind: 'swarm_cards', payload: ['x'.repeat(RELAY_MAX_BYTES)] })).toEqual({ error: 'NOT_A_RELAY' })
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(new RegExp(`^\\[relays\\] swarm_cards from superTabs is \\d+ bytes, over ${RELAY_MAX_BYTES}: not passed on$`)))
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const { api } = relays
    api.tell('swarm_waits', [cycle])
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('swarm_waits from superTabs is Infinity bytes'))
    expect(notify).not.toHaveBeenCalled()
  })

  it('hands a kind to the services in this process that hear it, and tells a sender here by the kind it says', () => {
    const { relays, notify } = setup([])
    const heard = vi.fn(), other = vi.fn()
    const stop = relays.api.on('swarm_cards', heard)
    relays.api.on('swarm_waits', other)
    relays.api.tell('swarm_cards', cards)
    expect(heard).toHaveBeenCalledWith(cards)
    expect(other).not.toHaveBeenCalled()
    // An unknown kind, said here, goes nowhere.
    relays.api.tell('swarm_secrets', cards)
    stop()
    relays.api.tell('swarm_cards', [])
    expect(heard).toHaveBeenCalledOnce()
    expect(notify).not.toHaveBeenCalled()
  })

  it('keeps a hearer\'s fault its own: the others still hear, and the fault is said', () => {
    const { relays, log } = setup([])
    const after = vi.fn()
    relays.api.on('swarm_cards', () => { throw new Error('bad dial') })
    relays.api.on('swarm_cards', () => { throw 'not an error' })
    relays.api.on('swarm_cards', after)
    relays.api.tell('swarm_cards', cards)
    expect(after).toHaveBeenCalledWith(cards)
    expect(log).toHaveBeenCalledWith('[relays] a listener failed on swarm_cards · bad dial')
    expect(log).toHaveBeenCalledWith('[relays] a listener failed on swarm_cards · not an error')
    // A kind nobody here listens for goes nowhere, and says nothing.
    log.mockClear()
    relays.api.tell('swarm_card_recap', { tabId: 't1' })
    expect(log).not.toHaveBeenCalled()
  })

  it('says a sticky kind\'s latest word again to its receiver as it connects, and not a passing one', () => {
    const { relays, notify } = setup()
    relays.api.tell('swarm_cards', cards)
    relays.api.tell('swarm_waits', [{ agentId: 'a1' }])
    relays.api.tell('swarm_card_recap', { tabId: 't1' })
    notify.mockClear()
    relays.connected('devices')
    expect(notify.mock.calls.filter(([, payload]) => payload.kind === 'relay').map(([to, payload]) => [to, payload.relay, payload.payload]))
      .toEqual([['devices', 'swarm_cards', cards], ['devices', 'swarm_waits', [{ agentId: 'a1' }]]])
    // A word of none (null) is no word to keep: the receiver hears it, and nothing is said again.
    relays.api.tell('swarm_cards', null)
    expect(notify).toHaveBeenLastCalledWith('devices', { kind: 'relay', relay: 'swarm_cards', payload: null })
    notify.mockClear()
    relays.connected('devices')
    expect(notify.mock.calls.filter(([, payload]) => payload.kind === 'relay').map(([, payload]) => payload.relay)).toEqual(['swarm_waits'])
    // Another service connecting hears none of them.
    notify.mockClear()
    relays.connected('superTabs')
    expect(notify.mock.calls.filter(([, payload]) => payload.kind === 'relay')).toEqual([])
  })

  it('tells each partner when a service connects or goes: its process, or the services here', () => {
    const { relays, notify, log } = setup(['devices'])
    const heard = vi.fn()
    const stop = relays.api.onPeer(heard)
    relays.api.onPeer(() => { throw new Error('bad peer') })
    // The devices, in their own process: the Swarm's service here hears it.
    relays.connected('devices')
    expect(heard).toHaveBeenLastCalledWith('devices', true)
    relays.disconnected('devices')
    expect(heard).toHaveBeenLastCalledWith('devices', false)
    expect(log).toHaveBeenCalledWith('[relays] a listener failed on devices gone · bad peer')
    // The Swarm's service: the devices' process hears it on its link.
    relays.connected('superTabs')
    expect(notify).toHaveBeenLastCalledWith('devices', { kind: 'relay_peer', service: 'superTabs', up: true })
    relays.disconnected('superTabs')
    expect(notify).toHaveBeenLastCalledWith('devices', { kind: 'relay_peer', service: 'superTabs', up: false })
    // A service that relays with nobody tells nobody.
    notify.mockClear(); heard.mockClear()
    relays.connected('search')
    relays.disconnected('search')
    expect(notify).not.toHaveBeenCalled()
    expect(heard).not.toHaveBeenCalled()
    stop()
    relays.connected('devices')
    expect(heard).not.toHaveBeenCalled()
  })

  it('asks another service\'s request by the actions it lists, as this computer\'s owner, and refuses the rest', async () => {
    const route = vi.fn(async (_type: string, payload: Record<string, unknown>) => ({ ok: true, asked: payload.action }))
    const { relays } = setup(['devices', 'superTabs'], route)
    for (const action of ['cardsWanted', 'cardRecap', 'cardOpen', 'cardSay', 'cardWorker']) {
      expect(await relays.ask('devices', { action, tabId: 't1' })).toEqual({ ok: true, asked: action })
    }
    expect(route).toHaveBeenLastCalledWith('super_tabs', { action: 'cardWorker', tabId: 't1' })
    route.mockClear()
    // Not one it lists (task #3908's cardThreadLeave), no action at all, or an asker it lists nothing for.
    for (const [service, payload] of [['devices', { action: 'cardThreadLeave' }], ['devices', { action: 'backend' }], ['devices', {}],
      ['orchestrator', { action: 'cardRecap' }], ['constructor', { action: 'cardRecap' }]] as const) {
      expect(await relays.ask(service, payload), JSON.stringify(payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(route).not.toHaveBeenCalled()
    route.mockRejectedValueOnce(new Error('gone'))
    expect(await relays.ask('devices', { action: 'cardRecap' })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  })

  // The review of this change: a devices process that outlived a core held the last account's cards, which no word kept here
  // would have cleared.
  it('forgets every kept word when the account ends, and tells each receiver every sticky kind is gone, kept or not', () => {
    const { relays, notify } = setup()
    const gone = [['devices', { kind: 'relay', relay: 'swarm_cards', payload: null }], ['devices', { kind: 'relay', relay: 'swarm_waits', payload: null }]]
    relays.reset()
    expect(notify.mock.calls).toEqual(gone)
    relays.api.tell('swarm_cards', cards)
    notify.mockClear()
    relays.reset()
    expect(notify.mock.calls).toEqual(gone)
    notify.mockClear()
    relays.connected('devices')
    expect(notify.mock.calls.filter(([, payload]) => payload.kind === 'relay')).toEqual([])
  })

  // The review of this change: the devices start late in the core's process, after the Swarm's host said its waits, which it
  // says only on a change.
  it('hands a receiver here that starts late the sticky word it missed, and nothing of a passing one', () => {
    const { relays, log } = setup([])
    relays.api.tell('swarm_waits', [{ agentId: 'a1' }])
    relays.api.tell('swarm_card_recap', { tabId: 't1' })
    const waits = vi.fn(), recaps = vi.fn()
    relays.api.on('swarm_waits', waits)
    relays.api.on('swarm_card_recap', recaps)
    expect(waits).toHaveBeenCalledWith([{ agentId: 'a1' }])
    expect(recaps).not.toHaveBeenCalled()
    relays.api.on('swarm_waits', () => { throw new Error('bad dial') })
    expect(log).toHaveBeenLastCalledWith('[relays] a listener failed on swarm_waits · bad dial')
  })

  it('says what it drops on the console when it is given no log of its own', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      createRelays({ ownProcess: () => false, notify: () => true, route: async () => ({}) }).api.tell('swarm_cards', ['x'.repeat(RELAY_MAX_BYTES)])
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('not passed on'))
    } finally { warned.mockRestore() }
  })
})
