// A Buddy's machine carrying out the model switch its owner asked the Swarm for (task #2354,
// docs/plans/2026-11-03-buddy-model-switch-design.md): it measures each session's conversation against the model's window, moves
// it through its own daemon's agent_retarget, and reports buddy.modelResult once.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyModelRequests, type BuddyModelRow } from './buddyModel.js'

const GRID = 'swarm-0123456789ab'
const request = (over: Record<string, unknown> = {}) => ({ id: 'req1', gridModel: 'deepseek-4.1-flash', gridName: GRID, name: 'DeepSeek 4.1 Flash',
  servedBy: ['Mac Studio'], contextWindow: 131072, requestedBy: 'peer', at: '2026-11-03T10:00:00.000Z', ...over })
const main = (modelRequest: Record<string, unknown> | null = request()): BuddyModelRow => ({ tabId: 'tab', agent: { id: 'buddy', harnessId: 'h-main',
  buddyOf: { personId: 'peer', generation: 'first' }, ...(modelRequest ? { modelRequest } : {}) } })
const thread = (harnessId: string): BuddyModelRow => ({ tabId: 'tab', agent: { id: `s-${harnessId}`, harnessId,
  buddyOf: { personId: 'peer', generation: 'first' }, buddySession: { thread: 't', from: 0 } } })

function fixture(options: { tokens?: Record<string, number | null>; answers?: Array<Record<string, unknown>>; dataDir?: string } = {}) {
  const frames: Array<Record<string, unknown>> = []
  const posts: Array<Record<string, unknown>> = []
  const answers = [...(options.answers ?? [])]
  let now = 0
  const runner = new BuddyModelRequests({
    dataDir: options.dataDir ?? mkdtempSync(join(tmpdir(), 'buddy-model-')),
    now: () => now,
    log: () => {},
    open: async () => ({ request: async (type, payload) => { frames.push({ type, ...payload }); return answers.shift() ?? { retargeted: true } }, close: () => {} }),
    post: async (_tabId, agentId, _operationId, command) => { posts.push({ asAgentId: agentId, ...command }) },
    transcript: harnessId => `/transcripts/${harnessId}.jsonl`,
    tokens: async path => options.tokens?.[path.slice('/transcripts/'.length, -'.jsonl'.length)] ?? null,
  })
  return { runner, frames, posts, later: (ms: number) => { now += ms } }
}

describe('carrying out a Buddy\'s model request', () => {
  it('moves a conversation that fits onto the model, resuming it, and reports once', async () => {
    const f = fixture({ tokens: { 'h-main': 40_000 } })
    await f.runner.serve(main(), [])
    expect(f.frames).toEqual([{ type: 'agent_retarget', agentId: 'h-main', gridModel: 'deepseek-4.1-flash', gridName: GRID }])
    expect(f.posts).toEqual([{ asAgentId: 'buddy', type: 'buddy.modelResult', agentId: 'buddy', requestId: 'req1', ok: true }])
    await f.runner.serve(main(), [])
    expect([f.frames.length, f.posts.length]).toEqual([1, 1])
  })

  it('starts a fresh session when the conversation is 80% of the window or more', async () => {
    const f = fixture({ tokens: { 'h-main': 104_858 } })
    await f.runner.serve(main(), [])
    expect(f.frames).toEqual([{ type: 'agent_retarget', agentId: 'h-main', gridModel: 'deepseek-4.1-flash', gridName: GRID, fresh: true }])
    expect(f.posts).toEqual([expect.objectContaining({ ok: true, fresh: true })])
  })

  it('resumes when the window or the conversation\'s size is unknown', async () => {
    for (const [over, tokens] of [[{ contextWindow: undefined }, 120_000], [{}, null]] as const) {
      const f = fixture({ tokens: { 'h-main': tokens } })
      await f.runner.serve(main(request(over)), [])
      expect(f.frames[0]).not.toHaveProperty('fresh')
    }
  })

  it('moves the Buddy home to its own login', async () => {
    const f = fixture()
    await f.runner.serve(main(request({ gridModel: null, gridName: undefined, name: 'DeepSeek 4.1 Flash' })), [])
    expect(f.frames).toEqual([{ type: 'agent_retarget', agentId: 'h-main', clearGrid: true }])
    expect(f.posts).toEqual([expect.objectContaining({ ok: true })])
  })

  it('moves the Buddy\'s thread sessions too, each measured on its own, and names one that stayed', async () => {
    const f = fixture({ tokens: { 'h-main': 1_000, 'h-a': 120_000, 'h-b': 1_000 }, answers: [{ retargeted: true }, { retargeted: true }, { error: 'AGENT_BUSY' }] })
    await f.runner.serve(main(), [thread('h-a'), thread('h-b')])
    expect(f.frames.map(frame => [frame.agentId, frame.fresh ?? false])).toEqual([['h-main', false], ['h-a', true], ['h-b', false]])
    expect(f.posts).toEqual([expect.objectContaining({ ok: true, error: 'A thread session stayed where it was: it was answering' })])
  })

  it('says why a move was refused, in words its owner can act on', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ error: 'AGENT_BUSY' }, 'Your Buddy is answering. Try again when it has finished'],
      [{ error: 'GRID_UNAVAILABLE', detail: '/Users/someone/secret path' }, "Mac Studio isn't serving DeepSeek 4.1 Flash now"],
      [{ error: 'RESPAWN_FAILED', detail: 'tmux: /private/path' }, 'its computer could not switch it (RESPAWN_FAILED)'],
    ]
    for (const [answer, error] of cases) {
      const f = fixture({ answers: [answer] })
      await f.runner.serve(main(), [thread('h-a')])
      expect(f.frames).toHaveLength(1)
      expect(f.posts).toEqual([{ asAgentId: 'buddy', type: 'buddy.modelResult', agentId: 'buddy', requestId: 'req1', ok: false, error }])
    }
  })

  it('waits for the turn to end before sending a Buddy home by itself, then moves it', async () => {
    const f = fixture({ answers: [{ error: 'AGENT_BUSY' }, { retargeted: true }] })
    const home = main(request({ gridModel: null, gridName: undefined, reason: 'limit' }))
    await f.runner.serve(home, [])
    expect(f.posts).toEqual([])
    await f.runner.serve(home, [])
    expect(f.frames).toHaveLength(1)
    f.later(15_000)
    await f.runner.serve(home, [])
    expect(f.frames).toHaveLength(2)
    expect(f.posts).toEqual([expect.objectContaining({ ok: true })])
  })

  it('never carries out the same request twice, across a restart, and reports one it carried out but could not report', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'buddy-model-'))
    const first = fixture({ dataDir })
    first.runner['deps'].post = async () => { throw new Error('offline') }
    await first.runner.serve(main(), [])
    expect(first.frames).toHaveLength(1)
    const second = fixture({ dataDir })
    await second.runner.serve(main(), [])
    expect(second.frames).toEqual([])
    expect(second.posts).toEqual([expect.objectContaining({ requestId: 'req1', ok: true })])
  })

  it('does nothing for a Buddy with no request', async () => {
    const f = fixture()
    await f.runner.serve(main(null), [])
    expect([f.frames, f.posts]).toEqual([[], []])
  })
})
