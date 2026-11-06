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

  it('counts a person\'s Buddy proposal as an ask, answered once a task is opened from it', () => {
    const proposal = (createdAt: number) => person('chat', createdAt, { source: { kind: 'buddy-proposal', personId: 'dee', buddyId: 'b', ownerMessageId: 'o' } })
    const open = proposal(at(2)), built = proposal(at(3))
    // A task card's line is the person's too, and asks nothing.
    const line = person('chat', at(4), { source: { kind: 'task-line', taskId: 't9', number: 9, title: 'Scorecard' } })
    const day = scorecardDay(input({ messages: [open, built, line], tasks: [task('t9', { number: 9, askedAt: at(3, 5), requestMessageIds: [built.id] })] }))
    expect(day.unansweredAsks).toBe(1)
    expect(day.oldestUnansweredAskMinutes).toBe((END - at(2)) / MIN)
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

  it('closes a step when its task closes, working or waiting (review of #3212, 1)', () => {
    const tasks = [
      // Cancelled at 03:00 with its review step waiting for a Reviewer since 01:00: the step's wait ends at the cancel.
      task('t1', { number: 1, askedAt: at(-5) }),
      task('s1', { number: 2, reviewOf: 't1', askedAt: at(1) }),
      // In review since yesterday; its step is worked from 10:00 and the task is cancelled at 11:00: the step stops Working then.
      task('t2', { number: 3, askedAt: at(-5), runs: [at(-4)] }),
      task('s2', { number: 4, reviewOf: 't2', askedAt: at(10), runs: [at(10)] }),
      // Waits from 12:00 until it is assigned at 13:00, done at 14:00.
      task('t3', { number: 5, askedAt: at(12), runs: [at(13)] }),
    ]
    const messages = [status('t1', at(-4), 'needs_human'), status('t1', at(3), 'cancelled'), status('t2', at(-3), 'review'),
      status('t2', at(11), 'cancelled'), status('t3', at(14), 'done')]
    // 01:00-03:00 s1 waits and nobody works; 12:00-13:00 t3 waits and nobody works. Left open, s1 would wait all day and s2's
    // Working would hide t3's wait: 540.
    expect(scorecardDay(input({ tasks, messages })).idleMinutes).toBe(2 * 60 + 60)
  })

  it('counts lost tasks left alone longer than the limit', () => {
    const tasks = [task('t1', { number: 1, askedAt: at(-2), runs: [at(-1), at(2, 5)] }), task('t2', { number: 2, askedAt: at(-2), runs: [at(-1)] }),
      task('t3', { number: 3, askedAt: at(-2), runs: [at(-1)] })]
    const messages = [
      lost('t1', at(2)), // picked up after 5 minutes
      lost('t2', at(4)), // a start after 40 minutes
      lost('t2', at(4)), // the same loss's row to the agent: one loss
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

  it('does not count a person answering what the PM asked them, nor replies to rows the Swarm writes as the PM (review of #3212, 2)', () => {
    const question = row({ conversationId: 'chat', createdAt: at(1), text: '@dee which day should it start?', mentions: ['dee'] })
    const taskLine = row({ conversationId: 'chat', createdAt: at(1), source: { kind: 'system', ask: 'm1' }, text: 'Opened #9' })
    const answer = row({ conversationId: 'chat', createdAt: at(1) })
    const messages = [question, taskLine, answer,
      person('chat', at(2), { replyTo: question.id, text: 'Monday.' }),
      person('chat', at(2), { replyTo: taskLine.id, text: 'Thanks' }),
      // Someone else the question did not tag, correcting it: a correction.
      person('chat', at(3), { author: { kind: 'person', id: 'ken' }, replyTo: question.id, text: 'No, start today.' }),
      person('chat', at(3), { replyTo: answer.id, text: 'That is not what I asked.' })]
    expect(scorecardDay(input({ messages })).corrections).toBe(2)
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
      // The same rule as the server's guard (acknowledgements.ts): an emoji alone says nothing, but it is no acknowledgement post.
      row({ conversationId: 't1', createdAt: at(1), text: '👀' }),
      row({ conversationId: 't1', createdAt: at(1), text: 'On it: the route needs a machine with a phone, so I picked Tony\'s Mac.' }),
      row({ conversationId: 't1', createdAt: at(1), text: 'Done', source: { kind: 'system', status: 'done' } }),
      person('t1', at(1), { text: 'thanks' })]
    const day = scorecardDay(input({ messages }))
    expect(day.typedIntoPm).toBe(2)
    expect(day.ackPosts).toBe(2)
    expect(day.agentPosts).toBe(4)
  })
})

// Task #3462: the day's crew wakes and moves, from their timing rows in the project chat.
describe('crew wake and move times (#3462)', () => {
  const timing = (what: 'wake' | 'move', runningAt: number, seconds: number, over: Partial<ScorecardMessage> = {}) =>
    row({ conversationId: 'chat', createdAt: runningAt, source: { kind: 'crew-timing', what, agentId: 'ada', startedAt: runningAt - seconds * 1000,
      runningAt, reason: what === 'wake' ? 'work on #7' : 'offline' }, text: `${what} ${seconds}s`, ...over })

  it('shows the median and slowest wake and move of the day', () => {
    const figures = scorecardDay(input({ messages: [timing('wake', at(2), 8), timing('wake', at(5), 30), timing('wake', at(9), 12),
      timing('move', at(3), 120), timing('move', at(11), 300)] }))
    expect(figures.crewWake).toEqual({ count: 3, medianSeconds: 12, slowestSeconds: 30 })
    expect(figures.crewMove).toEqual({ count: 2, medianSeconds: 210, slowestSeconds: 300 })
  })

  it('counts only the rows of the day, and shows none on a day without any', () => {
    const figures = scorecardDay(input({ messages: [timing('wake', START - MIN, 50), timing('wake', at(1), 6), timing('move', END, 90)] }))
    expect(figures.crewWake).toEqual({ count: 1, medianSeconds: 6, slowestSeconds: 6 })
    expect(figures.crewMove).toEqual({ count: 0, medianSeconds: null, slowestSeconds: null })
  })

  it('reads timing rows only from the project chat, never one a client could write elsewhere', () => {
    const figures = scorecardDay(input({ messages: [timing('wake', at(2), 8, { conversationId: 'task7' }), timing('wake', at(3), 9, { author: { kind: 'person', id: 'dee' } })] }))
    expect(figures.crewWake).toEqual({ count: 0, medianSeconds: null, slowestSeconds: null })
  })
})


describe('PM first-answer time (#3609)', () => {
  it('times each main ask, thread follow-up and Buddy relay to its first PM answer in place', () => {
    const main = person('chat', at(1), { id: 'main', recipientIds: ['pm'] })
    const follow = person('chat', at(2), { id: 'follow', thread: 'root', recipientIds: ['pm'] })
    const relay = person('chat', at(3), { id: 'relay', source: { kind: 'buddy-proposal' }, recipientIds: ['pm'] })
    const messages = [main, follow, relay,
      row({ conversationId: 'chat', createdAt: at(1) + 10_000, answers: 'main' }),
      row({ conversationId: 'chat', createdAt: at(1) + 90_000, answers: 'main' }),
      row({ conversationId: 'chat', createdAt: at(2) + 30_000, thread: 'root' }),
      row({ conversationId: 'chat', createdAt: at(3) + 50_000, answers: 'relay' })]
    expect(scorecardDay(input({ messages: [...messages, ...messages] })).pmAnswer).toEqual({ count: 3, medianSeconds: 30, slowestSeconds: 50 })
  })

  it('ignores other agents, wrong places, earlier thread answers, cards, and reaction/delivery timestamps', () => {
    const ask = person('chat', at(1), { id: 'ask', thread: 'root', recipientIds: ['pm'] })
    const unseen = person('task', at(1), { id: 'unseen', recipientIds: ['worker'] })
    const messages = [ask, unseen,
      row({ conversationId: 'chat', createdAt: at(0), thread: 'root' }),
      row({ conversationId: 'chat', createdAt: at(2), answers: 'ask', author: { kind: 'agent', id: 'worker' } }),
      row({ conversationId: 'other', createdAt: at(3), answers: 'ask', thread: 'root' }),
      row({ conversationId: 'chat', createdAt: at(4), source: { kind: 'task-line' }, answers: 'ask' }),
      row({ conversationId: 'task', createdAt: at(4), answers: 'unseen' })]
    expect(scorecardDay(input({ messages, answeredDeliveries: [{ messageId: 'ask', answeredAt: at(2) }] })).pmAnswer)
      .toEqual({ count: 0, medianSeconds: null, slowestSeconds: null })
  })

  it('counts first answers completed today across midnight, never a second answer today or one after the day', () => {
    const messages = [
      person('chat', START - 20_000, { id: 'overnight', recipientIds: ['pm'] }),
      row({ conversationId: 'chat', createdAt: START + 10_000, answers: 'overnight' }),
      person('chat', START - 60_000, { id: 'yesterday', recipientIds: ['pm'] }),
      row({ conversationId: 'chat', createdAt: START - 30_000, answers: 'yesterday' }),
      row({ conversationId: 'chat', createdAt: START + 20_000, answers: 'yesterday' }),
      person('chat', END - 20_000, { id: 'tomorrow', recipientIds: ['pm'] }),
      row({ conversationId: 'chat', createdAt: END, answers: 'tomorrow' })]
    expect(scorecardDay(input({ messages })).pmAnswer).toEqual({ count: 1, medianSeconds: 30, slowestSeconds: 30 })
  })
})


it('orders a same-millisecond PM answer after its ask by stored sequence', () => {
  const ask = person('chat', at(1), { id: 'instant', recipientIds: ['pm'], sequence: 10 })
  const answer = row({ conversationId: 'chat', createdAt: at(1), answers: 'instant', sequence: 11 })
  expect(scorecardDay(input({ messages: [answer, ask] })).pmAnswer).toEqual({ count: 1, medianSeconds: 0, slowestSeconds: 0 })
})
