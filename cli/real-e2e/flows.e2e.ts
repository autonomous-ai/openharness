/** REAL_ENGINES=1 via npm run test:e2e-real only. Real native records, never generated transcripts.
 * Authenticated runs spend inference quota. Missing credentials fail preflight; no CI invocation. */
import { afterEach, describe, expect, it } from 'vitest'
import { until } from '../e2e/harness/daemon.js'
import { RealFixture, isAgentFrame, plan } from './fixture.js'

describe('real-engine daemon prototype', () => {
  let fixture: RealFixture | undefined
  afterEach(async () => { await fixture?.close(); fixture = undefined })
  const fresh = async (engine: 'claude' | 'codex') => (fixture = await RealFixture.create(engine))

  it.each(plan.engines)('%s refuses a message during folder trust, then accepts it exactly once after trust', async (engine) => {
    const f = await fresh(engine)
    await f.trustScreen()
    const marker = 'QA_TRUST_RESEND'
    const since = f.client!.frames.length
    f.client!.send('message', { agentId: f.agent.id, content: `Reply with ${marker}, without tools.` })
    const refusal = await f.client!.waitFor(isAgentFrame('error', f.agent.id), 20_000, 'trust refusal', since)
    expect(refusal.payload?.message).toMatch(/trust this folder/i)
    expect(await f.trustScreen()).not.toContain(marker)
    expect(f.client!.frames.slice(since).filter(isAgentFrame('turn_started', f.agent.id))).toHaveLength(0)
    expect(JSON.stringify(f.native())).not.toContain(marker)
    await f.acceptTrust()
    await f.turn(`Reply with ${marker}, without tools.`)
    await f.userOnce(marker)
  })

  it.each(plan.engines)('%s cancels a running tool without a phantom turn or a stuck next message', async (engine) => {
    const f = await fresh(engine)
    await f.acceptTrust()
    const since = await f.hold('QA_CANCEL_TOOL')
    f.client!.send('cancel', { agentId: f.agent.id })
    await f.client!.waitFor(isAgentFrame('turn_ended', f.agent.id), 30_000, 'cancel ended the real turn', since)
    f.release()
    await f.idle()
    await f.settle()
    expect(f.client!.frames.slice(since).filter(isAgentFrame('turn_started', f.agent.id))).toHaveLength(1)
    expect(f.client!.frames.slice(since).filter(isAgentFrame('turn_ended', f.agent.id))).toHaveLength(1)
    expect(f.native().some((record) => record.payload?.type === 'turn_aborted'
      || (record.type === 'user' && Array.isArray(record.message?.content) && record.message.content.some((part: Record<string, any>) =>
        part.type === 'tool_result' && part.is_error === true && /interrupted|cancelled|canceled|abort/i.test(JSON.stringify(part.content))))),
    'a native abort or interrupted tool result, not the prompt asking for cancellation').toBe(true)
    await f.turn('Reply with QA_AFTER_CANCEL, without tools.')
    await f.userOnce('QA_AFTER_CANCEL')
  })

  it.each(plan.engines)('%s compacts a real context and preserves history and the next turn', async (engine) => {
    const f = await fresh(engine)
    await f.acceptTrust()
    await f.turn('QA_BEFORE_COMPACT: Read all of context.txt, then report its first and last item numbers. Do not modify files.')
    const since = f.client!.frames.length
    const nativeBefore = new Set(f.native().map((record) => JSON.stringify(record)))
    await f.type('/compact')
    await f.client!.waitFor(isAgentFrame('context_compact', f.agent.id), 120_000, 'real context_compact', since)
    await until('a native compaction record', () => f.native().some((record) =>
      !nativeBefore.has(JSON.stringify(record)) && (record.type === 'compacted' || record.subtype === 'compact_boundary'
      || record.payload?.type === 'context_compacted')), 20_000)
    await f.idle()
    await f.settle()
    if (engine === 'claude') expect(f.client!.frames.slice(since).filter(isAgentFrame('turn_started', f.agent.id))).toHaveLength(0)
    await f.turn('Reply with QA_AFTER_COMPACT, without tools.')
    await f.userOnce('QA_BEFORE_COMPACT')
    await f.userOnce('QA_AFTER_COMPACT')
  })

  it.each(plan.engines)('%s keeps a human message typed into its real prompt while a tool is busy', async (engine) => {
    const f = await fresh(engine)
    await f.acceptTrust()
    await f.hold('QA_BUSY_FIRST')
    await f.type('QA_BUSY_SECOND: After the tool finishes, reply with this marker without more tools.')
    f.release()
    await f.userOnce('QA_BUSY_FIRST')
    await f.userOnce('QA_BUSY_SECOND')
    await f.idle()
    const native = f.native()
    if (engine === 'claude') {
      expect(native.some((record) => record.type === 'attachment' && record.attachment?.type === 'queued_command'
        && record.attachment?.origin?.kind === 'human' && JSON.stringify(record).includes('QA_BUSY_SECOND'))).toBe(true)
    } else expect(JSON.stringify(native)).toContain('QA_BUSY_SECOND')
    await f.turn('Reply with QA_AFTER_BUSY, without tools.')
    await f.userOnce('QA_AFTER_BUSY')
  })

  if (plan.engines.includes('codex')) it('codex gives its real sub-agent a completed Task card, live and in history', async () => {
    const f = await fresh('codex')
    await f.acceptTrust()
    const since = f.client!.frames.length
    await f.turn('Use exactly one sub-agent named counter to read three-lines.txt and count its lines. The child must reply QA_CHILD_COUNT=3. Wait for its final answer and relay it. Do not count it yourself or change files.')
    const task = f.client!.frames.slice(since).find((frame) => isAgentFrame('tool_start', f.agent.id)(frame) && frame.payload?.tool === 'Task')
    expect(task, 'real child opened a Task').toBeDefined()
    const live = f.client!.frames.slice(since).find((frame) => isAgentFrame('tool_end', f.agent.id)(frame) && frame.payload?.id === task!.payload?.id)
    expect(live?.payload).toMatchObject({ tool: 'Task', isError: false, output: expect.stringContaining('QA_CHILD_COUNT=3') })
    const replay = (await f.history()).find((event) => event.type === 'tool_end' && event.payload?.id === task!.payload?.id)
    expect(replay?.payload).toMatchObject({ tool: 'Task', isError: false, output: expect.stringContaining('QA_CHILD_COUNT=3') })
    const records = f.native()
    expect(records.some((r) => r.payload?.type === 'function_call' && r.payload?.name === 'spawn_agent')).toBe(true)
    for (const kind of ['started', 'completed']) expect(records.some((r) => r.payload?.item?.type === 'SubAgentActivity' && r.payload.item.kind === kind)).toBe(true)
    expect(records.some((r) => r.payload?.type === 'agent_message' && r.payload?.author?.startsWith('/root/') && JSON.stringify(r.payload).includes('QA_CHILD_COUNT=3'))).toBe(true)
  })
})
