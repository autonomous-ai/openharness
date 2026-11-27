import { afterEach, expect, it, vi } from 'vitest'
import { processLaunchArgs } from '../../lib/processTable.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { createGridAssignments } from './gridAssignments.js'

vi.mock('../../lib/processTable.js', () => ({ processLaunchArgs: vi.fn(async () => '') }))
const assignment = { baseUrl: 'https://grid.example/relay', model: 'chosen' }
const ON_GRID = `-c model_providers.grid.base_url="${assignment.baseUrl}" -m chosen`
const row = (id = 'a'): RegisteredSession => ({ agentId: id, engine: 'codex', sessionId: 'session', registeredAt: 1, boundAt: 2,
  active: true, primaryRuntimeKey: 'tmux:%1', processIdentity: { pid: 123, startMarker: 'start', executable: 'codex' },
  grid: assignment } as RegisteredSession)
const observed = (session: RegisteredSession, marked = true): DiscoveredTerminalAgent => ({ engine: session.engine, processIdentity: session.processIdentity,
  ...(marked ? { gridProcess: { key: 'old', engine: 'codex', args: `model_providers.grid.base_url="${assignment.baseUrl}"  -m chosen` } } : {}) } as DiscoveredTerminalAgent)
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
  s.rows.push({ ...row('b'), processIdentity: { pid: 124, startMarker: 'start', executable: 'codex' }, grid: undefined })
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
    if (change === 'engine') current.engine = 'pi'
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

it("refreshes a committed Codex swap in the background from its argv alone, with the same stale-answer guards", async () => {
  const s = setup()
  vi.mocked(processLaunchArgs).mockResolvedValueOnce(`codex --prompt private ${ON_GRID}`)
  expect(s.service.refresh(s.rows[0])).toBeUndefined()
  s.service.refresh(s.rows[0])
  await flush()
  expect(processLaunchArgs).toHaveBeenCalledExactlyOnceWith(s.rows[0].processIdentity)
  expect(s.pending[0].processes).toEqual([{ key: expect.any(String), engine: 'codex', args: `model_providers.grid.base_url="${assignment.baseUrl}"  -m chosen` }])
  s.answer()
  await flush()
  expect(s.rows[0].grid).toBeNull()
})

it.each(['claude', 'hermes', 'grok', 'copilot', 'opencode'] as const)('reads no command line of %s after a swap, its grid being in none, and keeps the grid its launch recorded', async engine => {
  const s = setup()
  s.rows[0] = { ...s.rows[0], engine, processIdentity: { pid: 123, startMarker: 'start', executable: engine } }
  s.service.refresh(s.rows[0])
  await flush()
  expect(processLaunchArgs).not.toHaveBeenCalled()
  expect(s.models.gridAssignments).not.toHaveBeenCalled()
  expect(s.registry.updateProcessIdentity).not.toHaveBeenCalled()
  expect(s.rows[0].grid).toEqual(assignment)
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
  changed.gridProcess!.args = 'model_providers.grid.base_url="https://other.example/relay"'
  s.service.observe([changed])
  await flush()
  s.answer(1)
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  s.answer(2)
  await flush()
  expect(s.rows[0].grid).toBeNull()
})

it('a process that is gone or a rejected read keeps the assignment; a plain Codex launch clears it', async () => {
  const s = setup()
  // '' is a table that could not be read, or a process no longer in it: no finding.
  vi.mocked(processLaunchArgs).mockResolvedValueOnce('')
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  vi.mocked(processLaunchArgs).mockRejectedValueOnce(new Error('gone'))
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  vi.mocked(processLaunchArgs).mockResolvedValueOnce('codex -m gpt-5')
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.rows[0].grid).toBeNull()
  expect(s.models.gridAssignments).not.toHaveBeenCalled()
})

it('reads a Pi from how it was launched, and only when that names a grid', async () => {
  // Pi renames its process, and `ps` then shows no argv (2026-10-14): what is left is its launcher's command line.
  // Moved onto a grid, that names the extension, and the switch is confirmed at once.
  const s = setup()
  s.rows[0] = { ...s.rows[0], engine: 'pi', grid: undefined }
  vi.mocked(processLaunchArgs).mockResolvedValueOnce("zsh -lic . 'launch.sh' harness-engine /w /bin/pi --session s --model grid/chosen -e /c/grid-provider.ts")
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.pending[0].processes).toEqual([{ key: expect.any(String), engine: 'pi', args: '-e /c/grid-provider.ts --model grid/chosen' }])
  s.answer(0, assignment)
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  // A launch naming no extension (a Pi from before it) says nothing of its grid: still not known.
  vi.mocked(processLaunchArgs).mockResolvedValueOnce('zsh -lic . launch.sh harness-engine /w /bin/pi --session s')
  s.service.refresh(s.rows[0])
  await flush()
  expect(s.rows[0].grid).toEqual(assignment)
  expect(s.models.gridAssignments).toHaveBeenCalledOnce()
})
