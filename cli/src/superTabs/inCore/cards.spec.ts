import { describe, expect, it, vi } from 'vitest'
import { createSuperTabCards } from './cards.js'

const lead = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, projectId: `p-${id}`, project: 'mobile', engine: 'claude', owner: '', local: 'h1', state: 'work', order: 0, since: 12, ...over })
const card = (id: string, leads: unknown[] = [lead('l1')], over: Record<string, unknown> = {}) => ({ id, name: 'openharness', count: 4, leads, ...over })
const recap = (over: Record<string, unknown> = {}) => ({ tabId: 't1', leadId: 'l1', text: 'Shipped it', at: 1792560000, none: false, ...over })

function setup() {
  const swarmCards = vi.fn(), swarmCardRecap = vi.fn(), log = vi.fn()
  const cards = createSuperTabCards({ swarmCards, swarmCardRecap, log })
  return { swarmCards, swarmCardRecap, log, cards }
}

describe('the Swarm cards on the devices', () => {
  it('forwards each list whole, keeps the last one and replays it to a device that attaches', () => {
    const { cards, swarmCards } = setup()
    cards.replay()
    expect(swarmCards).not.toHaveBeenCalled()
    const list = [card('t1', [lead('l1', { order: 2 }), lead('l2', { state: 'ask', order: 0 }), lead('l3', { since: undefined, order: 5 })])]
    cards.cards(list)
    expect(swarmCards).toHaveBeenLastCalledWith(JSON.parse(JSON.stringify(list)))
    // Without `since` the key is left out; with an empty owner the lead is still whole.
    expect(swarmCards.mock.calls[0][0][0].leads[2]).not.toHaveProperty('since')
    expect(swarmCards.mock.calls[0][0][0].leads.map((l: { order: number }) => l.order)).toEqual([2, 0, 5])
    swarmCards.mockClear()
    cards.replay()
    expect(swarmCards).toHaveBeenCalledOnce()
    // An empty list is a list too: the devices clear their cards.
    cards.cards([])
    swarmCards.mockClear()
    cards.replay()
    expect(swarmCards).toHaveBeenCalledWith([])
  })

  it('checks ids, counts and strings, and drops a malformed list whole, keeping the last good one', () => {
    const { cards, swarmCards, log } = setup()
    cards.cards([card('t1')])
    swarmCards.mockClear()
    const bad: unknown[] = [
      'not a list', [null], [card('bad id')], [card('')], [card('x'.repeat(65))], [card('x'.repeat(48))], [card('t1', [lead('l1', { local: 'x'.repeat(48) })])], [card('t1', 'nope' as never)], [card('t1', [lead('bad id')])],
      [card('t1', [lead('l1', { projectId: 'no good' })])], [card('t1', [lead('l1', { state: 'sleeping' })])], [card('t1', [lead('l1', { project: 7 })])],
      [card('t1', [lead('l1', { local: 'bad local' })])], [card('t1', [lead('l1', { since: -1 })])], [card('t1', [lead('l1', { since: 'soon' })])],
      [card('t1', [lead('l1', { order: undefined })])], [card('t1', [lead('l1', { order: -1 })])], [card('t1', [lead('l1', { order: 1.5 })])],
      [card('t1', [lead('l1')], { count: -1 })], [card('t1', [lead('l1')], { count: 1.5 })], [card('t1', [lead('l1')], { name: 3 })],
    ]
    for (const list of bad) cards.cards(list)
    expect(swarmCards).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(bad.length)
    cards.replay()
    expect(swarmCards).toHaveBeenCalledWith([card('t1')])
  })

  it('keeps at most 16 Swarms of 12 Leads and cuts strings on a character boundary', () => {
    const { cards, swarmCards } = setup()
    const many = Array.from({ length: 20 }, (_, i) => card(`t${i}`, Array.from({ length: 15 }, (_, j) => lead(`l${j}`))))
    cards.cards(many)
    const sent = swarmCards.mock.calls[0][0]
    expect(sent).toHaveLength(16)
    expect(sent[0].leads).toHaveLength(12)
    swarmCards.mockClear()
    cards.cards([card('t1', [lead('l1', { project: 'é'.repeat(40), owner: 'ö'.repeat(40), engine: 'e'.repeat(30) })], { name: '日'.repeat(30) })])
    const [only] = swarmCards.mock.calls[0][0]
    expect(Buffer.byteLength(only.name)).toBe(48)
    expect(only.name).toBe('日'.repeat(16))
    expect(Buffer.byteLength(only.leads[0].project)).toBe(48)
    expect(Buffer.byteLength(only.leads[0].owner)).toBe(48)
    expect(only.leads[0].engine).toHaveLength(16)
  })

  it('says what it drops on the console when it is given no log of its own', () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    createSuperTabCards({ swarmCards: vi.fn(), swarmCardRecap: vi.fn() }).recap(null)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('not sound'))
    logged.mockRestore()
  })

  it('forwards a checked recap, cut at 1,500 bytes, and refuses a malformed one', () => {
    const { cards, swarmCardRecap, log } = setup()
    cards.recap(recap())
    expect(swarmCardRecap).toHaveBeenLastCalledWith(recap())
    cards.recap(recap({ text: '日'.repeat(600) }))
    expect(swarmCardRecap.mock.calls[1][0].text).toBe('日'.repeat(500))
    cards.recap(recap({ text: '', at: 0, none: true }))
    expect(swarmCardRecap).toHaveBeenCalledTimes(3)
    for (const bad of [null, 'x', recap({ tabId: 'bad id' }), recap({ leadId: '' }), recap({ text: 5 }), recap({ at: -1 }), recap({ at: 'now' }), recap({ none: 'no' })]) cards.recap(bad)
    expect(swarmCardRecap).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledTimes(8)
  })

  it('keeps a sound chat and notice, drops a malformed one', () => {
    const { cards, swarmCards, swarmCardRecap, log } = setup()
    const chat = (over: Record<string, unknown> = {}) => ({ kind: 'group', id: 'g1', name: 'Fix login', working: true, since: 5, ...over })
    const notice = (over: Record<string, unknown> = {}) => ({ chat: 'pm', chatId: 'pm1', id: 'm1', text: 'Shipped', at: 1792560000, ...over })
    cards.cards([card('t1', [lead('l1', { chat: chat({ name: 'g'.repeat(60) }), notice: notice({ text: '日'.repeat(600) }) })])])
    const [sent] = swarmCards.mock.calls[0][0][0].leads
    expect(sent.chat).toEqual(chat({ name: 'g'.repeat(48) }))
    expect(sent.notice).toEqual(notice({ text: '日'.repeat(500) }))
    // A chat without `since`, or a Lead chat that does not work, is sound too.
    cards.cards([card('t1', [lead('l1', { chat: { kind: 'lead', id: 'c1', name: 'Lead', working: false }, notice: notice({ chat: 'lead' }) })])])
    expect(swarmCards.mock.calls[1][0][0].leads[0]).toMatchObject({ chat: { kind: 'lead', id: 'c1' }, notice: { chat: 'lead' } })
    expect(swarmCards.mock.calls[1][0][0].leads[0].chat).not.toHaveProperty('since')
    swarmCards.mockClear()
    const badChats = [chat({ kind: 'other' }), chat({ id: 'bad id' }), chat({ name: 5 }), chat({ working: 'yes' }), chat({ since: -1 }), 'chat']
    const badNotices = [notice({ chat: 'group' }), notice({ chatId: 'bad id' }), notice({ id: '' }), notice({ text: 5 }), notice({ at: -1 }), 7]
    for (const bad of badChats) cards.cards([card('t1', [lead('l1', { chat: bad })])])
    for (const bad of badNotices) cards.cards([card('t1', [lead('l1', { notice: bad })])])
    // The Lead stays, without what was not sound.
    expect(swarmCards).toHaveBeenCalledTimes(badChats.length + badNotices.length)
    for (const [list] of swarmCards.mock.calls) {
      expect(list[0].leads[0]).toMatchObject({ id: 'l1' })
      expect(list[0].leads[0]).not.toHaveProperty('chat')
      expect(list[0].leads[0]).not.toHaveProperty('notice')
    }
    expect(log).not.toHaveBeenCalled()
    // A recap names its chat with an id, or is dropped: a dial must not show it for the wrong chat.
    cards.recap(recap({ chatId: 'g1' }))
    expect(swarmCardRecap).toHaveBeenLastCalledWith(recap({ chatId: 'g1' }))
    cards.recap(recap({ chatId: 'bad id' }))
    expect(swarmCardRecap).toHaveBeenCalledOnce()
  })
  // Round dial PM and Buddy screens (spec 2026-10-29): the swarmBuddy dial's fields, checked as the chat and notice are.
  it('keeps a sound side chat, buddies flag, buddy block and buddy notice, drops a malformed one', () => {
    const { cards, swarmCards, swarmCardRecap } = setup()
    const buddy = (over: Record<string, unknown> = {}) => ({ chatId: 'b1', name: "diego's Buddy", engine: 'codex', cells: 25513, color: '#d6a79a', live: true, ...over })
    const quiet = (over: Record<string, unknown> = {}) => ({ chat: 'buddy', chatId: 'b1', id: 'm2', text: 'An idea', at: 1792560000, ...over })
    const side = { kind: 'buddy', id: 'b1', name: "diego's Buddy", working: false }
    cards.cards([card('t1', [lead('l1', { sideChat: side, buddies: true, buddy: buddy({ name: 'b'.repeat(60), engine: 'e'.repeat(20) }), buddyNotice: quiet({ text: '日'.repeat(600) }), notice: quiet() })])])
    const [sent] = swarmCards.mock.calls[0][0][0].leads
    expect(sent).toMatchObject({ sideChat: side, buddies: true, buddy: buddy({ name: 'b'.repeat(48), engine: 'e'.repeat(16) }), buddyNotice: quiet({ text: '日'.repeat(500) }) })
    // The Buddy's word never rides in the Lead's notice, which an older dial reads.
    expect(sent).not.toHaveProperty('notice')
    swarmCards.mockClear()
    const badBuddies = [buddy({ chatId: 'bad id' }), buddy({ name: 5 }), buddy({ engine: null }), buddy({ cells: 32768 }), buddy({ cells: -1 }), buddy({ cells: 1.5 }),
      buddy({ color: '#D6A79A' }), buddy({ color: 'red' }), buddy({ live: 'yes' }), 'buddy']
    for (const bad of badBuddies) cards.cards([card('t1', [lead('l1', { buddy: bad, buddies: 'yes', sideChat: { ...side, kind: 'other' }, buddyNotice: quiet({ chat: 'lead' }) })])])
    expect(swarmCards).toHaveBeenCalledTimes(badBuddies.length)
    for (const [list] of swarmCards.mock.calls) {
      for (const field of ['buddy', 'buddies', 'sideChat', 'buddyNotice']) expect(list[0].leads[0]).not.toHaveProperty(field)
    }
    // A swarmBuddy dial's recap says so; anything but a literal true is not.
    cards.recap(recap({ chatId: 'b1', buddy: true }))
    expect(swarmCardRecap).toHaveBeenLastCalledWith(recap({ chatId: 'b1', buddy: true }))
    cards.recap(recap({ chatId: 'b1', buddy: 'yes' }))
    expect(swarmCardRecap).toHaveBeenLastCalledWith(recap({ chatId: 'b1' }))
  })
})

describe('whether the Swarm cards are wanted, which the core owns', () => {
  function wanting() {
    const request = vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true }))
    const swarmCards = vi.fn()
    const cards = createSuperTabCards({ swarmCards, swarmCardRecap: vi.fn(), request, log: vi.fn() })
    return { cards, request, swarmCards }
  }
  it('tells the service when a capable device comes, which Swarms to read first, and when the last goes; a repeat says nothing', () => {
    const { cards, request } = wanting()
    cards.want(true, ['t1', 'bad id', 't1', 't2'])
    cards.want(true, ['t1', 't2'])
    expect(request.mock.calls).toEqual([[{ action: 'cardsWanted', on: true, include: ['t1', 't2'] }]])
    cards.want(true, ['t2'])
    expect(request).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: true, include: ['t2'] })
    cards.want(false, ['t2'])
    expect(request).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: false, include: [] })
    cards.want(false, [])
    expect(request).toHaveBeenCalledTimes(3)
    // Swarms that are not a list are none.
    cards.want(true, 'nonsense')
    expect(request).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: true, include: [] })
  })
  it('says it again whenever the service (re)connects, only while a device wants the cards', () => {
    const { cards, request } = wanting()
    cards.serviceUp()
    expect(request).not.toHaveBeenCalled()
    cards.want(true, ['t1'])
    request.mockClear()
    cards.serviceUp()
    expect(request.mock.calls).toEqual([[{ action: 'cardsWanted', on: true, include: ['t1'] }]])
    cards.want(false, [])
    request.mockClear()
    cards.serviceUp()
    expect(request).not.toHaveBeenCalled()
  })
  it('takes the wish back when the devices go, so a crashed devices process stops the polling', () => {
    const { cards, request } = wanting()
    cards.devicesGone()
    expect(request).not.toHaveBeenCalled()
    cards.want(true, [])
    cards.devicesGone()
    expect(request).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: false, include: [] })
    request.mockClear()
    cards.serviceUp()
    expect(request).not.toHaveBeenCalled()
  })
  it('on an account change forgets the list, clears the devices\' cards and has the service start over', () => {
    const { cards, request, swarmCards } = wanting()
    cards.cards([card('t1')])
    cards.want(true, ['t1'])
    request.mockClear(); swarmCards.mockClear()
    cards.reset()
    expect(swarmCards).toHaveBeenCalledWith([])
    expect(request.mock.calls).toEqual([[{ action: 'cardsWanted', on: false, include: [] }], [{ action: 'cardsWanted', on: true, include: ['t1'] }]])
    swarmCards.mockClear()
    cards.replay()
    expect(swarmCards).not.toHaveBeenCalled()
  })
  it('lets the devices ask four things of the service and nothing else, whatever the path', async () => {
    const { cards, request } = wanting()
    expect(await cards.ask({ action: 'cardsWanted', on: true, include: ['t1'] })).toEqual({ ok: true })
    expect(request.mock.calls).toEqual([[{ action: 'cardsWanted', on: true, include: ['t1'] }]])
    request.mockClear()
    await cards.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1', extra: 1 })
    await cards.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: null, extra: 1 })
    await cards.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', extra: 1 })
    await cards.ask({ action: 'cardWorker', machineId: 'm2', harnessId: 'h1', text: 'x', extra: 1 })
    expect(request.mock.calls).toEqual([[{ action: 'cardRecap', tabId: 't1', leadId: 'l1' }], [{ action: 'cardOpen', session: 's1', tabId: 't1', leadId: null }],
      [{ action: 'cardSay', harnessId: 'h1', text: 'ship it' }], [{ action: 'cardWorker', machineId: 'm2', harnessId: 'h1' }]])
    request.mockClear()
    for (const action of ['backend', 'command', 'wake', 'prepareContribution', undefined]) expect(await cards.ask({ action, path: '/api/super-tabs' })).toEqual({ error: 'INVALID_REQUEST' })
    expect(request).not.toHaveBeenCalled()
    request.mockRejectedValueOnce(new Error('gone'))
    expect(await cards.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1' })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  })
  it('says the window\'s focus with the wish, again on a change and when the service reconnects; a malformed one is none', () => {
    const { cards, request } = wanting()
    const focus = { tabId: 't1', conversationId: 'g1' }
    cards.want(true, ['t1'], focus)
    expect(request).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: true, include: ['t1'], focus })
    cards.want(true, ['t1'], { ...focus })
    expect(request).toHaveBeenCalledTimes(1)
    cards.want(true, ['t1'], { tabId: 't1', conversationId: 'pm1' })
    expect(request).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: true, include: ['t1'], focus: { tabId: 't1', conversationId: 'pm1' } })
    request.mockClear()
    cards.serviceUp()
    expect(request.mock.calls).toEqual([[{ action: 'cardsWanted', on: true, include: ['t1'], focus: { tabId: 't1', conversationId: 'pm1' } }]])
    for (const bad of [{ tabId: 'bad id', conversationId: 'g1' }, { tabId: 't1', conversationId: 7 }, { tabId: 't1' }, 'focus', null]) {
      cards.want(true, ['t1'], { tabId: 't1', conversationId: 'pm1' })
      request.mockClear()
      cards.want(true, ['t1'], bad)
      expect(request.mock.calls).toEqual([[{ action: 'cardsWanted', on: true, include: ['t1'] }]])
    }
    // The devices gone take the focus with them.
    cards.want(true, ['t1'], focus)
    cards.devicesGone()
    expect(request).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: false, include: [] })
  })
  it('passes a device\'s focus and a swarmChat dial\'s chat flag on to the service', async () => {
    const { cards, request } = wanting()
    const focus = { tabId: 't1', conversationId: 'g1' }
    expect(await cards.ask({ action: 'cardsWanted', on: true, include: ['t1'], focus })).toEqual({ ok: true })
    expect(request).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: true, include: ['t1'], focus })
    request.mockClear()
    await cards.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1', chat: true })
    await cards.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: 'l1', chat: true })
    await cards.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: true })
    await cards.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1', chat: 'yes' })
    expect(request.mock.calls).toEqual([[{ action: 'cardRecap', tabId: 't1', leadId: 'l1', chat: true }], [{ action: 'cardOpen', session: 's1', tabId: 't1', leadId: 'l1', chat: true }],
      [{ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: true }], [{ action: 'cardRecap', tabId: 't1', leadId: 'l1' }]])
  })
  it('passes a swarmBuddy dial\'s buddy flag, and its side as cardSide with a sound side only', async () => {
    const { cards, request } = wanting()
    await cards.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1', chat: 'buddy' })
    await cards.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: 'l1', chat: 'buddy' })
    await cards.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy', chatId: 'pm1' })
    expect(await cards.ask({ action: 'cardSide', tabId: 't1', side: 'buddy', extra: 1 })).toEqual({ ok: true })
    await cards.ask({ action: 'cardSide', tabId: 't1', side: 'pm' })
    await cards.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: true, chatId: 'bad id' })
    await cards.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy', chatId: 'pm1', reviewed: true })
    expect(request.mock.calls).toEqual([[{ action: 'cardRecap', tabId: 't1', leadId: 'l1', chat: 'buddy' }], [{ action: 'cardOpen', session: 's1', tabId: 't1', leadId: 'l1', chat: 'buddy' }],
      [{ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy', chatId: 'pm1' }], [{ action: 'cardSide', tabId: 't1', side: 'buddy' }], [{ action: 'cardSide', tabId: 't1', side: 'pm' }],
      [{ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: true }],
      [{ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy', chatId: 'pm1', reviewed: true }]])
    request.mockClear()
    for (const side of ['up', null, undefined, true]) expect(await cards.ask({ action: 'cardSide', tabId: 't1', side })).toEqual({ error: 'INVALID_REQUEST' })
    expect(request).not.toHaveBeenCalled()
  })
  it('on an account change with no device wanting cards only clears the list', () => {
    const { cards, request, swarmCards } = wanting()
    cards.cards([card('t1')])
    swarmCards.mockClear()
    cards.reset()
    expect(swarmCards).toHaveBeenCalledWith([])
    expect(request).not.toHaveBeenCalled()
  })
  it('answers unavailable when the core has no way to the service', async () => {
    const cards = createSuperTabCards({ swarmCards: vi.fn(), swarmCardRecap: vi.fn(), log: vi.fn() })
    cards.want(true, [])
    expect(await cards.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: null })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  })
})
