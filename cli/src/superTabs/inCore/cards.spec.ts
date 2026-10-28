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
  it('lets the devices ask three things of the service and nothing else, whatever the path', async () => {
    const { cards, request } = wanting()
    expect(await cards.ask({ action: 'cardsWanted', on: true, include: ['t1'] })).toEqual({ ok: true })
    expect(request.mock.calls).toEqual([[{ action: 'cardsWanted', on: true, include: ['t1'] }]])
    request.mockClear()
    await cards.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1', extra: 1 })
    await cards.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: null, extra: 1 })
    await cards.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', extra: 1 })
    expect(request.mock.calls).toEqual([[{ action: 'cardRecap', tabId: 't1', leadId: 'l1' }], [{ action: 'cardOpen', session: 's1', tabId: 't1', leadId: null }],
      [{ action: 'cardSay', harnessId: 'h1', text: 'ship it' }]])
    request.mockClear()
    for (const action of ['backend', 'command', 'wake', 'prepareContribution', undefined]) expect(await cards.ask({ action, path: '/api/super-tabs' })).toEqual({ error: 'INVALID_REQUEST' })
    expect(request).not.toHaveBeenCalled()
    request.mockRejectedValueOnce(new Error('gone'))
    expect(await cards.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1' })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
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
