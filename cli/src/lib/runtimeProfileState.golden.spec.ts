/** Former manager answers, recorded before item 6 removes the legacy composition. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { RuntimeProfile } from '../engines/facets/runtime.js'

const GOLDEN = new URL('./__fixtures__/runtime-profile-state.golden.json', import.meta.url)
const RECORD = process.env.RECORD_RUNTIME_STATE_GOLDEN === '1'
const NOW = Date.parse('2026-10-09T00:00:00Z')
const platforms = ['linux', 'darwin'] as const
const engines = ['claude', 'codex', 'cursor', 'opencode', 'kilo', 'devin', 'hermes', 'amp', 'agy', 'grok', 'copilot', 'commandcode', 'muse', 'pi'] as const
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const recorded: Record<string, unknown> = {}
let root = ''

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', originalPlatform)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('former runtime manager state and control golden', () => {
  for (const platform of platforms) it(platform, async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
    root = mkdtempSync('/tmp/runtime-state-golden-')
    const home = join(root, 'home')
    mkdirSync(home)
    for (const [key, value] of Object.entries({ HOME: home, ADAPTER_DATA_DIR: join(root, 'data'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
      HERMES_HOME: join(home, '.hermes'), COMMANDCODE_HOME: join(home, '.commandcode'),
      CURSOR_HOME: join(home, '.cursor'), XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'), PATH: '/nonexistent-runtime-golden-bin', TZ: 'UTC',
    })) vi.stubEnv(key, value)
    vi.resetModules()
    const { RuntimeProfileManager } = await import('./runtimeProfile.js')
    const { RuntimeProfileState } = await import('./runtimeProfileState.js')
    const { loadEngine } = await import('../engines/inProcess.js')
    const { encodeRuntimeProfile } = await import('../engines/kit/runtime.js')
    for (const engine of engines) if (engine !== 'claude' && engine !== 'codex') await loadEngine(engine)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    const value = (engine: typeof engines[number], id = `session-${engine}`): RegisteredSession => ({
      agentId: id, sessionId: id, engine, model: 'registered-model', cliVersion: '1.0.0',
      cwd: '/work/runtime-golden', transcriptPath: null,
    } as RegisteredSession)
    const answers: Record<string, unknown> = {}
    for (const engine of engines) {
      vi.setSystemTime(NOW)
      const m = new RuntimeProfileManager(), s = value(engine)
      const changes: string[] = []
      m.onChanged = id => changes.push(id)
      const snapshot = () => ({ state: m.getState(s.sessionId), selected: m.selectedModel(s), changes: [...changes] })
      const states: Record<string, unknown> = { fresh: snapshot() }
      m.hydrate(s, ['invalid json', 'null', '[]'])
      states.hydrated = snapshot()
      const target: RuntimeProfile = { id: encodeRuntimeProfile({ sessionId: s.sessionId, engine, model: 'chosen-model', effort: 'high' }),
        sessionId: s.sessionId, engine, model: 'chosen-model', effort: 'high' }
      states.begin = m.beginControl(s, target)
      states.duplicate = m.beginControl(s, target)
      const modelWait = m.waitForModel(s.sessionId, 100)
      const profileWait = m.waitForProfile(s.sessionId, 100)
      m.confirmEffort(s.sessionId, 'invalid-effort')
      states.invalidEffort = snapshot()
      m.confirmControlProfile(target)
      states.confirmed = { ...snapshot(), modelWait: await modelWait, profileWait: await profileWait }
      m.finishControl(s)
      await vi.advanceTimersByTimeAsync(120)
      states.finished = snapshot()
      states.supported = m.supportsControl(s)
      states.gatewaySupported = m.supportsControl({ ...s, gateway: {} } as RegisteredSession)
      const other = { ...target, id: `${target.id}-other`, model: 'other-model', effort: 'low' }
      m.beginControl(s, other)
      const cancelled = m.waitForProfile(s.sessionId, 100)
      m.cancelControl(s.sessionId)
      await vi.advanceTimersByTimeAsync(120)
      states.cancelled = { ...snapshot(), waited: await cancelled }
      m.beginControl(s, other)
      const forgotten = m.waitForModel(s.sessionId, 100)
      m.forget(s.sessionId)
      await vi.advanceTimersByTimeAsync(120)
      states.forgotten = { ...snapshot(), waited: await forgotten }
      states.targets = [m.cursorTarget(s.sessionId, target.id), m.devinTarget(s.sessionId, target.id),
        m.hermesTarget(s.sessionId, target.id), m.commandcodeTarget(s.sessionId, target.id)]
      answers[engine] = states
    }
    // The supervised core has no pilot reader. It still owns confirmation, waiters and cleanup.
    const generic = new RuntimeProfileState(() => undefined), g = value('codex', 'generic')
    const target: RuntimeProfile = { id: 'runtime-v1:generic:codex:chosen@high', sessionId: 'generic', engine: 'codex', model: 'chosen', effort: 'high' }
    generic.beginControl(g, target)
    generic.confirmEffort(g.sessionId, 'high')
    const timedOut = generic.waitForModel(g.sessionId, 15)
    await vi.advanceTimersByTimeAsync(15)
    answers.generic = { state: generic.getState(g.sessionId), selected: generic.selectedModel(g), timedOut: await timedOut }
    generic.forget(g.sessionId)
    const blank = value('opencode', '')
    generic.ingestPane(blank, '  ┃  Build · Big Pickle OpenCode Zen', true)
    generic.hydrate(blank, ['{}'])
    answers.unbound = { state: generic.getState(''), own: generic.selectedModel(blank), other: generic.selectedModel(value('claude', '')) }

    const staged = new RuntimeProfileManager(), c = value('codex', 'staged')
    const line = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', reasoning_effort: 'high' } })
    staged.hydrate(c, [line])
    const before = staged.getState(c.sessionId)
    const pending = staged.beginHydrate(c)
    pending.ingest('invalid')
    pending.ingest('null')
    pending.ingest(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-luna', reasoning_effort: 'low' } }))
    const during = staged.getState(c.sessionId)
    pending.commit()
    const committed = staged.getState(c.sessionId)
    const emitted: string[] = []
    staged.onChanged = id => emitted.push(id)
    await staged.withoutChangeEvents(async () => { staged.ingest(c, line) })
    await vi.advanceTimersByTimeAsync(120)
    answers.staged = { before, during, committed, afterSuppressed: staged.getState(c.sessionId), fields: staged.transcriptFields(c, line), emitted }
    staged.forget(c.sessionId)

    recorded[platform] = answers
    if (RECORD) writeFileSync(GOLDEN, `${JSON.stringify(recorded, null, 2)}\n`)
    else expect(answers).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8'))[platform])
  })
})
