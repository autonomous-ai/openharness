import { describe, expect, it } from 'vitest'
import type { NoticeAsk } from '../lib/dialNotice.js'
import { type ListedAgent, listedAgent, type NoticeCaller, noticeKeys, Notices, type StoredNotice } from './notices.js'

type Call = ['ask', string, string, unknown] | ['close', string, string] | ['hold', string, string, unknown]

function desk(opts: {
  connected?: boolean; host?: string; hosts?: Record<string, string>; who?: NoticeCaller['who']
  keys?: Record<string, string[]>; clock?: number; restored?: StoredNotice[]
} = {}) {
  const state = {
    connected: opts.connected ?? true, at: 0, clock: opts.clock ?? 0, ids: 0, resolved: 0, changes: 0, redraws: [] as string[][], held: new Set<string>(),
  }
  const calls: Call[] = []
  const counted: Array<[string, string]> = []
  const logs: string[] = []
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
    restored: opts.restored ?? [],
    log: (line) => logs.push(line),
    redraw: (agentIds) => { state.redraws.push([...agentIds]) },
    hold: (agentId, id, questions) => calls.push(['hold', agentId, id, questions]),
  })
  return { notices, state, calls, counted, logs, asks: () => calls.filter((c) => c[0] === 'ask') }
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

describe('Notices after a restart', () => {
  const NOW = 1_800_000_000_000
  const DAY = 24 * 3_600_000
  const WHO = { name: 'api', engine: 'codex', machine: 'Mac mini' }
  const kept = (over: Partial<StoredNotice> = {}): StoredNotice =>
    ({ agentId: 'a1', keys: ['claude:s1'], id: 'shown:k1', line: VPN, host: 'orca', at: NOW - 60_000, ...over })
  const asWho = kept({ agentId: 'w1', id: 'shown:k2', keys: [], host: '', who: WHO })
  const asked = (host: string) => [{ key: 'notice', q: VPN, options: [`In ${host}`] }]
  const back = (cards: StoredNotice[], over: Parameters<typeof desk>[0] = {}) => desk({ restored: cards, clock: NOW, ...over })

  it('a card of the file is pending again under its id, and nothing is asked', () => {
    const { notices, state, calls } = back([kept()])
    expect(calls).toEqual([])
    expect(notices.pending('a1')).toBe(true)
    expect(notices.stored()).toEqual([kept()])
    // It waits for its agent to be listed.
    notices.attached()
    notices.reask('a1')
    expect(calls).toEqual([])
    expect(state.redraws).toEqual([])
  })

  it('a restored card of a caller no list holds is a drawer row at once; any other waits for its agent', () => {
    const { notices } = back([kept(), asWho])
    expect(notices.rows('m')).toEqual([{ agentId: 'w1', machineId: 'm', question: true, text: VPN }])
    expect(notices.from('w1')).toEqual(WHO)
  })

  // No redraw: the attach's greeting replaces the drawer after its carousel push, and a close still queued in the
  // agent's order came with its own reask, whose redraw waits behind it.
  it('a restored row\'s question is held as a dial attaches, never asked, so opening the row reads its line', () => {
    const { notices, state, calls } = back([kept(), asWho])
    notices.attached()
    expect(calls).toEqual([['hold', 'w1', 'shown:k2', asked('Terminal')]])
    expect(state.redraws).toEqual([])
  })

  it('a card older than 24 hours is dropped, one of exactly 24 hours is kept, and one ahead of the clock too', () => {
    const cards = [kept({ at: NOW - DAY - 1 }), kept({ agentId: 'a2', id: 'shown:k2', at: NOW - DAY }),
      kept({ agentId: 'a3', id: 'shown:k3', at: NOW + 60_000 })]
    const { notices, calls } = back(cards)
    expect(notices.stored()).toEqual(cards.slice(1))
    expect(calls).toEqual([])
  })

  it('the start says the counts in one line, and tells the file when a card aged out', () => {
    const aged = back([kept({ at: NOW - DAY - 1 }), kept({ agentId: 'a2', id: 'shown:k2' }), asWho])
    expect(aged.logs).toEqual(['[device] notices · restored 2 · aged out 1'])
    expect(aged.state.changes).toBe(1)
    const fresh = back([kept()])
    expect(fresh.logs).toEqual(['[device] notices · restored 1 · aged out 0'])
    expect(fresh.state.changes).toBe(0)
    expect(back([]).logs).toEqual([])
    expect([...aged.logs, ...fresh.logs].filter((line) => [VPN, 'a1', 'claude:s1'].some((secret) => line.includes(secret)))).toEqual([])
  })

  it('a restored row another question covered comes back held, by a drawer replace, never an ask', () => {
    const { notices, state, calls } = back([kept(), asWho])
    state.held.add('w1')
    expect(notices.rows('m')).toEqual([])
    notices.attached()
    notices.reask('w1')
    expect(calls).toEqual([])
    expect(state.redraws).toEqual([])
    state.held.delete('w1')
    notices.reask('w1')
    expect(calls).toEqual([['hold', 'w1', 'shown:k2', asked('Terminal')]])
    expect(state.redraws).toEqual([['w1']])
    notices.reask('a1')
    expect(calls).toHaveLength(1)
    expect(state.redraws).toEqual([['w1']])
  })

  it('a restored card ends as any card: closed under its id, once', () => {
    const { notices, state, calls } = back([kept(), asWho])
    notices.ended('w1')
    expect(calls).toEqual([['close', 'w1', 'shown:k2']])
    expect(state.changes).toBe(1)
    notices.ended('w1')
    expect(calls).toHaveLength(1)
    expect(state.changes).toBe(1)
  })

  it('a new notice of its agent rings and takes its place', () => {
    const { notices, calls } = back([kept()])
    expect(notices.notify(notice(VPN, 'a1'))).toBe('shown')
    expect(calls.map((c) => [c[0], c[2]])).toEqual([['close', 'shown:k1'], ['ask', 'shown:u1']])
    calls.length = 0
    notices.attached()
    expect(calls).toEqual([['ask', 'a1', 'shown:u1', asked('Orca')]])
  })

  it('restored cards count toward the twenty, waiting or not', () => {
    const cards = Array.from({ length: 20 }, (_, i) => kept({ agentId: `a${i + 1}`, id: `shown:k${i + 1}`, keys: [`claude:s${i + 1}`] }))
    const { notices, calls } = back(cards)
    expect(notices.notify(notice(VPN, 'a21'))).toBe('shown')
    expect(calls[0]).toEqual(['close', 'a1', 'shown:k1'])
    expect(notices.stored()).toHaveLength(20)
  })

  it('the last dial going ends a restored Harness card and leaves the others', () => {
    const { notices, calls } = back([kept({ agentId: 'h1', host: 'harness' }), asWho])
    notices.detached()
    expect(calls).toEqual([['close', 'h1', 'shown:k1']])
    expect(notices.pending('w1')).toBe(true)
  })

  describe('a restored card finds its agent', () => {
    const agent = (agentId: string, over: Partial<ListedAgent> = {}): ListedAgent => ({ agentId, panes: [], busy: false, ...over })
    /** The lists a look is given, and how many times it read them. */
    const lists = (...agents: ListedAgent[]) => {
      const read = Object.assign(() => { read.reads += 1; return agents }, { reads: 0 })
      return read
    }
    const row = (agentId: string) => ({ agentId, machineId: 'm', question: true, text: VPN })

    it('found by its id, its row is in the drawer by one drawer replace, and its question is held, never asked', () => {
      const { notices, state, calls } = back([kept()])
      notices.look(false, lists(agent('a1')))
      expect(notices.rows('m')).toEqual([row('a1')])
      expect(state.redraws).toEqual([['a1']])
      expect(calls).toEqual([['hold', 'a1', 'shown:k1', asked('Orca')]])
      expect(state.changes).toBe(0)
      // Another question of that agent covers it: found all the same, and nothing held or shown under it.
      const covered = back([kept()])
      covered.state.held.add('a1')
      covered.notices.look(false, lists(agent('a1')))
      const again = lists(agent('a1'))
      covered.notices.look(false, again)
      expect(again.reads).toBe(0)
      expect(covered.calls).toEqual([])
      expect(covered.notices.rows('m')).toEqual([])
    })

    it('several found in one look are one drawer replace, behind each one\'s order', () => {
      const { notices, state } = back([kept(), kept({ agentId: 'a2', id: 'shown:k2', keys: ['claude:s2'] })])
      notices.look(false, lists(agent('a1'), agent('a2')))
      expect(state.redraws).toEqual([['a1', 'a2']])
    })

    it('found by its session under a new id, it takes that id in its place, and the file is told', () => {
      const { notices, state, calls } = back([kept({ agentId: 'old' }), asWho])
      notices.look(false, lists(agent('new', { session: 'claude:s1' })))
      expect(notices.stored().map((card) => card.agentId)).toEqual(['new', 'w1'])
      expect(notices.pending('old')).toBe(false)
      expect(state.changes).toBe(1)
      expect(calls).toEqual([['hold', 'new', 'shown:k1', asked('Orca')]])
      notices.ended('new')
      expect(calls.at(-1)).toEqual(['close', 'new', 'shown:k1'])
    })

    it('found by a pane when the agent names no session', () => {
      const { notices } = back([kept({ agentId: 'old', keys: ['claude:s1', 'herdr:w1:p1'] })])
      notices.look(false, lists(agent('new', { panes: ['herdr:w1:p1'] })))
      expect(notices.rows('m')).toEqual([row('new')])
    })

    // A /clear, or another agent started in that pane before the list came back: its session names it, not the pane.
    it('another session in the same pane is not its agent', () => {
      const { notices, state } = back([kept({ agentId: 'old', keys: ['claude:s1', 'herdr:w1:p1'] })])
      notices.look(false, lists(agent('new', { session: 'claude:s2', panes: ['herdr:w1:p1'] })))
      expect(notices.rows('m')).toEqual([])
      expect(state.redraws).toEqual([])
      expect(notices.pending('old')).toBe(true)
    })

    it('a Harness card looks among Harness agents alone, any other among the outside lists alone', () => {
      const own = back([kept({ host: 'harness' })])
      const outside = lists(agent('a1'))
      own.notices.look(false, outside)
      expect(outside.reads).toBe(0)
      expect(own.notices.rows('m')).toEqual([])
      own.notices.look(true, lists(agent('a1')))
      expect(own.notices.rows('m')).toEqual([row('a1')])
      const other = back([kept()])
      const harness = lists(agent('a1'))
      other.notices.look(true, harness)
      expect(harness.reads).toBe(0)
      expect(other.notices.rows('m')).toEqual([])
      other.notices.look(false, lists(agent('a1')))
      expect(other.notices.rows('m')).toEqual([row('a1')])
    })

    it('first seen in a turn, it ends and is never shown', () => {
      const { notices, state, calls } = back([kept()])
      notices.look(false, lists(agent('a1', { busy: true })))
      expect(calls).toEqual([['close', 'a1', 'shown:k1']])
      expect(notices.rows('m')).toEqual([])
      expect(state.redraws).toEqual([])
      expect(state.changes).toBe(1)
    })

    it('not listed, it waits; with none waiting the lists are not read', () => {
      const { notices, state, calls } = back([kept()])
      const none = lists()
      notices.look(false, none)
      expect(none.reads).toBe(1)
      expect(calls).toEqual([])
      expect(state.changes).toBe(0)
      expect(state.redraws).toEqual([])
      expect(notices.pending('a1')).toBe(true)
      notices.look(false, lists(agent('a1')))
      const after = lists(agent('a1'))
      notices.look(false, after)
      expect(after.reads).toBe(0)
    })

    it('found once, it is looked for no more', () => {
      const { notices } = back([kept()])
      notices.look(false, lists(agent('a1')))
      notices.look(false, lists(agent('a1', { busy: true })))
      expect(notices.pending('a1')).toBe(true)
    })

    it('a new notice from an agent whose restored card waits under another id ends that card', () => {
      const { notices, calls } = back([kept({ agentId: 'old' })], { keys: { new: ['claude:s1'] } })
      expect(notices.notify(notice(VPN, 'new'))).toBe('shown')
      expect(calls.map((c) => [c[0], c[1], c[2]])).toEqual([['close', 'old', 'shown:k1'], ['ask', 'new', 'shown:u1']])
      expect(notices.stored()).toHaveLength(1)
    })

    it('a card whose agent already has one ends', () => {
      const { notices, calls } = back([kept({ agentId: 'x1' }), kept({ agentId: 'x2', id: 'shown:k2' })])
      notices.look(false, lists(agent('new', { session: 'claude:s1' })))
      expect(notices.stored().map((card) => [card.agentId, card.id])).toEqual([['new', 'shown:k1']])
      expect(calls).toEqual([['hold', 'new', 'shown:k1', asked('Orca')], ['close', 'x2', 'shown:k2']])
    })

    it('working ends a restored card, waiting or shown, and leaves a live one', () => {
      const { notices, calls } = back([kept(), asWho])
      notices.working('a1')
      notices.working('w1')
      expect(calls).toEqual([['close', 'a1', 'shown:k1'], ['close', 'w1', 'shown:k2']])
      const live = desk()
      live.notices.notify(notice(VPN))
      live.notices.working('a1')
      live.notices.working('a2')
      expect(live.calls.map((c) => c[0])).toEqual(['ask'])
      expect(live.notices.pending('a1')).toBe(true)
    })

    it('listedAgent and noticeKeys name a session the same way', () => {
      const named = { engine: 'claude', sessionId: 's1', paneKeys: ['herdr:p'] }
      const listed = listedAgent('x', named, true)
      expect(listed).toEqual({ agentId: 'x', session: 'claude:s1', panes: ['herdr:p'], busy: true })
      expect(listed.session).toBe(noticeKeys(named)[0])
      expect(listedAgent('x', { engine: 'claude' }, false).session).toBeUndefined()
    })
  })
})
