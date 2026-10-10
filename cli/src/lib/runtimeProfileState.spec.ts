import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { runtime as claudeRuntime } from '../engines/claude/runtimeProfile.js'
import type { RegisteredSession } from './registry.js'
import { RuntimeProfileState } from './runtimeProfileState.js'
import { RuntimeProfileManager } from './runtimeProfile.js'
import { parseRuntimeProfile } from './runtimeProfileWire.js'
import { engineNow, loadEngine, OTHER_ENGINES } from '../engines/inProcess.js'
import type { InlineRuntimeContext } from '../engines/facets/inlineRuntime.js'
import { createTerminalControl } from '../core/terminals/control.js'

// A test may say an engine's code could not be loaded.
vi.mock('../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../engines/inProcess.js')>()
  return { ...actual, engineNow: vi.fn(actual.engineNow), loadEngine: vi.fn(actual.loadEngine) }
})

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8')
const session = (engine: RegisteredSession['engine']): RegisteredSession => ({
  agentId: 'agent', sessionId: 'conversation', engine, model: 'registered-model', cliVersion: '1.0.0',
  cwd: '/tmp', transcriptPath: '/tmp/profile-recording.jsonl',
} as RegisteredSession)
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.mocked(engineNow).mockReset(); vi.mocked(loadEngine).mockReset() })
// The other engines' profile readers load as one of their sessions enters the registry (engines/inProcess.ts
// `preloadEngine`): before any pane of theirs is read, as here.
beforeAll(async () => { for (const engine of OTHER_ENGINES) await loadEngine(engine) })

describe('another engine whose code could not be loaded', () => {
  it('contains a missing or throwing reader factory while core confirmation and cleanup still work', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const createRuntimeProfileReader of [undefined, () => { throw new Error('broken facet') }]) {
      vi.mocked(engineNow).mockReturnValue({ createRuntimeProfileReader } as never)
      vi.mocked(loadEngine).mockResolvedValue({ createRuntimeProfileReader } as never)
      const manager = new RuntimeProfileState(() => undefined), agent = session('cursor')
      manager.hydrate(agent, [])
      expect(manager.ingestPane(agent, 'Auto · 10%', true)).toBe(false)
      expect(manager.ingestPane(agent, 'Auto · 10%', true)).toBe(false)
      expect(await manager.ingestConfig(agent)).toBe(false)
      manager.confirmEffort(agent.sessionId, 'high')
      expect(manager.getState(agent.sessionId).effort).toBe('high')
      manager.forget(agent.sessionId)
      expect(manager.getState(agent.sessionId).model).toBeNull()
    }
    expect(console.warn).toHaveBeenCalledTimes(2)
    vi.mocked(engineNow).mockReset()
    vi.mocked(loadEngine).mockReset()
  })

  it('reads nothing of its panes, config files or catalog, and leaves its chips as they were', async () => {
    const manager = new RuntimeProfileState(() => undefined)
    vi.mocked(engineNow).mockReturnValue(null)
    vi.mocked(loadEngine).mockResolvedValue(null as never)
    try {
      for (const engine of ['cursor', 'devin', 'hermes', 'commandcode', 'opencode', 'kilo', 'pi', 'grok', 'agy'] as const) {
        const agent = { ...session(engine), sessionId: `${engine}-s` }
        expect(manager.ingestPane(agent, 'any pane', true), engine).toBe(false)
        expect(manager.getState(agent.sessionId), engine).toMatchObject({ model: null, effort: null })
      }
      for (const engine of ['hermes', 'muse', 'amp'] as const) {
        expect(await manager.ingestConfig({ ...session(engine), sessionId: `${engine}-c` }, true), engine).toBe(false)
      }
      expect(await manager.opencodeCatalog()).toEqual([])
      expect(await manager.kiloCatalog()).toEqual([])
    } finally {
      vi.mocked(engineNow).mockReset()
      vi.mocked(loadEngine).mockReset()
    }
  })
})

describe('late optional profile observations', () => {
  it.each(['binding', 'process', 'route', 'confirmation', 'forget', 'unchanged'] as const)(
    'fences a pane through the promise handoff to its profile consumer: %s', async change => {
      const agent = { ...session('claude'), active: true, boundAt: 1, runtimes: [{ backend: 'tmux' as const, paneId: '%1' }],
        processIdentity: { pid: 7, startMarker: 'before', executable: 'claude' } }
      const manager = new RuntimeProfileState(() => ({ ...claudeRuntime, pane: ({ state }, text) => { state.model = text } }), () => agent)
      manager.hydrate(agent, [])
      let finish!: (value: { state: 'succeeded'; value: string }) => void
      const backend = { capture: vi.fn(() => new Promise<{ state: 'succeeded'; value: string }>(resolve => { finish = resolve })) }
      const terminal = createTerminalControl({ resolve: () => agent, terminals: backend as never })
      const pending = manager.capturePane(agent, terminal.captureTerminal, 60, true)
      finish({ state: 'succeeded', value: 'captured-model' })
      // Runs after captureTerminal's own guard, but before its awaiting profile consumer resumes.
      queueMicrotask(() => {
        if (change === 'binding') { agent.sessionId = 'new-conversation'; agent.boundAt++ }
        if (change === 'process') agent.processIdentity.startMarker = 'after'
        if (change === 'route') agent.runtimes[0]!.paneId = '%2'
        if (change === 'confirmation') manager.confirmEffort(agent.sessionId, 'high')
        if (change === 'forget') manager.forget(agent.sessionId)
      })
      expect(await pending).toBe(change === 'unchanged' ? 'captured-model' : null)
      expect(manager.getState(agent.sessionId).model === 'captured-model').toBe(change === 'unchanged')
      manager.forget('conversation'); manager.forget(agent.sessionId)
    },
  )

  it('does not capture for an unbound or detached profile, or ingest an empty pane', async () => {
    const agent = session('claude'), capture = vi.fn(async () => null)
    const manager = new RuntimeProfileState(() => claudeRuntime, () => agent)
    expect(await manager.capturePane({ ...agent, sessionId: '' }, capture)).toBeNull()
    expect(await manager.capturePane({ ...agent, boundAt: 2 }, capture)).toBeNull()
    expect(capture).not.toHaveBeenCalled()
    expect(await manager.capturePane(agent, capture)).toBeNull()
    expect(capture).toHaveBeenCalledOnce()
    manager.forget(agent.sessionId)
  })

  it.each(['explicit read', 'confirmation'] as const)('does not let a queued refresh supersede a newer %s', async newer => {
    const config = vi.fn(async ({ state }: InlineRuntimeContext) => { state.effort = 'low'; return true })
    const module = { createRuntimeProfileReader: () => ({ engine: 'commandcode', target: () => null, config,
      pane: ({ state, refreshConfig }: InlineRuntimeContext) => { state.model = 'model'; refreshConfig() },
    }) }
    vi.mocked(engineNow).mockReturnValue(module as never)
    vi.mocked(loadEngine).mockResolvedValue(module as never)
    const manager = new RuntimeProfileState(() => undefined), agent = session('commandcode')
    manager.ingestPane(agent, 'model', true)
    if (newer === 'explicit read') {
      await manager.ingestConfig(agent, true)
      expect(config).toHaveBeenCalledOnce()
      expect(manager.getState(agent.sessionId).effort).toBe('low')
    } else {
      manager.confirmEffort(agent.sessionId, 'high')
      await Promise.resolve()
      expect(config).not.toHaveBeenCalled()
      expect(manager.getState(agent.sessionId).effort).toBe('high')
    }
    manager.forget(agent.sessionId)
  })

  it.each(['cancel', 'finish'] as const)('does not revive a forgotten state when late control cleanup calls %s', async end => {
    const cleanup = vi.fn(() => { throw new Error('optional cleanup failed') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(engineNow).mockReturnValue({ createRuntimeProfileReader: () => ({
      engine: 'cursor', pane: () => false, forget: cleanup,
    }) } as never)
    const manager = new RuntimeProfileState(() => undefined), agent = session('cursor')
    manager.ingestPane(agent, '')
    manager.forget(agent.sessionId)
    if (end === 'cancel') manager.cancelControl(agent.sessionId)
    else manager.finishControl(agent)
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(agent.sessionId)
    expect(console.warn).toHaveBeenCalledOnce()
    manager.forget(agent.sessionId)
  })

  it('keeps newer control flags even when neither a value nor the control object changes', async () => {
    let finish!: (effort: string) => void
    const manager = new RuntimeProfileState(() => ({ ...claudeRuntime,
      transcript: ({ control }, raw) => { if (raw.confirm && control) control.modelConfirmed = true },
      configuredEffort: () => new Promise<string>(resolve => { finish = resolve }),
    })), agent = session('claude')
    manager.hydrate(agent, [])
    manager.confirmEffort(agent.sessionId, 'high')
    manager.beginControl(agent, { id: 'target', sessionId: agent.agentId, engine: agent.engine, model: 'new-model', effort: 'high' })
    const pending = manager.ingestConfig(agent)
    manager.ingest(agent, '{"confirm":true}')
    finish('low')
    await pending
    expect(await manager.waitForProfile(agent.sessionId, 10)).toBe(true)
    expect(manager.getState(agent.sessionId).effort).toBe('high')
    manager.forget(agent.sessionId)
  })

  it.each(['cancel', 'finish'] as const)('invalidates config and hydration across a complete control %s cycle', async end => {
    let finish!: (effort: string) => void
    const manager = new RuntimeProfileState(() => ({ ...claudeRuntime,
      configuredEffort: () => new Promise<string>(resolve => { finish = resolve }),
    })), agent = session('claude')
    manager.hydrate(agent, [])
    manager.confirmEffort(agent.sessionId, 'high')
    const before = manager.getState(agent.sessionId)
    const pending = manager.ingestConfig(agent), stage = manager.beginHydrate(agent)
    stage.ingest(JSON.stringify({ type: 'assistant', message: { model: 'staged-model' } }))
    expect(manager.beginControl(agent, { id: 'target', sessionId: agent.agentId, engine: agent.engine,
      model: 'new-model', effort: 'high' })).toBe(true)
    if (end === 'cancel') manager.cancelControl(agent.sessionId)
    else manager.finishControl(agent)
    finish('low')
    expect(await pending).toBe(false)
    const install = vi.fn(() => true)
    expect(stage.commitWith!(install)).toBe(false)
    expect(install).not.toHaveBeenCalled()
    expect(manager.getState(agent.sessionId)).toEqual(before)
    manager.forget(agent.sessionId)
  })

  it('treats a repeated confirmation as newer authority than a pending config or transcript stage', async () => {
    // One frozen millisecond: the repeated confirmation stamps observedAt again, and a clock that
    // ticked in between failed the comparison below on CI (observedAt 1 ms apart, 2026-10-09).
    vi.useFakeTimers({ toFake: ['Date'] })
    let finish!: (effort: string) => void
    const manager = new RuntimeProfileState(() => ({ ...claudeRuntime,
      configuredEffort: () => new Promise<string>(resolve => { finish = resolve }),
    })), agent = session('claude')
    manager.hydrate(agent, [])
    manager.confirmEffort(agent.sessionId, 'high')
    const pending = manager.ingestConfig(agent)
    manager.confirmEffort(agent.sessionId, 'high')
    finish('low')
    expect(await pending).toBe(false)
    expect(manager.getState(agent.sessionId).effort).toBe('high')
    const stage = manager.beginHydrate(agent)
    const before = manager.getState(agent.sessionId)
    manager.confirmEffort(agent.sessionId, 'high')
    stage.commit()
    expect(manager.getState(agent.sessionId)).toEqual(before)
  })

  it('keeps a same-value pane observation ahead of a pending config answer', async () => {
    let finish!: (effort: string) => void
    const manager = new RuntimeProfileState(() => ({ ...claudeRuntime,
      pane: ({ state }) => { state.effort = 'high' },
      configuredEffort: () => new Promise<string>(resolve => { finish = resolve }),
    })), agent = session('claude')
    manager.hydrate(agent, [])
    manager.confirmEffort(agent.sessionId, 'high')
    const pending = manager.ingestConfig(agent)
    manager.ingestPane(agent, 'same evidence', true)
    finish('low')
    expect(await pending).toBe(false)
    expect(manager.getState(agent.sessionId).effort).toBe('high')
  })

  it('finishes core waiters and every optional cleanup despite a throwing reader', async () => {
    const later = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(engineNow).mockImplementation(engine => ({ createRuntimeProfileReader: () => ({
      engine, target: () => null, forget: engine === 'cursor' ? () => { throw new Error('broken cleanup') } : later,
    }) }) as never)
    const manager = new RuntimeProfileState(() => undefined), agent = session('cursor')
    manager.ingestPane(agent, '', true)
    manager.ingestPane(session('grok'), '', true)
    manager.beginControl(agent, { id: 'target', sessionId: agent.sessionId, engine: agent.engine, model: 'wanted', effort: 'high' })
    const waiting = manager.waitForModel(agent.sessionId, 100)
    expect(() => manager.forget(agent.sessionId)).not.toThrow()
    expect(await waiting).toBe(false)
    expect(later).toHaveBeenCalledWith(agent.sessionId)
    expect(manager.getState(agent.sessionId).model).toBeNull()
  })

  it('cannot commit a staged transcript after forget or newer live evidence', () => {
    for (const forget of [true, false]) {
      const manager = new RuntimeProfileManager(), agent = session('codex')
      const line = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model, reasoning_effort: 'high' } })
      manager.hydrate(agent, [line('first')])
      const stage = manager.beginHydrate(agent)
      stage.ingest(line('old-history'))
      if (forget) manager.forget(agent.sessionId)
      else manager.ingest(agent, line('latest'), true)
      const before = manager.getState(agent.sessionId)
      stage.commit()
      expect(manager.getState(agent.sessionId)).toEqual(before)
    }
  })

  it('keeps the session version and control confirmation private until a stage commits', async () => {
    const manager = new RuntimeProfileState(() => ({ ...claudeRuntime,
      transcript(context) {
        context.session.cliVersion = 'staged-version'
        context.state.model = 'staged-model'
        if (context.control) context.control.modelConfirmed = true
      },
    })), agent = session('claude')
    const target = { id: 'runtime-v1:conversation:claude:staged-model@high', sessionId: agent.sessionId,
      engine: agent.engine, model: 'staged-model', effort: 'high' }
    manager.beginControl(agent, target)
    const stage = manager.beginHydrate(agent)
    stage.ingest('{}')
    expect(agent.cliVersion).toBe('1.0.0')
    vi.useFakeTimers()
    const waiting = manager.waitForModel(agent.sessionId, 15)
    await vi.advanceTimersByTimeAsync(15)
    expect(await waiting).toBe(false)
    stage.commit()
    expect(agent.cliVersion).toBe('staged-version')
    expect(await manager.waitForModel(agent.sessionId, 15)).toBe(true)
    manager.forget(agent.sessionId)
  })

  it('cannot recreate state when its module finishes loading after forget', async () => {
    const manager = new RuntimeProfileState(() => undefined), agent = session('hermes')
    let finish!: (value: Awaited<ReturnType<typeof loadEngine<'hermes'>>>) => void
    const module = await loadEngine('hermes')
    const read = vi.fn(async ({ state }: InlineRuntimeContext) => {
      state.model = 'late-model'; state.effort = 'high'; return true
    })
    vi.mocked(loadEngine).mockReturnValueOnce(new Promise(resolve => { finish = resolve }) as never)
    const pending = manager.ingestConfig(agent)
    manager.forget(agent.sessionId)
    finish({ ...module!, createRuntimeProfileReader: () => ({ engine: 'hermes', target: () => null, config: read }) })
    expect(await pending).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(manager.getState(agent.sessionId)).toMatchObject({ model: null, effort: null })
  })

  it('does not replace a confirmed effort with a config read started earlier', async () => {
    let finish!: (effort: string) => void
    const configuredEffort = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const manager = new RuntimeProfileState(() => ({ ...claudeRuntime, configuredEffort })), agent = session('claude')
    manager.hydrate(agent, [])
    const pending = manager.ingestConfig(agent)
    manager.confirmEffort(agent.sessionId, 'high')
    finish('low')
    expect(await pending).toBe(false)
    expect(manager.getState(agent.sessionId).effort).toBe('high')
  })

  it('does not notify for a read completed after the session was forgotten', async () => {
    vi.useFakeTimers()
    let finish!: (effort: string) => void
    const configuredEffort = () => new Promise<string>(resolve => { finish = resolve })
    const manager = new RuntimeProfileState(() => ({ ...claudeRuntime, configuredEffort })), agent = session('claude')
    manager.hydrate(agent, [])
    manager.confirmEffort(agent.sessionId, 'high')
    const changed = vi.fn(); manager.onChanged = changed
    const pending = manager.ingestConfig(agent)
    manager.forget(agent.sessionId)
    finish('low')
    expect(await pending).toBe(false)
    await vi.advanceTimersByTimeAsync(120)
    expect(changed).not.toHaveBeenCalled()
  })

  it('discards a config answer for a different native home on the same mutable row', async () => {
    const module = await loadEngine('hermes')
    let finish!: () => void
    const config = vi.fn(async ({ state }: InlineRuntimeContext) => {
      await new Promise<void>(resolve => { finish = resolve })
      state.model = 'old-home-model'; state.effort = 'high'; return true
    })
    vi.mocked(loadEngine).mockResolvedValueOnce({ ...module!, createRuntimeProfileReader: () => ({ engine: 'hermes', target: () => null, config }) })
    const manager = new RuntimeProfileState(() => undefined), agent = { ...session('hermes'), hermesHome: '/tmp/first-profile' }
    const pending = manager.ingestConfig(agent)
    await vi.waitFor(() => expect(config).toHaveBeenCalledOnce())
    agent.hermesHome = '/tmp/replacement-profile'
    finish()
    expect(await pending).toBe(false)
    expect(manager.getState(agent.sessionId)).toMatchObject({ model: null, effort: null })
  })
})

describe('runtime profiles without the pilot implementations', () => {
  it.each([
    ['amp', 'amp-session.jsonl'], ['amp', 'amp-session-queued.jsonl'],
    ['muse', 'muse-session.jsonl'], ['copilot', 'copilot-session.jsonl'], ['agy', 'agy-session.jsonl'],
  ] as const)('preserves the registry seed when replaying the recorded %s transcript %s', (engine, file) => {
    const lines = fixture(file).trim().split('\n')
    // Audit the removed fallback against recordings, not formats inferred from Claude. None of these
    // native records contributed profile metadata through that reader; their own config/panes do.
    expect(lines.map(line => claudeRuntime.decode(JSON.parse(line))).filter(Boolean)).toEqual([])
    const manager = new RuntimeProfileState(() => undefined)
    const agent = session(engine)
    manager.hydrate(agent, lines)
    expect(manager.getState(agent.sessionId)).toEqual({
      model: 'registered-model', effort: null, mode: 'unknown', cliVersion: '1.0.0', observedAt: null,
    })
  })

  it('keeps Pi metadata in its native footer and never treats answer text as Claude commands', () => {
    const manager = new RuntimeProfileState(() => undefined)
    const agent = session('pi')
    // These metadata records are copied from the Pi 0.82.1 recording in pi/normalizer.spec.ts.
    const lines = [
      '{"type":"session","version":3,"id":"019fa2a5-a26d-700c-bf8c-97af19ae3d5f","timestamp":"2026-07-27T08:16:31.854Z","cwd":"/tmp/pi-probe"}',
      '{"type":"model_change","id":"45215278","parentId":null,"model":"minimax/minimax-m3"}',
      '{"type":"thinking_level_change","id":"1da16955","parentId":"45215278","level":"medium"}',
    ]
    expect(lines.map(line => claudeRuntime.decode(JSON.parse(line)))).toEqual([null, null, null])
    manager.hydrate(agent, lines)
    manager.ingestPane(agent, '0.0%/500k (auto)                    minimax/minimax-m3 • high', true)
    const before = manager.getState(agent.sessionId)
    expect(parseRuntimeProfile(manager.selectedModel(agent))).toMatchObject({
      engine: 'pi', model: 'minimax/minimax-m3', effort: 'high',
    })
    // An answer explaining another CLI uses ordinary text in Pi's recorded message envelope.
    expect(manager.ingest(agent, JSON.stringify({ type: 'message', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Set model to Opus 5\nSet effort level to low' }],
    } }), true)).toBe(false)
    expect(manager.getState(agent.sessionId)).toEqual(before)
  })

  it.each(['amp', 'muse', 'copilot', 'terminal'] as const)('does not interpret Claude UI quoted in a %s pane', engine => {
    // Apply the same boundary in explicit inline mode. Supplying a Claude facet must not make it a
    // fallback for engines whose profile source is their own config or registration.
    const manager = new RuntimeProfileManager(), agent = session(engine)
    manager.hydrate(agent, [])
    const before = manager.getState(agent.sessionId)
    expect(manager.ingestPane(agent, 'Claude Code v2.1.212\nOpus 5 with high effort · Claude Max\nplan mode on', true)).toBe(false)
    expect(manager.getState(agent.sessionId)).toEqual(before)
  })

  it('retains the native Muse and Amp config sources without loading either pilot facet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-profile-'))
    const defaults = { muse: env.MUSE_CONFIG_DIR, amp: env.AMP_STATE_DIR }
    try {
      env.MUSE_CONFIG_DIR = join(root, 'muse'); env.AMP_STATE_DIR = join(root, 'amp')
      mkdirSync(env.MUSE_CONFIG_DIR); mkdirSync(env.AMP_STATE_DIR)
      // Verified config shapes documented in each engine's runtimeProfile.ts.
      writeFileSync(join(env.MUSE_CONFIG_DIR, 'settings.json'), JSON.stringify({
        schema_version: 1, provider: 'meta', model: 'muse-spark-1.2-contributor',
      }))
      writeFileSync(join(env.AMP_STATE_DIR, 'session.json'), JSON.stringify({ agentMode: 'medium' }))
      const manager = new RuntimeProfileState(() => undefined)
      for (const [engine, model, effort] of [
        ['muse', 'muse-spark-1.2-contributor', 'high'], ['amp', 'medium', 'auto'],
      ] as const) {
        const agent = { ...session(engine), sessionId: engine }
        await manager.ingestConfig(agent, true)
        expect(parseRuntimeProfile(manager.selectedModel(agent))).toMatchObject({ engine, model, effort })
      }
    } finally {
      env.MUSE_CONFIG_DIR = defaults.muse; env.AMP_STATE_DIR = defaults.amp
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still reads the captured agy footer and the registry-supplied CLI version', () => {
    const manager = new RuntimeProfileState(() => undefined), agent = session('agy')
    manager.hydrate(agent, [])
    manager.ingestPane(agent, fixture('permission-agy.txt'), true)
    expect(parseRuntimeProfile(manager.selectedModel(agent))).toMatchObject({
      engine: 'agy', model: 'gemini-3.7-flash-high', effort: 'high',
    })
    expect(manager.getState(agent.sessionId).cliVersion).toBe('1.0.0')
  })
})

describe('native evidence recovery', () => {
  it.each(['configured effort', 'optional config', 'pane'] as const)('rejects a deferred %s after a complete hold/recovery cycle', async operation => {
    const agent = session(operation === 'optional config' ? 'commandcode' : 'claude')
    let finish!: () => void
    const waiting = new Promise<void>(resolve => { finish = resolve })
    const config = vi.fn(async ({ state }: InlineRuntimeContext) => { await waiting; state.effort = 'high'; return true })
    vi.mocked(loadEngine).mockResolvedValue({ createRuntimeProfileReader: () => ({ engine: 'commandcode', config }) } as never)
    const manager = new RuntimeProfileState(engine => engine === 'claude' ? { ...claudeRuntime,
      configuredEffort: async () => { await waiting; return 'high' },
      pane: ({ state }, text) => { state.model = text },
    } : undefined, () => agent)
    manager.hydrate(agent, [])
    const before = { ...manager.getState(agent.sessionId) }
    const pending = operation === 'pane'
      ? manager.capturePane(agent, async () => { await waiting; return 'stale-model' }, 20, true)
      : manager.ingestConfig(agent, true)
    if (operation === 'optional config') await vi.waitFor(() => expect(config).toHaveBeenCalledOnce())
    agent.identityHold = 'incomplete'; agent.evidenceRevision = 1
    expect(manager.ingestPane(agent, 'held-model')).toBe(false)
    delete agent.identityHold; agent.evidenceRevision = 2
    finish(); await pending
    expect(manager.getState(agent.sessionId)).toEqual(before)
    manager.forget(agent.sessionId)
  })
})
