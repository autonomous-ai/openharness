import { describe, expect, it, vi } from 'vitest'
import { agentFrame } from './agentFrame.js'
import type { RegisteredSession } from './registry.js'

vi.mock('./transcriptActivity.js', () => ({ transcriptActivityAt: async () => null }))

const row = {
  schemaVersion: 2, agentId: 'agent', sessionId: 'session', engine: 'claude', active: true, registeredAt: 1,
  lastHookAt: 0, boundAt: 0, transcriptPath: null, cwd: null, tmuxPane: '%1', primaryRuntimeKey: 'tmux/%1',
  runtimes: [{ backend: 'tmux', paneId: '%1' }], projectDir: '', title: null, model: null,
} as RegisteredSession

describe('agent frame bytes at the service boundary', () => {
  it.each([
    ['no service', row, undefined, undefined],
    ['registered harness before viewers start', { ...row, dsh: 'saved/harness' }, undefined, undefined],
    ['viewer and browser', { ...row, dsh: 'old/id' }, {
      id: 'new/id', name: 'Drawing', viewerUrl: 'http://127.0.0.1:7000', viewerName: 'Preview',
      verdict: { status: 'pass', summary: 'Ready' },
    }, { state: 'ready' }],
    ['browser failure', row, undefined, { state: 'failed', error: 'podman_down' }],
    ['stopped', { ...row, active: false, tmuxPane: '', runtimes: [], primaryRuntimeKey: '' }, undefined, undefined],
  ])('%s', async (_name, session, dsh, browser) => {
    const frame = await agentFrame(session as RegisteredSession, {
      selectedModel: null, terminalAvailable: !!session.active,
      parts: () => ({
        ...(dsh ? { dsh: dsh.id, dshName: dsh.name, viewerUrl: dsh.viewerUrl, viewerName: dsh.viewerName, verdict: dsh.verdict } : {}),
        ...(browser ? { browser } : {}),
      }),
    })
    expect(JSON.stringify(frame)).toMatchSnapshot()
  })
})
