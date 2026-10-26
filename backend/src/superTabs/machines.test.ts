import { describe, expect, it } from 'vitest'
import { createSuperTab, SuperTabError, type AgentStart, type AgentStartRequest, type SuperTabState } from './model.js'
import { admitMachineStart, machineSlots, machineObservationSchema, servedLocalModels, type ContributedMachine } from './machines.js'

const NOW = 1_000_000
const requirements = { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 50, tools: ['git'], devices: [], quotaRequired: false }
const observation = { generation: 'o', receivedAt: NOW, resources: { cpuPercent: 1, memoryTotalBytes: 1, memoryUsedBytes: 1, diskFreeBytes: 1, diskTotalBytes: 1,
  projectDiskFreeBytes: 1, deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] }

it('accepts optional tool probe failures while preserving older observations', () => {
  const { receivedAt: _receivedAt, ...sent } = observation
  expect(machineObservationSchema.safeParse(sent).success).toBe(true)
  expect(machineObservationSchema.safeParse({ ...sent, tools: { git: true }, toolProbeErrors: { flutter: 'interactive shell timed out' } }).success).toBe(true)
})

it('takes a model that is starting, and never counts it as served for a Builder', () => {
  const { receivedAt: _receivedAt, ...sent } = observation
  const model = { grid: 'swarm-0123456789ab', model: 'qwen3', kind: 'local' as const }
  expect(machineObservationSchema.safeParse({ ...sent, localModels: [{ ...model, starting: true }] }).success).toBe(true)
  const state: SuperTabState = createSuperTab('tab', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.localModels = { grid: model.grid, enabled: true }
  const pool = (starting: boolean) => [{ machineId: 'host', name: 'Mac', contributorId: 'owner', membershipGeneration: 'tab', generation: 'g1',
    cwd: '/x', scope: 'swarm' as const, engines: ['claude'], maxAgents: 2, paused: false,
    observation: { ...observation, localModels: [{ ...model, ...(starting ? { starting } : {}) }] } }]
  state.machines = pool(true) as never
  expect(servedLocalModels(state, NOW)).toEqual([])
  state.machines = pool(false) as never
  expect(servedLocalModels(state, NOW).map(l => l.model)).toEqual(['qwen3'])
})

it('accepts the served models Builders are not offered, with why', () => {
  const { receivedAt: _receivedAt, ...sent } = observation
  const refused = { grid: 'swarm-0123456789ab', model: 'llama3.2:3b', name: 'llama3.2:3b', why: 'llama3.2:3b is too small for a coding agent.' }
  expect(machineObservationSchema.safeParse({ ...sent, refusedModels: [refused] }).success).toBe(true)
  expect(machineObservationSchema.safeParse({ ...sent, refusedModels: [{ ...refused, why: '' }] }).success).toBe(false)
  expect(machineObservationSchema.safeParse({ ...sent, refusedModels: [{ ...refused, extra: 1 }] }).success).toBe(false)
  expect(machineObservationSchema.safeParse({ ...sent, refusedModels: Array(17).fill(refused) }).success).toBe(false)
})

it('accepts what a machine is ready for, and a reading from before it', () => {
  const { receivedAt: _receivedAt, ...sent } = observation
  const readiness = { engines: [{ engine: 'claude', installed: true, signedIn: false }, { engine: 'codex', installed: true, signedIn: null }],
    checkouts: [{ folder: 'p1', repository: 'github.com/acme/app', git: true, push: false }, { folder: 'p2', repository: null, git: false, push: null }] }
  expect(machineObservationSchema.safeParse(sent).success).toBe(true)
  expect(machineObservationSchema.safeParse({ ...sent, readiness }).success).toBe(true)
  expect(machineObservationSchema.safeParse({ ...sent, readiness: {} }).success).toBe(true)
  expect(machineObservationSchema.safeParse({ ...sent, readiness: { ...readiness, extra: 1 } }).success).toBe(false)
  expect(machineObservationSchema.safeParse({ ...sent, readiness: { checkouts: [{ ...readiness.checkouts[0], folder: '../p1' }] } }).success).toBe(false)
  expect(machineObservationSchema.safeParse({ ...sent, readiness: { checkouts: Array(65).fill(readiness.checkouts[0]) } }).success).toBe(false)
  expect(machineObservationSchema.safeParse({ ...sent, readiness: { engines: [{ engine: 'claude', installed: 'yes', signedIn: null }] } }).success).toBe(false)
})

function setup(machine: Partial<ContributedMachine> = {}) {
  const state: SuperTabState = createSuperTab('tab', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.machines = [{ machineId: 'host', name: 'Studio Mac', contributorId: 'owner', membershipGeneration: 'tab', generation: 'g1',
    cwd: '/data/swarm-projects/tab', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 2, paused: false, observation, ...machine }]
  const request = (extra: Partial<AgentStartRequest> = {}): AgentStartRequest => ({ conversationId: 'lead', machineId: 'host', engine: 'claude',
    name: 'Builder', cwd: '/data/swarm-projects/tab/lead', worktree: true, requirements, ...extra })
  return { state, request }
}
/** The refusal a start meets, or null when it is admitted. */
function refusal(state: SuperTabState, request: AgentStartRequest, start?: AgentStart): SuperTabError | null {
  try { admitMachineStart(state, request, NOW, start); return null }
  catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** What the refusal lists as refused, after its opening sentence. */
const refused = (error: SuperTabError) => error.message.split('Refused: ')[1] ?? ''

describe('a start on a contributed machine', () => {
  it.each(['claude', 'codex'])('admits full permissions for %s, including dispatch rechecks', engine => {
    const f = setup()
    expect(refusal(f.state, f.request({ engine, permissionMode: 'full' }))).toBeNull()
    expect(refusal(f.state, f.request({ engine, permissionMode: 'full' }), { poolGeneration: 'g1' } as AgentStart)).toBeNull()
  })

  it.each(['ask', 'auto', 'readOnly', 'bypass'])('refuses permission mode %s with an accurate explanation', permissionMode => {
    const f = setup()
    const error = refusal(f.state, f.request({ permissionMode }))!
    expect(error).toMatchObject({ code: 'OUTSIDE_CONTRIBUTION' })
    expect(error.message).toContain('permissionMode (only full is accepted; leave it out to use the machine’s default)')
  })

  it('is admitted inside the contribution: its project folder, one of its engines, no account settings', () => {
    const f = setup()
    expect(refusal(f.state, f.request())).toBeNull()
    expect(refusal(f.state, f.request({ engine: 'codex' }))).toBeNull()
  })

  it('names the folder this project uses when the start asks for another', () => {
    const f = setup()
    const error = refusal(f.state, f.request({ cwd: '/Users/lead/work/repo' }))!
    expect(error).toMatchObject({ code: 'OUTSIDE_CONTRIBUTION', status: 403 })
    expect(error.message).toContain('Studio Mac')
    expect(error.message).toContain('Refused: cwd (this project uses /data/swarm-projects/tab/lead on it).')
    expect(refused(error)).not.toContain('engine')
    expect(error.message).not.toContain('/Users/lead/work/repo')
  })

  it('names the project\'s own checkout when the lead\'s machine is the one contributed', () => {
    const f = setup()
    delete f.state.projects
    f.state.project = { machineId: 'host', cwd: '/Users/lead/work/repo', repositoryUrl: null }
    expect(refusal(f.state, f.request({ cwd: '/data/swarm-projects/tab/lead' }))!.message).toContain('this project uses /Users/lead/work/repo on it')
    expect(refusal(f.state, f.request({ cwd: '/Users/lead/work/repo' }))).toBeNull()
  })

  it('lists the engines the machine contributes when the start asks for another', () => {
    const f = setup()
    const error = refusal(f.state, f.request({ engine: 'opencode' }))!
    expect(error).toMatchObject({ code: 'OUTSIDE_CONTRIBUTION', status: 403 })
    expect(error.message).toContain('Refused: engine (it contributes claude, codex).')
    expect(refused(error)).not.toContain('cwd')
    expect(error.message).not.toContain('opencode')
    f.state.machines![0]!.engines = []
    expect(refusal(f.state, f.request())!.message).toContain('it contributes no engines')
  })

  it('uses only installed Claude or Codex from an older contribution with unsupported engines', () => {
    const f = setup()
    const pool = f.state.machines![0]!
    pool.engines = ['opencode', 'kilo']
    pool.observation = { ...observation, quotas: [{ engine: 'claude', known: false, windows: [] }] }
    expect(refusal(f.state, f.request({ engine: 'claude' }))).toBeNull()
    expect(refusal(f.state, f.request({ engine: 'codex' }))).toMatchObject({ code: 'OUTSIDE_CONTRIBUTION' })
    expect(refusal(f.state, f.request({ engine: 'opencode' }))).toMatchObject({ code: 'OUTSIDE_CONTRIBUTION' })
  })

  it.each(['codexHome', 'gridModel', 'gridName'] as const)('names %s as the refused account setting, and not its value', field => {
    const f = setup()
    const error = refusal(f.state, f.request({ [field]: '/Users/lead/.secret-profile' }))!
    expect(error).toMatchObject({ code: 'OUTSIDE_CONTRIBUTION', status: 403 })
    expect(error.message).toContain(`Refused: ${field} (it runs with its own default account settings, so leave it out).`)
    for (const other of ['cwd', 'engine', ...['codexHome', 'gridModel', 'gridName', 'permissionMode'].filter(name => name !== field)]) {
      expect(refused(error)).not.toContain(other)
    }
    expect(error.message).not.toContain('secret-profile')
  })

  it('names every refused field at once', () => {
    const f = setup()
    const error = refusal(f.state, f.request({ cwd: '/elsewhere', engine: 'opencode', codexHome: '/h', permissionMode: 'bypass' }))!
    expect(error.message).toContain('cwd (this project uses /data/swarm-projects/tab/lead on it)')
    expect(error.message).toContain('engine (it contributes claude, codex)')
    expect(error.message).toContain('codexHome (it runs with its own default account settings, so leave it out); permissionMode (only full is accepted')
  })

  it('says nothing of other projects or machines', () => {
    const f = setup()
    f.state.projects = [
      { id: 'lead', name: 'Team', ownerId: 'owner', leadConversationId: 'lead', visibility: 'public', members: [], updateMinutes: 5 },
      { id: 'other', name: 'Private', ownerId: 'owner', leadConversationId: 'other', visibility: 'private', members: [], updateMinutes: 5,
        repository: { machineId: 'host', cwd: '/Users/someone-else/private-repo', repositoryUrl: null } },
    ]
    f.state.machines!.push({ ...f.state.machines![0]!, machineId: 'laptop', name: 'Someone else\'s laptop', cwd: '/Users/someone-else/.harness/swarm-projects/tab' })
    const error = refusal(f.state, f.request({ cwd: '/elsewhere', codexHome: '/h' }))!
    expect(error.message).not.toContain('someone-else')
    expect(error.message).not.toContain('private-repo')
    expect(error.message).not.toContain('laptop')
  })

  it('gives the same answer when the start is checked again before it is dispatched', () => {
    const f = setup()
    const start = { poolGeneration: 'g1' } as AgentStart
    expect(refusal(f.state, f.request({ permissionMode: 'bypass' }), start)!.message).toContain('Refused: permissionMode')
    expect(refusal(f.state, f.request(), start)).toBeNull()
  })
})


it('keeps durable release receipts authoritative over stale observations and retained starts', () => {
  const f = setup(), pool = f.state.machines![0]!
  pool.observation = { ...observation, runningHarnessIds: ['finished'] }
  f.state.starts = [{ request: { machineId: 'host' }, harnessId: 'finished' } as AgentStart]
  f.state.releasedHarnesses = [{ machineId: 'host', harnessId: 'finished' }]
  expect(machineSlots(f.state, pool)).toBe(0)
  f.state.agents.push({ machineId: 'host', harnessId: 'finished' } as never)
  expect(machineSlots(f.state, pool)).toBe(0)
  f.state.harnessReservations = [{ machineId: 'host', harnessId: 'finished', generation: 'new-runtime', renewed: true }]
  expect(machineSlots(f.state, pool)).toBe(1)
})
