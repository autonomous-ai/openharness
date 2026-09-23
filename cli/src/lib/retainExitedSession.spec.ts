import { describe, it, expect, vi } from 'vitest'
import { createRetainExitedSession, type RetainExitedSessionDeps } from './retainExitedSession.js'
import type { RegisteredSession } from './registry.js'

const row = (over: Partial<RegisteredSession> = {}): RegisteredSession => ({
  schemaVersion: 2, active: true, agentId: 'agent-a', sessionId: 'session-a', boundAt: 1,
  engine: 'codex', gateway: null, grid: null, gridLaunch: null, gridWebSearch: null,
  defaultName: 'harness Desktop', transcriptPath: '/tmp/rollout.jsonl', projectDir: 'demo',
  cwd: '/tmp/demo', runtimes: [{ backend: 'tmux', paneId: '%7' }], primaryRuntimeKey: 'tmux\u0000%7',
  tmuxPane: '%7', source: null, title: null, model: null, cliVersion: null, codexHome: null,
  dsh: null, agent: null, processIdentity: null, registeredAt: 1, updatedAt: 1, lastHookAt: 1,
  lastTranscriptAt: 1, ...over,
} as RegisteredSession)

function harness(over: Partial<RetainExitedSessionDeps> = {}) {
  const frames: Array<{ type: string; payload: Record<string, unknown> }> = []
  const calls: string[] = []
  const archive = new Map<string, RegisteredSession>()
  const shell = row({ agentId: 'agent-shell', engine: 'terminal', sessionId: '', defaultName: 'Terminal harness' })
  const deps: RetainExitedSessionDeps = {
    stoppedAgents: {
      save: entry => { calls.push(`save:${entry.agentId}`); archive.set(entry.agentId, entry) },
      get: agentId => archive.get(agentId) ?? null,
    },
    registry: {
      releaseEngine: (agentId, separate) => { calls.push(`release:${agentId}:${separate}`); return shell },
      removeAgent: agentId => { calls.push(`remove:${agentId}`); return true },
    },
    send: frame => { calls.push(`send:${frame.type}`); frames.push(frame) },
    publishStoppedAgent: async saved => { calls.push(`publish:${saved.agentId}`) },
    announceSession: session => { calls.push(`announce:${session.agentId}`) },
    invalidateTerminalControl: agentId => calls.push(`control:${agentId}`),
    forgetInput: agentId => calls.push(`input:${agentId}`),
    detachDsh: agentId => calls.push(`dsh:${agentId}`),
    syncRecapPool: () => calls.push('recap'),
    warn: () => {},
    ...over,
  }
  return { retain: createRetainExitedSession(deps), frames, calls, archive, shell }
}

describe('retainExitedSession', () => {
  it('ends the identity that was running the engine so its views close, and keeps the surviving shell', () => {
    const h = harness()
    const entry = row()
    h.retain(entry, true)

    expect(h.frames).toEqual([{ type: 'agent_deleted', payload: { agentId: 'agent-a', retained: true } }])
    // The archive exists BEFORE the client is told to go looking for it, and the ending reaches the
    // client before the frame that is behind an await.
    expect(h.calls.indexOf('save:agent-a')).toBeLessThan(h.calls.indexOf('send:agent_deleted'))
    expect(h.calls.indexOf('send:agent_deleted')).toBeLessThan(h.calls.indexOf('publish:agent-a'))
    expect(h.archive.get('agent-a')).toBe(entry)
    expect(h.calls).toContain('release:agent-a:true')
    expect(h.calls).not.toContain('remove:agent-a')
    expect(h.calls).toContain('announce:agent-shell')
  })

  it('a pane that died with its engine leaves no shell, and its views close just the same', () => {
    const h = harness()
    h.retain(row(), false)

    expect(h.frames).toEqual([{ type: 'agent_deleted', payload: { agentId: 'agent-a', retained: true } }])
    expect(h.calls).toContain('remove:agent-a')
    expect(h.calls.some(call => call.startsWith('release:'))).toBe(false)
    expect(h.calls.some(call => call.startsWith('announce:'))).toBe(false)
    expect(h.calls).toContain('publish:agent-a')
  })

  it('releases input, terminal control and the harness viewer before anything is announced', () => {
    const h = harness()
    h.retain(row(), true)
    for (const call of ['control:agent-a', 'input:agent-a', 'dsh:agent-a']) {
      expect(h.calls.indexOf(call)).toBeGreaterThanOrEqual(0)
      expect(h.calls.indexOf(call)).toBeLessThan(h.calls.indexOf('send:agent_deleted'))
    }
  })

  it('an archive that cannot be announced is warned about, never thrown at the caller', async () => {
    const warn = vi.fn()
    const h = harness({ publishStoppedAgent: () => Promise.reject(new Error('offline')), warn })
    expect(() => h.retain(row(), true)).not.toThrow()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
  })
})
