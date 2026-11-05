import { describe, expect, it } from 'vitest'
import { dayBounds, scorecardDay, SCORECARD_LIMITS, type ScorecardInput, type ScorecardMessage, type ScorecardTask } from './figures.js'

const MIN = 60_000
const HOUR = 60 * MIN
/** 2026-11-05 in Vietnam (UTC+7): 11-04 17:00 UTC to 11-05 17:00 UTC. */
const START = Date.UTC(2026, 10, 4, 17)
const END = START + 24 * HOUR
const at = (hours: number, minutes = 0) => START + hours * HOUR + minutes * MIN

let seq = 0
const row = (over: Partial<ScorecardMessage> & Pick<ScorecardMessage, 'conversationId' | 'createdAt'>): ScorecardMessage => ({
  id: `m${++seq}`, author: { kind: 'agent', id: 'pm' }, source: null, text: 'A real answer with substance.', replyTo: null, thread: null, ...over })
const person = (conversationId: string, createdAt: number, over: Partial<ScorecardMessage> = {}) =>
  row({ conversationId, createdAt, author: { kind: 'person', id: 'dee' }, text: 'Please build the scorecard.', ...over })
const status = (conversationId: string, createdAt: number, value: string) =>
  row({ conversationId, createdAt, author: { kind: 'agent', id: 'eng' }, source: { kind: 'system', status: value }, text: value })
const lost = (conversationId: string, createdAt: number) =>
  row({ conversationId, createdAt, source: { kind: 'work-lost', agentId: 'eng', assignmentId: 'a1', reason: 'no progress' }, text: 'lost' })
const task = (id: string, over: Partial<ScorecardTask> = {}): ScorecardTask => ({ id, runs: [], requestMessageIds: [], ...over })

const input = (over: Partial<ScorecardInput> = {}): ScorecardInput => ({ start: START, end: END, chatId: 'chat', pmAgentIds: ['pm'], tasks: [],
  messages: [], answeredDeliveries: [], starts: [], routeDecisions: [], ...over })

describe('dayBounds', () => {
  it('gives the local day in the project time zone', () => {
    expect(dayBounds('2026-11-05', 'Asia/Ho_Chi_Minh')).toEqual({ start: START, end: END })
  })
  it('gives a 25-hour day where the clock falls back', () => {
    const { start, end } = dayBounds('2026-11-01', 'America/New_York')
    expect(start).toBe(Date.UTC(2026, 10, 1, 4))
    expect(end - start).toBe(25 * HOUR)
  })
})

describe('scorecardDay', () => {
  it('records the limits it measured with', () => {
    expect(scorecardDay(input()).limits).toEqual(SCORECARD_LIMITS)
  })

  it('counts asks shipped in the day and their ask-to-ship minutes', () => {
    const tasks = [
      task('t1', { number: 1, askedAt: at(1), shippedAt: at(3) }),
      task('t2', { number: 2, askedAt: at(-10), shippedAt: at(5) }),
      task('t3', { number: 3, askedAt: at(2), shippedAt: at(4) }),
      // Shipped the day before, a step, and work with no number: none is an ask shipped today.
      task('t4', { number: 4, askedAt: at(-30), shippedAt: at(-1) }),
      task('s1', { number: 5, reviewOf: 't1', askedAt: at(1), shippedAt: at(2) }),
      task('x', { askedAt: at(1), shippedAt: at(2) }),
    ]
    const day = scorecardDay(input({ tasks }))
    expect(day.asksShipped).toBe(3)
    expect(day.askToShipMedianMinutes).toBe(120)
    expect(day.askToShipMaxMinutes).toBe(15 * 60)
    expect(scorecardDay(input()).askToShipMedianMinutes).toBeNull()
  })

  it('finds the asks still unanswered at day end and the oldest one', () => {
    const replied = person('chat', at(1))
    const threaded = person('chat', at(2))
    const delivered = person('chat', at(3))
    const tasked = person('chat', at(4))
    const open = person('chat', at(6))
    const older = person('chat', at(-30))
    const tooOld = person('chat', END - 8 * 24 * HOUR)
    const lateAnswer = person('chat', at(20))
    const elsewhere = person('t1', at(1))
    const answers = [
      row({ conversationId: 'chat', createdAt: at(1, 5), replyTo: replied.id, thread: replied.id }),
      row({ conversationId: 'chat', createdAt: at(2, 5), thread: threaded.id }),
      // A person's own follow-up in the thread is no answer; nor is an answer after day end.
      person('chat', at(6, 5), { thread: open.id, replyTo: open.id }),
      row({ conversationId: 'chat', createdAt: END + MIN, replyTo: lateAnswer.id, thread: lateAnswer.id }),
    ]
    const day = scorecardDay(input({
      messages: [replied, threaded, delivered, tasked, open, older, tooOld, lateAnswer, elsewhere, ...answers],
      answeredDeliveries: [{ messageId: delivered.id, answeredAt: at(3, 10) }],
      tasks: [task('t9', { number: 9, askedAt: at(4, 1), requestMessageIds: [tasked.id] })],
    }))
    expect(day.unansweredAsks).toBe(3)
    expect(day.oldestUnansweredAskMinutes).toBe((END - at(-30)) / MIN)
  })

  it('counts minutes with nobody working while open work waits', () => {
    const tasks = [
      // Waits from 01:00, assigned (working) at 02:00, done at 05:00.
      task('t1', { number: 1, askedAt: at(1), runs: [at(2)] }),
      // Working since yesterday; lost at 03:00, picked up again at 03:20.
      task('t2', { number: 2, askedAt: at(-20), runs: [at(-19), at(3, 20)] }),
      // Opened at 06:00 and never assigned: waits to day end.
      task('t3', { number: 3, askedAt: at(6) }),
      // Waits on a person: not work the Swarm can do.
      task('t4', { number: 4, askedAt: at(-5), runs: [at(-4)] }),
    ]
    const messages = [
      status('t1', at(5), 'done'),
      status('t2', at(-19), 'working'),
      lost('t2', at(3)),
      status('t2', at(4), 'done'),
      status('t4', at(-3), 'needs_human'),
    ]
    const day = scorecardDay(input({ tasks, messages }))
    // 01:00-02:00 t2 works (no idle); 03:00-03:20 t1 works; 04:00-05:00 t1 works; 06:00-24:00 nobody works while t3 waits.
    expect(day.idleMinutes).toBe(18 * 60)
  })

  it('counts lost tasks left alone longer than the limit', () => {
    const tasks = [task('t1', { number: 1, askedAt: at(-2), runs: [at(-1), at(2, 5)] }), task('t2', { number: 2, askedAt: at(-2), runs: [at(-1)] }),
      task('t3', { number: 3, askedAt: at(-2), runs: [at(-1)] })]
    const messages = [
      lost('t1', at(2)), // picked up after 5 minutes
      lost('t2', at(4)), // a start after 40 minutes
      lost('t3', at(23)), // nothing until day end, 60 minutes
    ]
    const day = scorecardDay(input({ tasks, messages, starts: [{ conversationId: 't2', requestedAt: at(4, 40), failed: false }] }))
    expect(day.lostLeftAlone).toBe(2)
    expect(day.lostLeftMinutes).toBe(30 + 50)
  })

  it('counts merged work that needed a fix', () => {
    const tasks = [task('t1', { fixedAfterMergeAt: at(3) }), task('t2', { fixedAfterMergeAt: at(-3) }), task('t3')]
    expect(scorecardDay(input({ tasks })).fixesAfterMerge).toBe(1)
  })

  it('counts people correcting an earlier PM answer', () => {
    const pmAnswer = row({ conversationId: 'chat', createdAt: at(-5) })
    const engineerPost = row({ conversationId: 't1', createdAt: at(1), author: { kind: 'agent', id: 'eng' } })
    const messages = [pmAnswer, engineerPost,
      person('chat', at(2), { replyTo: pmAnswer.id, text: 'No, I asked for daily.' }),
      person('t1', at(3), { replyTo: engineerPost.id }),
      person('chat', at(-1), { replyTo: pmAnswer.id })]
    expect(scorecardDay(input({ messages })).corrections).toBe(1)
  })

  it('counts starts, failed starts and route decisions in the day', () => {
    const day = scorecardDay(input({
      starts: [{ conversationId: 't1', requestedAt: at(1), failed: false }, { conversationId: 't1', requestedAt: at(2), failed: true },
        { conversationId: 't1', requestedAt: at(-1), failed: true }],
      routeDecisions: [{ conversationId: 't1', createdAt: at(1) }, { conversationId: 't2', createdAt: END }],
    }))
    expect([day.starts, day.startsFailed, day.routeDecisions]).toEqual([2, 1, 1])
  })

  it('counts messages typed into the PM and agents\' acknowledgement-only posts', () => {
    const typed = (agentId: string, createdAt: number) => row({ conversationId: 'chat', createdAt, author: { kind: 'person', id: 'dee' },
      source: { kind: 'terminal-input', agentId, requestId: `r${createdAt}` }, text: 'dee typed 1 in River\'s terminal' })
    const messages = [typed('pm', at(1)), typed('pm', at(2)), typed('eng', at(3)), typed('pm', at(-1)),
      row({ conversationId: 't1', createdAt: at(1), text: 'On it.' }),
      row({ conversationId: 't1', createdAt: at(1), text: 'Confirmed!' }),
      row({ conversationId: 't1', createdAt: at(1), text: '👀' }),
      row({ conversationId: 't1', createdAt: at(1), text: 'On it: the route needs a machine with a phone, so I picked Tony\'s Mac.' }),
      row({ conversationId: 't1', createdAt: at(1), text: 'Done', source: { kind: 'system', status: 'done' } }),
      person('t1', at(1), { text: 'thanks' })]
    const day = scorecardDay(input({ messages }))
    expect(day.typedIntoPm).toBe(2)
    expect(day.ackPosts).toBe(3)
    expect(day.agentPosts).toBe(4)
  })
})
