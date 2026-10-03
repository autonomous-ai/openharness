import { describe, expect, it, vi } from 'vitest'
import { agentFrame } from './agentFrame.js'
import { registry, type RegisteredSession } from './registry.js'
import { createSessionSync, type SessionSyncDeps } from './sessionSync.js'

function row(overrides: Partial<RegisteredSession> = {}): RegisteredSession {
  return {
    schemaVersion: 2, active: true, agentId: 'agent-a', sessionId: 'session-a', boundAt: 1,
    engine: 'codex', transcriptPath: null, projectDir: 'demo', cwd: null,
    runtimes: [{ backend: 'tmux', paneId: '%16' }], primaryRuntimeKey: 'tmux\u0000%16', tmuxPane: '%16',
    source: null, title: null, model: null, cliVersion: null, processIdentity: null,
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    ...overrides,
  }
}

function harness(overrides: Partial<SessionSyncDeps> = {}) {
  const deps = {
    terminalAvailable: () => true,
    project: vi.fn((session: RegisteredSession) => agentFrame(session, { selectedModel: null, terminalAvailable: true })),
    send: vi.fn(),
    sendCommander: vi.fn(),
    onUnavailable: vi.fn(),
    onFailed: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  }
  return { ...deps, sync: createSessionSync(deps) }
}

describe('session sync', () => {
  it('keeps an existing pane through registry reload, early metadata sync, and terminal rediscovery', async () => {
    registry.load()
    const opened = registry.openProcessAgent({
      agentId: 'restart-agent', engine: 'codex', tmuxPane: '%16',
      processIdentity: { pid: 42, executable: 'codex', startMarker: 'test-process' },
    })!.entry
    const h = harness({ terminalAvailable: (agentId) => registry.terminalAvailable(agentId) })
    await h.sync(opened)
    expect(h.send).toHaveBeenCalledTimes(1)

    // A daemon restart forgets verification, not the pane or the process. Title/profile updates
    // can arrive before discovery verifies that saved terminal locator again.
    registry.load()
    const restored = registry.byAgent(opened.agentId)!
    expect(restored).toBeDefined()
    expect(registry.terminalAvailable(restored.agentId)).toBe(false)
    await h.sync(restored)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.sendCommander).toHaveBeenLastCalledWith({
      type: 'agent_deleted', payload: { agentId: opened.agentId },
    })

    registry.setTerminalAvailable(restored.agentId, true)
    await h.sync(restored)
    expect(h.send).toHaveBeenCalledTimes(2)
    for (const [frame] of vi.mocked(h.send).mock.calls) {
      expect(frame).toMatchObject({ type: 'agent_synced', payload: { agent: { id: opened.agentId, terminal: { available: true } } } })
    }
    expect(h.warn).not.toHaveBeenCalled()
  })

  it.each([undefined, false])('does not close app panes for an unverified terminal (device=%s)', async (device) => {
    const h = harness({ terminalAvailable: () => false })
    await h.sync(row(), { device })
    expect(h.send).not.toHaveBeenCalled()
    expect(h.project).not.toHaveBeenCalled()
    expect(h.onUnavailable).toHaveBeenCalledWith('agent-a')
    expect(h.sendCommander).toHaveBeenCalledTimes(device === false ? 0 : 1)
  })

  it.each([true, false])('keeps plain terminals out of the dial (available=%s)', async (available) => {
    const h = harness({ terminalAvailable: () => available })
    await h.sync(row({ engine: 'terminal' }))
    expect(h.send).toHaveBeenCalledTimes(available ? 1 : 0)
    expect(h.sendCommander).not.toHaveBeenCalled()
  })

  it('honors app-only updates for a verified agent', async () => {
    const h = harness()
    await h.sync(row(), { device: false })
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_synced' }))
    expect(h.sendCommander).not.toHaveBeenCalled()
  })

  it('preserves launch-failure reporting and contains projection errors', async () => {
    const error = new Error('projection failed')
    const h = harness({ project: vi.fn().mockRejectedValue(error) })
    await h.sync(row({ launch: { state: 'failed', error: 'ENGINE_DID_NOT_START', detail: 'See terminal.' } }))
    expect(h.onFailed).toHaveBeenCalledWith('agent-a', 'See terminal.')
    expect(h.warn).toHaveBeenCalledWith(error)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.sendCommander).not.toHaveBeenCalled()
  })
})
