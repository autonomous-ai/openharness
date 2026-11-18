import { describe, expect, it } from 'vitest'
import type { NoticeAsk } from '../lib/dialNotice.js'
import { type NoticeCaller, noticeKeys, Notices } from './notices.js'

type Call = ['ask', string, string, unknown] | ['close', string, string]

function desk(opts: {
  connected?: boolean; host?: string; hosts?: Record<string, string>; who?: NoticeCaller['who']
  keys?: Record<string, string[]>; clock?: number
} = {}) {
  const state = { connected: opts.connected ?? true, at: 0, clock: opts.clock ?? 0, ids: 0, resolved: 0, changes: 0, held: new Set<string>() }
  const calls: Call[] = []
  const counted: Array<[string, string]> = []
  const notices = new Notices({
    connected: () => state.connected,
    resolve: (ask) => {
      state.resolved += 1
      const agentId = ask.sessionId ?? 'a1'
      return { agentId, keys: opts.keys?.[agentId] ?? [], host: opts.hosts?.[agentId] ?? opts.host ?? 'orca', who: opts.who }
    },
    held: (agentId) => state.held.has(agentId),
    ask: (agentId, id, questions) => calls.push(['ask', agentId, id, questions]),
    close: (agentId, id) => calls.push(['close', agentId, id]),
    uuid: () => `u${++state.ids}`,
    now: () => state.at,
    clock: () => state.clock,
    changed: () => { state.changes += 1 },
    count: (engine, result) => counted.push([engine, result]),
  })
  return { notices, state, calls, counted, asks: () => calls.filter((c) => c[0] === 'ask') }
}

const VPN = 'Connect the VPN so I can run the staging tests'
const notice = (text: string, sessionId = 'a1', engine: NoticeAsk['engine'] = 'claude'): NoticeAsk =>
  ({ text, engine, sessionId, folder: 'staging-api' })

describe('Notices', () => {
  it('a notice is one shown-only question: the line, and where to answer it', () => {
    const { notices, calls, counted } = desk()
    expect(notices.notify(notice(VPN))).toBe('shown')
    expect(calls).toEqual([['ask', 'a1', expect.stringMatching(/^shown:/),
      [{ key: 'notice', q: VPN, options: ['In Orca'] }]]])
    expect(counted).toEqual([['claude', 'shown']])
  })

  it('letters the round dial cannot draw become ?', () => {
    const { notices, asks } = desk()
    notices.notify(notice('Kết nối VPN 🙏 接続'))
    expect(asks()[0][3]).toEqual([{ key: 'notice', q: 'Kết nối VPN ? ??', options: ['In Orca'] }])
  })

  // 120 letters of three bytes each are 360 bytes: the dial's drawer row keeps 239, its question 255.
  it('a line too long in bytes for the dial is cut between letters, with …', () => {
    const { notices, asks } = desk()
    notices.notify(notice('ế'.repeat(120)))
    const [{ q }] = asks()[0][3] as Array<{ q: string }>
    expect(q).toBe(`${'ế'.repeat(78)}…`)
    expect(Buffer.byteLength(q, 'utf8')).toBeLessThanOrEqual(239)
    expect(notices.rows('machine-1')[0].text).toBe(q)
    const fits = `${'ế'.repeat(79)}ab`
    notices.notify(notice(fits, 'a2'))
    expect((asks()[1][3] as Array<{ q: string }>)[0].q).toBe(fits)
  })

  // What is counted is the engine and the outcome only: the text, session and folder are the person's own.
  it('each answer is counted by its engine, agent for a caller that names none', () => {
    const { notices, state, counted } = desk()
    notices.notify(notice(VPN, 'sess-7f3a'))
    notices.notify(notice(VPN, 'sess-7f3a'))
    state.connected = false
    notices.notify({ text: VPN })
    expect(counted).toEqual([['claude', 'shown'], ['claude', 'limited'], ['agent', 'no dial']])
  })

  it('with no dial nothing is asked, resolved or counted', () => {
    const { notices, state, calls } = desk({ connected: false })
    expect(notices.notify(notice(VPN))).toBe('no dial')
    expect(calls).toEqual([])
    expect(state.resolved).toBe(0)
    state.connected = true
    expect(notices.notify(notice(VPN))).toBe('shown')
  })

  it('over a limit nothing is asked and the pending card stays', () => {
    const { notices, state, calls } = desk()
    notices.notify(notice(VPN))
    state.at = 30_000
    expect(notices.notify(notice('Another line'))).toBe('limited')
    expect(calls.map((c) => c[0])).toEqual(['ask'])
  })

  it('a newer notice of the same agent takes the older card\'s place', () => {
    const { notices, state, calls } = desk()
    notices.notify(notice(VPN))
    const first = calls[0][2]
    state.at = 61_000
    expect(notices.notify(notice('Another line'))).toBe('shown')
    const second = calls[2][2]
    expect(calls.map((c) => [c[0], c[2]])).toEqual([['ask', first], ['close', first], ['ask', second]])
    expect(second).not.toBe(first)
    notices.ended('a1')
    expect(calls.slice(3)).toEqual([['close', 'a1', second]])
  })

  it('ended closes a card once, and nothing for an agent with none', () => {
    const { notices, calls } = desk()
    notices.notify(notice(VPN))
    notices.ended('a1')
    notices.ended('a1')
    notices.ended('a2')
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['ask', 'a1'], ['close', 'a1']])
  })

  it('a dial that attaches is asked each pending card again, under its id', () => {
    const { notices, calls, asks } = desk()
    notices.notify(notice(VPN, 'a1'))
    notices.notify(notice('Second agent line', 'a2'))
    notices.notify(notice('Third agent line', 'a3'))
    notices.ended('a2')
    const before = asks().filter((c) => c[1] !== 'a2')
    calls.length = 0
    notices.attached()
    expect(calls).toEqual(before)
  })

  // The dial holds one question an agent: a notice asked over another would hide it, and drop its close.
  it('a notice waits behind another question of its agent, and is asked as that one closes', () => {
    const { notices, state, calls } = desk()
    state.held.add('a1')
    expect(notices.notify(notice(VPN))).toBe('shown')
    notices.attached()
    expect(calls).toEqual([])
    expect(notices.rows('machine-1')).toEqual([])
    state.held.delete('a1')
    notices.reask('a1')
    notices.reask('a2')
    expect(calls).toEqual([['ask', 'a1', 'shown:u1', [{ key: 'notice', q: VPN, options: ['In Orca'] }]]])
  })

  it('a notice another question of its agent covered is asked again under its id, as that one closes', () => {
    const { notices, state, asks } = desk()
    notices.notify(notice(VPN))
    state.held.add('a1')
    notices.reask('a1')
    expect(asks()).toHaveLength(1)
    state.held.delete('a1')
    notices.reask('a1')
    expect(asks()).toEqual([asks()[0], asks()[0]])
    notices.ended('a1')
    notices.reask('a1')
    expect(asks()).toHaveLength(2)
  })

  // A Harness agent's next turn reaches the devices only while a dial listens (services/recaps.ts): its card cannot
  // wait for it through an unplug, as another agent's can.
  it('the last dial going ends the cards of Harness agents, and only theirs', () => {
    const { notices, calls } = desk({ hosts: { h1: 'harness' } })
    notices.notify(notice(VPN, 'h1'))
    notices.notify(notice(VPN, 'o1'))
    calls.length = 0
    notices.detached()
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['close', 'h1']])
    calls.length = 0
    notices.attached()
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['ask', 'o1']])
  })

  it('each pending card is a drawer row, newest first, for a drawer replaced whole', () => {
    const { notices } = desk()
    notices.notify(notice(VPN, 'a1'))
    notices.notify(notice('Kết nối 🙏', 'a2'))
    notices.notify(notice('Third agent line', 'a3'))
    notices.ended('a3')
    expect(notices.rows('machine-1')).toEqual([
      { agentId: 'a2', machineId: 'machine-1', question: true, text: 'Kết nối ?' },
      { agentId: 'a1', machineId: 'machine-1', question: true, text: VPN },
    ])
  })

  it('a caller no list holds is named while its card is pending', () => {
    const who = { name: 'staging-api', engine: 'claude', machine: 'Mac mini' }
    const named = desk({ who })
    named.notices.notify(notice(VPN))
    expect(named.notices.from('a1')).toEqual(who)
    named.notices.ended('a1')
    expect(named.notices.from('a1')).toBeUndefined()
    const listed = desk()
    listed.notices.notify(notice(VPN))
    expect(listed.notices.from('a1')).toBeUndefined()
  })

  it('a card is pending from its notice until it ends, held back or not', () => {
    const { notices, state } = desk()
    expect(notices.pending('a1')).toBe(false)
    state.held.add('a1')
    notices.notify(notice(VPN))
    expect(notices.pending('a1')).toBe(true)
    expect(notices.pending('a2')).toBe(false)
    notices.ended('a1')
    expect(notices.pending('a1')).toBe(false)
  })

  it('the twenty-first pending card closes the oldest', () => {
    const { notices, state, calls } = desk()
    for (let i = 1; i <= 20; i++) expect(notices.notify(notice(VPN, `a${i}`))).toBe('shown')
    const oldest = calls[0][2]
    state.at = 61 * 60_000
    calls.length = 0
    expect(notices.notify(notice(VPN, 'a21'))).toBe('shown')
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['close', 'a1'], ['ask', 'a21']])
    expect(calls[0][2]).toBe(oldest)
  })

  it('a card is stored with its agent\'s keys, its line, its host and when it was shown', () => {
    const { notices, state } = desk({ keys: { a1: ['claude:s1', 'herdr:w1:p1'] }, clock: 5_000 })
    state.at = 99
    notices.notify(notice(VPN))
    expect(notices.stored()).toEqual([
      { agentId: 'a1', keys: ['claude:s1', 'herdr:w1:p1'], id: 'shown:u1', line: VPN, host: 'orca', at: 5_000 },
    ])
    const who = { name: 'staging-api', engine: 'claude', machine: 'Mac mini' }
    const named = desk({ who, clock: 7_000 })
    named.notices.notify(notice(VPN))
    expect(named.notices.stored()).toEqual([{ agentId: 'a1', keys: [], id: 'shown:u1', line: VPN, host: 'orca', who, at: 7_000 }])
  })

  it('the stored cards are oldest first, a replaced card last', () => {
    const { notices, state } = desk()
    notices.notify(notice(VPN, 'a1'))
    notices.notify(notice(VPN, 'a2'))
    state.at = 61_000
    notices.notify(notice('Another line', 'a1'))
    expect(notices.stored().map((card) => card.agentId)).toEqual(['a2', 'a1'])
  })

  it('each change of the pending set is told, and nothing else is', () => {
    const { notices, state } = desk({ hosts: { h1: 'harness' } })
    notices.notify(notice(VPN, 'a1'))
    expect(state.changes).toBe(1)
    notices.notify(notice('Another line', 'a1'))
    expect(state.changes).toBe(1)
    notices.reask('a1')
    notices.attached()
    notices.rows('machine-1')
    notices.pending('a1')
    notices.from('a1')
    notices.stored()
    notices.ended('a9')
    state.connected = false
    notices.notify(notice(VPN, 'a2'))
    expect(state.changes).toBe(1)
    state.connected = true
    notices.ended('a1')
    expect(state.changes).toBe(2)
    notices.notify(notice(VPN, 'h1'))
    notices.detached()
    expect(state.changes).toBe(4)
    // Twenty notices an hour at most (lib/dialNotice.ts): each batch in an hour of its own.
    state.at = 61 * 60_000
    for (let i = 1; i <= 20; i++) expect(notices.notify(notice(VPN, `b${i}`))).toBe('shown')
    expect(state.changes).toBe(24)
    state.at = 122 * 60_000
    expect(notices.notify(notice(VPN, 'b21'))).toBe('shown')
    expect(state.changes).toBe(26)
  })

  it('noticeKeys names the session first, then the panes, bounded', () => {
    expect(noticeKeys({ engine: 'claude', sessionId: 's1', paneKeys: ['herdr:w1:p1'] })).toEqual(['claude:s1', 'herdr:w1:p1'])
    expect(noticeKeys({ engine: 'claude', paneKeys: ['herdr:w1:p1', 'cmux:s2'] })).toEqual(['herdr:w1:p1', 'cmux:s2'])
    expect(noticeKeys({ engine: 'claude', sessionId: '' })).toEqual([])
    expect(noticeKeys({ engine: 'claude' })).toEqual([])
    const panes = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    expect(noticeKeys({ engine: 'claude', paneKeys: panes })).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(noticeKeys({ engine: 'claude', sessionId: 's1', paneKeys: ['x'.repeat(161), 'p1'] })).toEqual(['claude:s1', 'p1'])
  })

  it('a host nothing names reads Terminal', () => {
    const { notices, asks } = desk({ host: '' })
    notices.notify(notice(VPN))
    expect(asks()[0][3]).toEqual([{ key: 'notice', q: VPN, options: ['In Terminal'] }])
  })
})
