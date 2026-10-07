import { mkdtempSync, rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { AgentCreationReceipts } from '../lib/agentCreationReceipt.js'
import { shellContextReply } from '../lib/shellContextReply.js'
import { checkPidRuntime } from '../lib/deleteAgentFallback.js'
import { tmuxPaneState } from '../lib/tmux.js'
import { fakeCore } from '../testing/fakeCore.js'
import { SHELL_REQUESTS, startShell } from './shell.js'
import { createTerminalSessions } from '../core/terminals/sessions.js'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), stat: vi.fn(async () => ({ isDirectory: () => true })),
}))
vi.mock('../lib/shellContextReply.js', () => ({ shellContextReply: vi.fn(() => true) }))
vi.mock('../lib/deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn() }))
vi.mock('../lib/tmux.js', () => ({ tmuxPaneState: vi.fn() }))
const OWNER = { local: false, owner: true }
let dataDir: string
function setup() {
  const row = { agentId: 'shell', sessionId: '', engine: 'terminal', cwd: '/work/project', projectDir: 'project', launch: { state: 'ready' } } as RegisteredSession
  const core = fakeCore({ dataDir, terminals: { open: vi.fn(async () => ({ ok: true as const, agentId: 'shell' })) }, agents: {
    byAgent: vi.fn(() => row), displayName: () => 'project', terminalAvailable: () => true,
  } })
  Object.assign(core.terminals, createTerminalSessions({ agents: core.agents, paneState: tmuxPaneState, processState: checkPidRuntime }))
  const requests = startShell(core)
  const ask = (type: string, payload: Record<string, unknown> = {}, asker = OWNER) => requests[type]!(payload, asker)
  const payload = { creationId: randomUUID(), cwd: '/work/project', argv: ['/bin/zsh', '/work/a script', '$(touch nope)', 'a; b', ''] }
  return { core, requests, ask, payload }
}

describe('shells through a service', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'shell-service-')) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); rmSync(dataDir, { recursive: true, force: true }) })
  it('declares every request and refuses every non-owner, regardless of the payload', async () => {
    const { requests, core, ask, payload } = setup()
    expect(Object.keys(requests).sort()).toEqual([...SHELL_REQUESTS].sort())
    for (const type of SHELL_REQUESTS) {
      expect(await ask(type, { ...payload, owner: true }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    }
    expect(core.terminals.open).not.toHaveBeenCalled()
    expect(shellContextReply).not.toHaveBeenCalled()
    expect(await ask('shell_capabilities')).toEqual({ protocol: 1 })
    expect(await ask('shell_context_reply', { id: 'reply' })).toEqual({ ok: true })
    expect(shellContextReply).toHaveBeenCalledWith({ id: 'reply' })
    vi.mocked(shellContextReply).mockReturnValueOnce(false)
    expect(await ask('shell_context_reply')).toEqual({ ok: false })
  })
  it('opens exact argv once, recovers a lost reply and keeps the receipt across service restarts', async () => {
    const { core, ask, payload } = setup()
    const reply = await ask('shell_open', payload)
    expect(reply).toEqual({ creationId: payload.creationId, state: 'created', agent: {
      id: 'shell', sessionId: '', engine: 'terminal', name: 'project', status: 'active', launch: { state: 'ready' },
      terminal: { available: true }, project: { cwd: payload.cwd, root: payload.cwd, name: 'project' },
    } })
    expect(core.terminals.open).toHaveBeenCalledWith({ argv: payload.argv, cwd: payload.cwd })
    expect(vi.mocked(core.terminals.open).mock.calls[0]![0].argv).not.toBe(payload.argv)
    expect(await ask('shell_open', payload)).toEqual(reply)
    expect(await ask('shell_open_status', payload)).toEqual(reply)
    expect(await startShell(core).shell_open!(payload, OWNER)).toEqual(reply)
    expect(core.terminals.open).toHaveBeenCalledTimes(1)
    expect(await ask('shell_open', { ...payload, argv: ['/bin/bash'] })).toEqual({ error: 'CREATION_CONFLICT' })
    vi.mocked(core.agents.byAgent).mockReturnValue(undefined)
    expect(await ask('shell_open_status', payload)).toEqual({ creationId: payload.creationId, state: 'unavailable' })
  })
  it('requires a durable creation id, an absolute folder, and bounded literal argv', async () => {
    const { core, ask, payload } = setup()
    for (const type of ['shell_open', 'shell_open_status']) expect(await ask(type, { creationId: 'bad' })).toEqual({ error: 'INVALID_CREATION_ID' })
    for (const argv of [undefined, 'echo hello', [], new Array(257).fill('x'), [null], [1], ['x\0y'], [''], ['x'.repeat(32 * 1024)]]) {
      expect(await ask('shell_open', { ...payload, argv })).toEqual({ error: 'INVALID_ARGV' })
    }
    expect(await ask('shell_open', { ...payload, command: 'echo unsafe' })).toEqual({ error: 'INVALID_ARGV' })
    for (const cwd of [undefined, 'relative', '/x\0y', '/' + 'x'.repeat(4096)]) {
      expect(await ask('shell_open', { ...payload, cwd })).toEqual({ error: 'INVALID_CWD' })
    }
    expect(core.terminals.open).not.toHaveBeenCalled()
    expect(await ask('shell_open_status', payload)).toEqual({ creationId: payload.creationId, state: 'missing' })
  })
  it('records launch failures, and never retries an unconfirmed launch', async () => {
    const { core, ask, payload } = setup()
    vi.mocked(core.terminals.open).mockResolvedValueOnce({ ok: false, error: 'TMUX_UNAVAILABLE', detail: 'gone' })
    expect(await ask('shell_open', payload)).toEqual({ creationId: payload.creationId, state: 'failed', error: 'TMUX_UNAVAILABLE', detail: 'gone' })
    const next = { ...payload, creationId: randomUUID() }
    vi.mocked(core.terminals.open).mockRejectedValueOnce(new Error('the reply was lost'))
    expect(await ask('shell_open', next)).toEqual({ creationId: next.creationId, state: 'unconfirmed' })
    expect(await ask('shell_open', next)).toEqual({ creationId: next.creationId, state: 'unconfirmed' })
    expect(core.terminals.open).toHaveBeenCalledTimes(2)
  })
  it('refuses unreadable folders and files without opening a terminal', async () => {
    const { core, ask, payload } = setup()
    vi.mocked(stat).mockRejectedValueOnce(new Error('ENOENT'))
    expect(await ask('shell_open', payload)).toMatchObject({ state: 'failed', error: 'CWD_NOT_FOUND' })
    vi.mocked(stat).mockResolvedValueOnce({ isDirectory: () => false } as Awaited<ReturnType<typeof stat>>)
    expect(await ask('shell_open', { ...payload, creationId: randomUUID() })).toMatchObject({ state: 'failed', error: 'CWD_NOT_FOUND' })
    expect(core.terminals.open).not.toHaveBeenCalled()
  })
  it('bounds a filesystem provider that never answers', async () => {
    vi.useFakeTimers()
    const { core, ask, payload } = setup()
    vi.mocked(stat).mockImplementationOnce(() => new Promise(() => {}))
    const opening = ask('shell_open', payload)
    await vi.advanceTimersByTimeAsync(4001)
    expect(await opening).toMatchObject({ state: 'failed', error: 'CWD_NOT_FOUND' })
    expect(core.terminals.open).not.toHaveBeenCalled()
  })
  it('leaves unexpected failures to the service host instead of reporting a successful launch', async () => {
    const { ask, payload } = setup()
    vi.spyOn(AgentCreationReceipts.prototype, 'status').mockImplementationOnce(() => { throw new Error('unexpected') })
    await expect(ask('shell_open_status', payload)).rejects.toThrow('unexpected')
  })
  it('returns a shell view only after independent exit evidence for the same ready process', async () => {
    const { core, ask } = setup()
    const row = { agentId: 'agent', active: true, engine: 'claude', sessionId: 'chat', tmuxPane: '%2', launch: { state: 'ready' },
      processIdentity: { pid: 22, startMarker: 'start', executable: '/bin/claude' } } as RegisteredSession
    for (const agentId of [undefined, '', 4, 'x'.repeat(257)]) expect(await ask('shell_visit_status', { agentId })).toEqual({ error: 'INVALID_AGENT_ID' })
    for (const current of [undefined, { ...row, engine: 'terminal' },
      { ...row, launch: { state: 'starting' } }, { ...row, launch: { state: 'failed' } }, { ...row, tmuxPane: '' }, { ...row, processIdentity: undefined },
      { ...row, processIdentity: { ...row.processIdentity!, startMarker: '' } }]) {
      vi.mocked(core.agents.byAgent).mockReturnValue(current as RegisteredSession | undefined)
      expect(await ask('shell_visit_status', { agentId: 'agent' })).toEqual({ exited: false })
    }
    expect(tmuxPaneState).not.toHaveBeenCalled()
    vi.mocked(core.agents.byAgent).mockReturnValue(row)
    for (const pane of ['gone', 'unknown', { dead: false }]) {
      vi.mocked(tmuxPaneState).mockResolvedValueOnce(pane as Awaited<ReturnType<typeof tmuxPaneState>>)
      expect(await ask('shell_visit_status', { agentId: 'agent' })).toEqual({ exited: false })
    }
    expect(checkPidRuntime).not.toHaveBeenCalled()
    vi.mocked(tmuxPaneState).mockResolvedValue({ dead: false, engineExit: 0 } as Awaited<ReturnType<typeof tmuxPaneState>>)
    for (const state of ['alive', 'unknown', 'gone'] as const) {
      vi.mocked(checkPidRuntime).mockResolvedValue({ state, reason: 'fixture' })
      expect(await ask('shell_visit_status', { agentId: 'agent' })).toEqual({ exited: state === 'gone' })
    }
    vi.mocked(core.agents.byAgent).mockReturnValue({ ...row, launch: undefined })
    expect(await ask('shell_visit_status', { agentId: 'agent' })).toEqual({ exited: true })
    vi.mocked(core.agents.byAgent).mockReturnValue(row)
    for (const replacement of [undefined, { ...row, sessionId: 'different' }, { ...row, launch: { state: 'starting' } },
      { ...row, processIdentity: { ...row.processIdentity!, startMarker: 'reused-pid' } }]) {
      vi.mocked(core.agents.byAgent).mockReturnValueOnce(row).mockReturnValueOnce(replacement as RegisteredSession | undefined)
      expect(await ask('shell_visit_status', { agentId: 'agent' })).toEqual({ exited: false })
    }
    expect(core.terminals.open).not.toHaveBeenCalled()
    expect(core.agents.sync).not.toHaveBeenCalled()
  })
  it('verifies an inactive resumed engine instead of stranding its parked shell', async () => {
    const { core, ask } = setup()
    const row = { agentId: 'agent', active: false, engine: 'claude', sessionId: 'chat', tmuxPane: '%2', launch: { state: 'ready' },
      processIdentity: { pid: 22, startMarker: 'resumed', executable: '/bin/claude' } } as RegisteredSession
    vi.mocked(core.agents.byAgent).mockReturnValue(row)
    vi.mocked(tmuxPaneState).mockResolvedValue({ dead: false, engineExit: 0 } as Awaited<ReturnType<typeof tmuxPaneState>>)
    for (const state of ['alive', 'unknown', 'gone'] as const) {
      vi.mocked(checkPidRuntime).mockResolvedValue({ state, reason: 'fixture' })
      expect(await ask('shell_visit_status', { agentId: 'agent' })).toEqual({ exited: state === 'gone' })
    }
    expect(core.agents.sync).not.toHaveBeenCalled()
    expect(row.active).toBe(false)
  })
  it('coalesces exit probes, keeps a value snapshot and releases failed probes', async () => {
    const { core, ask } = setup()
    const row = { agentId: 'agent', active: true, engine: 'claude', tmuxPane: '%2', launch: { state: 'ready' },
      processIdentity: { pid: 22, startMarker: 'start', executable: '/bin/claude' } } as RegisteredSession
    vi.mocked(core.agents.byAgent).mockReturnValue(row)
    let finish!: (value: Awaited<ReturnType<typeof tmuxPaneState>>) => void
    vi.mocked(tmuxPaneState).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = ask('shell_visit_status', { agentId: 'agent' })
    const second = ask('shell_visit_status', { agentId: 'agent' })
    expect(first).toBe(second)
    row.processIdentity!.startMarker = 'replacement'
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'gone', reason: 'fixture' })
    finish({ dead: false, engineExit: 1 } as Awaited<ReturnType<typeof tmuxPaneState>>)
    expect(await first).toEqual({ exited: false })
    expect(checkPidRuntime).toHaveBeenCalledWith(expect.objectContaining({ processIdentity: expect.objectContaining({ startMarker: 'start' }) }))
    vi.mocked(tmuxPaneState).mockRejectedValueOnce(new Error('probe failed'))
    await expect(ask('shell_visit_status', { agentId: 'agent' })).rejects.toThrow('probe failed')
    vi.mocked(tmuxPaneState).mockResolvedValueOnce('unknown')
    expect(await ask('shell_visit_status', { agentId: 'agent' })).toEqual({ exited: false })
  })
})
