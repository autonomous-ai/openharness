import { describe, expect, it } from 'vitest'
import { composeNotice, type NoticeAsk } from '../lib/dialNotice.js'
import { type ListedAgent, listedAgent, type NoticeCaller, type NoticeEnd, noticeKeys, Notices, NOTICE_WAITING_MAX, type StoredNotice } from './notices.js'

type Call = ['ask', string, string, unknown] | ['close', string, string] | ['hold', string, string, unknown]

/** The desk's n-th uuid: its first 8 characters name the card, the rest tell one draw from another. */
const uuid = (n: number): string => `${String(n).padStart(8, '0')}-${n}`
/** The id of the card drawn n-th: the agent's to close it by. */
const cid = (n: number): string => uuid(n).slice(0, 8)
/** The question id of the card drawn n-th, under draw [again] once a rouse asked it anew. */
const qid = (n: number, again = n): string => `shown:${cid(n)}${uuid(again).slice(8)}`

function desk(opts: {
  connected?: boolean; host?: string; hosts?: Record<string, string>; who?: NoticeCaller['who']
  keys?: Record<string, string[]>; clock?: number; restored?: StoredNotice[]
  /** The uuids drawn first, before the desk's own. */
  uuids?: string[]
} = {}) {
  const state = {
    connected: opts.connected ?? true, at: 0, clock: opts.clock ?? 0, ids: 0, resolved: 0, changes: 0, redraws: [] as string[][], held: new Set<string>(),
    present: new Set<string>(), presentReads: 0,
    /** The timers' own time, apart from the wall clock: a sleep moves the clock alone. */
    ticks: 0, timers: [] as Array<{ due: number; ms: number; run: () => void; live: boolean }>,
  }
  const calls: Call[] = []
  const counted: string[][] = []
  const logs: string[] = []
  /** Each card that went: its agent, its id, its kind and why. */
  const ends: string[][] = []
  const notices = new Notices({
    connected: () => state.connected,
    resolve: (ask) => {
      state.resolved += 1
      const agentId = ask.sessionId ?? 'a1'
      return { agentId, keys: opts.keys?.[agentId] ?? [], host: opts.hosts?.[agentId] ?? opts.host ?? 'orca', who: opts.who }
    },
    held: (agentId) => state.held.has(agentId),
    present: (agentId) => {
      state.presentReads += 1
      return state.present.has(agentId)
    },
    ask: (agentId, id, questions) => calls.push(['ask', agentId, id, questions]),
    close: (agentId, id) => calls.push(['close', agentId, id]),
    uuid: () => {
      state.ids += 1
      return opts.uuids?.[state.ids - 1] ?? uuid(state.ids)
    },
    now: () => state.at,
    clock: () => state.clock,
    changed: () => { state.changes += 1 },
    count: (engine, result, kind, present) => counted.push(present ? [engine, result, kind, 'present'] : [engine, result, kind]),
    restored: opts.restored ?? [],
    log: (line) => logs.push(line),
    redraw: (agentIds) => { state.redraws.push([...agentIds]) },
    hold: (agentId, id, questions) => calls.push(['hold', agentId, id, questions]),
    after: (ms, run) => {
      const timer = { due: state.ticks + ms, ms, run, live: true }
      state.timers.push(timer)
      return () => { timer.live = false }
    },
    closed: (agentId, { id, kind }, end) => { ends.push([agentId, id, kind, end]) },
  })
  return { notices, state, calls, counted, logs, ends, asks: () => calls.filter((c) => c[0] === 'ask') }
}

const VPN = 'Connect the VPN so I can run the staging tests'
const W = (n: number): string => `Waiting · Question ${n}`
const P = (n: number): string => `Proceeding · Step ${n} · Doing: it`
const notice =(text: string, sessionId = 'a1', engine: NoticeAsk['engine'] = 'claude'): NoticeAsk =>
  ({ text, engine, sessionId, folder: 'staging-api' })

describe('Notices', () => {
  it('a notice is one shown-only question: the line, and where to answer it', () => {
    const { notices, calls, counted } = desk()
    expect(notices.notify(notice(VPN)).result).toBe('shown')
    expect(calls).toEqual([['ask', 'a1', expect.stringMatching(/^shown:/),
      [{ key: 'notice', q: VPN, options: ['In Orca'] }]]])
    expect(counted).toEqual([['claude', 'shown', 'plain']])
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

  // The CLI composes a waiting line to the byte limit: the card must carry its suggestion whole, not cut off the end.
  it('a composed line of exactly 239 bytes is asked whole', () => {
    const { notices, asks } = desk()
    const line = composeNotice('ữ'.repeat(100), 'Dùng Redis', 'waiting')
    notices.notify(notice(line))
    expect((asks()[0][3] as Array<{ q: string }>)[0].q).toBe(line)
  })

  // What is counted is the engine and the outcome only: the text, session and folder are the person's own.
  it('each answer is counted by its engine, agent for a caller that names none', () => {
    const { notices, state, counted } = desk()
    notices.notify(notice(VPN, 'sess-7f3a'))
    notices.notify(notice(VPN, 'sess-7f3a'))
    state.connected = false
    notices.notify({ text: VPN })
    expect(counted).toEqual([['claude', 'shown', 'plain'], ['claude', 'limited', 'plain'], ['agent', 'no dial', 'plain']])
  })

  // The kind is read from the opening the CLI writes; a plain line that only starts like one is a limit the spec names.
  it('each answer is counted with the kind its line opens with', () => {
    const { notices, state, counted } = desk()
    notices.notify(notice('Waiting · Q', 'a1'))
    notices.notify(notice('Proceeding · Q · Doing: S', 'a2'))
    notices.notify(notice('Connect the VPN', 'a3'))
    notices.notify(notice('Waiting for CI', 'a4'))
    notices.notify(notice('Waiting · Q2', 'a1'))
    state.connected = false
    notices.notify(notice('Proceeding · Q · Doing: S', 'a5'))
    expect(counted).toEqual([
      ['claude', 'shown', 'waiting'], ['claude', 'shown', 'proceeding'], ['claude', 'shown', 'plain'], ['claude', 'shown', 'plain'],
      ['claude', 'limited', 'waiting'], ['claude', 'no dial', 'proceeding'],
    ])
  })

  it('with no dial nothing is asked, resolved or counted', () => {
    const { notices, state, calls } = desk({ connected: false })
    expect(notices.notify(notice(VPN)).result).toBe('no dial')
    expect(calls).toEqual([])
    expect(state.resolved).toBe(0)
    state.connected = true
    expect(notices.notify(notice(VPN)).result).toBe('shown')
  })

  it('over a limit nothing is asked and the pending card stays', () => {
    const { notices, state, calls } = desk()
    notices.notify(notice(VPN))
    state.at = 30_000
    expect(notices.notify(notice('Another line')).result).toBe('limited')
    expect(calls.map((c) => c[0])).toEqual(['ask'])
  })

  it('a newer notice of the same agent takes the older card\'s place', () => {
    const { notices, state, calls } = desk()
    notices.notify(notice(VPN))
    const first = calls[0][2]
    state.at = 61_000
    expect(notices.notify(notice('Another line')).result).toBe('shown')
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

  // It rang as it was asked: sent again, it would ring for a card the person may have answered already.
  it('a dial that attaches is held each pending card again, under its id', () => {
    const { notices, calls, asks } = desk()
    notices.notify(notice(VPN, 'a1'))
    notices.notify(notice('Second agent line', 'a2'))
    notices.notify(notice('Third agent line', 'a3'))
    notices.ended('a2')
    const before = asks().filter((c) => c[1] !== 'a2').map(([, agentId, id, questions]) => ['hold', agentId, id, questions])
    calls.length = 0
    notices.attached()
    expect(calls).toEqual(before)
  })

  // The dial holds one question an agent: a notice asked over another would hide it, and drop its close.
  it('a notice waits behind another question of its agent, and is asked as that one closes', () => {
    const { notices, state, calls } = desk()
    state.held.add('a1')
    expect(notices.notify(notice(VPN)).result).toBe('shown')
    notices.attached()
    expect(calls).toEqual([])
    expect(notices.rows('machine-1')).toEqual([])
    state.held.delete('a1')
    notices.reask('a1')
    notices.reask('a2')
    expect(calls).toEqual([['ask', 'a1', qid(1), [{ key: 'notice', q: VPN, options: ['In Orca'] }]]])
  })

  // The design's anti-goal: a ring for a card the person already answered. A card that rang is held from then on, its
  // row back in the drawer with no ring.
  it('a card that rang is held, not asked, when another question of its agent closes', () => {
    const { notices, state, calls } = desk()
    notices.notify(notice(VPN))
    calls.length = 0
    state.held.add('a1')
    notices.reask('a1')
    expect(calls).toEqual([])
    state.held.delete('a1')
    notices.reask('a1')
    expect(calls).toEqual([['hold', 'a1', qid(1), [{ key: 'notice', q: VPN, options: ['In Orca'] }]]])
    expect(state.redraws).toEqual([['a1']])
    notices.ended('a1')
    calls.length = 0
    notices.reask('a1')
    expect(calls).toEqual([])
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
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['hold', 'o1']])
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
    for (let i = 1; i <= 20; i++) expect(notices.notify(notice(VPN, `a${i}`)).result).toBe('shown')
    const oldest = calls[0][2]
    state.at = 61 * 60_000
    calls.length = 0
    expect(notices.notify(notice(VPN, 'a21')).result).toBe('shown')
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['close', 'a1'], ['ask', 'a21']])
    expect(calls[0][2]).toBe(oldest)
  })

  it('a card is stored with its agent\'s keys, its line, its host and when it was shown', () => {
    const { notices, state } = desk({ keys: { a1: ['claude:s1', 'herdr:w1:p1'] }, clock: 5_000 })
    state.at = 99
    notices.notify(notice(VPN))
    expect(notices.stored()).toEqual([
      { agentId: 'a1', keys: ['claude:s1', 'herdr:w1:p1'], id: qid(1), line: VPN, host: 'orca', at: 5_000 },
    ])
    const who = { name: 'staging-api', engine: 'claude', machine: 'Mac mini' }
    const named = desk({ who, clock: 7_000 })
    named.notices.notify(notice(VPN))
    expect(named.notices.stored()).toEqual([{ agentId: 'a1', keys: [], id: qid(1), line: VPN, host: 'orca', who, at: 7_000 }])
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
    for (let i = 1; i <= 20; i++) expect(notices.notify(notice(VPN, `b${i}`)).result).toBe('shown')
    expect(state.changes).toBe(24)
    state.at = 122 * 60_000
    expect(notices.notify(notice(VPN, 'b21')).result).toBe('shown')
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

// docs/plans/2026-11-26-needs-you-right-design.md, Part 2: the person is already with that agent, so its card comes as a
// drawer row with no beep and no wake, the path a restored card takes.
describe('Notices: a present caller', () => {
  const asked = [{ key: 'notice', q: VPN, options: ['In Orca'] }]

  it('a present caller\'s card is held, never asked, and still shown', () => {
    const { notices, state, calls, counted } = desk()
    state.present.add('a1')
    expect(notices.notify(notice(VPN)).result).toBe('shown')
    expect(calls).toEqual([['hold', 'a1', expect.stringMatching(/^shown:/), asked]])
    expect(state.redraws).toEqual([['a1']])
    expect(counted).toEqual([['claude', 'shown', 'plain', 'present']])
    expect(notices.quiet('a1')).toBe(true)
    expect(notices.quiet('a2')).toBe(false)
  })

  it.each([['waiting'], ['proceeding'], ['plain']] as const)('a %s notice is held alike', (kind) => {
    const { notices, state, calls, counted } = desk()
    state.present.add('a1')
    expect(notices.notify(notice(composeNotice('q', 's', kind === 'plain' ? undefined : kind))).result).toBe('shown')
    expect(calls.map((c) => c[0])).toEqual(['hold'])
    expect(counted.at(-1)).toEqual(['claude', 'shown', kind, 'present'])
  })

  it('it stays pending, a drawer row, until it ends', () => {
    const { notices, state, calls } = desk()
    state.present.add('a1')
    notices.notify(notice(VPN))
    const id = calls[0][2]
    expect(notices.pending('a1')).toBe(true)
    expect(notices.rows('m')).toEqual([{ agentId: 'a1', machineId: 'm', question: true, text: VPN }])
    calls.length = 0
    notices.ended('a1')
    expect(calls).toEqual([['close', 'a1', id]])
    expect(notices.quiet('a1')).toBe(false)
  })

  it('it leaves the hour\'s count alone and still takes its agent\'s minute', () => {
    const { notices, state, calls, counted } = desk()
    for (let i = 1; i <= 20; i++) {
      state.at = (i - 1) * 1_000
      state.present.add(`a${i}`)
      expect(notices.notify(notice(VPN, `a${i}`)).result).toBe('shown')
    }
    expect(calls.every((c) => c[0] === 'hold')).toBe(true)
    calls.length = 0
    state.at = 20_000
    expect(notices.notify(notice(VPN, 'a21')).result).toBe('shown')
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['close', 'a1'], ['ask', 'a21']])
    state.at = 30_000
    expect(notices.notify(notice('Another line', 'a1')).result).toBe('limited')
    expect(counted.filter((c) => c[1] === 'limited')).toEqual([['claude', 'limited', 'plain']])
  })

  it('presence is read before the limits', () => {
    const { notices, state, calls } = desk()
    for (let i = 1; i <= 20; i++) expect(notices.notify(notice(VPN, `a${i}`)).result).toBe('shown')
    expect(notices.notify(notice(VPN, 'a21')).result).toBe('limited')
    state.present.add('p1')
    calls.length = 0
    expect(notices.notify(notice(VPN, 'p1')).result).toBe('shown')
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['close', 'a1'], ['hold', 'p1']])
  })

  it('with no dial presence is not read', () => {
    const { notices, state, counted } = desk({ connected: false })
    state.present.add('a1')
    expect(notices.notify(notice(VPN)).result).toBe('no dial')
    expect(state.presentReads).toBe(0)
    expect(counted).toEqual([['claude', 'no dial', 'plain']])
  })

  it('covered by another question of its agent, it is held and redrawn as that one closes', () => {
    const { notices, state, calls } = desk()
    state.held.add('a1')
    state.present.add('a1')
    expect(notices.notify(notice(VPN)).result).toBe('shown')
    expect(calls).toEqual([])
    expect(state.redraws).toEqual([])
    state.held.delete('a1')
    notices.reask('a1')
    expect(calls).toEqual([['hold', 'a1', qid(1), asked]])
    expect(state.redraws).toEqual([['a1']])
  })

  it('a dial that attaches holds it again, with no redraw', () => {
    const { notices, state, calls } = desk()
    state.present.add('a1')
    notices.notify(notice(VPN))
    calls.length = 0
    notices.attached()
    expect(calls).toEqual([['hold', 'a1', qid(1), asked]])
    expect(state.redraws).toEqual([['a1']])
  })

  it('a newer notice replaces it: rung when the person has gone, held when still there', () => {
    const gone = desk()
    gone.state.present.add('a1')
    gone.notices.notify(notice(VPN))
    gone.state.at = 61_000
    gone.state.present.clear()
    expect(gone.notices.notify(notice('Another line')).result).toBe('shown')
    expect(gone.calls.map((c) => [c[0], c[2]])).toEqual([['hold', qid(1)], ['close', qid(1)], ['ask', qid(2)]])
    expect(gone.notices.quiet('a1')).toBe(false)
    const there = desk()
    there.notices.notify(notice(VPN))
    there.state.at = 61_000
    there.state.present.add('a1')
    expect(there.notices.notify(notice('Another line')).result).toBe('shown')
    expect(there.calls.map((c) => [c[0], c[2]])).toEqual([['ask', qid(1)], ['close', qid(1)], ['hold', qid(2)]])
    expect(there.notices.quiet('a1')).toBe(true)
  })

  it('the last dial going ends a quiet Harness card, as a live one', () => {
    const { notices, state, calls } = desk({ hosts: { h1: 'harness' } })
    state.present.add('h1')
    notices.notify(notice(VPN, 'h1'))
    calls.length = 0
    notices.detached()
    expect(calls).toEqual([['close', 'h1', qid(1)]])
    expect(notices.pending('h1')).toBe(false)
  })

  // After a restart every restored card is held already: the file needs no word of it.
  it('a quiet card is stored as any card', () => {
    const { notices, state } = desk()
    state.present.add('a1')
    notices.notify(notice(VPN))
    expect(notices.stored()).toEqual([{ agentId: 'a1', keys: [], id: qid(1), line: VPN, host: 'orca', at: 0 }])
  })
})

// docs/plans/2026-11-26-needs-you-right-design.md, Part 2b: its turn ended and the person has gone, so the quiet card
// rings once. The dial mutes an id it holds, so it is asked under a new one.
describe('Notices: a quiet card at its turn\'s end (Part 2b)', () => {
  const asked = [{ key: 'notice', q: VPN, options: ['In Orca'] }]
  const quietly = (over: Parameters<typeof desk>[0] = {}) => {
    const rig = desk(over)
    rig.state.present.add('a1')
    rig.notices.notify(notice(VPN))
    rig.calls.length = 0
    return rig
  }

  it('it is asked once, under a new id, and is no longer quiet', () => {
    const { notices, state, calls } = quietly()
    const changes = state.changes
    expect(notices.rouse('a1')).toEqual({ id: cid(1), kind: 'plain' })
    expect(calls).toEqual([['close', 'a1', qid(1)], ['ask', 'a1', qid(1, 2), asked]])
    expect(notices.quiet('a1')).toBe(false)
    expect(notices.pending('a1')).toBe(true)
    expect(notices.stored()[0].id).toBe(qid(1, 2))
    expect(state.changes).toBeGreaterThan(changes)
    calls.length = 0
    expect(notices.rouse('a1')).toBeUndefined()
    expect(calls).toEqual([])
  })

  it.each(['waiting', 'proceeding', 'plain'] as const)('it answers the id and the kind of a %s card', (kind) => {
    const { notices, state } = desk()
    state.present.add('a1')
    notices.notify(notice(composeNotice('q', 's', kind === 'plain' ? undefined : kind)))
    expect(notices.rouse('a1')).toEqual({ id: cid(1), kind })
  })

  it('a rung card, a restored card and no card are left', () => {
    const rung = desk()
    rung.notices.notify(notice(VPN, 'a2'))
    rung.calls.length = 0
    expect(rung.notices.rouse('a2')).toBeUndefined()
    expect(rung.notices.rouse('none')).toBeUndefined()
    expect(rung.calls).toEqual([])
    const NOW = 1_800_000_000_000
    const back = desk({ clock: NOW, restored: [{ agentId: 'a1', keys: [], id: 'shown:k1', line: VPN, host: 'orca', at: NOW - 60_000 }] })
    expect(back.notices.rouse('a1')).toBeUndefined()
    expect(back.calls).toEqual([])
  })

  it('with no hour left it stays quiet', () => {
    const { notices, state, calls } = desk()
    for (let i = 1; i <= 20; i++) {
      state.at = (i - 1) * 1_000
      expect(notices.notify(notice(VPN, `a${i}`)).result).toBe('shown')
    }
    state.at = 20_000
    state.present.add('p')
    expect(notices.notify(notice(VPN, 'p')).result).toBe('shown')
    calls.length = 0
    expect(notices.rouse('p')).toBeUndefined()
    expect(calls).toEqual([])
    expect(notices.quiet('p')).toBe(true)
    state.at = 20_000 + 3_600_000
    expect(notices.rouse('p')).toEqual({ id: cid(21), kind: 'plain' })
  })

  // Decided by the PM (2026-11-26): a dial that attaches later holds it, as today.
  it('with no dial it stays quiet', () => {
    const { notices, state, calls } = quietly()
    state.connected = false
    expect(notices.rouse('a1')).toBeUndefined()
    expect(calls).toEqual([])
    expect(notices.quiet('a1')).toBe(true)
  })

  it('covered by another question of its agent, it is asked as that one closes', () => {
    const { notices, state, calls } = desk()
    state.held.add('a1')
    state.present.add('a1')
    notices.notify(notice(VPN))
    expect(notices.rouse('a1')).toEqual({ id: cid(1), kind: 'plain' })
    expect(calls).toEqual([['close', 'a1', qid(1)]])
    state.held.delete('a1')
    notices.reask('a1')
    expect(calls).toEqual([['close', 'a1', qid(1)], ['ask', 'a1', qid(1, 2), asked]])
    expect(state.redraws).toEqual([])
  })

  // Decided by the PM (2026-11-26): it loses quiet, so from then it is a rung card, held when sent again.
  it('from then it is any rung card', () => {
    const { notices, calls } = quietly()
    notices.rouse('a1')
    calls.length = 0
    notices.attached()
    expect(calls).toEqual([['hold', 'a1', qid(1, 2), asked]])
    calls.length = 0
    notices.ended('a1')
    expect(calls).toEqual([['close', 'a1', qid(1, 2)]])
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

  it('a card 24 hours old is dropped, one a millisecond younger is kept, and one ahead of the clock too', () => {
    const cards = [kept({ at: NOW - DAY }), kept({ agentId: 'a2', id: 'shown:k2', at: NOW - DAY + 1 }),
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
    expect(notices.notify(notice(VPN, 'a1')).result).toBe('shown')
    expect(calls.map((c) => [c[0], c[2]])).toEqual([['close', 'shown:k1'], ['ask', qid(1)]])
    calls.length = 0
    notices.attached()
    expect(calls).toEqual([['hold', 'a1', qid(1), asked('Orca')]])
  })

  it('restored cards count toward the twenty, waiting or not', () => {
    const cards = Array.from({ length: 20 }, (_, i) => kept({ agentId: `a${i + 1}`, id: `shown:k${i + 1}`, keys: [`claude:s${i + 1}`] }))
    const { notices, calls } = back(cards)
    expect(notices.notify(notice(VPN, 'a21')).result).toBe('shown')
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
    const agent = (agentId: string, over: Partial<ListedAgent> = {}): ListedAgent => ({ agentId, panes: [], ...over })
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

    // A listed agent in a turn closed its restored card until 2026-11-27: Harness cannot tell from a turn whether the
    // person answered, so a list that says busy, as an older one did, changes nothing.
    it('a restored card found busy is kept and shown as a row', () => {
      const { notices, state, calls } = back([kept()])
      notices.look(false, lists({ ...agent('a1'), busy: true } as ListedAgent))
      expect(calls).toEqual([['hold', 'a1', 'shown:k1', asked('Orca')]])
      expect(notices.rows('m')).toEqual([row('a1')])
      expect(state.redraws).toEqual([['a1']])
      expect(state.changes).toBe(0)
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

    // The restored card is the older: shown, held, while the new one waits behind it with no ring.
    it('a new notice from an agent whose restored card waits under another id: that card joins its cards', () => {
      const { notices, calls, state } = back([kept({ agentId: 'old', line: W(1) })], { keys: { new: ['claude:s1'] } })
      expect(notices.notify(notice(W(2), 'new'))).toEqual({ result: 'shown', card: { id: cid(1), kind: 'waiting', quiet: false, rang: false } })
      expect(calls).toEqual([['hold', 'new', 'shown:k1', [{ key: 'notice', q: `${W(1)} (1/2)`, options: ['In Orca'] }]]])
      expect(state.redraws).toEqual([['new']])
      expect(notices.stored().map((card) => [card.agentId, card.id])).toEqual([['new', 'shown:k1'], ['new', qid(1)]])
      // Two other cards: the newest is kept (rule 2).
      const plain = back([kept({ agentId: 'old' })], { keys: { new: ['claude:s1'] } })
      expect(plain.notices.notify(notice(VPN, 'new')).result).toBe('shown')
      expect(plain.calls.map((c) => [c[0], c[1], c[2]])).toEqual([['close', 'new', 'shown:k1'], ['ask', 'new', qid(1)]])
      expect(plain.notices.stored()).toHaveLength(1)
    })

    it('listedAgent and noticeKeys name a session the same way', () => {
      const named = { engine: 'claude', sessionId: 's1', paneKeys: ['herdr:p'] }
      const listed = listedAgent('x', named)
      expect(listed).toStrictEqual({ agentId: 'x', session: 'claude:s1', panes: ['herdr:p'] })
      expect(listed.session).toBe(noticeKeys(named)[0])
      expect(listedAgent('x', { engine: 'claude' }).session).toBeUndefined()
    })
  })
})

// docs/plans/2026-11-27-dial-notice-cards-agent-closes-design.md: an agent keeps up to five waiting cards and one other,
// and the dial shows one of them, its oldest waiting card, with its place. Each notice of an agent comes a minute after
// its last, past the agent's own limit.
describe('several cards an agent', () => {
  type Rig = ReturnType<typeof desk>
  /** [agentId]'s notice of [line], then the clock a minute on. */
  const say = ({ notices, state }: Rig, line: string, agentId = 'a') => {
    const outcome = notices.notify(notice(line, agentId))
    state.at += 61_000
    return outcome
  }
  const card = (q: string) => [{ key: 'notice', q, options: ['In Orca'] }]
  const row = (text: string, agentId = 'a') => ({ agentId, machineId: 'm', question: true, text })
  const lines = ({ notices }: Rig, agentId = 'a') => notices.list(agentId).map(({ line }) => line)
  const clear = ({ calls, state }: Rig) => {
    calls.length = 0
    state.redraws.length = 0
  }

  it('keeps five waiting cards an agent, and a sixth drops the oldest', () => {
    const rig = desk()
    for (let n = 1; n <= 5; n++) expect(say(rig, W(n)).result).toBe('shown')
    clear(rig)
    expect(say(rig, W(6)).result).toBe('shown')
    expect(lines(rig)).toEqual([W(2), W(3), W(4), W(5), W(6)])
    expect(NOTICE_WAITING_MAX).toBe(5)
    // The oldest was the card shown: the next comes up, held.
    expect(rig.calls).toEqual([['close', 'a', qid(1)], ['hold', 'a', qid(2), card(`${W(2)} (1/5)`)]])
    expect(rig.logs).toEqual(['[device] notice · dropped · sixth'])
  })

  it('a proceeding or plain card replaces only the other card', () => {
    const rig = desk()
    say(rig, W(1))
    say(rig, P(1))
    say(rig, W(2))
    clear(rig)
    say(rig, VPN)
    expect(lines(rig)).toEqual([W(1), W(2), VPN])
    expect(rig.notices.list('a').map(({ kind }) => kind)).toEqual(['waiting', 'waiting', 'plain'])
    expect(rig.calls).toEqual([['close', 'a', qid(2)]])
  })

  it('the dial shows the oldest waiting card with its place', () => {
    const rig = desk()
    say(rig, W(1))
    expect(rig.calls).toEqual([['ask', 'a', qid(1), card(W(1))]])
    clear(rig)
    say(rig, W(2))
    expect(rig.calls).toEqual([['hold', 'a', qid(1), card(`${W(1)} (1/2)`)]])
    expect(rig.state.redraws).toEqual([['a']])
    expect(rig.notices.rows('m')).toEqual([row(`${W(1)} (1/2)`)])
    expect(rig.notices.shown('a')).toEqual({ id: cid(1), kind: 'waiting' })
    // Its other card alone is asked; a waiting card then takes the dial, rung, and the other card's question closes.
    const other = desk()
    say(other, P(1))
    say(other, W(2))
    expect(other.calls).toEqual([
      ['ask', 'a', qid(1), card(P(1))], ['close', 'a', qid(1)], ['ask', 'a', qid(2), card(`${W(2)} (1/2)`)],
    ])
    expect(other.state.redraws).toEqual([])
    expect(other.notices.shown('a')).toEqual({ id: cid(2), kind: 'waiting' })
    expect(other.notices.rows('m')).toEqual([row(`${W(2)} (1/2)`)])
  })

  it('the place never pushes the line past 239 bytes', () => {
    const long = `${W(1)} ${'x'.repeat(217)}`
    expect(Buffer.byteLength(long)).toBe(239)
    const rig = desk()
    say(rig, long)
    say(rig, W(2))
    const cut = `${W(1)} ${'x'.repeat(208)}… (1/2)`
    expect(Buffer.byteLength(cut)).toBe(239)
    expect(rig.calls.at(-1)).toEqual(['hold', 'a', qid(1), card(cut)])
    expect(rig.notices.rows('m')).toEqual([row(cut)])
    expect(lines(rig)).toEqual([long, W(2)])
  })

  it('closing the card shown brings the next up without a ring', () => {
    const rig = desk()
    say(rig, W(1))
    say(rig, W(2))
    clear(rig)
    expect(rig.notices.done('a', cid(1))).toBe(1)
    expect(rig.calls).toEqual([['close', 'a', qid(1)], ['hold', 'a', qid(2), card(W(2))]])
    expect(rig.state.redraws).toEqual([['a']])
    expect(rig.notices.rows('m')).toEqual([row(W(2))])
    expect(rig.logs).toEqual(['[device] notice · done'])
    // A dial that attaches holds it too.
    clear(rig)
    rig.notices.attached()
    expect(rig.calls).toEqual([['hold', 'a', qid(2), card(W(2))]])
    // The other card, when the last waiting card goes.
    const other = desk()
    say(other, P(1))
    say(other, W(2))
    clear(other)
    expect(other.notices.done('a', cid(2))).toBe(1)
    expect(other.calls).toEqual([['close', 'a', qid(2)], ['hold', 'a', qid(1), card(P(1))]])
    expect(other.state.redraws).toEqual([['a']])
  })

  // Only a card that reaches the dial now rings, so only it takes one of the hour's twenty; its agent's own limits
  // apply to every card.
  it('a card queued behind another takes none of the hour', () => {
    const rig = desk()
    expect(say(rig, W(1))).toEqual({ result: 'shown', card: { id: cid(1), kind: 'waiting', quiet: false, rang: true } })
    for (let n = 2; n <= 20; n++) {
      say(rig, VPN, `o${n}`)
      rig.notices.ended(`o${n}`)
    }
    expect(say(rig, W(1), 'b').result).toBe('limited')
    expect(say(rig, W(2))).toEqual({ result: 'shown', card: { id: cid(21), kind: 'waiting', quiet: false, rang: false } })
  })

  it('done names only the caller\'s cards', () => {
    const rig = desk()
    say(rig, W(1))
    say(rig, W(2), 'b')
    say(rig, W(3))
    clear(rig)
    const changes = rig.state.changes
    expect(rig.notices.done('a', cid(2))).toBe(0)
    expect(rig.notices.done('a', 'ffffffff')).toBe(0)
    expect(rig.calls).toEqual([])
    expect(rig.state.changes).toBe(changes)
    expect(rig.notices.done('a', 'all')).toBe(2)
    expect(rig.notices.pending('a')).toBe(false)
    expect(rig.calls.map((c) => [c[0], c[1]])).toEqual([['close', 'a'], ['close', 'a']])
    expect(lines(rig, 'b')).toEqual([W(2)])
    expect(rig.logs).toEqual(['[device] notice · done', '[device] notice · done'])
  })

  it('an id stays the card\'s through a rouse and a place change', () => {
    const rig = desk()
    rig.state.present.add('a')
    say(rig, W(1))
    say(rig, W(2))
    expect(rig.calls).toEqual([['hold', 'a', qid(1), card(W(1))], ['hold', 'a', qid(1), card(`${W(1)} (1/2)`)]])
    clear(rig)
    expect(rig.notices.rouse('a')).toEqual({ id: cid(1), kind: 'waiting' })
    expect(rig.calls).toEqual([['close', 'a', qid(1)], ['ask', 'a', qid(1, 3), card(`${W(1)} (1/2)`)]])
    expect(rig.notices.shown('a')).toEqual({ id: cid(1), kind: 'waiting' })
    expect(rig.notices.list('a').map(({ id }) => id)).toEqual([cid(1), cid(2)])
    clear(rig)
    expect(rig.notices.done('a', cid(1))).toBe(1)
    expect(rig.calls).toEqual([['close', 'a', qid(1, 3)], ['hold', 'a', qid(2), card(W(2))]])
  })

  it('ids are unique among pending cards', () => {
    const rig = desk({ uuids: ['3f9a1c2e-0001', '3f9a1c2e-0002', '0b1c2d3e-0003'] })
    expect(say(rig, W(1)).card?.id).toBe('3f9a1c2e')
    expect(say(rig, W(2), 'b').card?.id).toBe('0b1c2d3e')
    expect(rig.notices.stored().map(({ id }) => id)).toEqual(['shown:3f9a1c2e-0001', 'shown:0b1c2d3e-0003'])
  })

  it('twenty across agents, the oldest dropped first', () => {
    const rig = desk()
    say(rig, W(1))
    say(rig, W(2))
    for (let n = 3; n <= 20; n++) say(rig, VPN, `o${n}`)
    clear(rig)
    expect(say(rig, VPN, 'o21').result).toBe('shown')
    // Its agent's next card comes up, held.
    expect(rig.calls).toEqual([['close', 'a', qid(1)], ['hold', 'a', qid(2), card(W(2))], ['ask', 'o21', qid(21), card(VPN)]])
    expect(rig.state.redraws).toEqual([['a']])
    expect(rig.notices.stored()).toHaveLength(20)
  })

  it('restore keeps several cards an agent', () => {
    const NOW = 1_800_000_000_000
    const who = { name: 'api', engine: 'claude', machine: 'Mac mini' }
    const kept = (n: number): StoredNotice =>
      ({ agentId: 'a', keys: [], id: qid(n), line: W(n), host: 'orca', who, at: NOW - 60_000 * (4 - n) })
    const rig = desk({ clock: NOW, restored: [kept(1), kept(2), kept(3)] })
    expect(lines(rig)).toEqual([W(1), W(2), W(3)])
    expect(rig.notices.rows('m')).toEqual([row(`${W(1)} (1/3)`)])
    rig.notices.attached()
    expect(rig.calls).toEqual([['hold', 'a', qid(1), card(`${W(1)} (1/3)`)]])
    clear(rig)
    rig.notices.done('a', cid(1))
    expect(rig.calls).toEqual([['close', 'a', qid(1)], ['hold', 'a', qid(2), card(`${W(2)} (1/2)`)]])
  })

  it('a tap on an unlisted caller\'s card ends it alone', () => {
    const rig = desk({ who: { name: 'api', engine: 'claude', machine: 'Mac mini' } })
    say(rig, W(1))
    say(rig, W(2))
    clear(rig)
    rig.notices.tapped('a')
    expect(rig.calls).toEqual([['close', 'a', qid(1)], ['hold', 'a', qid(2), card(W(2))]])
    expect(rig.state.redraws).toEqual([['a']])
    expect(lines(rig)).toEqual([W(2)])
    // A listed caller's tap opens its app: its card stays.
    const listed = desk()
    say(listed, W(1))
    clear(listed)
    listed.notices.tapped('a')
    listed.notices.tapped('none')
    expect(listed.calls).toEqual([])
    expect(lines(listed)).toEqual([W(1)])
  })

  it('rouse asks only the card shown, when it is quiet', () => {
    // A rung card shown, and one queued behind it while the person is there: neither is quiet.
    const rig = desk()
    say(rig, W(1))
    rig.state.present.add('a')
    expect(say(rig, W(2)).card?.quiet).toBe(false)
    clear(rig)
    expect(rig.notices.rouse('a')).toBeUndefined()
    rig.notices.done('a', cid(1))
    clear(rig)
    expect(rig.notices.rouse('a')).toBeUndefined()
    expect(rig.calls).toEqual([])
    // A quiet card that lost the dial to a waiting card is not asked as it comes back up.
    const other = desk()
    other.state.present.add('a')
    expect(say(other, P(1)).card?.quiet).toBe(true)
    other.state.present.clear()
    say(other, W(2))
    other.notices.done('a', cid(2))
    clear(other)
    expect(other.notices.quiet('a')).toBe(false)
    expect(other.notices.rouse('a')).toBeUndefined()
    expect(other.calls).toEqual([])
  })

  it('a restored card found for an agent with cards joins them under the caps', () => {
    const NOW = 1_800_000_000_000
    const restored = (line: string): StoredNotice =>
      ({ agentId: 'old', keys: ['claude:s1'], id: 'shown:k1', line, host: 'orca', at: NOW - 60_000 })
    const listed = (): ListedAgent[] => [{ agentId: 'new', session: 'claude:s1', panes: [] }]
    // Two waiting cards: both kept; the restored one is the older, so it is shown, held, and the live one's question
    // closes.
    const rig = desk({ clock: NOW, restored: [restored(W(1))] })
    say(rig, W(2), 'new')
    clear(rig)
    rig.notices.look(false, listed)
    expect(lines(rig, 'new')).toEqual([W(1), W(2)])
    expect(rig.calls).toEqual([['close', 'new', qid(1)], ['hold', 'new', 'shown:k1', card(`${W(1)} (1/2)`)]])
    expect(rig.state.redraws).toEqual([['new']])
    // Two other cards: the newest is kept (rule 2), and the dial is left as it was.
    const plain = desk({ clock: NOW, restored: [restored(VPN)] })
    say(plain, P(2), 'new')
    clear(plain)
    plain.notices.look(false, listed)
    expect(lines(plain, 'new')).toEqual([P(2)])
    expect(plain.calls).toEqual([['close', 'new', 'shown:k1']])
    expect(plain.state.redraws).toEqual([])
  })
})

// A turn start no longer closes a card (2026-11-27), so a card nobody closes goes when it is 24 hours old, by one timer
// at the oldest card's due time.
describe('a card goes at 24 hours', () => {
  type Rig = ReturnType<typeof desk>
  const DAY = 24 * 3_600_000
  const HOUR = 3_600_000
  const card = (q: string) => [{ key: 'notice', q, options: ['In Orca'] }]
  const lines = ({ notices }: Rig, agentId = 'a') => notices.list(agentId).map(({ line }) => line)
  const live = ({ state }: Rig) => state.timers.filter((timer) => timer.live)
  /** Time passes by [ms], the wall clock and the timers alike; each timer due by then fires, the soonest first. */
  const pass = (rig: Rig, ms: number) => {
    rig.state.clock += ms
    rig.state.at += ms
    rig.state.ticks += ms
    for (;;) {
      const next = live(rig).filter(({ due }) => due <= rig.state.ticks).sort((a, b) => a.due - b.due)[0]
      if (!next) return
      next.live = false
      next.run()
    }
  }
  const clear = ({ calls, state, logs }: Rig) => {
    calls.length = 0
    state.redraws.length = 0
    logs.length = 0
  }

  it('a live card goes at 24 hours', () => {
    const rig = desk()
    rig.notices.notify(notice(W(1), 'a'))
    clear(rig)
    pass(rig, DAY - 1)
    expect(lines(rig)).toEqual([W(1)])
    expect(rig.calls).toEqual([])
    const changes = rig.state.changes
    pass(rig, 1)
    expect(lines(rig)).toEqual([])
    expect(rig.calls).toEqual([['close', 'a', qid(1)]])
    expect(rig.state.changes).toBeGreaterThan(changes)
    expect(rig.logs).toEqual(['[device] notice · expired'])
  })

  it('two cards an hour apart go an hour apart', () => {
    const rig = desk()
    rig.notices.notify(notice(W(1), 'a'))
    pass(rig, HOUR)
    rig.notices.notify(notice(W(2), 'b'))
    pass(rig, DAY - HOUR)
    expect(lines(rig, 'a')).toEqual([])
    expect(lines(rig, 'b')).toEqual([W(2)])
    pass(rig, HOUR - 1)
    expect(lines(rig, 'b')).toEqual([W(2)])
    pass(rig, 1)
    expect(lines(rig, 'b')).toEqual([])
    expect(live(rig)).toEqual([])
  })

  it('a card done before its time leaves no timer that ends another', () => {
    const rig = desk()
    rig.notices.notify(notice(W(1), 'a'))
    pass(rig, HOUR)
    rig.notices.notify(notice(W(2), 'b'))
    expect(live(rig).map(({ due }) => due)).toEqual([DAY])
    rig.notices.done('a', cid(1))
    // One timer at a time, now at b's card's due time.
    expect(live(rig).map(({ due }) => due)).toEqual([DAY + HOUR])
    pass(rig, DAY - 1)
    expect(lines(rig, 'b')).toEqual([W(2)])
    pass(rig, 1)
    expect(lines(rig, 'b')).toEqual([])
  })

  it('a clock moved on by a sleep ends every aged card at the next fire', () => {
    const rig = desk()
    rig.notices.notify(notice(W(1), 'a'))
    pass(rig, HOUR)
    rig.notices.notify(notice(W(2), 'b'))
    // Asleep two days: the wall clock moved on, the timers did not.
    rig.state.clock += 2 * DAY
    clear(rig)
    pass(rig, DAY - HOUR)
    expect(lines(rig, 'a')).toEqual([])
    expect(lines(rig, 'b')).toEqual([])
    expect(rig.logs).toEqual(['[device] notice · expired', '[device] notice · expired'])
    expect(live(rig)).toEqual([])
  })

  it('no card, no timer', () => {
    expect(live(desk())).toEqual([])
    const rig = desk()
    rig.notices.notify(notice(W(1), 'a'))
    expect(live(rig)).toHaveLength(1)
    rig.notices.done('a', 'all')
    expect(live(rig)).toEqual([])
    const away = desk({ connected: false })
    away.notices.notify(notice(W(1), 'a'))
    expect(away.state.timers).toEqual([])
  })

  // A clock set back leaves a card ahead of it: the timer waits a day at most, then looks again, never one past what a
  // timer holds, which would fire at once and again.
  it('a card ahead of the clock waits a day at most for the next look', () => {
    const NOW = 1_800_000_000_000
    const rig = desk({ clock: NOW, restored: [{ agentId: 'a', keys: [], id: qid(1), line: W(1), host: 'orca', at: NOW + 30 * DAY }] })
    expect(live(rig).map(({ ms }) => ms)).toEqual([DAY])
    pass(rig, DAY)
    expect(lines(rig)).toEqual([W(1)])
    expect(live(rig).map(({ ms }) => ms)).toEqual([DAY])
  })

  it('the next card comes up without a ring when the one shown expires', () => {
    const rig = desk()
    rig.notices.notify(notice(W(1), 'a'))
    pass(rig, 61_000)
    rig.notices.notify(notice(W(2), 'a'))
    clear(rig)
    pass(rig, DAY - 61_000)
    expect(rig.calls).toEqual([['close', 'a', qid(1)], ['hold', 'a', qid(2), card(W(2))]])
    expect(rig.state.redraws).toEqual([['a']])
    expect(rig.notices.rows('m')).toEqual([{ agentId: 'a', machineId: 'm', question: true, text: W(2) }])
    pass(rig, 61_000)
    expect(lines(rig)).toEqual([])
  })
})

// services/devices.ts ends each card's wait on the person by why it went: answered only when its agent closed it.
describe('closed is told once for each card that goes, with why', () => {
  type Rig = ReturnType<typeof desk>
  /** [agentId]'s notice of [line], then the clock a minute on. */
  const say = ({ notices, state }: Rig, line: string, agentId = 'a') => {
    notices.notify(notice(line, agentId))
    state.at += 61_000
  }
  // a's first card, the desk it is on, and what ends it, for every end there is.
  const ENDS = {
    done: [W(1), 'waiting', {}, (rig) => { rig.notices.done('a', cid(1)) }],
    sixth: [W(1), 'waiting', {}, (rig) => { for (let n = 2; n <= 6; n++) say(rig, W(n)) }],
    // Its second card is queued, so the hour's twenty still holds the others'.
    full: [W(1), 'waiting', {}, (rig) => {
      say(rig, W(2))
      for (let n = 3; n <= 21; n++) say(rig, VPN, `o${n}`)
    }],
    replaced: [P(1), 'proceeding', {}, (rig) => say(rig, P(2))],
    tapped: [W(1), 'waiting', { who: { name: 'api', engine: 'claude', machine: 'Mac mini' } }, (rig) => rig.notices.tapped('a')],
    gone: [W(1), 'waiting', {}, (rig) => rig.notices.ended('a')],
    detached: [W(1), 'waiting', { host: 'harness' }, (rig) => rig.notices.detached()],
    expired: [W(1), 'waiting', {}, (rig) => {
      rig.state.clock += 24 * 3_600_000
      for (const timer of rig.state.timers.filter(({ live }) => live)) {
        timer.live = false
        timer.run()
      }
    }],
  } satisfies Record<NoticeEnd, [string, string, Parameters<typeof desk>[0], (rig: Rig) => void]>

  it.each(Object.entries(ENDS))('%s', (end, [line, kind, opts, ending]) => {
    const rig = desk(opts)
    say(rig, line)
    expect(rig.ends).toEqual([])
    ending(rig)
    expect(rig.ends.filter(([, id]) => id === cid(1))).toEqual([['a', cid(1), kind, end]])
    // Gone, it is not told again as the rest of its agent's cards go.
    rig.notices.ended('a')
    expect(rig.ends.filter(([, id]) => id === cid(1))).toEqual([['a', cid(1), kind, end]])
  })

  it('a card that moves to its agent\'s new id is not told, nor is a close of a card that is not there', () => {
    const NOW = 1_800_000_000_000
    const rig = desk({ clock: NOW, restored: [{ agentId: 'old', keys: ['claude:s1'], id: qid(1), line: W(1), host: 'orca', at: NOW - 60_000 }] })
    rig.notices.look(false, () => [{ agentId: 'new', session: 'claude:s1', panes: [] }])
    rig.notices.done('new', 'ffffffff')
    rig.notices.done('old', cid(1))
    expect(rig.ends).toEqual([])
    rig.notices.done('new', cid(1))
    expect(rig.ends).toEqual([['new', cid(1), 'waiting', 'done']])
  })
})
