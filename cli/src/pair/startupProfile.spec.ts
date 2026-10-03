import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegisteredSession } from '../lib/registry.js'
import { parseRuntimeProfile, readStartupProfile, RuntimeProfileManager } from '../lib/runtimeProfile.js'
import { CompanionStartupProfile } from './startupProfile.js'
import { CompanionIntelligence } from './intelligence.js'
import { ConversationReview } from './learn/conversationReview.js'
import { LessonDistiller } from './learn/distill.js'
import { LessonStore } from './learn/store.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'companion-startup-'))
  mkdirSync(join(directory, '.claude'))
  writeFileSync(join(directory, '.claude', 'settings.local.json'), '{"effortLevel":"default"}')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const CLAUDE_READY = [
  ' ▐▛███▛█   Claude Code v2.1.285',
  '▝▜██████▀  Opus 5.5 · Claude Max',
  ' ▝▝   ▝▝   ~/collection',
  '', '─────────────────────────────────',
  '❯\u00a0Try "edit <filepath> to..."',
  '─────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
].join('\n')

function session(extra: Partial<RegisteredSession> = {}): RegisteredSession {
  return { schemaVersion: 2, active: true, launch: { state: 'ready' }, agentId: 'companion', sessionId: '',
    engine: 'claude', boundAt: null, transcriptPath: null, projectDir: '', cwd: directory,
    tmuxPane: '%1', source: null, title: null, model: null, cliVersion: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1',
    processIdentity: { pid: 1234, executable: '/bin/claude', startMarker: 'first-start' },
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1, ...extra }
}

describe('companion readiness before its first message', () => {
  it('reads the actual Claude startup banner and effective effort without an engine session ID', async () => {
    const value = session()
    expect(parseRuntimeProfile(await readStartupProfile(value, CLAUDE_READY))).toMatchObject({
      sessionId: 'companion', engine: 'claude', model: 'opus', effort: 'auto',
    })
    writeFileSync(join(directory, '.claude', 'settings.local.json'), '{"effortLevel":"xhigh"}')
    expect(parseRuntimeProfile(await readStartupProfile(value, CLAUDE_READY))?.effort).toBe('xhigh')
    expect(parseRuntimeProfile(await readStartupProfile(value,
      CLAUDE_READY.replace('Opus 5.5', 'Sonnet 5.5 with low effort')))).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(parseRuntimeProfile(await readStartupProfile(value,
      CLAUDE_READY + '\n⎿ Set model to Sonnet 5.5\n❯ '))?.model).toBe('sonnet')
    // The ordinary cache still refuses the shared empty engine-session ID.
    const profiles = new RuntimeProfileManager()
    profiles.ingestPane(value, CLAUDE_READY)
    expect(profiles.selectedModel(value)).toBeNull()
    expect(value.sessionId).toBe('')
  })

  it('does not mistake setup dialogs, unknown models or other providers for readiness', async () => {
    for (const pane of [
      CLAUDE_READY.replace('❯\u00a0Try "edit <filepath> to..."', '❯ 1. Yes, I trust this folder'),
      CLAUDE_READY + '\nPlease sign in to continue',
      CLAUDE_READY.replace('Opus 5.5 · Claude Max', 'Unknown subscription'),
      CLAUDE_READY.replace('❯\u00a0Try "edit <filepath> to..."', ''),
    ]) expect(await readStartupProfile(session(), pane)).toBeNull()
    expect(await readStartupProfile(session({ gateway: 'ori' }), CLAUDE_READY)).toBeNull()
    expect(await readStartupProfile(session({ active: false }), CLAUDE_READY)).toBeNull()
    expect(await readStartupProfile(session({ sessionId: 'now-bound' }), CLAUDE_READY)).toBeNull()
  })

  it('reads the Codex model and effort only at its ready prompt', async () => {
    const value = session({ engine: 'codex', codexHome: '/profiles/companion' })
    const pane = 'OpenAI Codex (v0.144.5)\n› Implement a feature\n  gpt-5.6-terra xhigh · 100% context left'
    expect(parseRuntimeProfile(await readStartupProfile(value, pane))).toMatchObject({
      sessionId: 'companion', engine: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh',
    })
    expect(await readStartupProfile(value, pane.replace('› Implement a feature', '› 1. Sign in with ChatGPT'))).toBeNull()
  })

  it('expires evidence and isolates agents, process restarts, homes, and newly bound conversations', async () => {
    let current: RegisteredSession | null = session(), now = 1_000
    const capture = vi.fn(async () => CLAUDE_READY)
    const observer = new CompanionStartupProfile({ current: () => current, capture, now: () => now })
    await observer.refresh()
    const original = current
    expect(observer.selected(original)?.profile).toContain(':claude:opus@auto')
    for (const replacement of [
      session({ agentId: 'other' }),
      session({ processIdentity: { ...original.processIdentity!, startMarker: 'reused-pid' } }),
      session({ codexHome: '/another/account' }),
      session({ sessionId: 'first-conversation' }),
      session({ active: false }),
      session({ launch: { state: 'starting' } }),
      null,
    ]) {
      current = replacement
      expect(observer.selected(original)).toBeNull()
      if (replacement) expect(observer.selected(replacement)).toBeNull()
    }
    current = original; now += 45_001
    expect(observer.selected(original)).toBeNull()
    await observer.refresh()
    expect(observer.selected(original)).not.toBeNull()
    capture.mockRejectedValueOnce(new Error('pane unavailable'))
    await observer.refresh()
    expect(observer.selected(original)).toBeNull()
  })

  it('discards a capture that finishes after the companion changes', async () => {
    let current = session(), finish!: (pane: string) => void
    const observer = new CompanionStartupProfile({ current: () => current,
      capture: () => new Promise(resolve => { finish = resolve }) })
    const pending = observer.refresh()
    current = session({ agentId: 'other' })
    finish(CLAUDE_READY); await pending
    expect(observer.selected(current)).toBeNull()
  })

  it('fills an unknown bound profile from the banner without overriding a later model choice', async () => {
    const value = session({ sessionId: 'conversation' }), profiles = new RuntimeProfileManager()
    await profiles.ingestConfig(value, true)
    profiles.ingestPane(value, CLAUDE_READY, true)
    expect(parseRuntimeProfile(profiles.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'auto' })
    profiles.ingest(value, JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5' } }), true)
    profiles.ingestPane(value, CLAUDE_READY, true)
    expect(parseRuntimeProfile(profiles.selectedModel(value))?.model).toBe('sonnet')
  })

  it('resumes a queued history review into pending memories without sending a first message', async () => {
    const value = session(), now = Date.now()
    const observer = new CompanionStartupProfile({ current: () => value, capture: async () => CLAUDE_READY })
    const run = vi.fn(async () => ({ text: JSON.stringify({ lessons: [{ sources: ['1'],
      reason: 'The person specified the editor layout.',
      lesson: { kind: 'note', lines: ['Keep DSH viewers on the left and the agent terminal on the right.'] },
    }] }) }))
    const intelligence = new CompanionIntelligence({ enabled: () => true,
      current: () => ({ agentId: value.agentId, sessionId: value.sessionId, engine: value.engine,
        stopped: false, profile: null, startup: observer.selected(value) }),
      directory, stateFile: join(directory, 'intelligence.json'), run })
    const store = new LessonStore({ root: join(directory, 'lessons'), now: () => now, git: null })
    const distiller = new LessonDistiller({ oneshot: intelligence.run, modelEnabled: () => intelligence.ready(), now: () => now })
    const review = new ConversationReview({ directory, scope: () => value.agentId, pairedDaemon: () => 'tim',
      intelligence: () => intelligence.status(), store, distiller, now: () => now, cwd: () => null, machine: () => 'Desk',
      turns: () => ({ more: false, indexing: 0, rows: [{ agentId: 'work', sessionId: 'work-chat', engine: 'claude',
        cwd: '/code/app', title: 'Editor layout', turn: 1, at: now - 1_000, tools: '',
        ask: 'Keep the viewer on the left and the agent terminal on the right.', answer: 'I will keep that split.' }] }) })
    review.start(24)
    expect(review.status()).toMatchObject({ state: 'waiting', reviewed: 0, error: 'no-model' })
    expect(run).not.toHaveBeenCalled()
    await observer.refresh()
    await review.tick()
    expect(review.status()).toMatchObject({ state: 'complete', reviewed: 1, proposed: 1 })
    expect(run).toHaveBeenCalledWith('claude', expect.objectContaining({ model: 'opus' }))
    expect(store.pending()).toHaveLength(1)
    expect(store.approved()).toHaveLength(0)
    expect(value.sessionId).toBe('')
  })
})
