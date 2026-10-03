import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexActivityReader, RuntimeActivityReader } from './runtimeActivity.js'
import { registry, type RegisteredSession } from './registry.js'

function session(): RegisteredSession {
  const row = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%600' }], cwd: '/tmp', codexHome: '/tmp/activity-fixture' })!
  Object.assign(row, { sessionId: 'conversation', processIdentity: { pid: 78, startMarker: 'start', executable: 'codex' } })
  return row
}
afterEach(() => { for (const row of registry.list()) registry.removeAgent(row.agentId) })
function control() {
  let now = 1000
  const row = session()
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>): Promise<any> => ({ thread: { id: row.sessionId, status: { type: 'active' } } }))
  const close = vi.fn()
  const rows = vi.fn(async () => [{ ...row.processIdentity!, parentPid: 1, args: 'codex resume conversation' }])
  const connect = vi.fn(async () => ({ request, close }))
  const reader = new CodexActivityReader({ connect, rows, now: () => now })
  return { reader, row, request, close, rows, connect, advance: () => { now += 60_001 } }
}
describe('Codex activity RPC', () => {
  it.each([['active', 'working'], ['idle', 'idle'], ['notLoaded', 'unknown'], ['systemError', 'unknown']])(
    'reads %s without mutating or resuming the conversation', async (state, expected) => {
      const t = control(); t.request.mockResolvedValue({ thread: { id: t.row.sessionId, status: { type: state } } })
      expect(await t.reader.read(t.row)).toBe(expected)
      expect(t.request.mock.calls).toEqual([['thread/read', { threadId: t.row.sessionId }]])
      t.reader.close(); await Promise.resolve(); expect(t.close).toHaveBeenCalledOnce()
    })
  it.each(['--no-daemon', '--remote=ws://example.invalid'])('does not query the wrong server for %s', async option => {
    const t = control(); t.rows.mockResolvedValue([{ ...t.row.processIdentity!, parentPid: 1, args: `codex ${option} resume conversation` }])
    expect(await t.reader.read(t.row)).toBe('unknown'); expect(t.connect).not.toHaveBeenCalled()
  })
  it('rejects PID reuse and a different thread', async () => {
    const t = control(); t.rows.mockResolvedValueOnce([{ ...t.row.processIdentity!, startMarker: 'different', parentPid: 1, args: 'codex' }])
    expect(await t.reader.read(t.row)).toBe('unknown'); expect(t.connect).not.toHaveBeenCalled()
    t.advance(); t.request.mockResolvedValue({ thread: { id: 'other', status: { type: 'active' } } })
    expect(await t.reader.read(t.row)).toBe('unknown'); t.reader.close()
  })
  it('shares connections and backs off unavailable servers', async () => {
    const t = control()
    await Promise.all([t.reader.read(t.row), t.reader.read(t.row)])
    expect(t.connect).toHaveBeenCalledOnce(); expect(t.rows).toHaveBeenCalledOnce()
    t.request.mockRejectedValueOnce(new Error('socket hangup'))
    expect(await t.reader.read(t.row)).toBe('unknown')
    expect(await t.reader.read(t.row)).toBe('unknown'); expect(t.connect).toHaveBeenCalledOnce()
    t.advance(); expect(await t.reader.read(t.row)).toBe('working'); expect(t.connect).toHaveBeenCalledTimes(2)
    t.reader.close()
  })
})
describe('live terminal fallback', () => {
  it('requires changing busy indicators and refuses a frozen footer or prose', async () => {
    const row = session()
    const capture = vi.fn(async () => '• Working (30s · esc to interrupt)\n› \x1b[2mAsk Codex to do anything\x1b[0m\n? for shortcuts')
    const reader = new RuntimeActivityReader({ codex: async () => 'unknown', capture })
    expect(await reader.read(row)).toBe('unknown')
    expect(await reader.read(row)).toBe('unknown')
    capture.mockResolvedValue('• Working (35s · esc to interrupt)\n› \x1b[2mAsk Codex to do anything\x1b[0m\n? for shortcuts')
    expect(await reader.read(row)).toBe('working')
    capture.mockResolvedValue('The answer says Working (40s · esc to interrupt).')
    expect(await reader.read(row)).toBe('unknown')
  })
  it('recognizes the actual cmd p stopped goal without requiring or generating a transcript end', async () => {
    const row = session()
    const capture = vi.fn(async () => '■ Conversation interrupted\n› \x1b[2mAsk Codex to do anything\x1b[0m\n  GPT-6-Astra max · ~/work Goal stalled (/goal resume)\n? for shortcuts')
    const reader = new RuntimeActivityReader({ codex: async () => 'unknown', capture })
    expect(await reader.read(row)).toBe('unknown')
    expect(await reader.read(row)).toBe('idle')
    row.processIdentity = { ...row.processIdentity!, startMarker: 'replacement' }
    expect(await reader.read(row)).toBe('unknown')
    capture.mockResolvedValue('› draft text\nGoal stalled (/goal resume)\n? for shortcuts')
    expect(await reader.read(row)).toBe('unknown')
  })
  it('prefers structured status and leaves unsupported engines unknown', async () => {
    const row = session(); const capture = vi.fn(async () => null)
    const codex = vi.fn(async () => 'working' as const)
    const reader = new RuntimeActivityReader({ codex, capture })
    expect(await reader.read(row)).toBe('working'); expect(capture).not.toHaveBeenCalled()
    const unsupported = new RuntimeActivityReader({ codex: async () => 'unknown', capture })
    row.engine = 'pi'; expect(await unsupported.read(row)).toBe('unknown'); expect(capture).not.toHaveBeenCalled()
  })
})
