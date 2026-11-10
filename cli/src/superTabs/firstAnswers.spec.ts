import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { FIRST_ANSWER_GIVE_UP_MS, FirstAnswers, launchLine, type FirstAnswerAgent } from './firstAnswers.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const root = mkdtempSync(join(tmpdir(), 'super-tab-first-answers-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let files = 0

const ARLO_ANSWER = 'I\'m Arlo, the PM for the openharness Swarm. Tell me what you want shipped.'

/** This computer's person's agent Arlo, running here, in a Swarm that gives it a chat with its person. */
function setup(options: { working?: boolean | null; lastTurn?: { userMessage: string; assistantText: string } | null; row?: Json } = {}) {
  const state = { working: options.working ?? false as boolean | null, lastTurn: options.lastTurn === undefined
    ? { userMessage: 'You are Arlo.', assistantText: ARLO_ANSWER } : options.lastTurn, live: true }
  const clock = { now: Date.parse('2026-11-10T23:31:00Z') }
  const row: Json = { tabId: 'tab', agent: { id: 'arlo', harnessId: 'h-arlo', name: 'Claude Code', displayName: 'Arlo', regular: true,
    contributorId: 'dee', machineOwnerId: 'dee' }, ...options.row }
  const post = vi.fn(async (_agent: FirstAnswerAgent, _operationId: string, _text: string) => ({}))
  const log = vi.fn()
  const file = join(root, `first-answers-${files++}.json`)
  const read = vi.fn(async () => ({ conversations: [{ id: 'chat-arlo', kind: 'agent-chat', agentIds: ['arlo'] }, { id: 'lead', agentIds: ['arlo'] }] }))
  const make = () => new FirstAnswers({ me: async () => 'dee', live: () => state.live, roster: async () => [row], read,
    working: async () => state.working, lastTurn: async () => state.lastTurn, post, file, now: () => clock.now, log })
  return { state, clock, post, log, read, file, make, answers: make() }
}

describe('an agent\'s answer to its launch line, in its chat (firstAnswers.ts)', () => {
  // anh Dee, 2026-11-10: "in the terminal i can see that arlo has the first message but i didn't see it in the chat. my "hi" was
  // the first message in the chat".
  it('posts what an agent answered "You are Arlo." in its chat with its person, as the agent, once, and not again after a restart', async () => {
    const f = setup()
    await f.answers.tick()
    expect(f.post).toHaveBeenCalledTimes(1)
    const [agent, operationId, text] = f.post.mock.calls[0]!
    expect(agent).toEqual({ tabId: 'tab', agentId: 'arlo', harnessId: 'h-arlo', chat: 'chat-arlo', names: ['Arlo', 'Claude Code'] })
    expect(operationId).toBe('first-answer-arlo')
    expect(text).toBe(ARLO_ANSWER)
    await f.answers.tick()
    await f.make().tick()
    expect(f.post).toHaveBeenCalledTimes(1)
    // Looked at once: a restarted host does not even read its Swarm for it again.
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('posts the answer to its launch line with its person\'s request, as New Project starts a PM', async () => {
    const f = setup({ lastTurn: { userMessage: 'You are Arlo.\n\nA home for the docs.', assistantText: 'On it: three issues.' } })
    await f.answers.tick()
    expect(f.post.mock.calls.map(([, , text]) => text)).toEqual(['On it: three issues.'])
  })

  it('waits while its first turn runs, or while nobody can say, and posts once it has ended', async () => {
    const f = setup({ working: true, lastTurn: { userMessage: 'You are Arlo.', assistantText: 'Half an answer' } })
    await f.answers.tick()
    f.state.working = null
    await f.answers.tick()
    expect(f.post).not.toHaveBeenCalled()
    f.state.working = false
    f.state.lastTurn = { userMessage: 'You are Arlo.', assistantText: ARLO_ANSWER }
    await f.answers.tick()
    expect(f.post.mock.calls.map(([, , text]) => text)).toEqual([ARLO_ANSWER])
  })

  it('waits for a turn to be written, and lets an agent go that shows none in an hour, saying so', async () => {
    const f = setup({ lastTurn: null })
    await f.answers.tick()
    f.clock.now += FIRST_ANSWER_GIVE_UP_MS
    await f.answers.tick()
    expect(f.log).toHaveBeenCalledWith('[super-tab] no first answer posted for agent arlo: no turn of it ended in an hour.')
    f.state.lastTurn = { userMessage: 'You are Arlo.', assistantText: ARLO_ANSWER }
    await f.answers.tick()
    expect(f.post).not.toHaveBeenCalled()
  })

  it('posts nothing when its newest turn is not its launch line: an agent attached as it ran, or its person spoke since', async () => {
    const f = setup({ lastTurn: { userMessage: 'hi', assistantText: 'Hi. I\'m Arlo.' } })
    await f.answers.tick()
    f.state.lastTurn = { userMessage: 'You are Arlo.', assistantText: ARLO_ANSWER }
    await f.answers.tick()
    expect(f.post).not.toHaveBeenCalled()
  })

  it('tries a post that failed for a moment again at the next pass, and lets one the server refuses for good go, saying so', async () => {
    const f = setup()
    f.post.mockRejectedValueOnce(new SuperTabHostError('TIMEOUT', 'The server did not answer.', 503))
    await f.answers.tick()
    await f.answers.tick()
    expect(f.post).toHaveBeenCalledTimes(2)
    expect(new Set(f.post.mock.calls.map(([, id]) => id))).toEqual(new Set(['first-answer-arlo']))
    const g = setup()
    g.post.mockRejectedValueOnce(new SuperTabHostError('VALIDATION_ERROR', 'Too long.', 400))
    await g.answers.tick()
    await g.answers.tick()
    expect(g.post).toHaveBeenCalledTimes(1)
    expect(g.log).toHaveBeenCalledWith('[super-tab] first answer of agent arlo refused: VALIDATION_ERROR.')
  })

  it('looks only at a regular agent of this computer\'s person, running here, closing nothing, in a Swarm that gives it a chat', async () => {
    for (const row of [
      { agent: { id: 'arlo', harnessId: 'h-arlo', displayName: 'Arlo', regular: false, contributorId: 'dee', machineOwnerId: 'dee' } },
      { agent: { id: 'arlo', harnessId: 'h-arlo', displayName: 'Arlo', regular: true, contributorId: 'kai', machineOwnerId: 'dee' } },
      { agent: { id: 'arlo', harnessId: 'h-arlo', displayName: 'Arlo', regular: true, contributorId: 'dee', machineOwnerId: 'kai' } },
      { closeSession: true },
      { stopRequested: true },
      { agent: { id: 'arlo', harnessId: 'h-arlo', displayName: ' ', regular: true, contributorId: 'dee', machineOwnerId: 'dee' } },
    ]) {
      const f = setup({ row })
      await f.answers.tick()
      expect(f.post, JSON.stringify(row)).not.toHaveBeenCalled()
    }
    const off = setup()
    off.state.live = false
    await off.answers.tick()
    const chatless = setup()
    chatless.read.mockResolvedValueOnce({ conversations: [{ id: 'lead', agentIds: ['arlo'] }] })
    await chatless.answers.tick()
    expect(off.post).not.toHaveBeenCalled()
    expect(chatless.post).not.toHaveBeenCalled()
  })

  it('reads a launch line as Desktop writes it, and nothing that only begins like one', () => {
    expect(launchLine('You are Pip.', ['Pip'])).toBe(true)
    expect(launchLine('You are Pip.\n\nTidy the docs.', ['Pip'])).toBe(true)
    expect(launchLine('You are Pipkin.', ['Pip'])).toBe(false)
    expect(launchLine('You are Pip. Now go.', ['Pip'])).toBe(false)
    expect(launchLine('hi', ['Pip'])).toBe(false)
  })
})
