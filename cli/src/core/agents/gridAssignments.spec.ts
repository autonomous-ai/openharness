import { afterEach, expect, it, vi } from 'vitest'
import { readProcessEnv } from '../../lib/processEnv.js'
import { processArgvIsBoundaryFaithful, processRows } from '../../lib/tmux.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { createGridAssignments } from './gridAssignments.js'

vi.mock('../../lib/processEnv.js', () => ({ readProcessEnv: vi.fn(async () => ({ ANTHROPIC_BASE_URL: 'https://grid.example/relay' })) }))
vi.mock('../../lib/tmux.js', () => ({
  argvTokens: vi.fn((args: string) => args.split(' ')),
  engineProcessMatchScore: vi.fn((row: { args: string }) => row.args.startsWith('node ') ? 4 : 0),
  processRows: vi.fn(async () => []),
  processArgvIsBoundaryFaithful: vi.fn(() => true),
}))
const assignment = { baseUrl: 'https://grid.example/relay', model: 'chosen' }
const row = (id = 'a'): RegisteredSession => ({ agentId: id, engine: 'claude', sessionId: 'session', registeredAt: 1, boundAt: 2,
  active: true, primaryRuntimeKey: 'tmux:%1', processIdentity: { pid: 123, startMarker: 'start', executable: 'claude' },
  grid: assignment } as RegisteredSession)
const observed = (session: RegisteredSession, marked = true): DiscoveredTerminalAgent => ({ engine: session.engine, processIdentity: session.processIdentity,
  ...(marked ? { gridProcess: { key: 'old', engine: 'claude', env: { ANTHROPIC_BASE_URL: assignment.baseUrl }, args: '' } } : {}) } as DiscoveredTerminalAgent)
const flush = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve() }
function setup() {
  let rows = [row()]
  let revision = 1
  const pending: Array<{ processes: any[]; resolve: (value: any) => void; reject: (error: Error) => void }> = []
  const models = { gridAssignments: vi.fn((processes) => new Promise<any[]>((resolve, reject) => pending.push({ processes, resolve, reject }))) }
  const registry = { list: () => rows, byAgent: (id: string) => rows.find(row => row.agentId === id),
    updateProcessIdentity: vi.fn((id, _identity, _gateway, grid) => { rows.find(row => row.agentId === id)!.grid = grid; return true }) }
  const announce = vi.fn()
  const service = createGridAssignments({ models: () => models, registry, revision: () => revision, announce, waitMs: 50 })
  const answer = (index = 0, grid: typeof assignment | null = null) => pending[index].resolve(pending[index].processes.map(p => ({ key: p.key, assignment: grid })))
  return { service, models, registry, announce, pending, answer, get rows() { return rows }, set rows(value) { rows = value }, bump: () => ++revision }
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

it('batches fresh observations after binding, never blocks, and announces only changed assignments', async () => {
  const s = setup()
  s.rows.push({ ...row('b'), processIdentity: { pid: 124, startMarker: 'start', executable: 'claude' }, grid: undefined })
  expect(s.service.observe(s.rows.map(row => observed(row)))).toBeUndefined()
  await flush()
  expect(s.models.gridAssignments).toHaveBeenCalledOnce()
  expect(s.pending[0].processes).toHaveLength(2)
  expect(s.announce).not.toHaveBeenCalled()
  s.answer(0, assignment)
  await flush()
  expect(s.announce).toHaveBeenCalledExactlyOnceWith(s.rows[1])
  s.service.observe(s.rows.map(row => observed(row)))
  await flush()
  s.answer()
  s.answer(1)
  await flush()
  expect(s.rows.every(row => row.grid === null)).toBe(true)
})

it.each(['down', 'malformed', 'timeout', 'late-rejection'] as const)('keeps the last assignment when models is %s', async failure => {
  vi.useFakeTimers()
  const s = setup()
  s.service.observe([observed(s.rows[0])])
  await flush()
  if (failure === 'down') s.pending[0].reject(new Error('down'))
  else if (failure === 'malformed') s.pending[0].resolve([{ key: 'wrong', assignment: null }])
  else {
    await vi.advanceTimersByTimeAsync(51)
    if (failure === 'late-rejection') s.pending[0].reject(new Error('late'))
    else s.answer()
  }
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  expect(s.registry.updateProcessIdentity).not.toHaveBeenCalled()
})

it('contains an unavailable port that throws synchronously', async () => {
  const s = setup()
  const service = createGridAssignments({ models: () => { throw new Error('off') }, registry: s.registry, revision: () => 0, announce: s.announce })
  service.observe([observed(s.rows[0])])
  await flush()
  expect(s.announce).not.toHaveBeenCalled()
})

it.each(['removed', 'registration', 'engine', 'session', 'binding', 'route', 'active', 'process', 'revision', 'new-observation'] as const)(
  'rejects a late answer after %s changed', async change => {
    const s = setup()
    s.service.observe([observed(s.rows[0])])
    await flush()
    const current = s.rows[0]
    if (change === 'removed') s.rows = []
    if (change === 'registration') current.registeredAt++
    if (change === 'engine') current.engine = 'codex'
    if (change === 'session') current.sessionId = 'another'
    if (change === 'binding') current.boundAt = 3
    if (change === 'route') current.primaryRuntimeKey = 'tmux:%2'
    if (change === 'active') current.active = false
    if (change === 'process') current.processIdentity = { ...current.processIdentity!, startMarker: 'new' }
    if (change === 'revision') s.bump()
    if (change === 'new-observation') s.service.observe([observed(current, false)])
    s.answer()
    await flush()
    expect(s.registry.updateProcessIdentity).not.toHaveBeenCalled()
  })

it('does not ask for missing rows, unknown process reads or absent markers, and forgets retired ordering tokens', async () => {
  const s = setup()
  s.service.observe([observed(s.rows[0], false)])
  s.rows = [{ ...row('new'), processIdentity: null } as RegisteredSession]
  s.service.observe([observed(row()), observed(s.rows[0], false)])
  s.service.refresh(s.rows[0])
  s.rows = [row('new')]
  s.service.observe([observed(s.rows[0], false)])
  await flush()
  expect(s.models.gridAssignments).not.toHaveBeenCalled()
})

it('refreshes a committed swap in the background, with the same stale-answer guards', async () => {
  const s = setup()
  expect(s.service.refresh(s.rows[0])).toBeUndefined()
  s.service.refresh(s.rows[0])
  await flush()
  expect(readProcessEnv).toHaveBeenCalledWith(s.rows[0].processIdentity)
  expect(processRows).toHaveBeenCalled()
  s.answer()
  await flush()
  expect(s.rows[0].grid).toBeNull()
})

it('coalesces only unfinished identical observations so a slower-than-discovery answer eventually lands', async () => {
  const s = setup()
  s.rows[0].grid = undefined
  for (let pass = 0; pass < 5; ++pass) {
    s.service.observe([observed(s.rows[0])])
    await flush()
  }
  expect(s.models.gridAssignments).toHaveBeenCalledOnce()
  s.answer(0, assignment)
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  // No completed answer is cached. The very next pass reads the process/config again.
  s.service.observe([observed(s.rows[0])])
  await flush()
  expect(s.models.gridAssignments).toHaveBeenCalledTimes(2)
  const changed = observed(s.rows[0])
  changed.gridProcess!.env.ANTHROPIC_BASE_URL = 'https://other.example/relay'
  s.service.observe([changed])
  await flush()
  s.answer(1)
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  s.answer(2)
  await flush()
  expect(s.rows[0].grid).toBeNull()
})

it('an unreadable or rejected process read keeps the assignment; a confirmed plain launch clears it', async () => {
  const s = setup()
  vi.mocked(readProcessEnv).mockResolvedValueOnce(null)
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  vi.mocked(processRows).mockRejectedValueOnce(new Error('gone'))
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  vi.mocked(readProcessEnv).mockResolvedValueOnce({})
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.rows[0].grid).toBeNull()
  expect(s.models.gridAssignments).not.toHaveBeenCalled()
})

it('refresh reads boundary-faithful argv and otherwise offers models only the executable', async () => {
  const s = setup()
  const identity = s.rows[0].processIdentity!
  const args = 'codex -c model_providers.grid.base_url="https://grid.example/relay/v1" -m chosen'
  vi.mocked(readProcessEnv).mockResolvedValue({})
  vi.mocked(processRows).mockResolvedValue([{ ...identity, parentPid: 1, args }])
  s.rows[0].engine = 'codex'
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.pending[0].processes[0].args).toContain('model_providers.grid.base_url')
  s.answer()
  await flush()
  // Flattened `ps` text is no evidence: a prompt could spell the provider flag. Only the executable is read.
  vi.mocked(processArgvIsBoundaryFaithful).mockReturnValueOnce(false)
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.models.gridAssignments).toHaveBeenCalledOnce()
  expect(s.rows[0].grid).toBeNull()
  vi.mocked(readProcessEnv).mockReset().mockResolvedValue({ ANTHROPIC_BASE_URL: 'https://grid.example/relay' })
  vi.mocked(processRows).mockReset().mockResolvedValue([])
})

it('refresh uses a faithful daemon launcher when the engine replaced its argv with a bare title', async () => {
  const s = setup()
  const identity = { ...s.rows[0].processIdentity!, executable: '/bin/codex' }
  s.rows[0].engine = 'codex'
  s.rows[0].processIdentity = identity
  vi.mocked(readProcessEnv).mockResolvedValue({})
  const parent = { pid: 100, parentPid: 1, startMarker: 'parent', executable: 'sh',
    args: 'sh harness-engine /work /bin/codex -c model_providers.grid.base_url=https://grid.example/relay/v1 -m chosen' }
  vi.mocked(processRows).mockResolvedValue([{ ...identity, parentPid: 100, args: 'codex' }, parent])
  vi.mocked(processArgvIsBoundaryFaithful).mockImplementation(row => row.pid === 100)
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.pending[0].processes[0].args).toContain('model_providers.grid.base_url')
  s.answer()
  await flush()
  // The same launcher text without faithful boundaries is not evidence.
  vi.mocked(processArgvIsBoundaryFaithful).mockReturnValue(false)
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.models.gridAssignments).toHaveBeenCalledOnce()
  vi.mocked(processArgvIsBoundaryFaithful).mockReturnValue(true)
  vi.mocked(readProcessEnv).mockResolvedValue({ ANTHROPIC_BASE_URL: 'https://grid.example/relay' })
  vi.mocked(processRows).mockResolvedValue([])
})

it('refresh uses a faithful Codex wrapper after its native child replaces its argv', async () => {
  const s = setup()
  const identity = { ...s.rows[0].processIdentity!, executable: 'codex' }
  s.rows[0].engine = 'codex'
  s.rows[0].processIdentity = identity
  vi.mocked(readProcessEnv).mockResolvedValue({})
  const parent = { pid: 100, parentPid: 1, startMarker: 'parent', executable: 'node',
    args: 'node /opt/codex/bin/codex -c model_providers.grid.base_url=https://grid.example/relay/v1 -m chosen' }
  vi.mocked(processRows).mockResolvedValue([{ ...identity, parentPid: 100, args: 'codex' }, parent])
  vi.mocked(processArgvIsBoundaryFaithful).mockImplementation(row => row.pid === 100)
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.pending[0].processes[0].args).toContain('model_providers.grid.base_url')
  vi.mocked(processArgvIsBoundaryFaithful).mockReturnValue(true)
  vi.mocked(readProcessEnv).mockResolvedValue({ ANTHROPIC_BASE_URL: 'https://grid.example/relay' })
  vi.mocked(processRows).mockResolvedValue([])
})

it('marks only a local profile launch with its own endpoint, on discovery and on refresh', async () => {
  const s = setup()
  const local = 'http://127.0.0.1:8090/v1'
  s.rows[0].gridLaunch = { networkId: 'local-grid', networkName: 'Node1', baseUrl: local, apiKey: 'local-secret', targetId: 'local:node1:0123456789abcdef' }
  s.service.observe([observed(s.rows[0])])
  await flush()
  expect(s.pending[0].processes[0]).toMatchObject({ trustedBaseUrl: local })
  expect(JSON.stringify(s.pending[0].processes)).not.toContain('local-secret')
  s.answer()
  await flush()
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.pending[1].processes[0]).toMatchObject({ trustedBaseUrl: local })
  s.answer(1)
  await flush()
  // A remote grid launch is recognised by its relay address; nothing is marked trusted for it.
  s.rows[0].gridLaunch = { ...s.rows[0].gridLaunch, targetId: 'remote:my-grid' }
  s.service.observe([observed(s.rows[0])])
  await flush()
  expect(s.pending[2].processes[0]).not.toHaveProperty('trustedBaseUrl')
})
