import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgyNormalizer } from '../../engines/agy/normalizer.js'
import { AmpNormalizer } from '../../engines/amp/normalizer.js'
import { CodexNormalizer } from '../../engines/codex/normalizer.js'
import { CommandCodeNormalizer } from '../../engines/commandcode/normalizer.js'
import { CopilotNormalizer } from '../../engines/copilot/normalizer.js'
import { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import { GrokNormalizer } from '../../engines/grok/normalizer.js'
import { MuseNormalizer } from '../../engines/muse/normalizer.js'
import { PiNormalizer } from '../../engines/pi/normalizer.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { HistoryEvent, LineEvent, RewrittenEvent, Watcher } from '../../watcher/watcher.js'
import { createIngest, type IngestDeps } from './ingest.js'
import { createSessionNormalizers } from './normalizers.js'

const CODEX_FAILED = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'rate limited' } } })
const COMMANDCODE_FAILED = JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Error: 500\nTrace ID: 932a' }] } })
const CLAUDE_PROMPT = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })

function setup(engines: Record<string, string>, over: Partial<IngestDeps> = {}) {
  const sessions = new Map(Object.entries(engines).map(([sessionId, engine]) =>
    [sessionId, { agentId: `agent-${sessionId}`, sessionId, engine, transcriptPath: `/t/${sessionId}.jsonl` } as RegisteredSession]))
  const normalizers = createSessionNormalizers()
  const service = { needsTranscript: vi.fn(() => false), observeTranscript: vi.fn() }
  const deps: IngestDeps = {
    has: (sessionId) => sessions.has(sessionId),
    bySession: (sessionId) => sessions.get(sessionId),
    tokenUsage: { changed: vi.fn() },
    device: () => service,
    runtimeProfiles: { ingest: vi.fn() },
    normalizers,
    announceTurnAborted: vi.fn(),
    emit: vi.fn(),
    attachSession: vi.fn(async () => true),
    ...over,
  }
  return { deps, sessions, normalizers, service, ingest: createIngest(deps) }
}

const line = (sessionId: string, engine: string, text = '{}'): LineEvent => ({ sessionId, engine, text } as LineEvent)

describe('ingesting a transcript line', () => {
  afterEach(() => vi.restoreAllMocks())

  it('takes lines only for a registered session of the engine that wrote them', () => {
    const { ingest, deps } = setup({ s1: 'claude', s2: 'codex' })
    expect(ingest.ingestLine(line('nobody', 'claude'))).toBeNull()
    expect(ingest.ingestLine(line('s1', 'codex'))).toBeNull()
    const ghost = setup({}, { has: () => true })
    expect(ghost.ingest.ingestLine(line('s9', 'claude'))).toBeNull()
    expect(deps.tokenUsage.changed).not.toHaveBeenCalled()
  })

  it('counts tokens, shows the device its raw lines when it asks, and reads the runtime from each line', () => {
    const { ingest, deps, service, sessions } = setup({ s1: 'claude' })
    ingest.ingestLine(line('s1', 'claude', CLAUDE_PROMPT))
    expect(deps.tokenUsage.changed).toHaveBeenCalledWith(sessions.get('s1'))
    expect(service.observeTranscript).not.toHaveBeenCalled()
    service.needsTranscript.mockReturnValue(true)
    ingest.ingestLine(line('s1', 'claude', CLAUDE_PROMPT))
    expect(service.observeTranscript).toHaveBeenCalledWith('agent-s1', 's1', 'claude', CLAUDE_PROMPT)
    expect(deps.runtimeProfiles.ingest).toHaveBeenCalledWith(sessions.get('s1'), CLAUDE_PROMPT)
    const none = setup({ s1: 'claude' }, { device: () => undefined })
    expect(none.ingest.ingestLine(line('s1', 'claude', CLAUDE_PROMPT))).toEqual(expect.any(Array))
  })

  it('creates each file engine\'s normalizer on the session\'s first line, and keeps it', () => {
    const engines = {
      codex: CodexNormalizer, cursor: CursorNormalizer, muse: MuseNormalizer, amp: AmpNormalizer, grok: GrokNormalizer,
      agy: AgyNormalizer, copilot: CopilotNormalizer, pi: PiNormalizer, commandcode: CommandCodeNormalizer,
    } as const
    const run = setup(Object.fromEntries(Object.keys(engines).map((engine) => [engine, engine])))
    const maps = {
      codex: run.normalizers.codexNormalizers, cursor: run.normalizers.cursorNormalizers, muse: run.normalizers.museNormalizers,
      amp: run.normalizers.ampNormalizers, grok: run.normalizers.grokNormalizers, agy: run.normalizers.agyNormalizers,
      copilot: run.normalizers.copilotNormalizers, pi: run.normalizers.piNormalizers, commandcode: run.normalizers.commandcodeNormalizers,
    } as Record<keyof typeof engines, Map<string, unknown>>
    for (const [engine, Normalizer] of Object.entries(engines) as Array<[keyof typeof engines, new (...args: never[]) => unknown]>) {
      expect(run.ingest.ingestLine(line(engine, engine)), engine).toEqual(expect.any(Array))
      const first = maps[engine].get(engine)
      expect(first, engine).toBeInstanceOf(Normalizer)
      run.ingest.ingestLine(line(engine, engine))
      expect(maps[engine].get(engine), `${engine} keeps its normalizer`).toBe(first)
    }
  })

  it('reads Claude Code and any other engine with the turn state, created once', () => {
    const run = setup({ s1: 'claude', s2: 'terminal' })
    const events = run.ingest.ingestLine(line('s1', 'claude', CLAUDE_PROMPT))!
    expect(events.map((event) => event.type)).toContain('turn_started')
    const state = run.normalizers.turnStates.get('s1')
    run.ingest.ingestLine(line('s1', 'claude', '{}'))
    expect(run.normalizers.turnStates.get('s1')).toBe(state)
    run.ingest.ingestLine(line('s2', 'terminal', '{}'))
    expect(run.normalizers.turnStates.has('s2')).toBe(true)
  })

  it('announces the reason a Codex or Command Code turn failed', () => {
    const run = setup({ cx: 'codex', cc: 'commandcode' })
    run.ingest.ingestLine(line('cx', 'codex', CODEX_FAILED))
    run.ingest.ingestLine(line('cc', 'commandcode', COMMANDCODE_FAILED))
    run.ingest.ingestLine(line('cx', 'codex', '{}'))
    run.ingest.ingestLine(line('cc', 'commandcode', '{}'))
    expect(vi.mocked(run.deps.announceTurnAborted).mock.calls).toEqual([
      ['cx', 'codex', 'rate limited'],
      ['cc', 'commandcode', 'Error: 500\nTrace ID: 932a', 'Error: 500'],
    ])
  })
})

describe('the watcher wiring', () => {
  afterEach(() => vi.restoreAllMocks())

  function wired(engines: Record<string, string>, over: Partial<IngestDeps> = {}) {
    const run = setup(engines, over)
    const watcher = new EventEmitter()
    run.ingest.wireWatcher(watcher as unknown as Pick<Watcher, 'on'>)
    return { ...run, watcher }
  }

  it('streams each live line, and contains a line that throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = wired({ s1: 'claude' })
    run.watcher.emit('line', line('s1', 'claude', CLAUDE_PROMPT))
    run.watcher.emit('line', line('nobody', 'claude', CLAUDE_PROMPT))
    expect(vi.mocked(run.deps.emit).mock.calls).toHaveLength(1)
    expect(vi.mocked(run.deps.emit).mock.calls[0][0]).toBe('s1')
    vi.mocked(run.deps.runtimeProfiles.ingest).mockImplementationOnce(() => { throw new Error('bad line') })
    run.watcher.emit('line', line('s1', 'claude', CLAUDE_PROMPT))
    vi.mocked(run.deps.runtimeProfiles.ingest).mockImplementationOnce(() => { throw 'worse' })
    run.watcher.emit('line', line('s1', 'claude', CLAUDE_PROMPT))
    expect(error.mock.calls).toEqual([
      ['[cli] line handler error (session s1):', 'bad line'],
      ['[cli] line handler error (session s1):', 'worse'],
    ])
  })

  it('emits a catch-up batch as one replay, and nothing when it holds no events', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = wired({ s1: 'claude' })
    const batch = (lines: LineEvent[]): HistoryEvent => ({ sessionId: 's1', lines } as HistoryEvent)
    run.watcher.emit('history', batch([line('s1', 'claude', CLAUDE_PROMPT), line('nobody', 'claude'), line('s1', 'claude', '{}')]))
    run.watcher.emit('history', batch([line('nobody', 'claude')]))
    expect(vi.mocked(run.deps.emit).mock.calls).toHaveLength(1)
    expect(vi.mocked(run.deps.emit).mock.calls[0][2]).toEqual({ replay: true })
    vi.mocked(run.deps.runtimeProfiles.ingest).mockImplementationOnce(() => { throw new Error('bad batch') })
    run.watcher.emit('history', batch([line('s1', 'claude', CLAUDE_PROMPT)]))
    vi.mocked(run.deps.runtimeProfiles.ingest).mockImplementationOnce(() => { throw 'worse' })
    run.watcher.emit('history', batch([line('s1', 'claude', CLAUDE_PROMPT)]))
    expect(error.mock.calls).toEqual([
      ['[cli] history handler error (session s1):', 'bad batch'],
      ['[cli] history handler error (session s1):', 'worse'],
    ])
  })

  it('attaches a transcript rewritten in place again, from its end, and only the session\'s own', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = wired({ s1: 'claude' })
    const rewritten = (sessionId: string, transcriptPath: string) => ({ sessionId, transcriptPath } as RewrittenEvent)
    run.watcher.emit('rewritten', rewritten('nobody', '/t/nobody.jsonl'))
    run.watcher.emit('rewritten', rewritten('s1', '/t/other.jsonl'))
    expect(run.deps.attachSession).not.toHaveBeenCalled()
    run.watcher.emit('rewritten', rewritten('s1', '/t/s1.jsonl'))
    expect(run.deps.attachSession).toHaveBeenCalledWith(run.sessions.get('s1'), true)
    expect(String(log.mock.calls[0][0])).toContain('transcript rewritten in place — attaching it again from its end')
    vi.mocked(run.deps.attachSession).mockRejectedValueOnce(new Error('pane gone')).mockRejectedValueOnce('tmux down')
    run.watcher.emit('rewritten', rewritten('s1', '/t/s1.jsonl'))
    run.watcher.emit('rewritten', rewritten('s1', '/t/s1.jsonl'))
    await new Promise((done) => setTimeout(done, 0))
    expect(error.mock.calls.map((call) => call[1])).toEqual(['pane gone', 'tmux down'])
  })
})
