/**
 * The stop of a shared Codex conversation, end to end inside one process: the core's broker (rows, identity,
 * the grant's answers) with Codex's own control in process. These are the recorded cases of the former
 * lib/codexSessionLifecycle.ts, unchanged: the move into the worker keeps every outcome and message.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CodexControl } from '../../engines/codex/nativeControl.js'
import { registry, type RegisteredSession } from '../../lib/registry.js'
import type { ProcessRow } from '../../lib/tmux.js'
import { composedCodex } from '../../testing/inlineNativeControls.js'

interface CodexStopDeps {
  daemonIdentity(home: string): Promise<{ pid: number; processStartTime: string } | null>
  rows(): Promise<ProcessRow[] | null>
  connect(home: string): Promise<CodexControl>
}
/** The former entry point, composed of the pieces it was split into. */
function stopSharedCodexSession(session: RegisteredSession, current: () => boolean, deps: CodexStopDeps,
  confirmUnusedConversation?: (session: RegisteredSession) => Promise<boolean>): Promise<void> {
  return composedCodex(deps).stop(session, current, confirmUnusedConversation)
}
let row: RegisteredSession
let deps: CodexStopDeps
let request: ReturnType<typeof vi.fn<(method: string, params?: Record<string, unknown>) => Promise<any>>>
let close: ReturnType<typeof vi.fn<() => void>>
let loaded: boolean
beforeEach(() => {
  row = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%500' }], cwd: '/tmp', codexHome: '/tmp/fixture-home' })!
  Object.assign(row, { sessionId: 'conversation' })
  loaded = true
  request = vi.fn(async (method: string) => {
    if (method === 'thread/read') return { thread: { id: row.sessionId, status: { type: loaded ? 'active' : 'notLoaded' } } }
    if (method === 'thread/goal/get') return { goal: { status: 'active' } }
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'inProgress' }] }
    if (method === 'thread/archive') loaded = false
    return {}
  })
  close = vi.fn()
  deps = { daemonIdentity: vi.fn(async () => ({ pid: 78, processStartTime: 'Thu Oct  1 01:00:00 2026' })),
    rows: vi.fn(async () => [{ pid: 78, parentPid: 1, executable: 'codex', args: 'codex app-server', startMarker: 'Thu Oct 1 01:00:00 2026' }]),
    connect: vi.fn(async () => ({ request, close })),
  }
})
afterEach(() => { for (const entry of registry.list()) registry.removeAgent(entry.agentId) })
it('stops only the named conversation and restores its disk history without restarting it', async () => {
  await stopSharedCodexSession(row, () => true, deps)
  expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/read', 'thread/goal/get', 'thread/goal/set', 'thread/turns/list', 'turn/interrupt', 'thread/archive', 'thread/unarchive', 'thread/read'])
  for (const [, params] of request.mock.calls) expect(params).toMatchObject({ threadId: 'conversation' })
  expect(close).toHaveBeenCalledOnce()
})
it.each(['other engine', 'no daemon', 'old pid', 'recycled pid'])('does not contact a server for %s', async mode => {
  if (mode === 'other engine') row.engine = 'claude'
  if (mode === 'no daemon') vi.mocked(deps.daemonIdentity).mockResolvedValue(null)
  if (mode === 'old pid') vi.mocked(deps.rows).mockResolvedValue([])
  if (mode === 'recycled pid') vi.mocked(deps.rows).mockResolvedValue([{ pid: 78, parentPid: 1, executable: 'codex', args: '', startMarker: 'replacement' }])
  await stopSharedCodexSession(row, () => true, deps)
  expect(deps.connect).not.toHaveBeenCalled()
})
it('refuses an unreadable process table or an unbound conversation before controlling a server', async () => {
  vi.mocked(deps.rows).mockResolvedValueOnce(null)
  await expect(stopSharedCodexSession(row, () => true, deps)).rejects.toThrow('verify')
  row.sessionId = ''
  await expect(stopSharedCodexSession(row, () => true, deps)).rejects.toThrow('identify')
  expect(deps.connect).not.toHaveBeenCalled()
})
it('requires a verified process before accepting an unused conversation', async () => {
  row.sessionId = ''
  const confirmUnused = vi.fn(async () => true)
  await expect(stopSharedCodexSession(row, () => true, deps, confirmUnused)).rejects.toThrow('identify')
  expect(confirmUnused).not.toHaveBeenCalled()
  expect(deps.connect).not.toHaveBeenCalled()
})
it('does not ask an unrelated shared server to identify an exited, unbound client', async () => {
  row.sessionId = ''
  row.processIdentity = { pid: 99, executable: 'node', startMarker: 'exited client' }
  await stopSharedCodexSession(row, () => true, deps)
  expect(deps.daemonIdentity).not.toHaveBeenCalled()
  expect(deps.connect).not.toHaveBeenCalled()
  await expect(stopSharedCodexSession(row, () => false, deps)).rejects.toThrow('cancelled')
})
it.each(['live', 'recycled', 'bound', 'transcript', 'resuming', 'unreadable'])('does not treat an unbound client as safely exited when %s', async state => {
  row.sessionId = ''
  row.processIdentity = { pid: 99, executable: 'node', startMarker: 'client' }
  if (state === 'live' || state === 'recycled') {
    vi.mocked(deps.rows).mockResolvedValue([
      ...(await deps.rows())!, { ...row.processIdentity, parentPid: 1, args: 'node /bin/codex',
        startMarker: state === 'live' ? 'client' : 'replacement' },
    ])
  }
  if (state === 'bound') row.boundAt = 1
  if (state === 'transcript') row.transcriptPath = '/history'
  if (state === 'resuming') row.resumeOnly = true
  if (state === 'unreadable') vi.mocked(deps.rows).mockResolvedValue(null)
  await expect(stopSharedCodexSession(row, () => true, deps)).rejects.toThrow(state === 'unreadable' ? 'verify' : 'identify')
  expect(deps.connect).not.toHaveBeenCalled()
})
it('rechecks cancellation after confirming an unused conversation', async () => {
  row.sessionId = ''
  row.processIdentity = { pid: 99, executable: 'codex', startMarker: 'born' }
  vi.mocked(deps.rows).mockResolvedValue([
    ...(await deps.rows())!, { ...row.processIdentity, parentPid: 1, args: 'codex' },
  ])
  let current = true
  await expect(stopSharedCodexSession(row, () => current, deps, async () => {
    current = false
    return true
  })).rejects.toThrow('cancelled')
  expect(deps.connect).not.toHaveBeenCalled()
})
it('leaves a process-owned conversation and an unrelated shared server untouched', async () => {
  loaded = false
  await stopSharedCodexSession(row, () => true, deps)
  expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/read'])
  expect(close).toHaveBeenCalledOnce()
})
it('does not interrupt a completed turn or pause a completed goal', async () => {
  const normal = request.getMockImplementation()!
  request.mockImplementation(async (method: string) => {
    if (method === 'thread/goal/get') return { goal: null }
    if (method === 'thread/turns/list') return { data: [{ status: 'completed' }] }
    return normal(method)
  })
  await stopSharedCodexSession(row, () => true, deps)
  expect(request.mock.calls.some(([method]) => method === 'turn/interrupt' || method === 'thread/goal/set')).toBe(false)
})
it.each(['thread/read', 'thread/goal/get', 'thread/goal/set', 'thread/turns/list', 'turn/interrupt'])('honors a cancellation after %s before the next destructive request', async boundary => {
  let current = true
  const normal = request.getMockImplementation()!
  request.mockImplementation(async (method: string) => { const result = await normal(method); if (method === boundary) current = false; return result })
  await expect(stopSharedCodexSession(row, () => current, deps)).rejects.toThrow('cancelled')
  expect(request.mock.calls.some(([method]) => method === 'thread/archive')).toBe(false)
  expect(close).toHaveBeenCalledOnce()
})
it('restores the archived history even when reopened while archive was in flight', async () => {
  let current = true
  const normal = request.getMockImplementation()!
  request.mockImplementation(async (method: string) => { const result = await normal(method); if (method === 'thread/archive') current = false; return result })
  await expect(stopSharedCodexSession(row, () => current, deps)).rejects.toThrow('cancelled')
  expect(request).toHaveBeenCalledWith('thread/unarchive', { threadId: row.sessionId })
})
it.each(['before', 'after'])('rejects the wrong conversation %s archive', async when => {
  const normal = request.getMockImplementation()!
  request.mockImplementation(async (method: string) => method === 'thread/read' && (when === 'before' || !loaded)
    ? { thread: { id: 'somebody-else', status: { type: 'notLoaded' } } } : normal(method))
  await expect(stopSharedCodexSession(row, () => true, deps)).rejects.toThrow(when === 'before' ? 'different conversation' : 'confirm')
  expect(close).toHaveBeenCalledOnce()
})
it('does not claim a shared thread stopped when it remains loaded', async () => {
  const normal = request.getMockImplementation()!
  request.mockImplementation(async (method: string) => { const result = await normal(method); loaded = true; return result })
  await expect(stopSharedCodexSession(row, () => true, deps)).rejects.toThrow('confirm')
})
it('closes the connection and leaves the terminal alone on a failed API request', async () => {
  request.mockRejectedValueOnce(new Error('disconnected'))
  await expect(stopSharedCodexSession(row, () => true, deps)).rejects.toThrow('disconnected')
  expect(close).toHaveBeenCalledOnce()
})

it('returns history to sessions even if archive times out after being applied', async () => {
  const normal = request.getMockImplementation()!
  request.mockImplementation(async (method: string) => {
    const result = await normal(method)
    if (method === 'thread/archive') throw new Error('timed out')
    return result
  })
  await expect(stopSharedCodexSession(row, () => true, deps)).rejects.toThrow('timed out')
  expect(request).toHaveBeenCalledWith('thread/unarchive', { threadId: row.sessionId })
  expect(close).toHaveBeenCalledOnce()
})

it.each(['codex --no-daemon resume conversation', '/usr/bin/node /bin/codex.js --no-daemon resume conversation'])('does not contact an unrelated shared server for an owned TUI: %s', async args => {
  row.processIdentity = { pid: 99, startMarker: 'born', executable: 'codex' }
  vi.mocked(deps.rows).mockResolvedValue([{ ...row.processIdentity, parentPid: 1, args }])
  await stopSharedCodexSession(row, () => true, deps)
  expect(deps.connect).not.toHaveBeenCalled()
})

it.each(['codex --remote ws://fixture.invalid resume conversation', 'codex resume --remote=ws://fixture.invalid conversation'])('refuses to claim remote work stopped: %s', async args => {
  row.processIdentity = { pid: 99, startMarker: 'born', executable: 'codex' }
  vi.mocked(deps.rows).mockResolvedValue([{ ...row.processIdentity, parentPid: 1, args }])
  vi.mocked(deps.daemonIdentity).mockResolvedValue(null)
  await expect(stopSharedCodexSession(row, () => true, deps)).rejects.toThrow('remote Codex server')
  expect(deps.connect).not.toHaveBeenCalled()
})
it('does not bypass a remote server for an unbound chat', async () => {
  row.sessionId = ''
  row.processIdentity = { pid: 99, executable: 'codex', startMarker: 'born' }
  vi.mocked(deps.rows).mockResolvedValue([{ ...row.processIdentity, parentPid: 1, args: 'codex --remote=ws://fixture.invalid' }])
  const confirmUnused = vi.fn(async () => true)
  await expect(stopSharedCodexSession(row, () => true, deps, confirmUnused)).rejects.toThrow('remote Codex server')
  expect(confirmUnused).not.toHaveBeenCalled()
  expect(deps.connect).not.toHaveBeenCalled()
})
