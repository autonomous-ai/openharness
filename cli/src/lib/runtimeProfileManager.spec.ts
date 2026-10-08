import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { runtime as claudeRuntime } from '../engines/claude/runtimeProfile.js'
import type { RegisteredSession } from './registry.js'
import { LegacyRuntimeProfileManager } from './runtimeProfileManager.js'
import { RuntimeProfileManager } from './runtimeProfile.js'
import { parseRuntimeProfile } from './runtimeProfileWire.js'

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8')
const session = (engine: RegisteredSession['engine']): RegisteredSession => ({
  agentId: 'agent', sessionId: 'conversation', engine, model: 'registered-model', cliVersion: '1.0.0',
  cwd: '/tmp', transcriptPath: '/tmp/profile-recording.jsonl',
} as RegisteredSession)
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('runtime profiles without the pilot implementations', () => {
  it.each([
    ['amp', 'amp-session.jsonl'], ['amp', 'amp-session-queued.jsonl'],
    ['muse', 'muse-session.jsonl'], ['copilot', 'copilot-session.jsonl'], ['agy', 'agy-session.jsonl'],
  ] as const)('preserves the registry seed when replaying the recorded %s transcript %s', (engine, file) => {
    const lines = fixture(file).trim().split('\n')
    // Audit the removed fallback against recordings, not formats inferred from Claude. None of these
    // native records contributed profile metadata through that reader; their own config/panes do.
    expect(lines.map(line => claudeRuntime.decode(JSON.parse(line))).filter(Boolean)).toEqual([])
    const manager = new LegacyRuntimeProfileManager(() => undefined)
    const agent = session(engine)
    manager.hydrate(agent, lines)
    expect(manager.getState(agent.sessionId)).toEqual({
      model: 'registered-model', effort: null, mode: 'unknown', cliVersion: '1.0.0', observedAt: null,
    })
  })

  it('keeps Pi metadata in its native footer and never treats answer text as Claude commands', () => {
    const manager = new LegacyRuntimeProfileManager(() => undefined)
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
      const manager = new LegacyRuntimeProfileManager(() => undefined)
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
    const manager = new LegacyRuntimeProfileManager(() => undefined), agent = session('agy')
    manager.hydrate(agent, [])
    manager.ingestPane(agent, fixture('permission-agy.txt'), true)
    expect(parseRuntimeProfile(manager.selectedModel(agent))).toMatchObject({
      engine: 'agy', model: 'gemini-3.7-flash-high', effort: 'high',
    })
    expect(manager.getState(agent.sessionId).cliVersion).toBe('1.0.0')
  })
})
