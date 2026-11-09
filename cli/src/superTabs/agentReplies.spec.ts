import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnDelivery } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { adoptReplies, AgentReplies, NAME_MAX, OWED_GIVE_UP_MS, OWED_PER_AGENT, READ_WAIT_MS, REPLY_RETRY_MS, REPLY_TEXT_MAX, REPLY_WAIT_MS, type Owed } from './agentReplies.js'
import { SuperTabHostError } from './wire.js'

const ok = { status: 200, body: { success: true, data: { result: {} } } }
const refused = (status: number, code: string) => ({ status, body: { success: false, error: { code, message: `the server said ${code}` } } })
const SECRET = 'the-agents-own-words-never-in-a-log'
/** What the host passes: the server's refusals no resend changes (host.ts `ackRefused`). */
const refused_ = (error: unknown) => error instanceof SuperTabHostError && [400, 403, 404, 409].includes(error.status)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** A host's side of one agent: its chat, its journal and what the core reads and the backend answers. */
function setup() {
  let clock = 1_000_000
  const journal: { replies?: Record<string, Owed> } = {}
  const log = vi.fn(), save = vi.fn()
  const lastTurn = vi.fn(async () => ({ userMessage: 'Ship it.', assistantText: 'Shipped.' }) as { userMessage: string; assistantText: string } | null)
  const backend = vi.fn(async (..._args: unknown[]) => ok as { status: number; body: Record<string, unknown> })
  const core = fakeCore({ transcripts: { lastTurn }, account: { backend } as never })
  const deps = { now: () => clock, log, save, typedId: (id: string) => `typed:${id}`, refused: refused_ }
  const replies = new AgentReplies(core, journal, deps)
  // Each agent runs in a terminal of its own, by the id the core knows it by.
  const owe = (deliveryId = 'd1', text = 'Ship it.', message: Record<string, unknown> = {}, agentId = 'agent') =>
    replies.owe({ deliveryId, tabId: 'tab', agentId, harnessId: agentId === 'agent' ? 'harness' : `harness-${agentId}`, name: 'Mia' },
      { id: `m-${deliveryId}`, conversationId: 'chat', ...message }, text)
  const end = (event: Partial<{ agentId: string; sessionId: string; aborted: boolean }> = {}) =>
    replies.ended({ agentId: 'harness', sessionId: 'session', aborted: false, ...event })
  const posts = () => backend.mock.calls.filter(([method, path]) => method === 'POST' && String(path).endsWith('/commands'))
  /** The operation of each post, in the order they were made. */
  const operations = () => posts().map(([, , body]) => (body as { operationId: string }).operationId)
  const lines = () => log.mock.calls.map(([line]) => String(line))
  return { replies, journal, log, save, lastTurn, backend, owe, end, posts, operations, lines, deps, wait: (ms: number) => { clock += ms }, core }
}
/** The server turning a post away, the first [count] times it is asked. */
const turnedAway = (t: ReturnType<typeof setup>, response: { status: number; body: Record<string, unknown> }, count = 1) => {
  for (let i = 0; i < count; i++) t.backend.mockResolvedValueOnce(response)
}
const NOTE = 'Mia\'s answer could not be posted.'

describe('a reply owed to a person in their agent\'s own chat', () => {
  it('posts the final answer of the turn that ended, as the agent, right below the message it answers', async () => {
    const t = setup()
    t.owe()
    await t.end()
    expect(t.lastTurn).toHaveBeenCalledWith('session')
    expect(t.posts()).toEqual([['POST', '/api/super-tabs/tab/commands', {
      operationId: 'reply-d1', asAgentId: 'agent',
      command: { type: 'message.send', conversationId: 'chat', text: 'Shipped.', replyTo: null, answers: 'm-d1', recipientIds: [] },
    }]])
    // Nothing owed is left behind, in memory or in the journal.
    expect(t.journal.replies).toBeUndefined()
  })

  it('answers a message in a thread in that thread, as the Answer line said --reply-to', async () => {
    const t = setup()
    t.owe('d1', 'Ship it.', { thread: 'root' })
    await t.end()
    expect(t.posts()[0]![2]).toMatchObject({ operationId: 'reply-d1', command: { replyTo: 'm-d1', recipientIds: [] } })
    expect(t.posts()[0]![2]).not.toHaveProperty('command.answers')
    // A message that starts its own thread is answered right below it.
    const own = setup()
    own.owe('d2', 'Ship it.', { thread: 'm-d2' })
    await own.end()
    expect(own.posts()[0]![2]).toMatchObject({ command: { replyTo: null, answers: 'm-d2' } })
  })

  it('does its work once: a second hearing of the same turn end posts nothing', async () => {
    const t = setup()
    t.owe()
    await Promise.all([t.end(), t.end()])
    await t.end()
    expect(t.posts()).toHaveLength(1)
  })

  it('keeps what is owed through a restart, and a restart after the reply was posted owes nothing', async () => {
    const t = setup()
    t.owe()
    // The host restarts: the new one has the saved record and nothing else, which holds none of the words.
    const saved = JSON.parse(JSON.stringify(t.journal)) as { replies?: Record<string, Owed> }
    expect(Object.keys(saved.replies!)).toEqual(['d1'])
    expect(JSON.stringify(saved)).not.toContain('Ship it')
    t.replies.stop()
    await t.end()
    expect(t.lastTurn).not.toHaveBeenCalled()
    const restarted: { replies?: Record<string, Owed> } = { replies: adoptReplies(saved.replies, t.log) }
    const next = new AgentReplies(t.core, restarted, t.deps)
    await next.ended({ agentId: 'harness', sessionId: 'session', aborted: false })
    expect(t.posts()).toHaveLength(1)
    expect(restarted.replies).toBeUndefined()
    // Posted, so what that host saved after it holds nothing: one that starts from it owes nothing, and posts nothing.
    const after = new AgentReplies(t.core, { replies: adoptReplies(JSON.parse(JSON.stringify(restarted)).replies, t.log) }, t.deps)
    await after.ended({ agentId: 'harness', sessionId: 'session', aborted: false })
    expect(t.posts()).toHaveLength(1)
  })

  it('posts nothing for a turn that was asked something else, and keeps the reply owed for the turn that was asked it', async () => {
    const t = setup()
    t.owe()
    t.lastTurn.mockResolvedValueOnce({ userMessage: 'Something typed in the terminal.', assistantText: 'Done.' })
    await t.end()
    expect(t.posts()).toHaveLength(0)
    expect(Object.keys(t.journal.replies!)).toEqual(['d1'])
    expect(t.lines()).toEqual([])
    await t.end()
    expect(t.posts()).toHaveLength(1)
  })

  it('posts nothing for a turn with no answer to read, and for no agent it owes nothing', async () => {
    const t = setup()
    t.owe()
    t.lastTurn.mockResolvedValueOnce(null)
    await t.end()
    expect(t.posts()).toHaveLength(0)
    expect(t.journal.replies).toBeDefined()
    await t.end({ agentId: 'another-agent' })
    expect(t.lastTurn).toHaveBeenCalledTimes(1)
  })

  // A queued follow-up begins the moment a turn ends, and its prompt may be written before the answer is read: the last turn
  // is then one that has said nothing yet, and it is not over for certain.
  it('keeps the reply owed for a turn that has said nothing yet, and posts it when that turn has', async () => {
    const t = setup()
    t.owe()
    t.lastTurn.mockResolvedValueOnce({ userMessage: 'Ship it.', assistantText: ' \n ' })
    await t.end()
    expect(t.posts()).toHaveLength(0)
    expect(Object.keys(t.journal.replies!)).toEqual(['d1'])
    expect(t.lines()).toEqual([])
    await t.end()
    expect(t.posts()).toHaveLength(1)
  })

  it('names a turn the person interrupted, takes its reply off what is owed and posts nothing', async () => {
    const t = setup()
    t.owe()
    await t.end({ aborted: true })
    expect(t.posts()).toHaveLength(0)
    expect(t.journal.replies).toBeUndefined()
    expect(t.lines()).toEqual(['No reply posted for delivery d1 of agent agent: its turn was interrupted.'])
  })

  it('matches the prompt the engine recorded, with or without the markers Claude Code puts around a paste and however it spaces lines', async () => {
    for (const recorded of ['Ship it.', '  Ship it.\r\n', '<pasted_content id="1c18">\nShip it.\n</pasted_content id="1c18">', 'Ship\tit.']) {
      const t = setup()
      t.owe()
      t.lastTurn.mockResolvedValueOnce({ userMessage: recorded, assistantText: 'Shipped.' })
      await t.end()
      expect(t.posts(), recorded).toHaveLength(1)
    }
    const words = setup()
    words.owe('d1', 'Ship it.\n\nAnd then the logout.')
    words.lastTurn.mockResolvedValueOnce({ userMessage: '<pasted_content id="ab">\nShip it.\n\n\nAnd then the logout.\n</pasted_content id="ab">', assistantText: 'Both shipped.' })
    await words.end()
    expect(words.posts()).toHaveLength(1)
  })

  it('posts an answer cut to what the backend takes, trimmed, with an ellipsis and never in the middle of an emoji', async () => {
    const t = setup()
    t.owe()
    t.lastTurn.mockResolvedValueOnce({ userMessage: 'Ship it.', assistantText: `\n  ${'a'.repeat(REPLY_TEXT_MAX + 50)}  \n` })
    await t.end()
    const long = (t.posts()[0]![2] as { command: { text: string } }).command.text
    expect(long).toHaveLength(REPLY_TEXT_MAX)
    expect(long.endsWith('a…')).toBe(true)
    const emoji = setup()
    emoji.owe()
    emoji.lastTurn.mockResolvedValueOnce({ userMessage: 'Ship it.', assistantText: `${'a'.repeat(REPLY_TEXT_MAX - 2)}😀tail` })
    await emoji.end()
    const cut = (emoji.posts()[0]![2] as { command: { text: string } }).command.text
    expect(cut).toBe(`${'a'.repeat(REPLY_TEXT_MAX - 2)}…`)
    const exact = setup()
    exact.owe()
    exact.lastTurn.mockResolvedValueOnce({ userMessage: 'Ship it.', assistantText: 'b'.repeat(REPLY_TEXT_MAX) })
    await exact.end()
    expect((exact.posts()[0]![2] as { command: { text: string } }).command.text).toBe('b'.repeat(REPLY_TEXT_MAX))
  })

  it('maps each reply to its own message, in the order the turns end, and the oldest message of the same words first', async () => {
    const t = setup()
    t.owe('d1', 'First.')
    t.wait(10)
    t.owe('d2', 'Second.')
    t.wait(10)
    t.owe('d3', 'Second.')
    for (const [asked, said] of [['First.', 'one'], ['Second.', 'two'], ['Second.', 'three']]) {
      t.lastTurn.mockResolvedValueOnce({ userMessage: asked!, assistantText: said! })
      await t.end()
    }
    expect(t.posts().map(([, , body]) => { const b = body as { operationId: string; command: { answers: string; text: string } }; return [b.operationId, b.command.answers, b.command.text] }))
      .toEqual([['reply-d1', 'm-d1', 'one'], ['reply-d2', 'm-d2', 'two'], ['reply-d3', 'm-d3', 'three']])
    expect(t.journal.replies).toBeUndefined()
  })

  it('says a message whose turn the agent went past is not answered, when a later one is', async () => {
    const t = setup()
    t.owe('d1', 'First.')
    t.wait(10)
    t.owe('d2', 'Second.')
    t.wait(10)
    t.owe('d3', 'Third.', {}, 'another-agent')
    t.lastTurn.mockResolvedValueOnce({ userMessage: 'Second.', assistantText: 'Only this one.' })
    await t.end()
    expect(t.posts().map(([, , body]) => (body as { operationId: string }).operationId)).toEqual(['reply-d2'])
    expect(Object.keys(t.journal.replies!)).toEqual(['d3'])
    expect(t.lines()).toEqual(['No reply posted for delivery d1 of agent agent: its turn went on without it.'])
  })

  it('never says what a person or an agent said in the log', async () => {
    const t = setup()
    t.owe('d1', SECRET)
    t.lastTurn.mockResolvedValueOnce({ userMessage: SECRET, assistantText: SECRET })
    t.backend.mockRejectedValue(new SuperTabHostError('SWARM_BUSY', `busy ${'x'}`, 503))
    await t.end()
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS.reduce((sum, ms) => sum + ms, 0))
    expect(t.lines().length).toBeGreaterThan(0)
    expect(t.lines().join('\n')).not.toContain(SECRET)
    expect(JSON.stringify(t.journal)).not.toContain(SECRET)
  })
})

describe('a reply the backend does not take at once', () => {
  it('sends the same post again after a wait, each time the same operation, until it goes through', async () => {
    const t = setup()
    t.owe()
    t.backend.mockResolvedValueOnce(refused(503, 'SWARM_BUSY')).mockResolvedValueOnce(refused(401, 'UNAUTHORIZED'))
    await t.end()
    expect(t.posts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS[0]! - 1)
    expect(t.posts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.posts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS[1]!)
    expect(t.posts()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS.reduce((sum, ms) => sum + ms, 0))
    expect(t.posts()).toHaveLength(3)
    expect(new Set(t.posts().map(([, , body]) => JSON.stringify(body))).size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(t.lines()).toEqual([
      `Could not post the reply to delivery d1 of agent agent: SWARM_BUSY (try 1 of ${REPLY_RETRY_MS.length + 1}); trying again in ${REPLY_RETRY_MS[0]! / 1_000} s.`,
      `Could not post the reply to delivery d1 of agent agent: UNAUTHORIZED (try 2 of ${REPLY_RETRY_MS.length + 1}); trying again in ${REPLY_RETRY_MS[1]! / 1_000} s.`,
    ])
  })

  it('gives up after its tries, says so once with the name of the failure, tells its person once, and leaves no timer behind', async () => {
    const t = setup()
    t.owe()
    turnedAway(t, refused(503, 'SWARM_BUSY'), REPLY_RETRY_MS.length + 1)
    await t.end()
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS.reduce((sum, ms) => sum + ms, 0) * 2)
    expect(t.operations()).toEqual([...Array<string>(REPLY_RETRY_MS.length + 1).fill('reply-d1'), 'dropped-reply-d1'])
    expect(vi.getTimerCount()).toBe(0)
    expect(t.lines().at(-1)).toBe(`Dropped the reply to delivery d1 of agent agent: SWARM_BUSY after ${REPLY_RETRY_MS.length + 1} tries.`)
    expect(t.lines().filter(line => line.startsWith('Dropped'))).toHaveLength(1)
    expect(t.journal.replies).toBeUndefined()
  })

  it('does not send again what no resend can change, says so, and tells its person', async () => {
    for (const [status, code] of [[400, 'VALIDATION_ERROR'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'OPERATION_REUSED']] as const) {
      const t = setup()
      t.owe()
      turnedAway(t, refused(status, code))
      await t.end()
      await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS[0]! * 10)
      expect(t.operations(), code).toEqual(['reply-d1', 'dropped-reply-d1'])
      expect(t.lines()).toEqual([`Dropped the reply to delivery d1 of agent agent: ${code}; no later try changes it.`])
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  // Its person is waiting for an answer in their chat, so a dropped one is told there, where it would have been, from the agent as
  // the answer would have been, and says no more than that it is missing (anh Dee's lead, 2026-11-09).
  it('tells its person in the chat the answer was owed in, below their message or in its thread, as the agent', async () => {
    const t = setup()
    t.owe()
    turnedAway(t, refused(403, 'FORBIDDEN'))
    await t.end()
    expect(t.posts()[1]).toEqual(['POST', '/api/super-tabs/tab/commands', { operationId: 'dropped-reply-d1', asAgentId: 'agent',
      command: { type: 'message.send', conversationId: 'chat', text: NOTE, replyTo: null, answers: 'm-d1', recipientIds: [] } }])
    const threaded = setup()
    threaded.owe('d2', 'Ship it.', { thread: 'root' })
    turnedAway(threaded, refused(403, 'FORBIDDEN'))
    await threaded.end()
    expect(threaded.posts()[1]![2]).toEqual({ operationId: 'dropped-reply-d2', asAgentId: 'agent',
      command: { type: 'message.send', conversationId: 'chat', text: NOTE, replyTo: 'm-d2', recipientIds: [] } })
    // It was taken: nothing of it in the log.
    expect(t.lines()).toEqual(['Dropped the reply to delivery d1 of agent agent: FORBIDDEN; no later try changes it.'])
  })

  it('tries to tell its person once: a line the server turns away, or does not answer, is only in the log, by the name of the failure', async () => {
    const away = setup()
    away.owe()
    turnedAway(away, refused(403, 'FORBIDDEN'), 2)
    await away.end()
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS.reduce((sum, ms) => sum + ms, 0))
    expect(away.operations()).toEqual(['reply-d1', 'dropped-reply-d1'])
    expect(away.lines()).toEqual([
      'Dropped the reply to delivery d1 of agent agent: FORBIDDEN; no later try changes it.',
      'Could not tell the person that the reply to delivery d1 of agent agent was dropped: FORBIDDEN.',
    ])
    const silent = setup()
    silent.owe()
    turnedAway(silent, refused(403, 'FORBIDDEN'))
    silent.backend.mockImplementationOnce(() => new Promise(() => {}))
    const done = silent.end()
    await vi.advanceTimersByTimeAsync(REPLY_WAIT_MS)
    await done
    expect(silent.operations()).toEqual(['reply-d1', 'dropped-reply-d1'])
    expect(silent.lines().at(-1)).toBe('Could not tell the person that the reply to delivery d1 of agent agent was dropped: TIMEOUT.')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tells its person nothing of a reply it dropped because the host stopped, or because a turn was interrupted', async () => {
    const stopped = setup()
    stopped.owe()
    turnedAway(stopped, refused(503, 'SWARM_BUSY'))
    await stopped.end()
    stopped.replies.stop()
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS.reduce((sum, ms) => sum + ms, 0))
    expect(stopped.operations()).toEqual(['reply-d1'])
    const interrupted = setup()
    interrupted.owe()
    await interrupted.end({ aborted: true })
    expect(interrupted.operations()).toEqual([])
  })

  it('names the failure of a call that could not reach the backend at all', async () => {
    const t = setup()
    t.owe()
    t.backend.mockRejectedValueOnce(new TypeError('fetch failed'))
    await t.end()
    expect(t.lines()).toEqual([`Could not post the reply to delivery d1 of agent agent: TypeError (try 1 of ${REPLY_RETRY_MS.length + 1}); trying again in ${REPLY_RETRY_MS[0]! / 1_000} s.`])
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS[0]!)
    expect(t.posts()).toHaveLength(2)
    // Whatever it was that failed, never what it said.
    const odd = setup()
    odd.owe()
    odd.backend.mockRejectedValueOnce('a string, not an error')
    await odd.end()
    expect(odd.lines()[0]).toContain(': ERROR (try 1 of')
    expect(odd.lines()[0]).not.toContain('a string')
  })

  it('stops waiting on a call that never answers and tries again', async () => {
    const t = setup()
    t.owe()
    t.backend.mockImplementationOnce(() => new Promise(() => {}))
    const done = t.end()
    await vi.advanceTimersByTimeAsync(REPLY_WAIT_MS)
    await done
    expect(t.lines()).toEqual([`Could not post the reply to delivery d1 of agent agent: TIMEOUT (try 1 of ${REPLY_RETRY_MS.length + 1}); trying again in ${REPLY_RETRY_MS[0]! / 1_000} s.`])
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS[0]!)
    expect(t.posts()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops retrying when the host stops, and drops the reply, saying so', async () => {
    const t = setup()
    t.owe()
    t.backend.mockResolvedValue(refused(503, 'SWARM_BUSY'))
    await t.end()
    t.log.mockClear()
    t.replies.stop()
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS[0]! * 10)
    expect(t.posts()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(t.lines()).toEqual(['Dropped the reply to delivery d1 of agent agent: the host stopped.'])
    // And hears nothing more.
    t.owe('d2')
    await t.end()
    expect(t.lastTurn).toHaveBeenCalledTimes(1)
  })

  it('does not retry a post whose failure is heard after the host stopped, and says it was dropped', async () => {
    const t = setup()
    t.owe()
    let fail!: () => void
    t.backend.mockImplementationOnce(() => new Promise((_, reject) => { fail = () => reject(new Error('late')) }))
    const done = t.end()
    await vi.advanceTimersByTimeAsync(0)
    t.replies.stop()
    fail()
    await done
    expect(vi.getTimerCount()).toBe(0)
    expect(t.posts()).toHaveLength(1)
    expect(t.lines()).toEqual(['Dropped the reply to delivery d1 of agent agent: the host stopped.'])
  })
})

describe('an answer that cannot be read', () => {
  it('names the failure of a read that throws or takes too long, and keeps the reply owed', async () => {
    const t = setup()
    t.owe()
    t.lastTurn.mockRejectedValueOnce(new Error('Core disconnected'))
    await t.end()
    t.lastTurn.mockImplementationOnce(() => new Promise(() => {}))
    const done = t.end()
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS)
    await done
    // A core that answers with an error, by its code (superTabsProcess.ts).
    t.lastTurn.mockRejectedValueOnce(new SuperTabHostError('UNKNOWN_QUERY', 'The core could not read the last turn.', 502))
    await t.end()
    expect(t.lines()).toEqual([
      'Could not read the answer of the turn that ended for agent agent: Error.',
      'Could not read the answer of the turn that ended for agent agent: TIMEOUT.',
      'Could not read the answer of the turn that ended for agent agent: UNKNOWN_QUERY.',
    ])
    expect(Object.keys(t.journal.replies!)).toEqual(['d1'])
    expect(t.posts()).toHaveLength(0)
    await t.end()
    expect(t.posts()).toHaveLength(1)
  })
})

describe('what is owed, kept small', () => {
  it('drops a reply never asked for within a day, saying so, when the agent next does anything', async () => {
    const t = setup()
    t.owe('old')
    t.wait(OWED_GIVE_UP_MS - 1)
    t.owe('young')
    expect(Object.keys(t.journal.replies!)).toEqual(['old', 'young'])
    t.wait(1)
    await t.end()
    expect(Object.keys(t.journal.replies ?? {})).not.toContain('old')
    expect(t.lines()).toContain('Dropped the reply owed for delivery old of agent agent: its turn was not seen in 24 hours.')
  })

  it('keeps at most a few replies owed an agent, the oldest going first, saying so', () => {
    const t = setup()
    for (let i = 0; i < OWED_PER_AGENT + 2; i++) { t.owe(`d${i}`); t.wait(1) }
    t.owe('other', 'Ship it.', {}, 'another-agent')
    const kept = Object.keys(t.journal.replies!)
    expect(kept).toHaveLength(OWED_PER_AGENT + 1)
    expect(kept).not.toContain('d0')
    expect(kept).not.toContain('d1')
    expect(kept).toContain('other')
    expect(t.lines()).toEqual([
      'Dropped the reply owed for delivery d0 of agent agent: more than 16 are owed it.',
      'Dropped the reply owed for delivery d1 of agent agent: more than 16 are owed it.',
    ])
  })

  it('owes one reply per delivery: a delivery typed again after the pane held it is the same one, owed from the terminal it is typed in now', async () => {
    const t = setup()
    t.owe('d1')
    const first = { ...t.journal.replies!.d1! }
    t.wait(50)
    t.owe('d1')
    expect(t.journal.replies!.d1).toEqual(first)
    // Its member moved to a new session while it waited: the turn that ends there is the one that answers it.
    t.replies.owe({ deliveryId: 'd1', tabId: 'tab', agentId: 'agent', harnessId: 'replacement', name: 'Mia' }, { id: 'm-d1', conversationId: 'chat' }, 'Ship it.')
    expect(t.journal.replies!.d1).toEqual({ ...first, harnessId: 'replacement' })
    expect(Object.keys(t.journal.replies!)).toEqual(['d1'])
    await t.end({ agentId: 'replacement' })
    expect(t.posts()).toHaveLength(1)
  })

  it('keeps the name its person knows the agent by, to tell them with if its answer is dropped, cut to a few characters', () => {
    const t = setup()
    t.owe()
    expect(t.journal.replies!.d1!.name).toBe('Mia')
    t.replies.owe({ deliveryId: 'd2', tabId: 'tab', agentId: 'agent', harnessId: 'harness', name: 'N'.repeat(NAME_MAX + 20) }, { id: 'm-d2', conversationId: 'chat' }, 'Ship it.')
    expect(t.journal.replies!.d2!.name).toBe(`${'N'.repeat(NAME_MAX - 1)}…`)
    expect(t.journal.replies!.d2!.name).toHaveLength(NAME_MAX)
  })

  it('is taken back when the delivery was never typed, and kept when it may have been', () => {
    const t = setup()
    t.owe('d1')
    const event = (state: TurnDelivery['state'], reason?: string, deliveryId = 'typed:d1'): TurnDelivery => ({ deliveryId, sessionId: 'harness', state, ...(reason ? { reason } : {}) })
    for (const heard of [event('queued'), event('delivered'), event('started'), event('unknown'), event('rejected', 'team_waiting_busy'), event('rejected', undefined, 'typed:another'),
      event('rejected', 'cancelled', 'not-a-typed-id')]) {
      t.replies.delivery(heard)
      expect(Object.keys(t.journal.replies!), `${heard.state} ${heard.reason}`).toEqual(['d1'])
    }
    t.save.mockClear()
    t.replies.delivery(event('rejected', 'cancelled'))
    expect(t.journal.replies).toBeUndefined()
    expect(t.save).toHaveBeenCalledOnce()
    t.replies.delivery(event('rejected', 'cancelled'))
    expect(t.save).toHaveBeenCalledOnce()
    t.owe('d2')
    t.replies.delivery(event('rejected', undefined, 'typed:d2'))
    expect(t.journal.replies).toBeUndefined()
  })

  it('takes a reply back that was owed for a delivery the host could not save, writing nothing', () => {
    const t = setup()
    t.owe('d1')
    t.owe('d2')
    t.save.mockClear()
    t.replies.forget('d1')
    expect(Object.keys(t.journal.replies!)).toEqual(['d2'])
    t.replies.forget('d2')
    t.replies.forget('d3')
    expect(t.journal.replies).toBeUndefined()
    expect(t.save).not.toHaveBeenCalled()
  })

  it('goes on past a journal that cannot be saved, and says so', async () => {
    const t = setup()
    t.owe()
    t.save.mockImplementation(() => { throw new Error('disk full') })
    await t.end()
    expect(t.posts()).toHaveLength(1)
    expect(t.lines()).toEqual(['Could not save the replies owed: disk full'])
    const gone = setup()
    gone.owe()
    gone.save.mockImplementation(() => { throw 'not an error' })
    gone.replies.delivery({ deliveryId: 'typed:d1', sessionId: 'harness', state: 'rejected', reason: 'cancelled' })
    expect(gone.lines()).toEqual(['Could not save the replies owed: not an error'])
  })
})

describe('the replies owed that a journal holds', () => {
  const saved = (over: Record<string, unknown> = {}) => ({ tabId: 'tab', agentId: 'agent', harnessId: 'harness', conversationId: 'chat', messageId: 'message',
    thread: false, asked: 'a'.repeat(32), at: 5, name: 'Mia', ...over })

  it('adopts each one this host could have written and drops, saying so, the rest', () => {
    const log = vi.fn()
    const adopted = adoptReplies({
      good: saved(), threaded: saved({ thread: true }), longestName: saved({ name: 'x'.repeat(NAME_MAX) }),
      'bad id!': saved(), badTab: saved({ tabId: '../x' }), badAgent: saved({ agentId: 4 }), badHarness: saved({ harnessId: '' }), badChat: saved({ conversationId: null }),
      badMessage: saved({ messageId: undefined }), badThread: saved({ thread: 'yes' }), badAsked: saved({ asked: 'not a hash' }), badAt: saved({ at: 'now' }),
      noName: saved({ name: undefined }), emptyName: saved({ name: '' }), numberName: saved({ name: 4 }), longName: saved({ name: 'x'.repeat(NAME_MAX + 1) }),
      notAnObject: 'row', alsoNot: null,
    }, log)
    expect(Object.keys(adopted)).toEqual(['good', 'threaded', 'longestName'])
    expect(adopted.good).toEqual(saved())
    expect(log.mock.calls.map(([line]) => line)).toEqual(['Dropped 15 saved replies owed that this host could not use.'])
  })

  it('adopts none from a journal that holds no such list, or a list of the wrong kind', () => {
    const log = vi.fn()
    for (const value of [undefined, null, 'replies', 4, []]) expect(adoptReplies(value, log)).toEqual({})
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps the newest few of each terminal, and the newest of all when there are more than the journal should carry', () => {
    const log = vi.fn()
    const rows = (count: number, terminals: number) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
      [`d${i}`, saved({ harnessId: `harness-${i % terminals}`, at: i })]))
    const few = adoptReplies(rows(300, 10), log)
    for (let n = 0; n < 10; n++) expect(Object.values(few).filter(o => o.harnessId === `harness-${n}`)).toHaveLength(OWED_PER_AGENT)
    // The newest of each: the first of terminal 0 are the oldest rows, and the last ones stay.
    expect(Object.keys(few)).not.toContain('d0')
    expect(Object.keys(few)).toContain('d299')
    expect(log).toHaveBeenLastCalledWith('Dropped 140 saved replies owed that this host could not use.')
    const all = adoptReplies(rows(300, 40), log)
    expect(Object.keys(all)).toHaveLength(256)
    expect(Object.keys(all)).not.toContain('d0')
    expect(Object.keys(all)).toContain('d299')
    expect(log).toHaveBeenLastCalledWith('Dropped 44 saved replies owed that this host could not use.')
  })
})
