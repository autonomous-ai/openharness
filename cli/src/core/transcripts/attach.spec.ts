import { liveFor } from '../../engines/live.js'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TailHold } from '../../watcher/watcher.js'
import { createAttach, type AttachDeps } from './attach.js'
import { loadEngine } from '../../engines/inProcess.js'
import { createSessionNormalizers } from './normalizers.js'
import { createRelaunchMarks, type RelaunchMark } from './relaunch.js'
import type { PreparedLive } from '../engines/liveSessions.js'
import type { LiveFrame } from '../../engines/worker/liveProtocol.js'

/**
 * The engines' own normalizers and readers are tested with each engine. Here each is a fake that
 * reads JSON lines: `{"events":[…]}` is what a line yields, `{"open":true}` / `{"close":true}` move
 * its turn. Transcript reading, folding and the attach tracker are the real ones.
 */
const fakes = vi.hoisted(() => {
  const made: Array<{ kind: string; args: unknown[]; instance: Record<string, any> }> = []
  const normalizer = (kind: string) => class {
    turnOpen = false
    turnRevision = 0
    thinkingPrefix = ''
    args: unknown[]
    constructor(...args: unknown[]) { this.args = args; made.push({ kind, args, instance: this as Record<string, any> }) }
    ingest(line: string) {
      this.turnRevision++
      const record = JSON.parse(line || '{}') as { events?: unknown[]; open?: boolean; close?: boolean }
      if (record.open) this.turnOpen = true
      if (record.close) this.turnOpen = false
      return record.events ?? []
    }
    closeTurn() { this.turnRevision++; this.turnOpen = false; return [] }
  }
  const reader = (kind: string) => class {
    turnOpen = false
    opts: Record<string, any>
    start = async () => {}
    constructor(opts: Record<string, any>) { this.opts = opts; made.push({ kind, args: [opts], instance: this as Record<string, any> }) }
  }
  return { made, normalizer, reader, copilotOpen: { value: true } }
})
vi.mock('../../engines/codex/normalizer.js', async (real) => ({ ...await real<object>(), CodexNormalizer: fakes.normalizer('codex') }))
vi.mock('../../engines/cursor/normalizer.js', async (real) => ({ ...await real<object>(), CursorNormalizer: fakes.normalizer('cursor') }))
vi.mock('../../engines/muse/normalizer.js', async (real) => ({ ...await real<object>(), MuseNormalizer: fakes.normalizer('muse') }))
vi.mock('../../engines/amp/normalizer.js', async (real) => ({ ...await real<object>(), AmpNormalizer: fakes.normalizer('amp') }))
vi.mock('../../engines/grok/normalizer.js', async (real) => ({ ...await real<object>(), GrokNormalizer: fakes.normalizer('grok') }))
vi.mock('../../engines/agy/normalizer.js', async (real) => ({ ...await real<object>(), AgyNormalizer: fakes.normalizer('agy') }))
vi.mock('../../engines/pi/normalizer.js', async (real) => ({ ...await real<object>(), PiNormalizer: fakes.normalizer('pi') }))
vi.mock('../../engines/commandcode/normalizer.js', async (real) => ({ ...await real<object>(), CommandCodeNormalizer: fakes.normalizer('commandcode') }))
vi.mock('../../engines/copilot/normalizer.js', async (real) => ({
  ...await real<object>(),
  CopilotNormalizer: fakes.normalizer('copilot'),
  copilotHistoryTurnOpen: () => fakes.copilotOpen.value,
}))
vi.mock('../../engines/opencode/reader.js', async (real) => ({ ...await real<object>(), OpencodeReader: fakes.reader('opencode') }))
vi.mock('../../engines/kilo/reader.js', async (real) => ({ ...await real<object>(), KiloReader: fakes.reader('kilo') }))
vi.mock('../../engines/hermes/reader.js', async (real) => ({ ...await real<object>(), HermesReader: fakes.reader('hermes') }))
vi.mock('../../engines/devin/reader.js', async (real) => ({ ...await real<object>(), DevinReader: fakes.reader('devin') }))

const dirs: string[] = []
const bindings = new Map<string, RegisteredSession>()
const transcript = (lines: unknown[] = []): string => {
  const dir = mkdtempSync(join(tmpdir(), 'core-attach-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + (lines.length ? '\n' : ''))
  return file
}
const session = (engine: string, transcriptPath?: string, over: Partial<RegisteredSession> = {}): RegisteredSession => {
  const value = { agentId: `${engine}-agent`, sessionId: `${engine}-s`, engine, transcriptPath, ...over } as RegisteredSession
  bindings.set(value.agentId, value)
  return value
}

// Each engine's code is loaded in this process before an attach folds; a test may say it could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})

const IDLE_AGY = 'done\n\n  ? for shortcuts'
const started = (userMessage = 'go') => ({ type: 'turn_started' as const, payload: { userMessage } })
const CLAUDE_PROMPT = { type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1' }

function setup(over: Partial<AttachDeps> = {}) {
  const normalizers = createSessionNormalizers()
  const service = { needsTranscript: vi.fn(() => false), observeTranscript: vi.fn() }
  const profile = { ingest: vi.fn(), commit: vi.fn() }
  const deps: AttachDeps = {
    liveFor,
    resolve: id => bindings.get(id),
    terminalGone: vi.fn(async () => false),
    normalizers,
    watcher: { addSession: vi.fn(async () => {}), hold: vi.fn(async () => null), tails: vi.fn(() => false) },
    cursorDiscovery: { add: vi.fn(async () => {}) },
    device: () => service,
    runtimeProfiles: {
      transcriptFields: vi.fn(() => []),
      beginHydrate: vi.fn(() => profile),
      hydrate: vi.fn(),
      ingestConfig: vi.fn(async () => false),
      ingestPane: vi.fn(() => false),
      capturePane: vi.fn(async (session, capture, lines, silent) => {
        const text = await capture(session.agentId, lines)
        if (text) await deps.runtimeProfiles.ingestPane(session, text, silent)
        return text
      }),
    } as AttachDeps['runtimeProfiles'],
    captureTerminal: vi.fn(async () => 'pane'),
    emit: vi.fn(),
    announceTurnAborted: vi.fn(),
    questionWatcher: { start: vi.fn() },
    terminalLabel: () => 'tmux:%0',
    dbs: { opencode: '/db/opencode.db', kilo: '/db/kilo.db', devin: '/db/devin.db' },
    devinHome: '/devin',
    hermesDb: async (s) => `/db/hermes-${s.agentId}.db`,
    concurrency: 2,
    ...over,
  }
  return { deps, normalizers, service, profile, attach: createAttach(deps) }
}

const made = (kind: string) => fakes.made.filter((entry) => entry.kind === kind).map((entry) => entry.instance)

function remoteSetup(open = false, over: Partial<AttachDeps> = {}) {
  const turn = { identity: 'worker:turn', turnOpen: open, continued: false }
  const handle = { engine: 'claude', turnOpen: open, snapshot: () => ({ ...turn }), closeTurn: vi.fn() }
  const candidate = { state: { handle }, page: { cursor: { offset: 20 }, lastStarted: open ? started() : null },
    records: 1, content: true } as unknown as PreparedLive
  const frames: LiveFrame[] = [
    { raw: 'metadata', profile: true, observe: false, events: [], replay: false, turn },
    { raw: 'record', profile: false, observe: true, events: [], replay: false, turn },
  ]
  const remote: NonNullable<AttachDeps['remoteLive']> = {
    handles: engine => engine === 'claude', current: vi.fn(() => true),
    prepare: vi.fn(async (_session, _options, observe, observePage) => { await observePage?.(frames); frames.forEach(observe); return candidate }),
    install: vi.fn(() => true), discard: vi.fn(), retry: vi.fn(),
  }
  const p = setup({ remoteLive: remote, liveFor: vi.fn(() => { throw new Error('isolated parser must stay in its worker') }), ...over })
  return { ...p, remote, candidate, handle }
}

describe('the order of an attach of another engine\'s session', () => {
  it('loads the engine\'s code, then folds, then starts the tail: no line can come before its normalizer', async () => {
    let loaded!: () => void
    const real = await loadEngine('muse')
    vi.mocked(loadEngine).mockImplementationOnce(() => new Promise((settle) => { loaded = () => settle(real as never) }) as never)
    const run = setup()
    const path = transcript([{ any: 'line' }])
    const attaching = run.attach.attachSession(session('muse', path))
    await new Promise((settle) => setTimeout(settle, 20))
    expect(run.deps.watcher.addSession).not.toHaveBeenCalled()
    expect(run.normalizers.hasState('muse-s')).toBe(false)
    loaded()
    expect(await attaching).toBe(true)
    expect(run.normalizers.museNormalizers.has('muse-s')).toBe(true)
    expect(run.deps.watcher.addSession).toHaveBeenCalledTimes(1)
    // Claude Code and Codex never ask for it.
    vi.mocked(loadEngine).mockClear()
    await setup().attach.attachSession(session('codex', transcript([])))
    expect(loadEngine).not.toHaveBeenCalled()
  })
})

describe('attaching a session whose engine\'s code could not be loaded', () => {
  it('follows it with no normalizer or reader, says so, and folds nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(loadEngine).mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never)
    const file = setup()
    const path = transcript([{ any: 'line' }])
    expect(await file.attach.attachSession(session('grok', path))).toBe(true)
    expect(file.normalizers.hasState('grok-s')).toBe(false)
    expect(file.deps.watcher.addSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'grok-s', transcriptPath: path }), {})
    expect(file.deps.emit).not.toHaveBeenCalled()
    const store = setup()
    expect(await store.attach.attachSession(session('opencode'))).toBe(true)
    expect(store.normalizers.hasState('opencode-s')).toBe(false)
    expect(warn).toHaveBeenCalledWith('[agent] grok-age attached without its engine\'s code · engine=grok · its transcript is not read')
    expect(warn).toHaveBeenCalledWith('[agent] opencode attached without its engine\'s code · engine=opencode · its transcript is not read')
    warn.mockRestore()
  })
})

describe('attaching a session', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    fakes.made.length = 0
    fakes.copilotOpen.value = true
    bindings.clear()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('installs worker state after hydration, keeps device/profile observations and reuses only a current binding', async () => {
    const p = remoteSetup(true), s = session('claude', '/private/transcript')
    p.service.needsTranscript.mockReturnValue(true)
    expect(await p.attach.attachSession(s)).toBe(true)
    expect(p.deps.liveFor).not.toHaveBeenCalled()
    expect(p.remote.prepare).toHaveBeenCalledWith(s, { live: false, end: undefined }, expect.any(Function), undefined)
    expect(p.profile.ingest).toHaveBeenCalledExactlyOnceWith('metadata')
    expect(p.service.observeTranscript).toHaveBeenCalledExactlyOnceWith(s.agentId, s.sessionId, s.engine, 'record')
    expect(p.profile.commit).toHaveBeenCalledOnce()
    expect(p.normalizers.liveParsers.get(s.sessionId)).toBe(p.handle)
    expect(p.remote.install).toHaveBeenCalledWith(p.candidate)
    await p.attach.attachSession(s)
    expect(p.remote.prepare).toHaveBeenCalledOnce()
    vi.mocked(p.remote.current).mockReturnValue(false)
    await p.attach.attachSession(s)
    expect(p.remote.prepare).toHaveBeenCalledTimes(2)
  })

  it('activates a first live worker stream without reading locally, including a session whose path is not announced yet', async () => {
    const p = remoteSetup(), s = session('claude')
    expect(await p.attach.attachSession(s, false, false, true)).toBe(true)
    expect(p.remote.prepare).toHaveBeenCalledWith(s, { live: true, end: undefined }, expect.any(Function), undefined)
    expect(p.deps.watcher.hold).not.toHaveBeenCalled()
    expect(p.normalizers.liveParsers.get(s.sessionId)).toBe(p.handle)
  })

  it.each(['begin', 'prepare', 'config', 'commit', 'install'])('keeps the crash-resume boundary after a failed %s until an attach commits', async phase => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const marks = createRelaunchMarks()
    const p = remoteSetup(true, { relaunchMarks: marks }), s = session('claude', '/fixture/transcript')
    marks.note(s.sessionId, 20, true)
    const unavailable = () => { throw new Error('ENGINE_STALE_REPLY') }
    if (phase === 'begin') vi.mocked(p.deps.runtimeProfiles.beginHydrate).mockImplementationOnce(unavailable)
    if (phase === 'prepare') vi.mocked(p.remote.prepare).mockImplementationOnce(unavailable)
    if (phase === 'config') vi.mocked(p.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...p.profile, config: async () => unavailable() })
    if (phase === 'commit') vi.mocked(p.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...p.profile, commitWith: () => false })
    if (phase === 'install') vi.mocked(p.remote.install).mockReturnValueOnce(false)
    await p.attach.attachSession(s).catch(() => {})
    expect(p.deps.emit).not.toHaveBeenCalled()
    expect(p.remote.retry).toHaveBeenCalledWith(s)
    expect(marks.size).toBe(1)
    // Worker availability cannot age a confirmed resume back into an interrupted live turn.
    now = 60 * 60_000
    await p.attach.attachSession(s, true)
    expect(p.remote.prepare).toHaveBeenLastCalledWith(s, { live: false, end: 20 }, expect.any(Function), undefined)
    expect(p.handle.closeTurn).toHaveBeenCalledExactlyOnceWith('abandoned')
    expect(p.deps.emit).not.toHaveBeenCalled()
    expect(marks.size).toBe(0)
  })

  it('closes the interrupted history before the resumed engine can deliver a new live turn', async () => {
    const marks = createRelaunchMarks()
    const p = remoteSetup(true, { relaunchMarks: marks }), s = session('claude', '/fixture/transcript')
    marks.note(s.sessionId, 20, true)
    vi.mocked(p.deps.watcher.addSession).mockImplementationOnce(async () => {
      expect(p.handle.closeTurn).toHaveBeenCalledExactlyOnceWith('abandoned')
      p.deps.emit(s.sessionId, [started('after the crash')])
      p.handle.closeTurn.mockClear()
    })
    await p.attach.attachSession(s)
    expect(p.deps.emit).toHaveBeenCalledExactlyOnceWith(s.sessionId, [started('after the crash')])
    expect(p.handle.closeTurn).not.toHaveBeenCalled()
  })

  it.each([false, true])('uses a held tail from the old engine only when the engine survived: restarted %s', async restarted => {
    const marks = createRelaunchMarks()
    const p = remoteSetup(true, { relaunchMarks: marks }), s = session('claude', '/fixture/transcript')
    const old = { ...p.handle }
    p.normalizers.liveParsers.set(s.sessionId, old)
    const hold: TailHold = { offset: 12, expired: false, release: vi.fn() }
    vi.mocked(p.deps.watcher.hold).mockResolvedValue(hold)
    vi.mocked(p.deps.watcher.tails).mockReturnValue(true)
    marks.note(s.sessionId, 20, restarted)
    await p.attach.attachSession(s)
    expect(p.remote.prepare).toHaveBeenCalledWith(s, { live: false, end: restarted ? 20 : 12 }, expect.any(Function), undefined)
    expect(p.handle.closeTurn).toHaveBeenCalledTimes(restarted ? 1 : 0)
    expect(p.deps.emit).not.toHaveBeenCalled()
    expect(hold.release).toHaveBeenCalled()
    expect(marks.size).toBe(0)
  })

  it.each(['prepare', 'config'])('retries a resumed attach whose tail hold expires during %s', async stage => {
    const marks = createRelaunchMarks()
    const p = remoteSetup(true, { relaunchMarks: marks }), s = session('claude', '/fixture/transcript')
    let expired = stage === 'prepare'
    const hold: TailHold = { offset: 12, get expired() { return expired }, release: vi.fn() }
    vi.mocked(p.deps.watcher.hold).mockResolvedValue(hold)
    if (stage === 'config') vi.mocked(p.deps.runtimeProfiles.ingestConfig).mockImplementationOnce(async () => { expired = true; return false })
    marks.note(s.sessionId, 20, true)
    await p.attach.attachSession(s)
    expect(p.remote.retry).toHaveBeenCalledWith(s)
    expect(p.remote.install).not.toHaveBeenCalled()
    expect(p.deps.emit).not.toHaveBeenCalled()
    expect(marks.read(s.sessionId)).toEqual({ offset: 20, engineStarted: true })
  })

  it.each([false, true])('retains a binding and retries a failed worker prepare, with an existing tail: %s', async held => {
    const p = remoteSetup(), s = session('claude', '/private/transcript')
    const old = { ...p.handle }
    p.normalizers.liveParsers.set(s.sessionId, old)
    const hold: TailHold = { offset: 12, expired: false, release: vi.fn() }
    if (held) vi.mocked(p.deps.watcher.hold).mockResolvedValue(hold)
    vi.mocked(p.remote.prepare).mockRejectedValueOnce(new Error('ENGINE_UNAVAILABLE'))
    expect(await p.attach.attachSession(s, true)).toBe(true)
    expect(p.remote.retry).toHaveBeenCalledWith(s)
    expect(p.normalizers.liveParsers.get(s.sessionId)).toBe(old)
    expect(p.profile.commit).not.toHaveBeenCalled()
    expect(p.remote.install).not.toHaveBeenCalled()
    if (held) expect(hold.release).toHaveBeenCalled()
    expect(await p.attach.attachSession(s, true)).toBe(true)
    expect(p.normalizers.liveParsers.get(s.sessionId)).toBe(p.handle)
  })

  it.each(['prepare', 'config', 'install'])('discards a superseded candidate during %s and keeps the live state', async stage => {
    const p = remoteSetup(), s = session('claude', '/private/transcript')
    const old = { ...p.handle }
    p.normalizers.liveParsers.set(s.sessionId, old)
    let expired = stage === 'prepare'
    const hold: TailHold = { offset: 12, get expired() { return expired }, release: vi.fn() }
    vi.mocked(p.deps.watcher.hold).mockResolvedValue(hold)
    if (stage === 'config') vi.mocked(p.deps.runtimeProfiles.ingestConfig).mockImplementation(async () => { expired = true; return false })
    if (stage === 'install') vi.mocked(p.remote.install).mockReturnValue(false)
    expect(await p.attach.attachSession(s, true)).toBe(true)
    expect(p.remote.discard).toHaveBeenCalledWith(p.candidate)
    expect(p.normalizers.liveParsers.get(s.sessionId)).toBe(old)
    expect(hold.release).toHaveBeenCalled()
  })

  it('uses the worker only for engines it handles', async () => {
    const p = remoteSetup()
    const local = setup({ remoteLive: p.remote })
    expect(await local.attach.attachSession(session('pi', transcript([])))).toBe(true)
    expect(p.remote.prepare).not.toHaveBeenCalled()
  })

  it('commits staged worker profile state with parser installation and never parses its raw records', async () => {
    const p = remoteSetup(), s = session('claude', '/private/transcript')
    const order: string[] = []
    const ingestFrames = vi.fn(async () => { order.push('evidence') })
    const config = vi.fn(async () => { order.push('config') })
    const commitWith = vi.fn((install: () => boolean) => { order.push('commit'); return install() })
    vi.mocked(p.deps.runtimeProfiles.beginHydrate).mockReturnValue({ ...p.profile, ingestFrames, config, commitWith })
    vi.mocked(p.remote.install).mockImplementation(() => { order.push('install'); return true })
    expect(await p.attach.attachSession(s)).toBe(true)
    expect(order).toEqual(['evidence', 'config', 'commit', 'install'])
    expect(ingestFrames).toHaveBeenCalledOnce()
    expect(p.profile.ingest).not.toHaveBeenCalled()
    expect(p.profile.commit).not.toHaveBeenCalled()
    expect(p.deps.runtimeProfiles.ingestConfig).not.toHaveBeenCalled()
    expect(p.normalizers.liveParsers.get(s.sessionId)).toBe(p.handle)
  })

  it.each(['config', 'commit'])('discards and retries a worker profile %s failure without replacing live state', async phase => {
    const p = remoteSetup(), s = session('claude', '/private/transcript'), old = { ...p.handle }
    p.normalizers.liveParsers.set(s.sessionId, old)
    vi.mocked(p.deps.runtimeProfiles.beginHydrate).mockReturnValue({ ...p.profile,
      ingestFrames: async () => {}, config: async () => { if (phase === 'config') throw new Error('worker failed') },
      commitWith: () => false })
    expect(await p.attach.attachSession(s, true)).toBe(true)
    expect(p.remote.install).not.toHaveBeenCalled()
    expect(p.remote.discard).toHaveBeenCalledWith(p.candidate)
    expect(p.remote.retry).toHaveBeenCalledWith(s)
    expect(p.normalizers.liveParsers.get(s.sessionId)).toBe(old)
  })

  it('refuses a session whose pane is gone', async () => {
    const { attach, deps } = setup({ terminalGone: vi.fn(async () => true) })
    expect(await attach.attachSession(session('pi', transcript()))).toBe(false)
    expect(deps.watcher.addSession).not.toHaveBeenCalled()
  })

  describe('a session it already follows', () => {
    it('only makes sure the tail runs — from the start for one that never folded anything', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const s = session('pi', '/t/pi.jsonl')
      run.normalizers.piNormalizers.set(s.sessionId, {} as never)
      expect(await run.attach.attachSession(s)).toBe(true)
      run.attach.neverFoldedHistory.add(s.sessionId)
      await run.attach.attachSession(s)
      await run.attach.attachSession(s, false, false, true)
      expect(vi.mocked(run.deps.watcher.addSession).mock.calls.map((call) => call[1])).toEqual([
        { fromStart: false }, { fromStart: true }, { fromStart: true },
      ])
      expect(run.attach.neverFoldedHistory.has(s.sessionId)).toBe(false)
    })

    it('replays Cursor from the start when asked, and asks discovery when Cursor has no transcript yet', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const withFile = session('cursor', '/t/cursor.jsonl')
      run.normalizers.cursorNormalizers.set(withFile.sessionId, {} as never)
      await run.attach.attachSession(withFile, false, true)
      expect(vi.mocked(run.deps.watcher.addSession).mock.calls[0][1]).toEqual({ fromStart: true })
      const noFile = session('cursor', undefined, { sessionId: 'cursor-2' })
      run.normalizers.cursorNormalizers.set('cursor-2', {} as never)
      await run.attach.attachSession(noFile)
      expect(run.deps.cursorDiscovery.add).toHaveBeenCalledWith('cursor-2')
      const opencode = session('opencode')
      run.normalizers.opencodeReaders.set(opencode.sessionId, {} as never)
      expect(await run.attach.attachSession(opencode)).toBe(true)
    })
  })

  describe('a first attach', () => {
    it('keeps an unknown engine registered without inventing a Claude parser for its file', async () => {
      const run = setup()
      const s = session('future-engine', transcript([CLAUDE_PROMPT]))
      expect(await run.attach.attachSession(s)).toBe(true)
      expect(run.normalizers.hasState(s.sessionId)).toBe(false)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.deps.watcher.addSession).toHaveBeenCalledWith(s, {})
    })

    it('reads Claude Code from the end, hands the tail the byte it stopped at, and replays a turn left open', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const s = session('claude', transcript([CLAUDE_PROMPT]))
      expect(await run.attach.attachSession(s)).toBe(true)
      const [, from] = vi.mocked(run.deps.watcher.addSession).mock.calls[0]
      expect(from).toEqual({ fromOffset: expect.any(Number) })
      expect(run.normalizers.liveParsers.get(s.sessionId)?.turnOpen).toBe(true)
      expect(run.profile.commit).toHaveBeenCalled()
      expect(run.deps.emit).toHaveBeenCalledWith(s.sessionId, [expect.objectContaining({ type: 'turn_started' })], { resumed: true })
      expect(run.attach.replayedFirstTurn.has(s.sessionId)).toBe(true)
      expect(run.deps.questionWatcher.start).toHaveBeenCalledWith(s.sessionId)
      expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('read the transcript from its end'))).toBe(true)
    })

    it('reads Codex from the end through its own normalizer, and lets each window name its thinking ids', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const s = session('codex', transcript([{ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }]))
      await run.attach.attachSession(s)
      const [codex] = made('codex')
      expect(run.normalizers.liveParsers.get(s.sessionId)?.turnOpen).toBe(codex.turnOpen)
      codex.turnOpen = true
      expect(run.normalizers.liveParsers.get(s.sessionId)?.snapshot().turnOpen).toBe(true)
      expect(codex.thinkingPrefix).toMatch(/^thinking-codex-/)
    })

    it('attaches a Codex session before its rollout exists, ready for its first line', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      expect(await run.attach.attachSession(session('codex'))).toBe(true)
      expect(run.normalizers.liveParsers.get('codex-s')?.turnOpen).toBe(made('codex')[0].turnOpen)
      expect(run.attach.neverFoldedHistory.has('codex-s')).toBe(true)
    })

    it('shows the device the raw lines it subscribed to, on either path', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      run.service.needsTranscript.mockReturnValue(true)
      await run.attach.attachSession(session('claude', transcript([CLAUDE_PROMPT])))
      await run.attach.attachSession(session('pi', transcript([{ events: [] }])))
      expect(run.service.observeTranscript).toHaveBeenCalledWith('claude-agent', 'claude-s', 'claude', expect.any(String))
      expect(run.service.observeTranscript).toHaveBeenCalledWith('pi-agent', 'pi-s', 'pi', '{"events":[]}')
      const none = setup({ device: () => undefined })
      expect(await none.attach.attachSession(session('pi', transcript([{}])))).toBe(true)
    })

    it('attaches a session whose device or runtime profile cannot take in its lines, on either path', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      // Asking the device whether it watches the session throws: the attach goes on without it.
      const asking = setup()
      asking.service.needsTranscript.mockImplementation(() => { throw new Error('device state unreadable') })
      expect(await asking.attach.attachSession(session('pi', transcript([{ events: [] }])))).toBe(true)
      expect(asking.normalizers.piNormalizers.has('pi-s')).toBe(true)
      expect(asking.service.observeTranscript).not.toHaveBeenCalled()
      // The device watches, but cannot take a line in; the profile cannot be hydrated either.
      const run = setup()
      run.service.needsTranscript.mockReturnValue(true)
      run.service.observeTranscript.mockImplementation(() => { throw new Error('evidence unreadable') })
      vi.mocked(run.deps.runtimeProfiles.hydrate).mockImplementation(() => { throw 'profile unreadable' })
      expect(await run.attach.attachSession(session('pi', transcript([{ events: [] }, { events: [] }])))).toBe(true)
      expect(await run.attach.attachSession(session('claude', transcript([CLAUDE_PROMPT])))).toBe(true)
      expect(run.normalizers.piNormalizers.has('pi-s')).toBe(true)
      expect(run.service.observeTranscript).toHaveBeenCalledWith('claude-agent', 'claude-s', 'claude', expect.any(String))
      expect(run.profile.commit).toHaveBeenCalled()
      expect(error.mock.calls).toEqual([
        ['[transcripts] the device could not take in a line of pi-s; the line goes on to its engine: device state unreadable'],
        ['[transcripts] the device could not take in a line of pi-s; the line goes on to its engine: evidence unreadable'],
        ['[transcripts] the runtime profile could not take in a line of pi-s; the line goes on to its engine: profile unreadable'],
        ['[transcripts] the device could not take in a line of claude-s; the line goes on to its engine: evidence unreadable'],
      ])
    })

    it('folds a resumed conversation only up to where its relaunched engine began, and tails the rest live', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const read = vi.fn((_sessionId: string): RelaunchMark | undefined => undefined)
      const run = setup({ relaunchMarks: { read, complete: vi.fn() } })
      const history = JSON.stringify({ ...CLAUDE_PROMPT, uuid: 'before' })
      // The relaunched engine answered a message before this attach: a whole turn after the mark.
      const s = session('claude', transcript([history, { ...CLAUDE_PROMPT, uuid: 'after' }, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }, uuid: 'a1' }]))
      const mark = Buffer.byteLength(history) + 1
      read.mockReturnValueOnce({ offset: mark, engineStarted: true })
      expect(await run.attach.attachSession(s)).toBe(true)
      expect(read).toHaveBeenCalledWith(s.sessionId)
      // The tail starts where the engine's own writing began, so its turn reaches every window live.
      expect(vi.mocked(run.deps.watcher.addSession).mock.calls[0][1]).toEqual({ fromOffset: mark })
      // A mark is for the next attach only: taken even by an attach that only makes sure the tail runs.
      read.mockReturnValueOnce({ offset: mark, engineStarted: true })
      expect(await run.attach.attachSession(s)).toBe(true)
      expect(read).toHaveBeenCalledTimes(2)
    })

    it('takes over a tail it holds for a reset, resuming it where the read stopped', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const s = session('claude', transcript([CLAUDE_PROMPT]))
      const hold: TailHold = { offset: 1_000_000, expired: false, release: vi.fn() }
      vi.mocked(run.deps.watcher.hold).mockResolvedValue(hold)
      vi.mocked(run.deps.watcher.tails).mockReturnValue(true)
      expect(await run.attach.attachSession(s, true)).toBe(true)
      expect(run.deps.watcher.addSession).not.toHaveBeenCalled()
      expect(hold.release).toHaveBeenCalledWith(expect.any(Number))
      // A hold whose tail is gone by then: the tail is started from the read's end instead.
      vi.mocked(run.deps.watcher.tails).mockReturnValue(false)
      await run.attach.attachSession(s, true)
      expect(run.deps.watcher.addSession).toHaveBeenCalledTimes(1)
      // The prompt left a turn open, but the held tail had delivered its start already: never again.
      expect(run.deps.emit).not.toHaveBeenCalledWith(s.sessionId, [expect.objectContaining({ type: 'turn_started' })], { resumed: true })
    })

    it('keeps the live normalizer when the re-read fails or outlasts its hold', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const expired: TailHold = { offset: 10, expired: true, release: vi.fn() }
      vi.mocked(run.deps.watcher.hold).mockResolvedValueOnce(expired)
      expect(await run.attach.attachSession(session('claude', transcript([CLAUDE_PROMPT])), true)).toBe(true)
      expect(expired.release).toHaveBeenCalledWith()
      // The file is gone under the read: it cannot be read through.
      const missing: TailHold = { offset: 10, expired: false, release: vi.fn() }
      vi.mocked(run.deps.watcher.hold).mockResolvedValueOnce(missing)
      await run.attach.attachSession(session('claude', '/nowhere/session.jsonl', { sessionId: 'gone' }), true)
      // Expiring after the read, while the profile's config is read.
      const late = { offset: 1_000_000, expired: false, release: vi.fn() }
      vi.mocked(run.deps.watcher.hold).mockResolvedValueOnce(late as TailHold)
      vi.mocked(run.deps.runtimeProfiles.ingestConfig).mockImplementationOnce(async () => { late.expired = true; return true })
      await run.attach.attachSession(session('claude', transcript([CLAUDE_PROMPT]), { sessionId: 'late' }), true)
      expect(warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('kept its live normalizer'))).toEqual([
        expect.stringContaining('the re-read outlasted its hold on the tail'),
        expect.stringContaining('the re-read could not read the transcript'),
        expect.stringContaining('the re-read outlasted its hold on the tail'),
      ])
      expect(run.normalizers.liveParsers.has('late')).toBe(false)
    })

    it('replays a first turn already on disk when the transcript was born after its agent', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const s = session('pi', transcript([{ events: [started('first')] }, { events: [{ type: 'text_delta', payload: { content: 'hi' } }] }]))
      await run.attach.attachSession(s, false, false, true)
      expect(run.deps.emit).toHaveBeenCalledWith(s.sessionId, [expect.objectContaining({ type: 'turn_started' }), expect.objectContaining({ type: 'text_delta' })])
      expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('replayed the first turn'))).toBe(true)
      // Once replayed, never again.
      run.normalizers.piNormalizers.delete(s.sessionId)
      vi.mocked(run.deps.emit).mockClear()
      await run.attach.attachSession(s, true, false, true)
      expect(run.deps.emit).not.toHaveBeenCalled()
    })

    it('never replays a conversation its engine was relaunched on, however new its transcript', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      // A restore after a restart: the transcript is minutes old and was born after its agent, which is
      // what the first-turn rule asks, but its engine was relaunched on it, so it is history.
      const lines = [CLAUDE_PROMPT, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }, uuid: 'a1' }]
      const s = session('claude', transcript(lines))
      const read = vi.fn((_sessionId: string): RelaunchMark | undefined => ({ offset: statSync(s.transcriptPath!).size, engineStarted: true }))
      const run = setup({ relaunchMarks: { read, complete: vi.fn() } })
      await run.attach.attachSession(s, false, false, true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('replayed the first turn'))).toBe(false)
      // Cursor's own replay from the start is held to the same rule.
      const cursor = session('cursor', undefined, { sessionId: 'cursor-relaunched' })
      await run.attach.attachSession(cursor, false, true)
      expect(run.deps.emit).not.toHaveBeenCalled()
    })

    it('announces a turn open at attach while its engine may still be running, never one a new engine left behind', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      // The engine was killed mid-turn (the tmux server died): the prompt is in, its answer never came.
      const s = session('claude', transcript([CLAUDE_PROMPT]))
      const size = statSync(s.transcriptPath!).size
      // A daemon restart marks every conversation, and an engine that kept running is still in that turn.
      const survived = setup({ relaunchMarks: { complete: vi.fn(), read: () => ({ offset: size, engineStarted: false }) } })
      await survived.attach.attachSession(s)
      expect(vi.mocked(survived.deps.emit).mock.calls.some((call) => call[2]?.resumed)).toBe(true)
      // A resume, or a restore that rebuilt the pane, started a new engine: that turn died with the old one.
      const restarted = setup({ relaunchMarks: { complete: vi.fn(), read: () => ({ offset: size, engineStarted: true }) } })
      await restarted.attach.attachSession(s)
      expect(restarted.deps.emit).not.toHaveBeenCalled()
      expect(log.mock.calls.some(([line]) => String(line).includes('left the turn open at attach as history'))).toBe(true)
      // Closed where the next message is read, too: its start must not first end a turn nobody saw start.
      expect(restarted.normalizers.liveParsers.get(s.sessionId)?.turnOpen).toBe(false)
      expect(survived.normalizers.liveParsers.get(s.sessionId)?.turnOpen).toBe(true)
      // Codex's own normalizer, likewise.
      const codex = session('codex', transcript([{ open: true }]))
      const resumed = setup({ relaunchMarks: { complete: vi.fn(), read: () => ({ offset: statSync(codex.transcriptPath!).size, engineStarted: true }) } })
      await resumed.attach.attachSession(codex)
      expect(resumed.normalizers.liveParsers.get(codex.sessionId)?.turnOpen).toBe(false)
    })

    it('replays a Claude Code first turn live when born after its agent, unless a held tail already delivered it', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      await run.attach.attachSession(session('claude', transcript([CLAUDE_PROMPT])), false, false, true)
      expect(vi.mocked(run.deps.emit).mock.calls[0][2]).toBeUndefined()
      const held = setup()
      vi.mocked(held.deps.watcher.hold).mockResolvedValue({ offset: 1_000_000, expired: false, release: vi.fn() })
      await held.attach.attachSession(session('claude', transcript([CLAUDE_PROMPT])), true, false, true)
      expect(vi.mocked(held.deps.emit).mock.calls.every((call) => call[2]?.resumed)).toBe(true)
    })

    it('marks a session with no transcript yet, so its first content is read whole', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      await run.attach.attachSession(session('pi'))
      expect(run.attach.neverFoldedHistory.has('pi-s')).toBe(true)
      await run.attach.attachSession(session('cursor'))
      expect(run.deps.cursorDiscovery.add).toHaveBeenCalledWith('cursor-s')
      expect(run.attach.neverFoldedHistory.has('cursor-s')).toBe(false)
    })

    it('folds each file engine into its own normalizer, reading the pane where the chips live there', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const maps: Record<string, Map<string, unknown>> = {
        cursor: run.normalizers.cursorNormalizers, muse: run.normalizers.museNormalizers, amp: run.normalizers.ampNormalizers,
        grok: run.normalizers.grokNormalizers, agy: run.normalizers.agyNormalizers, copilot: run.normalizers.copilotNormalizers,
        pi: run.normalizers.piNormalizers, commandcode: run.normalizers.commandcodeNormalizers,
      }
      for (const engine of Object.keys(maps)) {
        await run.attach.attachSession(session(engine, transcript([{}])))
        expect(maps[engine].get(`${engine}-s`), engine).toBe(made(engine)[0])
      }
      expect(vi.mocked(run.deps.captureTerminal).mock.calls).toEqual([['cursor-agent', 100], ['grok-agent', 60], ['agy-agent', 60]])
      expect(run.deps.runtimeProfiles.ingestPane).toHaveBeenCalledTimes(3)
      // A pane that cannot be read leaves the chips to the next look.
      vi.mocked(run.deps.captureTerminal).mockResolvedValue(null)
      for (const engine of ['cursor', 'grok', 'agy']) await run.attach.attachSession(session(engine, transcript([{}]), { sessionId: `${engine}-2` }))
      expect(run.deps.runtimeProfiles.ingestPane).toHaveBeenCalledTimes(3)
    })

    it('closes an agy turn its pane shows finished, and a Copilot turn its records show over', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      vi.mocked(run.deps.captureTerminal).mockResolvedValue(IDLE_AGY)
      await run.attach.attachSession(session('agy', transcript([{ events: [started()], open: true }])))
      expect(made('agy')[0].turnOpen).toBe(false)
      fakes.copilotOpen.value = false
      await run.attach.attachSession(session('copilot', transcript([{ events: [started()], open: true }])))
      expect(made('copilot')[0].turnOpen).toBe(false)
      // Still running by the pane, and by the records: left open, and replayed as a resumed turn.
      vi.mocked(run.deps.captureTerminal).mockResolvedValue('working\n  esc to cancel')
      await run.attach.attachSession(session('agy', transcript([{ events: [started()], open: true }]), { sessionId: 'agy-2' }))
      fakes.copilotOpen.value = true
      await run.attach.attachSession(session('copilot', transcript([{ events: [started()], open: true }]), { sessionId: 'copilot-2' }))
      expect(made('agy')[1].turnOpen).toBe(true)
      expect(made('copilot')[1].turnOpen).toBe(true)
      expect(vi.mocked(run.deps.emit).mock.calls.filter((call) => call[2]?.resumed).map((call) => call[0])).toEqual(['agy-2', 'copilot-2'])
    })

    it('closes an idle agy history turn even when newer profile evidence discards the chip update', async () => {
      const run = setup({ settled: vi.fn() })
      vi.mocked(run.deps.captureTerminal).mockResolvedValue(IDLE_AGY)
      vi.mocked(run.deps.runtimeProfiles.capturePane).mockImplementationOnce(async (_session, capture, lines) => {
        await capture('agy-agent', lines)
        return null
      })
      await run.attach.attachSession(session('agy', transcript([{ events: [started()], open: true }])))
      expect(made('agy')[0].turnOpen).toBe(false)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.deps.settled).toHaveBeenCalledExactlyOnceWith('agy-s')
    })

    it.each(['binding', 'forgotten', 'new turn', 'later binding', 'later normalizer', 'later turn'] as const)(
      'does not close or replay agy history after %s supersedes its capture', async change => {
        const run = setup({ settled: vi.fn() }), s = session('agy', transcript([{ events: [started()], open: true }]))
        let finish!: (value: string) => void
        vi.mocked(run.deps.captureTerminal).mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve }))
        const mutate = () => {
          if (change.includes('binding')) bindings.set(s.agentId, { ...s, boundAt: 2 })
          if (change === 'forgotten' || change === 'later normalizer') run.normalizers.agyNormalizers.delete(s.sessionId)
          if (change.includes('turn')) made('agy')[0].ingest(JSON.stringify({ open: true }))
        }
        if (change.startsWith('later')) vi.mocked(run.deps.runtimeProfiles.capturePane).mockImplementationOnce(async (_s, capture) => {
          await capture(s.agentId)
          queueMicrotask(mutate)
          return null
        })
        const pending = run.attach.attachSession(s)
        await vi.waitFor(() => expect(run.deps.captureTerminal).toHaveBeenCalled())
        const normalizer = made('agy')[0], close = vi.spyOn(normalizer, 'closeTurn')
        if (!change.startsWith('later')) mutate()
        finish(change.startsWith('later') ? 'working\n  esc to cancel' : IDLE_AGY)
        await pending
        expect(close).not.toHaveBeenCalled()
        expect(run.deps.emit).not.toHaveBeenCalled()
        expect(run.deps.settled).not.toHaveBeenCalled()
      },
    )

    it.each(['new turn', 'binding', 'forgotten'] as const)(
      'keeps captured agy history fenced through watcher installation: %s', async change => {
        for (const pane of [IDLE_AGY, 'working\n  esc to cancel']) {
          const run = setup({ settled: vi.fn() }), s = session('agy', transcript([{ events: [started()], open: true }]))
          vi.mocked(run.deps.captureTerminal).mockResolvedValue(pane)
          let finish!: () => void
          vi.mocked(run.deps.watcher.addSession).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
          const pending = run.attach.attachSession(s)
          await vi.waitFor(() => expect(run.deps.watcher.addSession).toHaveBeenCalled())
          const normalizer = run.normalizers.agyNormalizers.get(s.sessionId)!
          if (change === 'new turn') normalizer.ingest(JSON.stringify({ open: true }))
          if (change === 'binding') bindings.set(s.agentId, { ...s, boundAt: 2 })
          if (change === 'forgotten') run.normalizers.agyNormalizers.delete(s.sessionId)
          finish()
          await pending
          expect(run.deps.emit, pane).not.toHaveBeenCalled()
          expect(run.deps.settled, pane).not.toHaveBeenCalled()
        }
      },
    )

    it('tells the recaps when the last turn was already over at attach, never for one open or killed', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const settled = vi.fn()
      const run = setup({ settled })
      const ended = (payload = {}) => ({ type: 'turn_ended', payload })
      // It ended while the daemon was stopped: its end is history, and only the recaps can still recap it.
      await run.attach.attachSession(session('pi', transcript([{ events: [started()], open: true }, { events: [ended()], close: true }])))
      await run.attach.attachSession(session('pi', transcript([{ events: [started()], open: true }]), { sessionId: 'open' }))
      await run.attach.attachSession(session('pi', transcript([{ events: [started()], open: true }, { events: [ended({ aborted: true })], close: true }]), { sessionId: 'killed' }))
      await run.attach.attachSession(session('pi', transcript([{}]), { sessionId: 'none' }))
      // Read from the end (Claude Code, Codex), only the last turn's start is history: closed, it ended.
      await run.attach.attachSession(session('pi', transcript([{ events: [started()], open: true }, { close: true }]), { sessionId: 'from-end' }))
      await run.attach.attachSession(session('codex', transcript([{ events: [started()], open: true }, { close: true }])))
      await run.attach.attachSession(session('codex', transcript([{ events: [started()], open: true }]), { sessionId: 'codex-open' }))
      expect(settled.mock.calls).toEqual([['pi-s'], ['from-end'], ['codex-s']])
    })

    it('does not resume a turn left open when its history holds no turn start', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      await run.attach.attachSession(session('pi', transcript([{ open: true }])))
      expect(run.deps.emit).not.toHaveBeenCalled()
    })

    it('polls each database engine through its reader, wired to the funnel', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      for (const engine of ['opencode', 'kilo', 'hermes', 'devin']) await run.attach.attachSession(session(engine))
      const [opencode] = made('opencode')
      const [kilo] = made('kilo')
      const [hermes] = made('hermes')
      const [devin] = made('devin')
      expect(opencode.opts).toMatchObject({ dbPath: '/db/opencode.db', sessionId: 'opencode-s' })
      expect(kilo.opts).toMatchObject({ dbPath: '/db/kilo.db', sessionId: 'kilo-s' })
      expect(hermes.opts).toMatchObject({ dbPath: '/db/hermes-hermes-agent.db', sessionId: 'hermes-s' })
      expect(devin.opts).toMatchObject({ dbPath: '/db/devin.db', devinHome: '/devin', sessionId: 'devin-s' })
      expect(run.normalizers.opencodeReaders.get('opencode-s')).toBe(opencode)
      expect(run.normalizers.kiloReaders.get('kilo-s')).toBe(kilo)
      expect(run.normalizers.hermesReaders.get('hermes-s')).toBe(hermes)
      expect(run.normalizers.devinReaders.get('devin-s')).toBe(devin)
      for (const reader of [opencode, kilo, hermes, devin]) {
        reader.opts.onEvents([started()])
        reader.opts.onFatal(new Error('store missing'))
      }
      expect(vi.mocked(run.deps.emit).mock.calls.map((call) => call[0])).toEqual(['opencode-s', 'kilo-s', 'hermes-s', 'devin-s'])
      expect(warn).toHaveBeenCalledTimes(4)
      devin.opts.onTurnAborted('provider error')
      expect(run.deps.announceTurnAborted).toHaveBeenCalledWith('devin-s', 'devin', 'provider error')
      expect(run.deps.emit).toHaveBeenLastCalledWith('devin-s', [{ type: 'turn_ended', payload: {} }])
      // OpenCode and Devin name their model only in the pane.
      expect(vi.mocked(run.deps.captureTerminal).mock.calls).toEqual([['opencode-agent', 100], ['devin-agent', 60]])
      vi.mocked(run.deps.captureTerminal).mockResolvedValue(null)
      await run.attach.attachSession(session('opencode', undefined, { sessionId: 'opencode-2' }))
      await run.attach.attachSession(session('devin', undefined, { sessionId: 'devin-2' }))
      expect(run.deps.runtimeProfiles.ingestPane).toHaveBeenCalledTimes(2)
    })

    it('folds any other engine with a plain turn state', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      await run.attach.attachSession(session('terminal', transcript(['{}'])))
      expect(run.normalizers.liveParsers.has('terminal-s')).toBe(true)
      expect(run.deps.questionWatcher.start).not.toHaveBeenCalled()
    })

    it('folds only the newest part of a transcript over the cap, and says so', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const records = Array.from({ length: 20 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(40) }))
      const capBytes = records.slice(-5).reduce((sum, record) => sum + Buffer.byteLength(record), 0)
      const run = setup({ wholeReadCapBytes: capBytes })
      await run.attach.attachSession(session('terminal', transcript(records)))
      expect(warn).toHaveBeenCalledWith('[agent] terminal transcript over 0 MB · folded from its newest 0 MB')
      // The profile was hydrated from what was read: the newest records that fit, in order.
      expect(run.deps.runtimeProfiles.hydrate).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'terminal-agent' }), records.slice(-5))
      warn.mockClear()
      await run.attach.attachSession(session('terminal', transcript(records.slice(0, 3)), { agentId: 'small', sessionId: 'small-s' }))
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('says when an attach is slow', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = setup({ terminalGone: () => new Promise<boolean>(() => {}) })
    void run.attach.attachSession(session('pi', '/t/pi.jsonl'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(String(warn.mock.calls[0][0])).toMatch(/attach still running · engine=pi · session=.* · 15s/)
    expect(run.attach.attaches.attaching()).toHaveLength(1)
  })
})
