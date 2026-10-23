import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { REPLACED_PROGRAM } from '../engines/kit/identityScan.js'
import { createNativeTurnObservations } from '../lib/nativeTurnObservations.js'
import { NativeRecorder, nativeJournalFile } from './native.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const alpha = 'context_alpha_123456', beta = 'context_beta_1234567'
function setup(recovery = false) {
  const root = mkdtempSync(join(tmpdir(), 'super-tab-native-')); roots.push(root)
  let now = 100, revoked = false, loseReply = false
  const observer = createNativeTurnObservations({ resolve: () => ({ sessionId: 'session', engine: 'codex', runtime: 'runtime' }), now: () => 100 })
  const contexts = new Map<string, { lastEventId: string | null }>([[alpha, { lastEventId: null }], [beta, { lastEventId: null }]])
  const records = new Map<string, Record<string, unknown>>(), sent: Record<string, unknown>[] = []
  const backend = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (revoked) return { status: 403, body: { success: false, error: { code: 'NATIVE_CONTEXT_REVOKED', message: 'Removed' } } }
    const id = path.split('/').at(-1)!, context = contexts.get(id)!
    if (method === 'GET') return { status: 200, body: { data: { contextId: id, tabId: 'tab', machineId: 'machine-1', harnessId: 'harness', ...context,
      ...(recovery ? { recovery: { version: 1, serverTime: now + 900 } } : {}) } } }
    const value = body as Record<string, unknown>
    sent.push(value)
    const eventId = createHash('sha256').update(JSON.stringify(['native-event', id, value.turnId, value.kind])).digest('hex').slice(0, 24)
    if (records.has(eventId)) expect(records.get(eventId)).toEqual(value)
    else {
      expect(value.previousEventId).toBe(context.lastEventId)
      records.set(eventId, value); context.lastEventId = eventId
    }
    if (loseReply) { loseReply = false; return { status: 503, body: { success: false } } }
    return { status: 200, body: { data: { eventId } } }
  })
  const core = fakeCore({ dataDir: root, account: { backend }, agents: { byAgent: vi.fn(() => ({ agentId: 'harness' }) as never) },
    transcripts: { nativeTurns: vi.fn(async (id, cursor) => observer.read(id, cursor)) } })
  const open = () => new NativeRecorder(core, 'machine-1', { now: () => now })
  const file = nativeJournalFile(root, 'machine-1')
  const prompt = (text: string, context: string | null = alpha) => {
    observer.typed('harness', context, true)
    observer.ingest('harness', [{ type: 'turn_started', payload: { userMessage: text } }])
  }
  const answer = (text: string) => observer.ingest('harness', [{ type: 'text_delta', payload: { content: text } }, { type: 'turn_ended', payload: {} }])
  const saved = () => JSON.parse(readFileSync(file, 'utf8'))
  return { core, open, observer, backend, sent, records, prompt, answer, saved, file, contexts,
    time: (value: number) => { now = value }, revoke: () => { revoked = true }, lose: () => { loseReply = true } }
}

describe('durable native conversation recording', () => {
  it('identifies a recording restart when preparing a previously recorded context, without replaying input', async () => {
    const t = setup(true)
    t.contexts.get(alpha)!.lastEventId = 'previous_event'
    const host = t.open()
    await host.prepare('tab', alpha); await host.flush()
    expect(t.sent).toEqual([expect.objectContaining({ kind: 'gap', previousEventId: 'previous_event',
      gap: { incidentId: expect.any(String), reason: 'recording_restarted', detectedAt: 1000 } })])
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
  })

  it('uses the same restart incident across capture and preparation, and preserves it through a lost reply', async () => {
    const t = setup(true), first = t.open()
    await first.prepare('tab', alpha); t.prompt('Checkpoint'); await first.capture(); await first.flush()
    t.contexts.get(beta)!.lastEventId = 'other_checkpoint'
    t.observer.ingest('harness', [], true)
    t.time(200)
    await first.prepare('tab', beta)
    await first.capture()
    const gaps = t.saved().agents.harness.outbox
    expect(gaps).toHaveLength(2)
    expect(gaps[0].gap).toEqual({ incidentId: expect.any(String), reason: 'recording_restarted', detectedAt: 1100 })
    expect(gaps[1].gap).toEqual(gaps[0].gap)
    t.lose(); await expect(first.flush()).rejects.toThrow(); first.stop()
    const restarted = t.open(); await restarted.capture(); await restarted.flush(); await restarted.capture(); await restarted.flush()
    expect(t.sent.slice(1)).toHaveLength(3)
    expect(t.sent[1]).toEqual(t.sent[2])
    expect(t.records.size).toBe(3)
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
  })

  it('keeps the old wire format for a backend without recovery support, including saved outboxes', async () => {
    const t = setup(), first = t.open()
    t.contexts.get(alpha)!.lastEventId = 'previous_event'
    await first.prepare('tab', alpha); first.stop()
    const restarted = t.open(); await restarted.flush()
    expect(t.sent).toEqual([{ turnId: expect.any(String), kind: 'gap', previousEventId: 'previous_event',
      text: '', truncated: false, interrupted: false }])
  })

  it('reopens a retired context in the same epoch without reusing an observation with different content', async () => {
    const t = setup(true), host = t.open()
    t.contexts.get(alpha)!.lastEventId = 'previous_event'
    await host.prepare('tab', alpha); await host.flush()
    t.time(100_000); await host.capture()
    expect(host.hasWork).toBe(false)
    await host.prepare('tab', alpha); await host.flush()
    expect(t.sent).toHaveLength(2)
    expect(t.sent[0]).toMatchObject({ gap: { incidentId: expect.any(String) } })
    expect(t.sent[1]!.gap).toMatchObject({ incidentId: (t.sent[0]!.gap as { incidentId: string }).incidentId })
    expect(t.sent[1]!.turnId).not.toBe(t.sent[0]!.turnId)
    expect(t.records.size).toBe(2)
  })

  it.each(['incident', 'reason', 'time', 'kind'] as const)('rejects corrupted recovery %s in a saved outbox', async field => {
    const t = setup(true), host = t.open()
    t.contexts.get(alpha)!.lastEventId = 'previous_event'
    await host.prepare('tab', alpha); host.stop()
    const saved = t.saved(), event = saved.agents.harness.outbox[0]
    event.gap = { incidentId: 'restart', reason: 'recording_restarted', detectedAt: 1000 }
    if (field === 'incident') event.gap.incidentId = '../invalid'
    if (field === 'reason') event.gap.reason = 'not_a_reason'
    if (field === 'time') event.gap.detectedAt = -1
    if (field === 'kind') event.kind = 'prompt'
    writeFileSync(t.file, JSON.stringify(saved))
    expect(() => t.open()).toThrow('Invalid terminal recording gap')
    expect(t.sent).toEqual([])
  })

  it('reports a confirmed stop with its detection time and retains the exact incident on retry', async () => {
    const t = setup(true), host = t.open()
    await host.prepare('tab', alpha); t.prompt('Unfinished'); await host.capture(); await host.flush()
    vi.mocked(t.core.transcripts.nativeTurns!).mockResolvedValue(null)
    t.core.agents.stopped = vi.fn(async () => ({ agentId: 'harness' }) as never)
    t.time(300); await host.capture()
    expect(t.saved().agents.harness.outbox[0]).toMatchObject({ kind: 'gap', interrupted: true,
      gap: { incidentId: expect.any(String), reason: 'agent_stopped', detectedAt: 1200 } })
    await host.flush(); await host.capture()
    expect(t.sent).toHaveLength(2)
  })

  it('distinguishes lost history and unattributed input from a recording restart', async () => {
    const t = setup(true), host = t.open()
    await host.prepare('tab', alpha)
    t.prompt('Unknown input', null); await host.capture(); await host.flush()
    expect(t.sent[0]).toMatchObject({ gap: { reason: 'unattributed_input', detectedAt: 1000 } })
    const cursor = t.saved().agents.harness.cursor
    vi.mocked(t.core.transcripts.nativeTurns!).mockResolvedValueOnce({ cursor: { ...cursor, sequence: cursor.sequence + 1 }, observations: [], gap: true })
    await host.capture(); await host.flush()
    expect(t.sent[1]).toMatchObject({ gap: { reason: 'history_lost', detectedAt: 1000 } })
    expect(t.sent[0]!.turnId).not.toEqual(t.sent[1]!.turnId)
  })

  it('says why an unidentified terminal cannot be recorded instead of asking for an update', async () => {
    const t = setup()
    const transcripts = t.core.transcripts as { nativeTurns?: unknown }
    transcripts.nativeTurns = vi.fn(async () => null)
    await expect(t.open().prepare('tab', alpha)).rejects.toThrow('Harness hasn’t identified this terminal’s conversation yet. Retry in a moment, or restart the agent.')
    vi.mocked(t.core.agents.byAgent).mockReturnValue({ agentId: 'harness', identityHold: `Conversation identity is held: ${REPLACED_PROGRAM}.` } as never)
    await expect(t.open().prepare('tab', alpha)).rejects.toThrow('This agent’s program was updated while it was running. Restart the agent, then retry.')
    delete transcripts.nativeTurns
    await expect(t.open().prepare('tab', alpha)).rejects.toThrow('Update this machine’s Harness to record native terminal conversations.')
    expect(existsSync(t.file)).toBe(false)
  })
  it('starts at the current boundary and records only the prepared conversation, without writing native input', async () => {
    const t = setup(), host = t.open()
    t.observer.read('harness'); t.prompt('Private history'); t.answer('Private answer')
    expect(await host.prepare('tab', alpha)).toEqual({ ok: true, inputContext: alpha })
    t.prompt('Shared input'); t.answer('Shared answer')
    t.prompt('Another conversation', beta); t.answer('Not shared here')
    await host.capture()
    expect(t.sent).toEqual([])
    expect(t.saved().agents.harness.outbox.map((e: { text: string }) => e.text)).toEqual(['Shared input', 'Shared answer'])
    await host.flush()
    expect(t.sent.map(e => e.text)).toEqual(['Shared input', 'Shared answer'])
    expect(t.saved().agents.harness.outbox).toEqual([])
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
    expect(statSync(t.file).mode & 0o777).toBe(0o600)
    const unchanged = statSync(t.file).mtimeMs
    await host.capture()
    expect(statSync(t.file).mtimeMs).toBe(unchanged)
  })

  it('reports ambiguous native activity without exporting its content or treating ordinary deliveries as gaps', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha)
    t.observer.submitting('harness')
    t.observer.ingest('harness', [{ type: 'turn_started', payload: { userMessage: 'Ordinary delivered instruction' } }, { type: 'turn_ended', payload: {} }])
    await host.capture(); await host.flush()
    expect(t.sent).toEqual([])
    t.prompt('Unknown person and conversation', null); t.answer('Do not expose this answer')
    await host.capture(); await host.flush()
    expect(t.sent).toEqual([expect.objectContaining({ kind: 'gap', text: '' })])
  })

  it('replays an identical saved observation after a lost backend acknowledgement and restart', async () => {
    const t = setup(), first = t.open()
    await first.prepare('tab', alpha); t.prompt('One input'); t.answer('One answer'); await first.capture()
    t.lose(); await expect(first.flush()).rejects.toThrow(); first.stop()
    const restarted = t.open(); await restarted.capture(); await restarted.flush()
    expect(t.sent).toHaveLength(3)
    expect(t.sent[0]).toEqual(t.sent[1])
    expect(t.records.size).toBe(2)
    expect(t.saved().agents.harness.outbox).toEqual([])
  })

  it('keeps capturing while the network is slow and preserves the global observation order across contexts', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha); await host.prepare('tab', beta)
    t.prompt('First'); t.answer('First answer'); await host.capture()
    const implementation = t.backend.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    t.backend.mockImplementationOnce(async (...args) => { await gate; return implementation(...args) })
    const sending = host.flush()
    t.prompt('Second', beta); t.answer('Second answer'); await host.capture()
    expect(t.saved().agents.harness.outbox).toHaveLength(4)
    release(); await sending
    expect(t.sent.map(e => e.text)).toEqual(['First', 'First answer', 'Second', 'Second answer'])
  })

  it('retains the old cursor if its durable write fails', async () => {
    const t = setup(), first = t.open()
    await first.prepare('tab', alpha); first.stop()
    const before = t.saved().agents.harness.cursor
    const failed = new NativeRecorder(t.core, 'machine-1', { write: () => { throw new Error('Disk full') } })
    t.prompt('Recover after storage failure'); t.answer('Recovered answer')
    await expect(failed.capture()).rejects.toThrow('Disk full')
    expect(t.saved().agents.harness.cursor).toEqual(before)
    expect(t.sent).toEqual([])
    failed.stop()
    const restarted = t.open(); await restarted.capture(); await restarted.flush()
    expect(t.sent.map(e => e.text)).toEqual(['Recover after storage failure', 'Recovered answer'])
  })

  it('reports discontinuity explicitly and does not send an answer without its prompt', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha)
    t.prompt('Before restart'); await host.capture(); await host.flush()
    t.observer.ingest('harness', [], true)
    await host.capture(); await host.flush()
    expect(t.sent.map(e => e.kind)).toEqual(['prompt', 'gap'])
    t.prompt('After restart'); t.answer('After restart answer'); await host.capture(); await host.flush()
    expect(t.sent.map(e => e.kind)).toEqual(['prompt', 'gap', 'prompt', 'answer'])
  })

  it('finishes an already observed turn after closing the view, then stops observing the idle terminal', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha); t.prompt('Long task'); await host.capture(); await host.flush()
    t.time(100_000); t.answer('Completed after the view closed'); await host.capture(); await host.flush(); await host.capture()
    expect(t.sent.map(e => e.kind)).toEqual(['prompt', 'answer'])
    expect(t.saved().agents).toEqual({})
    await expect(host.prepare('tab', alpha, true)).rejects.toThrow('expired')
  })

  it('withholds revoked content, refuses the old context and never turns it into native input', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha); t.prompt('Pending private observation'); await host.capture()
    t.revoke(); await expect(host.flush()).rejects.toThrow('Removed')
    expect(t.saved().agents.harness.outbox).toEqual([])
    expect(t.saved().agents.harness.contexts[alpha].blocked).toContain('recording stopped')
    await expect(host.prepare('tab', alpha, true)).rejects.toThrow('Removed')
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
  })

  it('retires a confirmed stopped harness after reporting any unfinished recorded turn', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha); t.prompt('Interrupted task'); await host.capture(); await host.flush()
    vi.mocked(t.core.transcripts.nativeTurns!).mockResolvedValue(null)
    t.core.agents.stopped = vi.fn(async () => ({ agentId: 'harness' }) as never)
    await host.capture(); await host.flush(); await host.capture()
    expect(t.sent.map(e => e.kind)).toEqual(['prompt', 'gap'])
    expect(host.hasWork).toBe(false)
    expect(t.saved().agents).toEqual({})
  })

  it('reports unread activity after a lease expires and retires old views while another stays open', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha)
    t.prompt('Cannot establish when this delayed input arrived'); t.answer('Do not silently lose this boundary')
    t.time(100_000)
    await expect(host.prepare('tab', alpha, true)).rejects.toThrow('expired')
    await host.prepare('tab', beta)
    await host.capture(); await host.flush(); await host.capture()
    expect(t.sent).toEqual([expect.objectContaining({ kind: 'gap', text: '' })])
    expect(Object.keys(t.saved().agents.harness.contexts)).toEqual([beta])
    t.prompt('Current conversation', beta); t.answer('Still recorded')
    await host.capture(); await host.flush()
    expect(t.sent.map(e => e.kind)).toEqual(['gap', 'prompt', 'answer'])
  })

  it('refuses lost, corrupt or replaced journals and a disconnected host', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha)
    rmSync(t.file)
    await expect(host.capture()).rejects.toThrow('missing')
    expect(() => t.open()).toThrow('missing')
    writeFileSync(t.file, '{}')
    await expect(host.capture()).rejects.toThrow('replaced')
    expect(() => t.open()).toThrow('Invalid')
    host.stop(); await expect(host.prepare('tab', alpha)).rejects.toThrow('disconnected')
  })

  it('refuses an in-place journal change even when the filesystem identity is unchanged', async () => {
    const t = setup(), host = t.open()
    await host.prepare('tab', alpha)
    const original = readFileSync(t.file, 'utf8'), inode = statSync(t.file).ino
    writeFileSync(t.file, `${original}\n`)
    expect(statSync(t.file).ino).toBe(inode)
    await expect(host.capture()).rejects.toThrow('changed')
    await expect(host.prepare('tab', alpha, true)).rejects.toThrow('changed')
    expect(t.sent).toEqual([])
  })

  it('checks the exact execution machine, native support, cancellation and renewal', async () => {
    const t = setup(), host = t.open()
    await expect(host.prepare('../wrong', alpha)).rejects.toThrow('no longer')
    const aborted = new AbortController(); aborted.abort()
    await expect(host.prepare('tab', alpha, false, aborted.signal)).rejects.toThrow('no longer')
    t.backend.mockResolvedValueOnce({ status: 200, body: { data: { contextId: alpha, machineId: 'elsewhere' } } } as never)
    await expect(host.prepare('tab', alpha)).rejects.toThrow('exact contributed terminal')
    vi.mocked(t.core.transcripts.nativeTurns!).mockResolvedValueOnce(null)
    await expect(host.prepare('tab', alpha)).rejects.toThrow('identified')
    await host.prepare('tab', alpha)
    t.time(80_000); await host.prepare('tab', alpha, true); t.time(100_000)
    t.prompt('Still open'); t.answer('Recorded'); await host.capture(); await host.flush()
    expect(t.sent).toHaveLength(2)
  })
})
