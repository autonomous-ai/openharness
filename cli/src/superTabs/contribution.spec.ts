import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { ContributionPreparations, prepareContribution, prepareTeamContribution, setMachineAgents } from './contribution.js'
import { SuperTabHostError } from './wire.js'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { swarmReply } from './fixtures/read/index.js'

const GiB = 1024 ** 3
function fixture() {
  const core = fakeCore()
  const state: Record<string, unknown> = { project: { machineId: core.daemon.machineId(), cwd: '/repo', repositoryUrl: 'https://github.com/example/project' } }
  const backend = vi.fn(async (_core: unknown, _method: string, path: string) => swarmReply(path, state))
  const close = vi.fn()
  const request = vi.fn(async () => ({ engines: [
    { engine: 'claude', installed: true, signedIn: true },
    { engine: 'codex', installed: true, signedIn: false },
    { engine: 'pi', installed: true },
    { engine: 'opencode', installed: false },
    { engine: 'terminal', installed: true },
  ] }))
  const open = vi.fn(async () => ({ request, close }))
  const prepare = vi.fn(async () => '/clone')
  const capacity = vi.fn(async () => ({ ok: true, resources: { memoryTotalBytes: 32 * GiB, memoryUsedBytes: 16 * GiB, projectDiskFreeBytes: 100 * GiB } }))
  const deps = { backend, open, prepare, capacity }
  const run = () => prepareContribution(core, { tabId: 'tab' }, deps as never)
  return { run, state, deps, core, request, close }
}
describe('one-field machine preparation', () => {
  // #1726: a whole Swarm is no longer read; its parts are, through the daemon's Swarm reads.
  it('reads the Swarm by parts, as the person', async () => {
    const f = fixture()
    await f.run()
    expect(f.deps.backend.mock.calls.map(c => [c[1], c[2]])).toEqual([['GET', '/api/super-tabs/tab/parts']])
  })
  it('contributes a swarm workspace without asking for a project or cloning one', async () => {
    const f = fixture()
    const dataDir = await mkdtemp(join(tmpdir(), 'harness-swarm-contribution-'))
    try {
      delete f.state.project
      const core = fakeCore({ dataDir })
      const result = await prepareContribution(core, { tabId: 'tab', scope: 'swarm' }, f.deps as never)
      const cwd = join(homedir(), 'harnesses', 'swarms', 'tab')
      expect(result).toMatchObject({ scope: 'swarm', cwd, engines: ['claude', 'codex'] })
      expect((await stat(cwd)).isDirectory()).toBe(true)
      expect(f.deps.prepare).not.toHaveBeenCalled()
      expect(f.deps.capacity).toHaveBeenCalledWith({ cwd, tools: ['git'], devices: [] })
    } finally {
      await rm(join(homedir(), 'harnesses', 'swarms', 'tab'), { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    }
  })
  // A Mac's Harness Team account reads no Swarm as the person (backend lib/teamSession.ts): its Mac's daemon adds it, and it
  // prepares its own swarm workspace without that read ("One machine", docs/plans/2026-10-24-swarm-team-account.md).
  it('prepares a Harness Team account\'s swarm workspace without reading the Swarm, and only that', async () => {
    const f = fixture()
    const dataDir = await mkdtemp(join(tmpdir(), 'harness-swarm-contribution-'))
    try {
      const core = fakeCore({ dataDir })
      const team = { ...f.deps, team: () => true }
      const result = await prepareContribution(core, { tabId: 'tab', scope: 'swarm' }, team as never)
      expect(result).toMatchObject({ scope: 'swarm', cwd: join(homedir(), 'harnesses', 'swarms', 'tab'), engines: ['claude', 'codex'] })
      expect(f.deps.backend).not.toHaveBeenCalled()
      await expect(prepareContribution(core, { tabId: 'tab' }, team as never)).rejects.toThrow('swarm')
    } finally {
      await rm(join(homedir(), 'harnesses', 'swarms', 'tab'), { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('uses the lead project on its host and probes all engines without inventing authentication', async () => {
    const f = fixture()
    expect(await f.run()).toEqual({ ok: true, state: 'ready', cwd: '/repo', engines: ['claude', 'codex'], maxAgents: 8, maxAvailableAgents: 16 })
    expect(f.request).toHaveBeenCalledWith('engines_probe', { engines: ['claude', 'codex'], accounts: true }, 20000)
    expect(f.deps.prepare).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('offers installed Claude and Codex even when the account probe reports no vendor login', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({ engines: [
      { engine: 'claude', installed: true, signedIn: false },
      { engine: 'codex', installed: true, signedIn: false },
      { engine: 'opencode', installed: true, signedIn: true },
      { engine: 'kilo', installed: true, signedIn: true },
    ] })
    expect(await f.run()).toMatchObject({ engines: ['claude', 'codex'] })
  })
  it.each([
    { totalGiB: 32, usedGiB: 30, maxAgents: 8, maxAvailableAgents: 16 },
    { totalGiB: 16, usedGiB: 15, maxAgents: 4, maxAvailableAgents: 8 },
    { totalGiB: 64, usedGiB: 63, maxAgents: 16, maxAvailableAgents: 32 },
    // The Mac Studio: every 2 GB may run an agent, while the starting suggestion stays at today's 16 (Ken, 2026-10-28).
    { totalGiB: 192, usedGiB: 100, maxAgents: 16, maxAvailableAgents: 96 },
    // Every machine may offer 4, whatever its RAM; a small one still starts at what it suggested before.
    { totalGiB: 8, usedGiB: 7, maxAgents: 2, maxAvailableAgents: 4 },
    { totalGiB: 2, usedGiB: 1, maxAgents: 1, maxAvailableAgents: 4 },
    // The server refuses more than 1024 (backend superTabs/commands.ts).
    { totalGiB: 4096, usedGiB: 1, maxAgents: 16, maxAvailableAgents: 1024 },
  ])('suggests $maxAgents of $maxAvailableAgents slots from $totalGiB GiB total RAM', async ({ totalGiB, usedGiB, maxAgents, maxAvailableAgents }) => {
    const f = fixture()
    f.deps.capacity.mockResolvedValueOnce({ ok: true, resources: {
      memoryTotalBytes: totalGiB * GiB, memoryUsedBytes: usedGiB * GiB, projectDiskFreeBytes: 100 * GiB,
    } })
    expect(await f.run()).toMatchObject({ maxAgents, maxAvailableAgents })
  })
  it('keeps the suggestion when free RAM changes but total RAM does not', async () => {
    const f = fixture()
    const slots = async (freeBytes: number) => {
      f.deps.capacity.mockResolvedValueOnce({ ok: true, resources: { memoryTotalBytes: 32 * GiB, memoryUsedBytes: 32 * GiB - freeBytes, projectDiskFreeBytes: 100 * GiB } })
      return (await f.run() as { maxAgents?: number }).maxAgents
    }
    expect(await slots(5.3 * GiB)).toBe(8)
    expect(await slots(GiB)).toBe(8)
    expect(await slots(30 * GiB)).toBe(8)
  })
  it('prepares the repository on another machine and reuses an existing contribution', async () => {
    const f = fixture(); (f.state.project as Record<string, unknown>).machineId = 'another'
    expect(await f.run()).toMatchObject({ cwd: '/clone' })
    expect(f.deps.prepare).toHaveBeenCalledWith({ source: 'remote', repositoryUrl: 'https://github.com/example/project.git', name: 'project' })
    f.state.machines = [{ machineId: f.core.daemon.machineId(), cwd: '/existing' }]
    expect(await f.run()).toMatchObject({ cwd: '/existing' })
    expect(f.deps.prepare).toHaveBeenCalledOnce()
  })
  it('does not clone paths or credential-bearing URLs from shared metadata', async () => {
    const f = fixture()
    for (const repositoryUrl of [null, 'file:///private/repo', 'https://token@github.com/example/project', 'ext::command']) {
      f.state.project = { machineId: 'other', repositoryUrl }
      await expect(f.run()).rejects.toThrow()
    }
    expect(f.deps.prepare).not.toHaveBeenCalled()
    expect(f.deps.open).not.toHaveBeenCalled()
  })
  it('fails when no installed engine or project disk can be read and closes the connection', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({ engines: [] })
    await expect(f.run()).rejects.toThrow('Install Claude Code or Codex')
    f.deps.capacity.mockResolvedValueOnce({ error: 'INVALID_REQUEST' } as never)
    await expect(f.run()).rejects.toThrow('project folder')
    expect(f.close).toHaveBeenCalledTimes(2)
  })
  it('keeps a slow clone in one bounded receipt and preserves errors for polling', async () => {
    let resolve!: (value: Record<string, unknown>) => void
    const prepare = vi.fn(() => new Promise<Record<string, unknown>>(r => { resolve = r }))
    const jobs = new ContributionPreparations(prepare), input = { operationId: 'setup', tabId: 'tab' }
    expect(jobs.read(input)).toMatchObject({ state: 'preparing' })
    expect(jobs.read(input)).toMatchObject({ state: 'preparing' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(jobs.read({ ...input, tabId: 'elsewhere' })).toEqual({ error: 'OPERATION_CONFLICT' })
    resolve({ ok: true, state: 'ready', cwd: '/clone' }); await Promise.resolve()
    expect(jobs.read(input)).toMatchObject({ state: 'ready', cwd: '/clone' })
    jobs.clear(); jobs.read(input); expect(prepare).toHaveBeenCalledTimes(2)
    const failed = new ContributionPreparations(async () => { throw new Error('Clone failed') })
    failed.read(input); await Promise.resolve()
    expect(failed.read(input)).toEqual({ error: 'SETUP_FAILED', detail: 'Clone failed' })
  })
  it('bounds pending setups and refuses invalid receipt keys', () => {
    const jobs = new ContributionPreparations(() => new Promise(() => {}))
    expect(jobs.read({ tabId: 'tab' })).toEqual({ error: 'INVALID_REQUEST' })
    for (let i = 0; i < 32; i++) jobs.read({ tabId: 'tab', operationId: `setup-${i}` })
    expect(jobs.read({ tabId: 'tab', operationId: 'extra' })).toMatchObject({ error: 'SETUP_BUSY' })
  })
})

describe('this Mac\'s Harness Team account preparing through the relay', () => {
  function relay(answers: Record<string, unknown>[]) {
    const core = fakeCore()
    const request = vi.fn(async () => answers.shift() ?? { ok: true, state: 'preparing' })
    const close = vi.fn()
    const open = vi.fn(async () => ({ machineId: 'team-1', request, close }))
    let clock = 0
    const deps = { open, sleep: vi.fn(async () => { clock += 1_000 }), deadlineMs: 3_000, now: () => clock }
    return { core, request, close, open, deps }
  }

  it('asks the team account\'s own daemon, keeps one receipt while it prepares, and closes the line', async () => {
    const r = relay([{ ok: true, state: 'preparing' }, { ok: true, state: 'ready', scope: 'swarm', cwd: '/Users/harnessteam/harnesses/swarms/tab', engines: ['codex'] }])
    expect(await prepareTeamContribution(r.core, { tabId: 'tab', machineId: 'team-1' }, r.deps as never)).toMatchObject({ cwd: '/Users/harnessteam/harnesses/swarms/tab' })
    expect(r.open).toHaveBeenCalledWith({ dataDir: r.core.dataDir, port: r.core.daemon.port, machineId: r.core.daemon.machineId() }, 'team-1')
    const [first, second] = r.request.mock.calls as unknown as [string, Record<string, unknown>][]
    expect(first![1]).toMatchObject({ action: 'prepareContribution', tabId: 'tab', scope: 'swarm' })
    expect(second![1].operationId).toBe(first![1].operationId)
    expect(r.close).toHaveBeenCalledOnce()
  })

  it('says why it could not, and gives up after its deadline', async () => {
    const failed = relay([{ error: 'SETUP_FAILED', detail: 'Install Claude Code or Codex on this machine, then try again.' }])
    await expect(prepareTeamContribution(failed.core, { tabId: 'tab', machineId: 'team-1' }, failed.deps as never)).rejects.toThrow('Install Claude Code or Codex')
    const slow = relay([])
    await expect(prepareTeamContribution(slow.core, { tabId: 'tab', machineId: 'team-1' }, slow.deps as never)).rejects.toThrow('still preparing')
    expect(slow.close).toHaveBeenCalledOnce()
  })
})

describe('the owner setting how many agents a machine offers, from a terminal', () => {
  function owned(totalGiB: number | null, machine: Record<string, unknown> = {}) {
    const core = fakeCore()
    const state: Record<string, unknown> = { machines: [{ machineId: 'studio', name: 'Mac Studio', contributorId: 'ken', cwd: '/Users/ken/harnesses/swarms/tab', scope: 'swarm',
      // A machine added before Swarms ran only Claude Code and Codex lists every engine it had; the server takes only those two.
      engines: ['claude', 'codex', 'opencode'], maxAgents: 16, paused: false,
      ...(totalGiB === null ? {} : { observation: { generation: 'g1', resources: { memoryTotalBytes: totalGiB * GiB, memoryUsedBytes: GiB } } }), ...machine }] }
    const sent: Record<string, unknown>[] = []
    const backend = vi.fn(async (_core: unknown, method: string, path: string, body?: unknown) => {
      if (method === 'GET') return swarmReply(path, state)
      sent.push(body as Record<string, unknown>)
      return { result: {} }
    })
    const set = (maxAgents: number) => setMachineAgents(core, { tabId: 'tab', machineId: 'studio', maxAgents }, { backend } as never)
    return { set, sent, backend }
  }

  it('changes only the number, keeping the machine\'s name, folder and engines', async () => {
    const f = owned(192)
    expect(await f.set(96)).toEqual({ ok: true, machineId: 'studio', maxAgents: 96, maximum: 96 })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.command).toEqual({ type: 'machine.contribute', machineId: 'studio', name: 'Mac Studio', cwd: '/Users/ken/harnesses/swarms/tab',
      scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 96 })
    expect(String(f.sent[0]!.operationId)).toMatch(/^machine-agents-/)
  })
  it('refuses a number above the machine\'s maximum, and says what the maximum is', async () => {
    const big = owned(192)
    expect(await big.set(97)).toEqual({ error: 'ABOVE_MACHINE_MAXIMUM', detail: 'Mac Studio can offer at most 96 agents: one for every 2 GB of its memory, and at least 4.' })
    const small = owned(8)
    expect(await small.set(5)).toMatchObject({ error: 'ABOVE_MACHINE_MAXIMUM', detail: expect.stringContaining('at most 4 agents') })
    expect([...big.sent, ...small.sent]).toEqual([])
    // Every machine may offer 4, whatever its memory.
    expect(await owned(2).set(4)).toMatchObject({ ok: true, maxAgents: 4, maximum: 4 })
  })
  it('refuses a machine that is not in the Swarm, or whose memory it has not reported', async () => {
    const f = owned(192, { machineId: 'other' })
    expect(await f.set(8)).toEqual({ error: 'MACHINE_NOT_FOUND', detail: 'This machine is not in this Swarm. Add it from Desktop first.' })
    const unread = owned(null)
    expect(await unread.set(8)).toEqual({ error: 'MACHINE_MEMORY_UNKNOWN', detail: 'Mac Studio has not reported its memory yet. Try again once it is online.' })
    expect([...f.sent, ...unread.sent]).toEqual([])
  })
  it('refuses a paused machine, which the server would resume with its new number', async () => {
    const f = owned(192, { paused: true })
    expect(await f.set(32)).toEqual({ error: 'MACHINE_PAUSED', detail: 'Mac Studio is paused. Resume it first: changing its agents would also resume it.' })
    expect(f.sent).toEqual([])
  })
  it('passes on the server\'s refusal, such as another person\'s machine', async () => {
    const f = owned(192)
    const read = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core: unknown, method: string, path: string, body?: unknown) => {
      if (method === 'GET') return read(core, method, path, body)
      throw new SuperTabHostError('OWNER_REQUIRED', 'Only the machine owner can contribute it.', 403)
    })
    await expect(f.set(8)).rejects.toMatchObject({ code: 'OWNER_REQUIRED', status: 403 })
  })
  it('says so when an older server could only take 16', async () => {
    const f = owned(192)
    f.backend.mockImplementation(async (_core: unknown, method: string, path: string, body?: unknown) => {
      if (method === 'GET') return swarmReply(path, { machines: [{ machineId: 'studio', name: 'Mac Studio', cwd: '/w', scope: 'swarm', engines: ['claude'], maxAgents: 2,
        observation: { resources: { memoryTotalBytes: 192 * GiB } } }] })
      const command = (body as { command: { maxAgents: number } }).command
      if (command.maxAgents > 16) throw new SuperTabHostError('VALIDATION_ERROR', 'command.maxAgents: Too big: expected number to be <=16', 400)
      f.sent.push(body as Record<string, unknown>)
      return { result: {} }
    })
    expect(await f.set(96)).toEqual({ ok: true, machineId: 'studio', maxAgents: 16, maximum: 96,
      notice: 'This Swarm\'s server takes at most 16 agents per machine, so Mac Studio now offers 16. Update the server to offer more.' })
    expect(f.sent.map(b => (b.command as { maxAgents: number }).maxAgents)).toEqual([16])
  })
})
