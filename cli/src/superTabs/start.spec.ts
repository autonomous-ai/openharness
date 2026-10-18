import { expect, it, vi } from 'vitest'
import { startAgent } from './start.js'
const where = { port: 14001, machineId: 'lead-machine', dataDir: '/fixture' }
function fixture() {
  const start = { creationId: 'super-native-receipt', request: { machineId: 'target', conversationId: 'group', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }, dispatched: false }
  let nativeState = 'unknown', lostJoin = false
  const scoped = vi.fn(async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (payload.action === 'startStatus') return { ok: true, value: structuredClone(start) }
    const cmd = payload.command as Record<string, unknown>
    if (cmd.type === 'agent.startDispatch') start.dispatched = true
    if (cmd.type === 'agent.started' && lostJoin) { lostJoin = false; throw new Error('Join interrupted') }
    return { ok: true, value: { result: cmd.type === 'agent.start' ? { startId: 'start' } : { agentId: 'worker' } } }
  })
  const request = vi.fn(async (type: string): Promise<Record<string, unknown>> => {
    if (type === 'agent_create_status') return { state: nativeState, ...(nativeState === 'created' ? { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:fixture-model@high' } } : {}) }
    if (type === 'engines_probe') return { engines: [{ engine: 'claude', installed: true }] }
    if (type === 'usage_read') return { providers: [] }
    if (type === 'super_tabs') return { ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 100, projectDiskFreeBytes: 1000 }, tools: { git: true }, devices: {} }
    if (type === 'agent_create') { nativeState = 'created'; return { state: 'created', agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:fixture-model@high' } } }
    throw new Error(type)
  })
  const close = vi.fn(), open = vi.fn(async () => ({ machineId: 'target', request, close }))
  return { scoped, start, request, open, close, loseJoin: () => { lostJoin = true }, forget: () => { nativeState = 'unknown' } }
}
it('uses one native creation receipt and joins its captured group after a lost join reply', async () => {
  const f = fixture(); f.loseJoin()
  const input = { action: 'start', tabId: 'tab', operationId: 'user-intent', request: f.start.request }
  await expect(startAgent(input, f.scoped, where, f.open)).rejects.toThrow('Join interrupted')
  expect(f.close).toHaveBeenCalledOnce()
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ ok: true, harnessId: 'native', agentId: 'worker' })
  const launches = f.request.mock.calls.filter(c => c[0] === 'agent_create')
  expect(launches).toHaveLength(1)
  expect(f.open).toHaveBeenCalledWith(where, 'target')
  const commands = f.scoped.mock.calls.map(c => c[0].command as Record<string, unknown>).filter(Boolean)
  expect(commands.find(c => c.type === 'agent.started')).toMatchObject({ startId: 'start', harnessId: 'native', configuration: { engine: 'claude', model: 'fixture-model', effort: 'high' } })
  expect(commands.some(c => c.type === 'work.assign')).toBe(false)
})
it('does not recreate when a previously dispatched start loses its native receipt', async () => {
  const f = fixture(); f.start.dispatched = true
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ error: 'START_UNCERTAIN', creationId: 'super-native-receipt' })
  expect(f.request.mock.calls.map(c => c[0])).toEqual(['agent_create_status'])
})
it('withholds native creation when capacity or authority cannot be verified', async () => {
  const f = fixture()
  f.start.request.requirements.diskBytes = 2000
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', allowed: false })
  expect(f.request.mock.calls.some(c => c[0] === 'agent_create')).toBe(false)
  f.scoped.mockResolvedValueOnce({ error: 'FORBIDDEN', detail: 'Machine sharing was withdrawn.' })
  await expect(startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).rejects.toThrow('withdrawn')
  expect(f.open).toHaveBeenCalledOnce()
})
