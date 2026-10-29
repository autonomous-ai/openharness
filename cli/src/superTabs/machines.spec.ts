import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { apisOn, ContributedMachines, createQuietGit, liveOn, localModelsStamp, offered, refusedOn, servedOn, sharedWith, swarmUnconfirmedFile, swarmWorktreesFile } from './machines.js'
import { SuperTabHostError } from './host.js'
import { startAgent } from './start.js'
import { hostForm, swarmReply } from './fixtures/read/index.js'
import { HostFeed } from './hostFeed.js'
import { SwarmReads } from './swarmReads.js'
import { processCoreApi } from '../services/processCoreApi.js'
import type { PrivacyObservation } from '../team/privacy.js'

function fixture(env: NodeJS.ProcessEnv = {}, privacy: () => PrivacyObservation | null = () => null, relayed: () => boolean = () => false) {
  let now = 1000, stamp = 's0'
  const core = fakeCore({ dataDir: '/isolated-pool-fixture', agents: {
    byAgent: vi.fn(id => id === 'running' ? { agentId: id } as never : undefined),
    stopped: vi.fn(async id => id === 'stopped'),
  } })
  const pool = { tabId: 'tab', machine: { machineId: 'host', generation: 'grant', cwd: '/repo', engines: ['codex'], paused: false },
    harnessIds: ['running', 'stopped'], starts: [{ id: 'start', dispatched: false }], paused: false }
  const backend = vi.fn(async (_core: unknown, method: string, path: string, _body?: unknown): Promise<unknown> => path.includes('/hosts/host/changes') ? hostForm([], { pools: [pool] }) : { revision: 1 })
  const request = vi.fn(async (_type: string): Promise<Record<string, unknown>> => ({ providers: [{ provider: 'codex', outcome: 'answered', httpStatus: 200,
    body: { account_email: 'private@example.com', secret: 'private-token', rate_limit: { primary_window: { used_percent: 25, reset_at: 1234567890 } } } }] }))
  const close = vi.fn(), open = vi.fn(async () => ({ machineId: 'host', request, close }))
  const capabilities = vi.fn(async (_input: { cwd: string; tools: string[]; devices: string[] }) => ({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 }, tools: { git: true } }))
  const start = vi.fn(async () => ({ ok: true }))
  const prepare = vi.fn(async () => {})
  const log = vi.fn()
  const modelsStamp = vi.fn(async () => stamp)
  const deps = { backend, open, capabilities, start, prepare, log, env, privacy, modelsStamp, relayed, now: () => now }
  const machine = new ContributedMachines(core, 'host', deps as never)
  return { deps, machine, pool, core, backend, open, request, close, capabilities, start, prepare, log, modelsStamp, advance: () => { now += 16000 }, step: (ms: number) => { now += ms },
    stamp: (next: string) => { stamp = next } }
}

// Second review of #1991: a start in a Swarm this host is cleaning up could write into a folder the cleanup then deleted.
describe('a Swarm this host is cleaning up', () => {
  const homes: string[] = []
  afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
  it('starts no agent there while its cleanup runs, and starts the waiting one once the cleanup ends', async () => {
    // The cleanup deletes Swarm folders under the home folder: a throwaway one.
    const home = mkdtempSync(join(tmpdir(), 'swarm-cleaning-')); homes.push(home)
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home)
    const f = fixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const answer = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => method === 'GET' && path.startsWith('/api/super-tabs/tab/')
      ? held.then(() => swarmReply(path, {})) : answer(core, method, path, body))
    const cleaning = f.machine.clean('tab', 'removal').catch(() => null)
    await f.machine.tick()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.log.mock.calls.flat().join('\n')).toContain('finish cleaning up this Swarm')
    release()
    await cleaning
    f.advance()
    await f.machine.tick()
    expect(f.start).toHaveBeenCalledTimes(1)
  })
})

// Review of #2004: a start passed the cleaning check, waited in its folder preparation, and launched after a cleanup began.
// A start holds its Swarm from that check through its launch, and a cleanup waits for the starts in flight, for a while.
describe('a start and a cleanup of one Swarm', () => {
  const homes: string[] = []
  afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
  function held(cleanupWaitMs?: number) {
    const home = mkdtempSync(join(tmpdir(), 'swarm-cleaning-')); homes.push(home)
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home)
    const f = fixture()
    let release!: () => void
    f.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const answer = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => method === 'GET' && path.startsWith('/api/super-tabs/tab/')
      ? swarmReply(path, {}) : answer(core, method, path, body))
    const machine = cleanupWaitMs === undefined ? f.machine : new ContributedMachines(f.core, 'host', { ...f.deps, cleanupWaitMs } as never)
    const swarmRead = () => f.backend.mock.invocationCallOrder.find((_order, i) => f.backend.mock.calls[i]![1] === 'GET'
      && String(f.backend.mock.calls[i]![2]).startsWith('/api/super-tabs/tab/'))
    return { f, machine, release: () => release(), swarmRead }
  }

  it('lets a start that passed the check launch before the cleanup touches anything', async () => {
    const { f, machine, release, swarmRead } = held()
    const pass = machine.tick()
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled())
    const cleaning = machine.clean('tab', 'removal').catch(() => null)
    // Room for a cleanup that does not wait to read the Swarm and delete: what is checked is that nothing happens.
    await new Promise(resolve => setTimeout(resolve, 50))
    release()
    await pass
    await cleaning
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(swarmRead()).toBeGreaterThan(f.start.mock.invocationCallOrder[0]!)
  })

  it('gives up waiting for a start that never finishes, with a clear error, and touches nothing', async () => {
    const { f, machine, release, swarmRead } = held(20)
    const pass = machine.tick()
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled())
    await expect(machine.clean('tab', 'removal')).rejects.toThrow('an agent start there is still running')
    expect(swarmRead()).toBeUndefined()
    release()
    await pass
    expect(f.start).toHaveBeenCalledTimes(1)
  })
})

// #1726: the pass read GET /hosts/:m/pools, up to 100 whole Swarms, every 5 s. Its pools now come with the host form.
describe('the pools of a contributed machine', () => {
  it('come from the host form, never the old pools roster', async () => {
    const f = fixture()
    await f.machine.tick()
    const reads = f.backend.mock.calls.filter(c => c[1] === 'GET').map(c => c[2])
    expect(reads).toEqual(['/api/super-tabs/hosts/host/changes?full=1'])
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab', startId: 'start' }), expect.any(Function), expect.anything(), f.open)
  })
  it('come from the host\'s own fresh read when it shares one, without reading again', async () => {
    const f = fixture()
    let now = 1000
    const feed = new HostFeed(f.core, 'host', { now: () => now, backend: f.backend })
    await feed.refresh()
    const machine = new ContributedMachines(f.core, 'host', { backend: f.backend, open: f.open, capabilities: f.capabilities, start: f.start, prepare: f.prepare,
      log: f.log, now: () => now, sources: { feed, reads: new SwarmReads(f.core, { backend: f.backend }) } } as never)
    now += 1_999
    await machine.tick()
    expect(f.backend.mock.calls.filter(c => c[1] === 'GET')).toHaveLength(1)
    expect(f.start).toHaveBeenCalledTimes(1)
  })
})

describe('contributed machine executor', () => {
  it('reports only installed supported engines for a legacy OpenCode contribution', async () => {
    const f = fixture()
    f.pool.machine.engines = ['opencode']
    const usage = f.request.getMockImplementation()!
    f.request.mockImplementation(async type => type === 'engines_probe'
      ? { engines: [{ engine: 'claude', installed: true, signedIn: false }, { engine: 'codex', installed: false }] }
      : usage(type))
    await f.machine.tick()
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ quotas: [{ engine: 'claude' }] })
    expect(f.request).toHaveBeenCalledWith('engines_probe', { engines: ['claude', 'codex'] }, 20_000)
  })
  const signedOut = { providers: [{ provider: 'codex', account: null, outcome: 'signedOut' }] }
  it('reports an engine run on an API key as metered: known, with no windows', async () => {
    const f = fixture({ OPENAI_API_KEY: 'sk-or-private' })
    f.request.mockImplementation(async () => signedOut)
    await f.machine.tick()
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ quotas: [{ engine: 'codex', known: true, windows: [] }] })
    expect(JSON.stringify(body)).not.toContain('sk-or-private')
  })
  it('keeps an unreadable subscription unknown, and a readable one by its windows even beside an API key', async () => {
    const unknown = fixture()
    unknown.request.mockImplementation(async () => signedOut)
    await unknown.machine.tick()
    expect(unknown.backend.mock.calls.find(c => c[1] === 'POST')![3]).toMatchObject({ quotas: [{ engine: 'codex', known: false, windows: [] }] })
    const read = fixture({ OPENAI_API_KEY: 'sk-or-private' })
    await read.machine.tick()
    const quota = (read.backend.mock.calls.find(c => c[1] === 'POST')![3] as { quotas: Array<{ windows: unknown[] }> }).quotas[0]!
    expect(quota.windows).toHaveLength(1)
  })
  it('prepares a swarm project before dispatch and durably rejects an unsafe checkout', async () => {
    const f = fixture()
    Object.assign(f.pool.machine, { scope: 'swarm' })
    await f.machine.tick()
    expect(f.prepare).toHaveBeenCalledWith(f.core, f.pool, f.pool.starts[0])
    expect(f.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.start.mock.invocationCallOrder[0]!)
    f.prepare.mockRejectedValueOnce(new Error('Project checkout unavailable'))
    f.advance()
    await f.machine.tick()
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.backend.mock.calls.some(c => JSON.stringify(c[3] ?? {}).includes('Project checkout unavailable'))).toBe(true)
    f.pool.starts[0]!.dispatched = true
    f.advance()
    await f.machine.tick()
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.start).toHaveBeenCalledTimes(2)
  })
  it('starts another person\'s work with the app for whom it is, and fails a start whose token cannot be had', async () => {
    const f = fixture()
    f.prepare.mockResolvedValueOnce({ requester: 'olive@example.com' } as never)
    await f.machine.tick()
    expect((f.start.mock.calls as unknown[][])[0]![0]).toEqual({ tabId: 'tab', startId: 'start', hostDispatch: true, github: { requester: 'olive@example.com' } })
    f.prepare.mockRejectedValueOnce(new Error('This machine could not get a Harness GitHub App token for this project'))
    f.advance()
    await f.machine.tick()
    expect(f.start).toHaveBeenCalledTimes(1)
    const failed = f.backend.mock.calls.find(c => JSON.stringify(c[3] ?? {}).includes('could not get a Harness GitHub App token'))!
    expect(failed[3]).toMatchObject({ command: { type: 'agent.startFailed', startId: 'start' } })
  })
  it('readies a start with the backend, as a team account when this daemon runs team work only', async () => {
    for (const team of [false, true]) {
      const f = fixture()
      const machine = new ContributedMachines(f.core, 'host', { backend: f.backend, open: f.open, capabilities: f.capabilities, start: f.start,
        log: f.log, env: {}, privacy: () => null, team: () => team, now: () => 1000 } as never)
      Object.assign(f.pool, { githubApp: true })
      f.backend.mockImplementation(async (_core: unknown, _method: string, path: string): Promise<unknown> => path.includes('/hosts/host/changes') ? hostForm([], { pools: [f.pool] })
        : path.endsWith('/github-token') ? { github: false } : { revision: 1 })
      await machine.tick()
      const asked = f.backend.mock.calls.find(c => String(c[2]).endsWith('/github-token'))!
      expect(asked[3]).toEqual(team ? { always: true } : {})
      expect(f.start).toHaveBeenCalledTimes(team ? 0 : 1)
    }
  })
  it('publishes only scoped measurements and executes through the owner start endpoint', async () => {
    const f = fixture()
    await f.machine.tick()
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.capabilities).toHaveBeenCalledWith({ cwd: '/repo', tools: ['git', 'node', 'npm', 'flutter', 'gh', 'cargo', 'python3'], devices: [] })
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ generation: 'grant', runningHarnessIds: ['running'], stoppedHarnessIds: ['stopped'], quotas: [{ engine: 'codex', known: true }] })
    expect(JSON.stringify(body)).not.toMatch(/private@example|private-token|account_email/)
    const [input, scoped, where] = (f.start.mock.calls as unknown[][])[0]!
    expect(input).toEqual({ tabId: 'tab', startId: 'start', hostDispatch: true })
    expect(where).toMatchObject({ machineId: 'host', dataDir: '/isolated-pool-fixture' })
    await (scoped as (p: unknown) => Promise<unknown>)({ action: 'startStatus' })
    expect(f.backend).toHaveBeenLastCalledWith(f.core, 'GET', '/api/super-tabs/hosts/host/starts/tab/start', undefined)
    // Any other read went out as an empty start report, which the backend refused with a 400 at every start (prod logs
    // 2026-10-28): the start endpoint takes only this start's commands.
    const sent = f.backend.mock.calls.length
    expect(await (scoped as (p: unknown) => Promise<unknown>)({ action: 'status' })).toMatchObject({ error: 'HOST_UNSUPPORTED' })
    expect(f.backend.mock.calls.length).toBe(sent)
    expect(f.close).toHaveBeenCalledOnce()
    await f.machine.tick()
    expect(f.open).toHaveBeenCalledOnce()
    f.machine.stop(); f.advance(); await f.machine.tick()
    expect(f.open).toHaveBeenCalledOnce()
  })
  it('launches a Buddy\'s start, which the backend lists apart so that a host from before Buddies never does', async () => {
    const f = fixture()
    Object.assign(f.pool, { starts: [], buddyStarts: [{ id: 'buddy-start', dispatched: false }] })
    await f.machine.tick()
    expect((f.start.mock.calls as unknown[][]).map(call => call[0])).toEqual([{ tabId: 'tab', startId: 'buddy-start', hostDispatch: true }])
  })
  it('launches a Product Manager\'s start, which the backend lists apart so that a host from before them never does', async () => {
    const f = fixture()
    Object.assign(f.pool, { starts: [], leadStarts: [{ id: 'lead-start', dispatched: false }] })
    await f.machine.tick()
    expect((f.start.mock.calls as unknown[][]).map(call => call[0])).toEqual([{ tabId: 'tab', startId: 'lead-start', hostDispatch: true }])
  })
  it('says in its reading that it starts Product Managers, to a backend that asks, and to no other', async () => {
    const f = fixture()
    Object.assign(f.pool, { capabilitiesWanted: true })
    await f.machine.tick()
    const posted = (g: typeof f) => g.backend.mock.calls.filter(c => c[1] === 'POST').map(c => c[3] as Record<string, unknown>)
    expect(posted(f)[0]).toMatchObject({ capabilities: ['leadStart'] })
    // A backend from before them does not ask, and would refuse the field.
    const older = fixture()
    await older.machine.tick()
    expect(posted(older)[0]).not.toHaveProperty('capabilities')
  })
  it('probes common tools plus pending-start requirements and publishes failures without calling them missing', async () => {
    const f = fixture()
    Object.assign(f.pool.starts[0]!, { request: { requirements: { tools: ['docker'] } } })
    f.capabilities.mockResolvedValueOnce({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
      tools: { git: true, node: true, docker: false }, toolProbeErrors: { flutter: 'interactive shell timed out' } } as never)
    await f.machine.tick()
    expect(f.capabilities).toHaveBeenCalledWith({ cwd: '/repo',
      tools: ['git', 'node', 'npm', 'flutter', 'gh', 'cargo', 'python3', 'docker'], devices: [] })
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ tools: { git: true, node: true, docker: false }, toolProbeErrors: { flutter: 'interactive shell timed out' } })
  })
  it('reuses tool readings across tabs and heartbeat passes without another shell probe', async () => {
    const f = fixture()
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => path.includes('/hosts/host/changes')
      ? hostForm([], { pools: [f.pool, { ...f.pool, tabId: 'second-tab' }] })
      : original(core, method, path, body))
    await f.machine.tick()
    expect(f.capabilities.mock.calls.map(([input]) => input.tools)).toEqual([
      ['git', 'node', 'npm', 'flutter', 'gh', 'cargo', 'python3'], []])
    const observations = f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/'))
    expect(observations[1]?.[3]).toMatchObject({ tools: { git: true }, toolProbeErrors: { node: 'The tool probe did not complete.' } })
    f.advance()
    await f.machine.tick()
    expect(f.capabilities.mock.calls.slice(2).map(([input]) => input.tools)).toEqual([[], []])
  })
  it('probes a newly queued tool immediately and retries an unverified tool after its short cache window', async () => {
    const f = fixture()
    f.capabilities.mockResolvedValueOnce({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
      tools: { git: true, node: true, npm: true, gh: true, cargo: true, python3: true },
      toolProbeErrors: { flutter: 'interactive shell timed out' } } as never)
    await f.machine.tick()
    Object.assign(f.pool.starts[0]!, { request: { requirements: { tools: ['docker'] } } })
    f.capabilities.mockResolvedValueOnce({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
      tools: { docker: true } } as never)
    f.advance()
    await f.machine.tick()
    expect(f.capabilities.mock.lastCall?.[0]).toMatchObject({ tools: ['docker'] })
    f.step(61_000)
    await f.machine.tick()
    expect(f.capabilities.mock.lastCall?.[0]).toMatchObject({ tools: ['flutter'] })
  })
  // v1 routing (#229): the route left out nothing it could not see, and picked machines signed out, without the project or
  // unable to push. The reading now says what the machine is ready for.
  describe('readiness', () => {
    const readings = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/'))
      .map(c => c[3] as Record<string, unknown> & { readiness?: { engines?: unknown[]; checkouts?: Array<Record<string, unknown>> } })
    const withEngines = (f: ReturnType<typeof fixture>) => {
      const usage = f.request.getMockImplementation()!
      f.request.mockImplementation(async (type, ...rest) => type === 'engines_probe'
        ? { engines: [{ engine: 'claude', installed: true, signedIn: false }, { engine: 'codex', installed: true }, { engine: 'cursor', installed: true }] }
        : usage(type, ...rest as []))
    }
    const probes = (f: ReturnType<typeof fixture>) => f.request.mock.calls.filter(c => c[0] === 'engines_probe')

    it('says whether each engine is installed and signed in, probing again only after ten minutes', async () => {
      const f = fixture()
      withEngines(f)
      await f.machine.tick()
      expect(f.request).toHaveBeenCalledWith('engines_probe', { engines: ['claude', 'codex'], accounts: true }, 20_000)
      // An engine that says nothing about its sign-in is unknown, never signed out.
      expect(readings(f)[0]!.readiness).toEqual({ engines: [{ engine: 'claude', installed: true, signedIn: false }, { engine: 'codex', installed: true, signedIn: null }] })
      f.advance(); await f.machine.tick()
      expect(readings(f)).toHaveLength(2)
      expect(readings(f)[1]!.readiness?.engines).toHaveLength(2)
      expect(probes(f)).toHaveLength(1)
      f.step(10 * 60_000); await f.machine.tick()
      expect(probes(f)).toHaveLength(2)
    })

    it('reads a Harness Team account\'s engine it has not signed in as ready when its owner\'s relay is there', async () => {
      const f = fixture({}, () => null, () => true)
      withEngines(f)
      await f.machine.tick()
      expect(readings(f)[0]!.readiness?.engines).toEqual([{ engine: 'claude', installed: true, signedIn: true }, { engine: 'codex', installed: true, signedIn: null }])
    })

    it('reads an engine the probe calls not installed as unknown, since a timed-out shell probe says the same (review of #1743)', async () => {
      const f = fixture()
      const usage = f.request.getMockImplementation()!
      f.request.mockImplementation(async (type, ...rest) => type === 'engines_probe'
        ? { engines: [{ engine: 'claude', installed: false }, { engine: 'codex', installed: true, signedIn: true }] } : usage(type, ...rest as []))
      await f.machine.tick()
      expect(readings(f)[0]!.readiness?.engines).toEqual([{ engine: 'claude', installed: null, signedIn: null }, { engine: 'codex', installed: true, signedIn: true }])
    })

    it('sends no engine readiness when the probe fails, and asks again a minute later', async () => {
      const f = fixture()
      const usage = f.request.getMockImplementation()!
      f.request.mockImplementation(async (type, ...rest) => type === 'engines_probe' ? Promise.reject(new Error('timed out')) : usage(type, ...rest as []))
      await f.machine.tick()
      expect(readings(f)[0]).not.toHaveProperty('readiness')
      f.advance(); await f.machine.tick()
      expect(probes(f)).toHaveLength(1)
      f.step(60_000); await f.machine.tick()
      expect(probes(f)).toHaveLength(2)
    })

    describe('of its Swarm folder', () => {
      const roots: string[] = []
      afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
      const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
      /** A Swarm folder: p1 a checkout of a GitHub repository this login may not push to, p2 a plain folder, p3 a checkout
       *  of a repository on disk it can push to. */
      function swarmFolder() {
        const root = mkdtempSync(join(tmpdir(), 'readiness-')); roots.push(root)
        const remote = join(root, 'remote.git'), swarm = join(root, 'swarm')
        mkdirSync(remote); run(remote, 'init', '-q', '--bare')
        for (const name of ['p1', 'p3']) {
          mkdirSync(join(swarm, name), { recursive: true }); const dir = join(swarm, name)
          run(dir, 'init', '-q'); run(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
        }
        run(join(swarm, 'p1'), 'remote', 'add', 'origin', 'https://someone:secret-token@github.com/Acme/App.git?access_token=query-secret')
        run(join(swarm, 'p3'), 'remote', 'add', 'origin', remote)
        mkdirSync(join(swarm, 'p2')); mkdirSync(join(swarm, '.hidden')); writeFileSync(join(swarm, 'notes.txt'), '')
        return swarm
      }
      /** git as it is, except that a push to GitHub answers as GitHub does to a login without write access. */
      function gitFor(denied: string) {
        const calls: string[][] = []
        const git = vi.fn(async (cwd: string, args: string[]) => {
          calls.push(args)
          if (args[0] === 'push' && cwd.endsWith('p1')) return { ok: false, stdout: '', stderr: denied }
          try { return { ok: true, stdout: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' } }
          catch (error) { return { ok: false, stdout: '', stderr: String((error as { stderr?: unknown }).stderr ?? '') } }
        })
        return { git, calls }
      }
      function swarmFixture(git: ReturnType<typeof gitFor>['git']) {
        const f = fixture()
        Object.assign(f.pool.machine, { scope: 'swarm', cwd: swarmFolder() })
        const machine = new ContributedMachines(f.core, 'host', { backend: f.backend, open: f.open, capabilities: f.capabilities, start: f.start, prepare: f.prepare,
          log: f.log, now: () => now, git } as never)
        let now = 1000
        return { ...f, machine, step: (ms: number) => { now += ms } }
      }

      it('lists each project folder\'s repository, whether it is a checkout, and whether this login can push, never a credential', async () => {
        const { git, calls } = gitFor("remote: Permission to Acme/App.git denied to someone.\nfatal: unable to access 'https://github.com/Acme/App.git/': The requested URL returned error: 403")
        const f = swarmFixture(git)
        await f.machine.tick()
        // The folder is read beside the pass, never holding it up.
        await vi.waitFor(() => expect(calls.filter(a => a[0] === 'push')).toHaveLength(2))
        f.step(16_000); await f.machine.tick()
        const checkouts = readings(f).at(-1)!.readiness!.checkouts!
        expect(checkouts).toEqual([
          { folder: 'p1', repository: 'github.com/acme/app', git: true, push: false },
          { folder: 'p2', repository: null, git: false, push: null },
          { folder: 'p3', repository: null, git: true, push: true },
        ])
        expect(JSON.stringify(readings(f))).not.toMatch(/secret-token|query-secret/)
        // A dry run that runs no hooks, so nothing is pushed and nothing of the repository's runs.
        expect(calls.find(a => a[0] === 'push')).toEqual(['push', '--dry-run', '--no-verify', '--porcelain', 'origin', 'HEAD:refs/heads/harness-push-check'])
        f.step(16_000); await f.machine.tick()
        expect(calls.filter(a => a[0] === 'push')).toHaveLength(2)
        f.step(10 * 60_000); await f.machine.tick()
        await vi.waitFor(() => expect(calls.filter(a => a[0] === 'push')).toHaveLength(4))
      })

      it('reads a checkout with git itself, which can push to a remote it may write to', async () => {
        const root = mkdtempSync(join(tmpdir(), 'readiness-')); roots.push(root)
        const remote = join(root, 'remote.git'), dir = join(root, 'swarm', 'p1')
        mkdirSync(remote); run(remote, 'init', '-q', '--bare'); mkdirSync(dir, { recursive: true })
        run(dir, 'init', '-q'); run(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'); run(dir, 'remote', 'add', 'origin', remote)
        const f = fixture()
        Object.assign(f.pool.machine, { scope: 'swarm', cwd: join(root, 'swarm') })
        await f.machine.tick()
        await vi.waitFor(async () => {
          f.advance(); await f.machine.tick()
          expect(readings(f).at(-1)!.readiness?.checkouts).toEqual([{ folder: 'p1', repository: null, git: true, push: true }])
        })
        // A dry run: the remote has nothing.
        expect(execFileSync('git', ['-C', remote, 'for-each-ref'], { encoding: 'utf8' })).toBe('')
      })

      it('says nothing of a Swarm folder it cannot read, and tries again a minute later, not every pass', async () => {
        const { git } = gitFor('')
        const f = swarmFixture(git)
        Object.assign(f.pool.machine, { cwd: join(tmpdir(), 'readiness-missing-folder') })
        await f.machine.tick()
        await vi.waitFor(() => expect(f.log).toHaveBeenCalledWith(expect.stringContaining('Could not read the Swarm folder')))
        // Proving it is not read again needs the time a read would take: each pass is followed by more than a folder read.
        for (let i = 0; i < 3; i++) { f.step(16_000); await f.machine.tick(); await new Promise(done => setTimeout(done, 50)) }
        expect(readings(f)).toHaveLength(4)
        expect(readings(f).at(-1)!.readiness?.checkouts).toBeUndefined()
        expect(f.log.mock.calls.filter(c => String(c[0]).includes('Swarm folder'))).toHaveLength(1)
        f.step(60_000); await f.machine.tick()
        await vi.waitFor(() => expect(f.log.mock.calls.filter(c => String(c[0]).includes('Swarm folder'))).toHaveLength(2))
      })

      it('leaves out a folder whose probe failed rather than calling it no checkout, and reads it again a minute later (review of #1743)', async () => {
        const { git: real, calls } = gitFor('denied')
        let failing = true
        const git = vi.fn(async (cwd: string, args: string[]) => failing && args[0] === 'rev-parse' && cwd.endsWith('p3')
          ? { ok: false, stdout: '', stderr: '', timedOut: true } : real(cwd, args))
        const f = swarmFixture(git)
        await f.machine.tick()
        await vi.waitFor(() => expect(calls.filter(a => a[0] === 'push')).toHaveLength(1))
        f.step(16_000); await f.machine.tick()
        expect(readings(f).at(-1)!.readiness!.checkouts!.map(c => [c.folder, c.git])).toEqual([['p1', true], ['p2', false]])
        failing = false
        f.step(60_000); await f.machine.tick()
        await vi.waitFor(() => expect(calls.filter(a => a[0] === 'push')).toHaveLength(3))
        f.step(16_000); await f.machine.tick()
        expect(readings(f).at(-1)!.readiness!.checkouts!.map(c => c.folder)).toEqual(['p1', 'p2', 'p3'])
      })

      it('ends a git whose helper hangs at its deadline, with everything it started, and settles at once', async () => {
        const root = mkdtempSync(join(tmpdir(), 'readiness-')); roots.push(root)
        const dir = join(root, 'p1'), pidFile = join(root, 'helper.pid'), ssh = join(root, 'ssh.sh')
        // An ssh that leaves a helper behind holding git's output, as a stuck credential helper or ssh agent can.
        writeFileSync(ssh, `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nsleep 60\n`, { mode: 0o755 })
        mkdirSync(dir); run(dir, 'init', '-q'); run(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
        run(dir, 'remote', 'add', 'origin', 'ssh://git@example.invalid/acme/app.git'); run(dir, 'config', 'core.sshCommand', ssh)
        const began = Date.now()
        const answer = await createQuietGit(1_000)(dir, ['push', '--dry-run', '--no-verify', '--porcelain', 'origin', 'HEAD:refs/heads/harness-push-check'])
        expect(answer).toMatchObject({ ok: false, timedOut: true })
        expect(Date.now() - began).toBeLessThan(5_000)
        const helper = Number(readFileSync(pidFile, 'utf8'))
        await vi.waitFor(() => expect(() => process.kill(helper, 0)).toThrow())
      })

      it('ends a helper that outlives git and keeps its output open, before the deadline (re-check of #1743)', async () => {
        const root = mkdtempSync(join(tmpdir(), 'readiness-')); roots.push(root)
        const dir = join(root, 'p1'), pidFile = join(root, 'helper.pid'), ssh = join(root, 'ssh.sh')
        // An ssh that fails at once, so git exits, but leaves a helper behind holding the error output git handed down.
        writeFileSync(ssh, `#!/bin/sh\nsleep 60 </dev/null >/dev/null &\necho $! > ${pidFile}\nexit 1\n`, { mode: 0o755 })
        mkdirSync(dir); run(dir, 'init', '-q'); run(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
        run(dir, 'remote', 'add', 'origin', 'ssh://git@example.invalid/acme/app.git'); run(dir, 'config', 'core.sshCommand', ssh)
        const began = Date.now()
        const answer = await createQuietGit(30_000)(dir, ['push', '--dry-run', '--no-verify', '--porcelain', 'origin', 'HEAD:refs/heads/harness-push-check'])
        expect(answer).toMatchObject({ ok: false })
        expect(Date.now() - began).toBeLessThan(10_000)
        const helper = Number(readFileSync(pidFile, 'utf8'))
        await vi.waitFor(() => expect(() => process.kill(helper, 0)).toThrow())
      })

      it('says a push is unknown, not refused, when the remote could not be reached', async () => {
        const { git, calls } = gitFor("fatal: unable to access 'https://github.com/Acme/App.git/': Could not resolve host: github.com")
        const f = swarmFixture(git)
        await f.machine.tick()
        await vi.waitFor(() => expect(calls.filter(a => a[0] === 'push')).toHaveLength(2))
        f.step(16_000); await f.machine.tick()
        expect(readings(f).at(-1)!.readiness!.checkouts![0]).toEqual({ folder: 'p1', repository: 'github.com/acme/app', git: true, push: null })
      })

      it('reads a credential prompt git could not show as no push access', async () => {
        const { git, calls } = gitFor("fatal: could not read Username for 'https://github.com': terminal prompts disabled")
        const f = swarmFixture(git)
        await f.machine.tick()
        await vi.waitFor(() => expect(calls.filter(a => a[0] === 'push')).toHaveLength(2))
        f.step(16_000); await f.machine.tick()
        expect(readings(f).at(-1)!.readiness!.checkouts![0]).toMatchObject({ folder: 'p1', push: false })
      })
    })

    it('drops only the readiness field for a backend from before it, for ten minutes, keeping privacy', async () => {
      const f = fixture({}, () => ({ mode: 'dedicated' }))
      withEngines(f)
      const original = f.backend.getMockImplementation()!
      f.backend.mockImplementation(async (core, method, path, body) => {
        if (method === 'POST' && (body as Record<string, unknown>)?.readiness) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: readiness', 400)
        return original(core, method, path, body)
      })
      await f.machine.tick()
      expect(readings(f)).toHaveLength(2)
      expect(readings(f)[1]).not.toHaveProperty('readiness')
      expect(readings(f)[1]).toMatchObject({ privacy: { mode: 'dedicated' } })
      f.advance(); await f.machine.tick()
      expect(readings(f)).toHaveLength(3)
      f.step(10 * 60_000); await f.machine.tick()
      expect(readings(f).at(-2)).toHaveProperty('readiness')
      expect(readings(f).at(-1)).not.toHaveProperty('readiness')
    })
  })

  it('retries a probe-failure observation without its new field for an older backend', async () => {
    const f = fixture()
    f.capabilities.mockResolvedValueOnce({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
      tools: { git: true }, toolProbeErrors: { flutter: 'interactive shell timed out' } } as never)
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && (body as Record<string, unknown>)?.toolProbeErrors) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: toolProbeErrors', 400)
      return original(core, method, path, body)
    })
    await f.machine.tick()
    const posts = f.backend.mock.calls.filter(c => c[1] === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]![3]).toHaveProperty('toolProbeErrors')
    expect(posts[1]![3]).not.toHaveProperty('toolProbeErrors')
  })

  it('sends when each running harness last showed progress, and only for those running', async () => {
    const f = fixture()
    const progress = vi.fn((ids: readonly string[]) => ({ running: 900, stopped: 800, elsewhere: 700 }) as Record<string, number>)
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, progress } as never)
    await machine.tick()
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3] as Record<string, unknown>
    expect(body.harnessProgress).toEqual({ running: 900 })
    // Nothing read yet for any running harness: the field is left out.
    progress.mockReturnValue({})
    f.advance(); await machine.tick()
    expect(f.backend.mock.calls.filter(c => c[1] === 'POST').at(-1)![3]).not.toHaveProperty('harnessProgress')
  })

  it('says whether each running session\'s folder has uncommitted changes, leaving out any git could not read', async () => {
    const f = fixture()
    const folders: Record<string, string> = { running: '/work/running', clean: '/work/clean', broken: '/work/broken' }
    vi.mocked(f.core.agents.byAgent).mockImplementation(id => folders[id] ? { agentId: id, cwd: folders[id] } as never : undefined)
    f.pool.harnessIds = ['running', 'clean', 'broken', 'stopped']
    const git = vi.fn(async (cwd: string, args: string[]) => cwd === '/work/broken' ? { ok: false, stdout: '', stderr: 'fatal' }
      : { ok: args.join(' ') === 'status --porcelain', stdout: cwd === '/work/running' ? ' M src/a.ts\n' : '', stderr: '' })
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, git } as never)
    await machine.tick()
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(3))
    f.advance(); await machine.tick()
    const body = f.backend.mock.calls.filter(c => c[1] === 'POST').at(-1)![3] as Record<string, unknown>
    expect(body.harnessUncommitted).toEqual({ running: true, clean: false })
    expect([...new Set(git.mock.calls.map(c => c[0]))].sort()).toEqual(['/work/broken', '/work/clean', '/work/running'])
  })

  it('reads each session\'s folder at most once a minute', async () => {
    const f = fixture()
    vi.mocked(f.core.agents.byAgent).mockImplementation(id => id === 'running' ? { agentId: id, cwd: '/work/running' } as never : undefined)
    const git = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }))
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, git } as never)
    await machine.tick()
    await vi.waitFor(() => expect(git).toHaveBeenCalledOnce())
    f.advance(); await machine.tick()
    expect(git).toHaveBeenCalledTimes(1)
    f.step(60_000); await machine.tick()
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(2))
  })

  // 2026-10-28: git status one folder after another took 20 s for the Mac Studio's 29 worktrees, inside the pass that
  // sends the machine's reading.
  it('never holds the reading up for git: a folder still being read is sent on a later pass', async () => {
    const f = fixture()
    vi.mocked(f.core.agents.byAgent).mockImplementation(id => id === 'running' ? { agentId: id, cwd: '/work/running' } as never : undefined)
    let answer!: (value: { ok: boolean; stdout: string; stderr: string }) => void
    const git = vi.fn(() => new Promise<{ ok: boolean; stdout: string; stderr: string }>(resolve => { answer = resolve }))
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, git } as never)
    await machine.tick()
    const posts = () => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/')).map(c => c[3] as Record<string, unknown>)
    expect(posts()).toHaveLength(1)
    expect(posts()[0]).not.toHaveProperty('harnessUncommitted')
    answer({ ok: true, stdout: ' M a.ts\n', stderr: '' })
    await vi.waitFor(async () => {
      f.advance(); await machine.tick()
      expect(posts().at(-1)).toHaveProperty('harnessUncommitted', { running: true })
    })
  })

  it('reads four folders at a time at most', async () => {
    const f = fixture()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    vi.mocked(f.core.agents.byAgent).mockImplementation(id => ids.includes(id) ? { agentId: id, cwd: `/work/${id}` } as never : undefined)
    f.pool.harnessIds = ids
    let reading = 0, most = 0
    const waiting: Array<() => void> = []
    const git = vi.fn(() => new Promise<{ ok: boolean; stdout: string; stderr: string }>(resolve => {
      most = Math.max(most, ++reading)
      waiting.push(() => { reading--; resolve({ ok: true, stdout: '', stderr: '' }) })
    }))
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, git } as never)
    await machine.tick()
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(4))
    waiting.shift()!()
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(5))
    while (waiting.length) { waiting.shift()!(); await new Promise(done => setTimeout(done, 0)) }
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(6))
    waiting.shift()?.()
    expect(most).toBe(4)
  })

  it('reads a session\'s folder again only once its screen changed, or after ten minutes', async () => {
    const f = fixture()
    vi.mocked(f.core.agents.byAgent).mockImplementation(id => id === 'running' ? { agentId: id, cwd: '/work/running' } as never : undefined)
    const git = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }))
    let shown = 900
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, git, progress: () => ({ running: shown }) } as never)
    const pass = async (ms: number) => { f.step(ms); await machine.tick(); await new Promise(done => setTimeout(done, 0)) }
    await pass(0)
    await vi.waitFor(() => expect(git).toHaveBeenCalledOnce())
    // An idle session: its files have not changed since the read.
    for (let i = 0; i < 5; i++) await pass(60_000)
    expect(git).toHaveBeenCalledOnce()
    shown = 400_000
    await pass(60_000)
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(2))
    // Changed again, but read under a minute ago.
    shown = 400_500
    await pass(30_000)
    expect(git).toHaveBeenCalledTimes(2)
    await pass(30_000)
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(3))
    await pass(9 * 60_000)
    expect(git).toHaveBeenCalledTimes(3)
    await pass(60_000)
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(4))
  })

  it('drops uncommitted changes alone for a backend that refuses them, and offers them again ten minutes later', async () => {
    const f = fixture()
    vi.mocked(f.core.agents.byAgent).mockImplementation(id => id === 'running' ? { agentId: id, cwd: '/work/running' } as never : undefined)
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && (body as Record<string, unknown>)?.harnessUncommitted) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: harnessUncommitted', 400)
      return original(core, method, path, body)
    })
    const git = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }))
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, git, progress: () => ({ running: 900 }) } as never)
    const posts = () => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/')).map(c => c[3] as Record<string, unknown>)
    const fields = (post: Record<string, unknown>) => ['harnessUncommitted', 'harnessProgress'].filter(key => key in post)
    await machine.tick()
    await vi.waitFor(() => expect(git).toHaveBeenCalledOnce())
    f.advance(); await machine.tick()
    expect(posts().map(fields)).toEqual([['harnessProgress'], ['harnessUncommitted', 'harnessProgress'], ['harnessProgress']])
    f.advance(); await machine.tick()
    expect(posts().map(fields).at(-1)).toEqual(['harnessProgress'])
    f.step(600_000); await machine.tick()
    expect(posts().map(fields).slice(-2)).toEqual([['harnessUncommitted', 'harnessProgress'], ['harnessProgress']])
  })

  it('sends each running harness’s token counts by model, and nothing for one with none or not running', async () => {
    const f = fixture()
    const session = (id: string) => ({ agentId: id, sessionId: `session-${id}`, engine: 'claude', transcriptPath: `/transcripts/${id}.jsonl`, registeredAt: 1 })
    vi.mocked(f.core.agents.byAgent).mockImplementation(id => ['running', 'quiet'].includes(id) ? session(id) as never : undefined)
    f.pool.harnessIds = ['running', 'quiet', 'stopped']
    const opus = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }
    f.core.usage = vi.fn(async target => target.agentId === 'running'
      ? { totalTokens: 135, updatedAt: '2026-10-29T00:00:00Z', inputTokens: 130, outputTokens: 5, models: { 'claude-opus-5-5': opus },
        work: { current: [{ cwd: '/private/work', at: '2026-10-29T00:00:00Z' }], locations: [], pullRequests: [], uncertain: false, truncated: false } }
      : { totalTokens: null, updatedAt: '2026-10-29T00:00:00Z' })
    await f.machine.tick()
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3] as Record<string, unknown>
    // Counts only: never the session's folders, pull requests or any other part of its usage reading.
    expect(body.harnessTokens).toEqual({ running: { 'claude-opus-5-5': opus } })
    expect(f.core.usage).toHaveBeenCalledTimes(2)
    f.core.usage = vi.fn(async () => null)
    f.advance(); await f.machine.tick()
    expect(f.backend.mock.calls.filter(c => c[1] === 'POST').at(-1)![3]).not.toHaveProperty('harnessTokens')
  })

  it('drops token counts for a backend that refuses them, keeping every other field, and offers them again ten minutes later', async () => {
    const f = fixture()
    vi.mocked(f.core.agents.byAgent).mockImplementation(id => id === 'running'
      ? { agentId: id, sessionId: 's', engine: 'claude', transcriptPath: '/t.jsonl', registeredAt: 1 } as never : undefined)
    f.core.usage = vi.fn(async () => ({ totalTokens: 3, updatedAt: '2026-10-29T00:00:00Z', models: { m: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 } } }))
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && (body as Record<string, unknown>)?.harnessTokens) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: harnessTokens', 400)
      return original(core, method, path, body)
    })
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, progress: () => ({ running: 900 }) } as never)
    const posts = () => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/'))
    const fields = (post: unknown) => ['harnessTokens', 'harnessProgress'].filter(key => key in (post as object))
    await machine.tick()
    expect(posts().map(c => fields(c[3]))).toEqual([['harnessTokens', 'harnessProgress'], ['harnessProgress']])
    f.advance(); await machine.tick()
    expect(posts().map(c => fields(c[3])).at(-1)).toEqual(['harnessProgress'])
    f.step(600_000); await machine.tick()
    expect(posts().map(c => fields(c[3])).slice(-2)).toEqual([['harnessTokens', 'harnessProgress'], ['harnessProgress']])
  })

  it('drops progress for a backend that refuses it, and offers it again ten minutes later', async () => {
    const f = fixture()
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && (body as Record<string, unknown>)?.harnessProgress) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: harnessProgress', 400)
      return original(core, method, path, body)
    })
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, progress: () => ({ running: 900 }) } as never)
    const posts = () => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/'))
    await machine.tick()
    expect(posts().map(c => 'harnessProgress' in (c[3] as object))).toEqual([true, false])
    f.advance(); await machine.tick()
    expect(posts().map(c => 'harnessProgress' in (c[3] as object))).toEqual([true, false, false])
    f.step(600_000); await machine.tick()
    expect(posts().map(c => 'harnessProgress' in (c[3] as object))).toEqual([true, false, false, true, false])
  })

  describe('a start this machine launched and is still preparing', () => {
    const machinePosts = (f: ReturnType<typeof fixture>) => f.backend.mock.calls
      .filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/')).map(c => c[3] as Record<string, unknown>)
    const pendingCreation = { error: 'START_PENDING', startId: 'start', creationId: 'creation', state: 'pending',
      detail: 'Keep this start ID. Run resume with it to check the same native creation; do not make another start request.' }

    it('is reported as preparing on every report while its creation is under way, and no longer once it runs', async () => {
      const f = fixture()
      f.start.mockResolvedValue(pendingCreation as never)
      // The pass that launches it reports first and launches after; the next pass says so at once.
      await f.machine.tick()
      expect(machinePosts(f).at(-1)).not.toHaveProperty('preparingStartIds')
      f.step(5_000); await f.machine.tick()
      expect(machinePosts(f).at(-1)!.preparingStartIds).toEqual(['start'])
      // Unchanged, it is sent again with each beat, so the backend sees it fresh.
      f.advance(); await f.machine.tick()
      expect(machinePosts(f)).toHaveLength(3)
      expect(machinePosts(f).at(-1)!.preparingStartIds).toEqual(['start'])
      f.start.mockResolvedValue({ ok: true, harnessId: 'harness' } as never)
      f.advance(); await f.machine.tick()
      f.advance(); await f.machine.tick()
      expect(machinePosts(f).at(-1)).not.toHaveProperty('preparingStartIds')
    })

    // Mac Auto's Harness Team account, 2026-10-29: the backend failed each start at 3 minutes while its Codex never recorded
    // its session, and the agent the machine launched for it stayed, idle, with no Swarm agent behind it.
    describe('that the backend then fails', () => {
      const waiting = { error: 'START_PENDING', startId: 'start', creationId: 'creation', harnessId: 'launched',
        detail: 'Waiting for the launched engine to record its session identity. Resume this same start request.' }
      const startPath = '/api/super-tabs/hosts/host/starts/tab/start'
      function failedLater(status: () => unknown) {
        const f = fixture()
        const closeMember = vi.fn(async (_agentId: string, _creationId?: string): Promise<Record<string, unknown>> => ({ closed: true }))
        f.core.agents.closeMember = closeMember as never
        f.start.mockResolvedValue(waiting as never)
        const original = f.backend.getMockImplementation()!
        f.backend.mockImplementation(async (core, method, path, body) => method === 'GET' && path === startPath ? status() : original(core, method, path, body))
        return { f, closeMember, fail: () => { f.pool.starts = [] } }
      }
      const settle = () => new Promise(resolve => setTimeout(resolve, 0))

      it('stops the agent it launched for it, by the start\'s own creation receipt', async () => {
        const { f, closeMember, fail } = failedLater(() => ({ error: 'Mac Auto did not start it within 3 minutes' }))
        await f.machine.tick()
        expect(closeMember).not.toHaveBeenCalled()
        fail(); f.advance(); await f.machine.tick(); await settle()
        expect(closeMember).toHaveBeenCalledWith('launched', 'creation')
        expect(f.log.mock.calls.flat().join('\n')).toContain('Stopped the agent a failed start launched (start start, session launched)')
        // Once: it is no longer the host's to stop.
        f.advance(); await f.machine.tick(); await settle()
        expect(closeMember).toHaveBeenCalledTimes(1)
      })

      // A daemon restarted between the launch and the Swarm failing the start no longer forgets the agent it launched.
      it('still stops it after the daemon restarted, from the launches it kept on disk', async () => {
        const { f, closeMember, fail } = failedLater(() => ({ error: 'Mac Auto did not start it within 3 minutes' }))
        const dataDir = mkdtempSync(join(tmpdir(), 'swarm-unconfirmed-'))
        onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
        ;(f.core as { dataDir: string }).dataDir = dataDir
        await f.machine.tick()
        expect(JSON.parse(readFileSync(swarmUnconfirmedFile(dataDir, 'host'), 'utf8')).launches)
          .toEqual([{ startId: 'start', path: startPath, harnessId: 'launched', creationId: 'creation' }])
        f.machine.stop()
        const restarted = new ContributedMachines(f.core, 'host', f.deps as never)
        fail(); f.advance(); await restarted.tick(); await settle()
        expect(closeMember).toHaveBeenCalledWith('launched', 'creation')
        expect(JSON.parse(readFileSync(swarmUnconfirmedFile(dataDir, 'host'), 'utf8')).launches).toEqual([])
        restarted.stop()
      })

      it('never stops one that joined, one its receipt does not name, or one whose start is still pending', async () => {
        const joined = failedLater(() => ({ harnessId: 'launched' }))
        await joined.f.machine.tick(); joined.fail(); joined.f.advance(); await joined.f.machine.tick(); await settle()
        expect(joined.closeMember).not.toHaveBeenCalled()
        const settled = failedLater(() => ({ error: null }))
        await settled.f.machine.tick(); settled.fail(); settled.f.advance(); await settled.f.machine.tick(); await settled.f.machine.tick(); await settle()
        expect(settled.closeMember).not.toHaveBeenCalled()
        const other = failedLater(() => ({ error: 'Abandoned before it started.' }))
        other.closeMember.mockResolvedValue({ error: 'NOT_A_MEMBER' })
        await other.f.machine.tick(); other.fail(); other.f.advance(); await other.f.machine.tick(); await settle()
        other.f.advance(); await other.f.machine.tick(); await settle()
        expect(other.closeMember).toHaveBeenCalledTimes(1)
        // Still pending on the backend: nothing is asked, nothing stopped.
        const pending = failedLater(() => ({ error: 'unused' }))
        await pending.f.machine.tick(); pending.f.advance(); await pending.f.machine.tick(); await settle()
        expect(pending.f.backend.mock.calls.some(c => c[2] === startPath)).toBe(false)
        expect(pending.closeMember).not.toHaveBeenCalled()
      })

      it('asks again on later passes when it cannot tell or cannot stop it, a few times, then lets it go', async () => {
        const { f, closeMember, fail } = failedLater(() => { throw new Error('backend down') })
        await f.machine.tick(); fail()
        for (let pass = 0; pass < 7; pass++) { f.advance(); await f.machine.tick(); await settle() }
        expect(f.backend.mock.calls.filter(c => c[2] === startPath)).toHaveLength(5)
        expect(closeMember).not.toHaveBeenCalled()
        expect(f.log.mock.calls.flat().join('\n')).toContain('Could not stop the agent a failed start launched (start start): backend down')
        const refused = failedLater(() => ({ error: 'failed' }))
        refused.closeMember.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE', detail: 'busy' })
        await refused.f.machine.tick(); refused.fail()
        refused.f.advance(); await refused.f.machine.tick(); await settle()
        refused.f.advance(); await refused.f.machine.tick(); await settle()
        expect(refused.closeMember).toHaveBeenCalledTimes(2)
        expect(refused.f.log.mock.calls.flat().join('\n')).toContain('SERVICE_UNAVAILABLE: busy')
      })

      it('leaves alone a start whose agent is not named, and a host whose core cannot close', async () => {
        const unnamed = failedLater(() => ({ error: 'failed' }))
        unnamed.f.start.mockResolvedValue({ ...waiting, harnessId: undefined } as never)
        await unnamed.f.machine.tick(); unnamed.fail(); unnamed.f.advance(); await unnamed.f.machine.tick(); await settle()
        expect(unnamed.closeMember).not.toHaveBeenCalled()
        const noClose = failedLater(() => ({ error: 'failed' }))
        noClose.f.core.agents.closeMember = undefined
        await noClose.f.machine.tick(); noClose.fail(); noClose.f.advance(); await noClose.f.machine.tick(); await settle()
        noClose.f.advance(); await noClose.f.machine.tick(); await settle()
        expect(noClose.f.backend.mock.calls.filter(c => c[2] === startPath)).toHaveLength(1)
      })
    })

    it('is not a start whose launch is uncertain, refused or failed', async () => {
      for (const result of [{ ...pendingCreation, state: 'unconfirmed' }, { error: 'START_UNCERTAIN', startId: 'start', detail: 'Inspect the machine.' },
        { error: 'CAPACITY_UNAVAILABLE', startId: 'start', reasons: ['Busy.'] }, { error: 'START_FAILED', startId: 'start', detail: 'Failed.' }]) {
        const f = fixture()
        f.start.mockResolvedValue(result as never)
        await f.machine.tick()
        f.advance(); await f.machine.tick()
        expect(machinePosts(f).at(-1)).not.toHaveProperty('preparingStartIds')
      }
    })

    it('is left out for a backend that refuses it, which then fails it at 3 minutes as before, and offered again ten minutes later', async () => {
      const f = fixture()
      f.start.mockResolvedValue(pendingCreation as never)
      const original = f.backend.getMockImplementation()!
      f.backend.mockImplementation(async (core, method, path, body) => {
        if (method === 'POST' && (body as Record<string, unknown>)?.preparingStartIds) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: preparingStartIds', 400)
        return original(core, method, path, body)
      })
      await f.machine.tick()
      f.step(5_000); await f.machine.tick()
      const sent = () => machinePosts(f).map(post => 'preparingStartIds' in post)
      expect(sent()).toEqual([false, true, false])
      f.advance(); await f.machine.tick()
      expect(sent()).toEqual([false, true, false, false])
      f.step(600_000); await f.machine.tick()
      expect(sent()).toEqual([false, true, false, false, true, false])
    })
  })

  it('drops readiness alone for a backend that takes progress, and both, keeping privacy, for one that takes neither', async () => {
    const f = fixture({}, () => ({ mode: 'dedicated' }))
    const usage = f.request.getMockImplementation()!
    f.request.mockImplementation(async (type, ...rest) => type === 'engines_probe' ? { engines: [{ engine: 'codex', installed: true, signedIn: true }] } : usage(type, ...rest as []))
    let refuses = ['readiness']
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      const sent = body as Record<string, unknown>
      if (method === 'POST' && refuses.some(key => sent?.[key])) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key', 400)
      return original(core, method, path, body)
    })
    const machine = new ContributedMachines(f.core, 'host', { ...f.deps, progress: () => ({ running: 900 }) } as never)
    const posts = () => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/')).map(c => c[3] as Record<string, unknown>)
    const fields = (post: Record<string, unknown>) => ['readiness', 'harnessProgress', 'privacy'].filter(key => key in post)
    await machine.tick()
    expect(posts().map(fields)).toEqual([['readiness', 'harnessProgress', 'privacy'], ['harnessProgress', 'privacy']])
    refuses = ['readiness', 'harnessProgress']
    const older = new ContributedMachines(f.core, 'host', { ...f.deps, progress: () => ({ running: 900 }) } as never)
    f.backend.mockClear(); await older.tick()
    expect(posts().map(fields)).toEqual([['readiness', 'harnessProgress', 'privacy'], ['harnessProgress', 'privacy'], ['privacy']])
  })

  it('lists the models it serves on the Swarm\'s grid only while the add-on is on, and drops them for an older backend', async () => {
    const GRID = 'swarm-0123456789ab'
    const f = fixture()
    await f.machine.tick()
    const local = (await f.open.mock.results[0]!.value) as { request: ReturnType<typeof vi.fn> }
    expect(local.request.mock.calls.some(c => c[0] === 'grid_fleet_models_list')).toBe(false)
    expect(f.backend.mock.calls.find(c => c[1] === 'POST')![3]).not.toHaveProperty('localModels')
    Object.assign(f.pool, { localGrid: GRID })
    local.request.mockImplementation((async (type: string) => type === 'grid_fleet_models_list'
      ? { models: [{ name: 'Qwen 3', contextWindow: 32768, servedOn: [{ grid: GRID, servedAs: ['qwen3'] }] }] } : { providers: [] }) as never)
    f.advance(); await f.machine.tick()
    expect(f.backend.mock.calls.filter(c => c[1] === 'POST').at(-1)![3]).toMatchObject({ localModels: [{ grid: GRID, model: 'qwen3', name: 'Qwen 3', contextWindow: 32768, kind: 'local' }] })
    expect(f.backend.mock.calls.filter(c => c[1] === 'POST').at(-1)![3]).not.toHaveProperty('refusedModels')
    // A model too small for Builders is reported apart, with why; an older backend that refuses the field gets it without.
    local.request.mockImplementation((async (type: string) => type === 'grid_fleet_models_list'
      ? { models: [{ name: 'llama3.2:3b', servedOn: [{ grid: GRID, servedAs: ['llama3.2:3b'] }] }] } : { providers: [] }) as never)
    const before = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && (body as Record<string, unknown>)?.refusedModels) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: refusedModels', 400)
      return before(core, method, path, body)
    })
    f.advance(); await f.machine.tick()
    const refusedPosts = f.backend.mock.calls.filter(c => c[1] === 'POST')
    expect(refusedPosts.at(-2)![3]).toMatchObject({ localModels: [], refusedModels: [{ grid: GRID, model: 'llama3.2:3b', name: 'llama3.2:3b', why: expect.stringContaining('too small') }] })
    expect(refusedPosts.at(-1)![3]).not.toHaveProperty('refusedModels')
    f.backend.mockImplementation(before)
    // A failed read serves nothing; an older backend that refuses the field gets the observation without it.
    local.request.mockImplementation((async (type: string) => { if (type === 'grid_fleet_models_list') throw new Error('timeout'); return { providers: [] } }) as never)
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && (body as Record<string, unknown>)?.localModels) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: localModels', 400)
      return original(core, method, path, body)
    })
    f.advance(); await f.machine.tick()
    const posts = f.backend.mock.calls.filter(c => c[1] === 'POST')
    expect(posts.at(-2)![3]).toMatchObject({ localModels: [] })
    expect(posts.at(-1)![3]).not.toHaveProperty('localModels')
  })
  it('adds the APIs it shares on the Swarm\'s grid and the models shared with its owner, and reads other grids once a minute', async () => {
    const GRID = 'swarm-0123456789ab'
    const f = fixture()
    Object.assign(f.pool, { localGrid: GRID })
    await f.machine.tick()
    const local = (await f.open.mock.results[0]!.value) as { request: ReturnType<typeof vi.fn> }
    local.request.mockImplementation((async (type: string) => type === 'grid_swarm_api_shares'
      ? { shares: [{ grid: GRID, connectionId: 'c1', model: 'deepseek/deepseek-chat', name: 'OpenRouter' }] }
      : type === 'grid_swarm_offers' ? { offers: [{ grid: GRID, sharedGrid: 'team-grid', model: 'qwen3-30b' }] }
      : type === 'grid_models_list' ? { grids: [{ name: 'team-grid', models: [{ id: 'qwen3-30b' }, { id: 'not-offered' }] }] } : { providers: [] }) as never)
    f.advance(); await f.machine.tick()
    expect(f.backend.mock.calls.filter(c => c[1] === 'POST').at(-1)![3]).toMatchObject({ localModels: [
      { grid: GRID, model: 'deepseek/deepseek-chat', name: 'deepseek/deepseek-chat · OpenRouter', kind: 'api' },
      { grid: 'team-grid', model: 'qwen3-30b', kind: 'shared' },
    ] })
    const reads = () => local.request.mock.calls.filter(c => c[0] === 'grid_models_list').length
    const before = reads()
    f.advance(); await f.machine.tick()
    expect(reads()).toBe(before)
    f.step(60_000); await f.machine.tick()
    expect(reads()).toBe(before + 1)
  })
  it('reports what the Swarm\'s grid does not list yet as starting, and everything as it is when the grid is unread', async () => {
    const GRID = 'swarm-0123456789ab'
    const f = fixture()
    Object.assign(f.pool, { localGrid: GRID })
    await f.machine.tick()
    const local = (await f.open.mock.results[0]!.value) as { request: ReturnType<typeof vi.fn> }
    let heal: unknown = { live: ['qwen3'], missing: ['deepseek/deepseek-chat'] }
    local.request.mockImplementation((async (type: string) => type === 'grid_swarm_api_shares'
      ? { shares: [{ grid: GRID, connectionId: 'c1', model: 'deepseek/deepseek-chat' }] }
      : type === 'grid_fleet_models_list' ? { models: [{ servedOn: [{ grid: GRID, servedAs: ['qwen3'] }] }] }
      : type === 'grid_swarm_heal' ? heal : { providers: [] }) as never)
    const reported = async () => { f.advance(); await f.machine.tick()
      return (f.backend.mock.calls.filter(c => c[1] === 'POST').at(-1)![3] as { localModels: Array<{ model: string; starting?: true }> }).localModels
        .map(m => m.starting ? `${m.model} (starting)` : m.model) }
    expect(await reported()).toEqual(['qwen3', 'deepseek/deepseek-chat (starting)'])
    expect(local.request).toHaveBeenCalledWith('grid_swarm_heal', { grid: GRID }, 30_000)
    heal = { live: null, missing: [] }
    expect(await reported()).toEqual(['qwen3', 'deepseek/deepseek-chat'])
    heal = Promise.reject(new Error('older daemon'))
    expect(await reported()).toEqual(['qwen3', 'deepseek/deepseek-chat'])
  })
  // 2026-10-26: a model run for the Swarm waited for the next 15 s beat to reach the machine's panel, then for the grid.
  it('sends a reading on the next pass when its Swarm models change, and every pass while one is starting', async () => {
    const GRID = 'swarm-0123456789ab'
    const f = fixture()
    Object.assign(f.pool, { localGrid: GRID })
    await f.machine.tick()
    const local = (await f.open.mock.results[0]!.value) as { request: ReturnType<typeof vi.fn> }
    let live: string[] = []
    local.request.mockImplementation((async (type: string) => type === 'grid_fleet_models_list'
      ? { models: [{ servedOn: [{ grid: GRID, servedAs: ['qwen3'] }] }] }
      : type === 'grid_swarm_heal' ? { live, missing: [] } : { providers: [] }) as never)
    const posts = () => f.backend.mock.calls.filter(c => c[1] === 'POST').length
    const pass = async () => { f.step(6_000); await f.machine.tick() }
    await pass()
    const quiet = posts()
    await pass()
    expect(posts()).toBe(quiet)
    // A start: the engine records change, so this pass sends it, as starting, and the next ones too until it is listed.
    f.stamp('s1')
    await pass()
    expect(posts()).toBe(quiet + 1)
    expect((f.backend.mock.calls.at(-1)![3] as { localModels: unknown[] }).localModels).toEqual([{ grid: GRID, model: 'qwen3', kind: 'local', starting: true }])
    await pass()
    expect(posts()).toBe(quiet + 2)
    live = ['qwen3']
    await pass()
    expect((f.backend.mock.calls.filter(c => c[1] === 'POST').at(-1)![3] as { localModels: unknown[] }).localModels).toEqual([{ grid: GRID, model: 'qwen3', kind: 'local' }])
    const listed = posts()
    await pass()
    expect(posts()).toBe(listed)
    // A backend before `starting` refuses it, and gets what the grid lists rather than no models at all.
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && JSON.stringify(body).includes('"starting"')) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: starting', 400)
      return original(core, method, path, body)
    })
    live = []
    f.stamp('s2')
    await pass()
    expect((f.backend.mock.calls.at(-1)![3] as { localModels: unknown[] }).localModels).toEqual([])
    f.backend.mockImplementation(original)
  })
  it('stamps the files that change with this machine\'s Swarm models, never reading them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'models-stamp-'))
    try {
      const before = await localModelsStamp(home, { GRID_HOME: join(home, 'grid') })
      await mkdir(join(home, 'grid', 'run', 'engines', 'grid-1'), { recursive: true })
      await writeFile(join(home, 'grid', 'run', 'engines', 'grid-1', 'remote.json'), '{}')
      await writeFile(join(home, 'swarm-api-shares.json'), '[]')
      const after = await localModelsStamp(home, { GRID_HOME: join(home, 'grid') })
      expect(after).not.toBe(before)
      expect(after.split(',')).toHaveLength(2)
      expect(await localModelsStamp(home, { HOME: home })).toMatch(/^\d/)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
  it('reads the models a heal answer says are live', () => {
    expect(liveOn({ live: ['a', 7, 'b'] })).toEqual(new Set(['a', 'b']))
    expect(liveOn({ live: null })).toBeNull()
    expect(liveOn(null)).toBeNull()
  })
  it('keeps of the models shared with its owner only those they offer', () => {
    const shared = [{ grid: 'team', model: 'a', kind: 'shared' as const }, { grid: 'team', model: 'b', kind: 'shared' as const }]
    expect(offered(shared, { offers: [{ sharedGrid: 'team', model: 'b' }] })).toEqual([shared[1]])
    expect(offered(shared, null)).toEqual([])
  })
  it('reads only live models of grids other than Swarms\', once each, and shared APIs of this Swarm alone', () => {
    const GRID = 'swarm-0123456789ab'
    expect(sharedWith(null, GRID)).toEqual([])
    expect(sharedWith({ grids: [
      { name: GRID, models: [{ id: 'mine' }] }, { name: 'swarm-ffffffffffff', models: [{ id: 'theirs' }] },
      { name: 'team', models: [{ id: 'a' }, { id: 'a' }, { id: 'down', unavailable: { reason: 'offline' } }, { id: 7 }, { id: '' }] },
      { name: 7, models: [{ id: 'b' }] }, { name: 'x'.repeat(161), models: [{ id: 'c' }] },
    ] }, GRID)).toEqual([{ grid: 'team', model: 'a', kind: 'shared' }])
    expect(apisOn({ shares: [{ grid: GRID, model: 'm' }, { grid: 'other', model: 'n' }, { grid: GRID, model: '' }, { grid: GRID, model: 'x'.repeat(201) }] }, GRID))
      .toEqual([{ grid: GRID, model: 'm', kind: 'api' }])
    expect(apisOn(null, GRID)).toEqual([])
  })
  it('leaves out a served model too small or too slow for a coding agent', () => {
    const GRID = 'swarm-0123456789ab'
    const on = (servedAs: string, more: Record<string, unknown> = {}) => ({ ...more, servedOn: [{ grid: GRID, servedAs: [servedAs] }] })
    expect(servedOn({ models: [
      on('llama3.2:3b', { name: 'llama3.2:3b', sizeBytes: 2e9 }), on('Qwen3-4B'), on('slow', { name: 'Qwen3.6-35B-A3B', estTokS: 3 }),
      on('fast', { name: 'Qwen3.6-35B-A3B', estTokS: 3, tokensPerSecond: 40, paramsB: 35, quant: 'Q4_K_M' }), on('gemma', { name: 'gemma-4-E2B-it', sizeBytes: 3.2e9 }),
    ] }, GRID).map(m => m.model)).toEqual(['fast'])
    // What is left out is reported with why, so a Lead asked for it hears that rather than to share it.
    expect(refusedOn({ models: [on('llama3.2:3b', { name: 'llama3.2:3b', sizeBytes: 2e9 }), on('Qwen3-4B'), on('fast', { paramsB: 35, tokensPerSecond: 40 })] }, GRID)).toEqual([
      { grid: GRID, model: 'llama3.2:3b', name: 'llama3.2:3b', why: 'llama3.2:3b is too small for a coding agent (about 3B parameters; Builders need 7B or more).' },
      { grid: GRID, model: 'Qwen3-4B', why: 'Qwen3-4B is too small for a coding agent (about 4B parameters; Builders need 7B or more).' },
    ])
    expect(refusedOn(null, GRID)).toEqual([])
  })
  it('reads a served model by the first name grid lists it under, and keeps sixteen at most', () => {
    const GRID = 'swarm-0123456789ab'
    expect(servedOn(null, GRID)).toEqual([])
    expect(servedOn({ models: [
      { name: 7, contextWindow: 1.5, servedOn: [{ grid: 'other', servedAs: ['elsewhere'] }, { grid: GRID, servedAs: ['', 9, 'qwen3'] }] },
      { servedOn: [{ grid: GRID, servedAs: 'qwen3' }] }, { servedOn: [{ grid: GRID, servedAs: ['x'.repeat(201)] }] }, { contextWindow: -1, servedOn: [{ grid: GRID }] },
    ] }, GRID)).toEqual([{ grid: GRID, model: 'qwen3', kind: 'local' }])
    const many = { models: Array.from({ length: 20 }, (_, i) => ({ name: 'n'.repeat(300), servedOn: [{ grid: GRID, servedAs: [`m${i}`] }] })) }
    const read = servedOn(many, GRID)
    expect(read).toHaveLength(16)
    expect(read[0]!.name).toHaveLength(200)
  })

  // The Harness Team account (cli/src/team/): its daemon reports its privacy check with the reading, and refuses new
  // work while it fails, besides routing (Task 3) not sending it any.
  describe('Harness Team privacy', () => {
    const passed: PrivacyObservation = { mode: 'account', passed: true, checkedAt: 900 }
    const exposed: PrivacyObservation = { mode: 'account', passed: false, item: 'gitconfig', detail: 'The team account could read ~/.gitconfig.', checkedAt: 900 }
    const posts = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/')).map(c => c[3] as Record<string, unknown>)

    it('sends the check with the reading, and nothing from the owner\'s own daemon', async () => {
      const team = fixture({}, () => passed)
      await team.machine.tick()
      expect(posts(team)[0]).toMatchObject({ privacy: passed })
      expect(team.start).toHaveBeenCalledOnce()
      const owner = fixture()
      await owner.machine.tick()
      expect(posts(owner)[0]).not.toHaveProperty('privacy')
      const dedicated = fixture({}, () => ({ mode: 'dedicated' }))
      await dedicated.machine.tick()
      expect(posts(dedicated)[0]).toMatchObject({ privacy: { mode: 'dedicated' } })
      expect(dedicated.start).toHaveBeenCalledOnce()
    })

    it('refuses a new start while the team account is not private, and never starts it anywhere else', async () => {
      const f = fixture({}, () => exposed)
      await f.machine.tick()
      expect(f.start).not.toHaveBeenCalled()
      const refusal = f.backend.mock.calls.find(c => String(c[2]).endsWith('/starts/tab/start'))![3] as { operationId: string; command: Record<string, unknown> }
      expect(refusal.operationId).toBe('privacy-failed-start')
      expect(refusal.command).toMatchObject({ type: 'agent.startFailed', startId: 'start' })
      expect(String(refusal.command.error)).toContain('not private (gitconfig)')
      // One already dispatched is reconciled as before: refusing it could orphan what it launched.
      f.pool.starts[0]!.dispatched = true
      f.advance(); await f.machine.tick()
      expect(f.start).toHaveBeenCalledOnce()
    })

    it('sends a changed result at once, without waiting for the next beat', async () => {
      let current: PrivacyObservation = passed
      const f = fixture({}, () => current)
      await f.machine.tick()
      f.step(6_000); await f.machine.tick()
      expect(posts(f)).toHaveLength(1)
      current = exposed
      f.step(6_000); await f.machine.tick()
      expect(posts(f)).toHaveLength(2)
      expect(posts(f)[1]).toMatchObject({ privacy: { passed: false, item: 'gitconfig' } })
    })

    it('reports a check that throws as unchecked, and refuses on it', async () => {
      const f = fixture({}, () => { throw new Error('config unreadable') })
      await f.machine.tick()
      expect(posts(f)[0]).toMatchObject({ privacy: { mode: 'account', passed: false, item: 'unchecked' } })
      expect(f.start).not.toHaveBeenCalled()
    })

    it('drops only the privacy field for a backend from before it, for ten minutes, keeping the local-model fields', async () => {
      const f = fixture({}, () => passed)
      f.capabilities.mockResolvedValue({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
        tools: { git: true }, toolProbeErrors: { flutter: 'timed out' } } as never)
      const original = f.backend.getMockImplementation()!
      f.backend.mockImplementation(async (core, method, path, body) => {
        if (method === 'POST' && (body as Record<string, unknown>)?.privacy) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: privacy', 400)
        return original(core, method, path, body)
      })
      await f.machine.tick()
      expect(posts(f)).toHaveLength(2)
      expect(posts(f)[1]).not.toHaveProperty('privacy')
      expect(posts(f)[1]).toHaveProperty('toolProbeErrors')
      f.advance(); await f.machine.tick()
      expect(posts(f)).toHaveLength(3)
      expect(posts(f)[2]).not.toHaveProperty('privacy')
      f.step(10 * 60_000); await f.machine.tick()
      expect(posts(f).at(-2)).toHaveProperty('privacy')
      expect(posts(f).at(-1)).not.toHaveProperty('privacy')
    })

    it('falls back to the oldest reading when the backend refuses the other new fields too', async () => {
      const f = fixture({}, () => passed)
      f.capabilities.mockResolvedValue({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
        tools: { git: true }, toolProbeErrors: { flutter: 'timed out' } } as never)
      const original = f.backend.getMockImplementation()!
      f.backend.mockImplementation(async (core, method, path, body) => {
        const sent = body as Record<string, unknown>
        if (method === 'POST' && (sent?.privacy || sent?.toolProbeErrors)) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key', 400)
        return original(core, method, path, body)
      })
      await f.machine.tick()
      expect(posts(f)).toHaveLength(3)
      expect(posts(f)[2]).not.toHaveProperty('privacy')
      expect(posts(f)[2]).not.toHaveProperty('toolProbeErrors')
    })

    it('does not retry a refusal that is not about the fields', async () => {
      const f = fixture({}, () => passed)
      const original = f.backend.getMockImplementation()!
      f.backend.mockImplementation(async (core, method, path, body) => {
        if (method === 'POST' && String(path).includes('/machines/')) throw new SuperTabHostError('FORBIDDEN', 'no', 403)
        return original(core, method, path, body)
      })
      await expect(f.machine.tick()).resolves.toBeUndefined()
      expect(posts(f)).toHaveLength(1)
    })
  })

  it('binds stopped native proof to the current slot reservation generation', async () => {
    const f = fixture()
    Object.assign(f.pool, { reservations: [{ harnessId: 'stopped', generation: 'new-contribution' }] })
    await f.machine.tick()
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ stoppedReservations: [{ harnessId: 'stopped', generation: 'new-contribution' }] })
  })

  it('does not connect to a daemon without an explicit contribution', async () => {
    const f = fixture()
    f.backend.mockResolvedValue(hostForm([{ tabId: 'tab', agent: { id: 'existing-agent' } }]))
    await f.machine.tick()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('pause blocks new work but still reconciles an already dispatched receipt', async () => {
    const f = fixture(); f.pool.machine.paused = true
    await f.machine.tick()
    expect(f.start).not.toHaveBeenCalled()
    f.pool.starts[0]!.dispatched = true
    f.advance(); await f.machine.tick()
    expect(f.start).toHaveBeenCalledOnce()
  })

  // DESKTOP-0TFH0OJ, 2026-10-23: CLI 0.4.57 refused every Claude start there as not signed in (Claude ran on an API key
  // set in its settings), and the pass dropped the refusal: two starts stayed "Queued" for hours with nothing in the log.
  it('logs why a waiting start was not started, once per reason', async () => {
    const f = fixture()
    f.start.mockResolvedValue({ error: 'CAPACITY_UNAVAILABLE', startId: 'start', reasons: ['The selected agent engine is not signed in on this machine.'] } as never)
    await f.machine.tick()
    f.advance(); await f.machine.tick()
    expect(f.start).toHaveBeenCalledTimes(2)
    expect(f.log.mock.calls).toEqual([['Swarm start start is waiting: The selected agent engine is not signed in on this machine.']])
    f.start.mockRejectedValue(new Error('Could not reach the Harness backend.'))
    f.advance(); await f.machine.tick()
    f.start.mockResolvedValue({ ok: true, harnessId: 'harness' } as never)
    f.advance(); await f.machine.tick()
    f.start.mockResolvedValue({ error: 'START_PENDING', startId: 'start', detail: 'Waiting for the launched engine.' } as never)
    f.advance(); await f.machine.tick()
    expect(f.log.mock.calls.slice(1)).toEqual([['Swarm start start is waiting: Could not reach the Harness backend.'],
      ['Swarm start start is waiting: Waiting for the launched engine.']])
  })

  // Diego's Mac, 2026-10-28: 410 connect timeouts on the reading in two days, and every one dropped that Swarm's starts
  // for the pass with nothing in the log, until the backend's deadline failed them.
  describe('a reading the backend did not take', () => {
    const failReading = (f: ReturnType<typeof fixture>, error: () => unknown) => f.backend.mockImplementation(async (_core, method, path) =>
      path.includes('/hosts/host/changes') ? hostForm([], { pools: [f.pool] }) : method === 'POST' && path.includes('/machines/') ? Promise.reject(error()) : { revision: 1 })

    it('is logged once per error, again when it changes or clears, and the waiting start is still launched', async () => {
      const f = fixture()
      failReading(f, () => new Error('Connect Timeout Error'))
      await f.machine.tick()
      f.advance(); await f.machine.tick()
      expect(f.start).toHaveBeenCalledTimes(2)
      failReading(f, () => new SuperTabHostError('VALIDATION_ERROR', 'Invalid request body', 400))
      f.advance(); await f.machine.tick()
      f.advance(); await f.machine.tick()
      expect(f.start).toHaveBeenCalledTimes(4)
      failReading(f, () => new SuperTabHostError('BACKEND_UNAVAILABLE', 'Could not reach this Super Tab.', 503))
      f.advance(); await f.machine.tick()
      expect(f.start).toHaveBeenCalledTimes(5)
      f.backend.mockImplementation(async (_core, _method, path) => path.includes('/hosts/host/changes') ? hostForm([], { pools: [f.pool] }) : { revision: 1 })
      f.advance(); await f.machine.tick()
      f.advance(); await f.machine.tick()
      expect(f.start).toHaveBeenCalledTimes(7)
      expect(f.log.mock.calls).toEqual([
        ['Could not send this machine\'s reading to Swarm tab: Connect Timeout Error'],
        ['Could not send this machine\'s reading to Swarm tab: Invalid request body'],
        ['Could not send this machine\'s reading to Swarm tab: Could not reach this Super Tab.'],
        ['This machine\'s reading reached Swarm tab again.']])
    })

    it('is logged, and the waiting start still launched, when the local daemon cannot be opened', async () => {
      const f = fixture()
      f.open.mockRejectedValueOnce(new Error('The Harness daemon is not running.'))
      await f.machine.tick()
      expect(f.start).toHaveBeenCalledOnce()
      expect(f.log.mock.calls).toEqual([['Could not send this machine\'s reading to Swarm tab: The Harness daemon is not running.']])
    })

    it('launches nothing when the refusal says this machine lost access to that Swarm', async () => {
      for (const [code, status] of [['CONTRIBUTION_REVOKED', 403], ['HOST_UNAVAILABLE', 403], ['NOT_FOUND', 404], ['UNAUTHORIZED', 401]] as const) {
        const f = fixture()
        failReading(f, () => new SuperTabHostError(code, 'Read the current machine contribution.', status))
        await f.machine.tick()
        expect(f.start).not.toHaveBeenCalled()
        expect(f.log.mock.calls).toEqual([['Could not send this machine\'s reading to Swarm tab: Read the current machine contribution.']])
      }
    })
  })

  describe('a start this machine cannot run', () => {
    const failures = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'POST' && c[2] === '/api/super-tabs/hosts/host/starts/tab/start')
      .map(c => c[3] as { operationId: string; command: { type: string; error?: string } }).filter(body => body.command.type === 'agent.startFailed')

    it('is failed with the machine\'s own reason once it has refused it for a minute', async () => {
      const f = fixture()
      f.start.mockResolvedValue({ error: 'CAPACITY_UNAVAILABLE', startId: 'start', reasons: ['The selected agent engine is not installed on this machine.', 'CPU use is 97%; the requested maximum is 85%.'] } as never)
      await f.machine.tick()
      // A busy minute passes: CPU or memory may free up, and routing saw this machine able a moment ago.
      f.step(30_000); await f.machine.tick()
      expect(failures(f)).toEqual([])
      f.step(30_000); await f.machine.tick()
      expect(failures(f)).toEqual([{ operationId: 'refused-start', command: { type: 'agent.startFailed', startId: 'start',
        error: 'The selected agent engine is not installed on this machine. CPU use is 97%; the requested maximum is 85%.' } }])
    })

    it('starts its minute again after a pass that did not refuse it, and never fails one whose launch is uncertain or pending', async () => {
      const f = fixture()
      f.start.mockResolvedValue({ error: 'CONTRIBUTION_REQUIRED', startId: 'start', detail: 'Ask the machine owner to use Add machine in this Swarm.' } as never)
      await f.machine.tick()
      f.start.mockRejectedValue(new Error('Could not reach the Harness backend.'))
      f.step(30_000); await f.machine.tick()
      f.start.mockResolvedValue({ error: 'CONTRIBUTION_REQUIRED', startId: 'start', detail: 'Ask the machine owner to use Add machine in this Swarm.' } as never)
      f.step(30_000); await f.machine.tick()
      expect(failures(f)).toEqual([])
      for (const error of ['START_UNCERTAIN', 'START_PENDING', 'START_REFUSED']) {
        f.start.mockResolvedValue({ error, startId: 'start', detail: 'The machine did not confirm.' } as never)
        f.step(60_000); await f.machine.tick()
        f.step(60_000); await f.machine.tick()
      }
      // Refused again: its minute starts now, not at the passes before.
      f.start.mockResolvedValue({ error: 'CONTRIBUTION_REQUIRED', startId: 'start', detail: 'Ask the machine owner to use Add machine in this Swarm.' } as never)
      f.step(60_000); await f.machine.tick()
      expect(failures(f)).toEqual([])
    })
  })

  it('a lead queues a contributed start without connecting to that computer', async () => {
    const open = vi.fn()
    const scoped = vi.fn(async () => ({ ok: true, value: { creationId: 'creation', poolGeneration: 'grant', request: { machineId: 'host', engine: 'claude' } } }))
    const reply = await startAgent({ startId: 'start' }, scoped, { port: 14001, machineId: 'lead', dataDir: '/fixture' }, open)
    expect(reply).toMatchObject({ ok: true, queued: true, startId: 'start', machineId: 'host' })
    expect(open).not.toHaveBeenCalled()
  })

  describe('how soon a change is seen', () => {
    const posts = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/'))
    const reads = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'GET' && String(c[2]).includes('/hosts/host/changes'))
    const lastBody = (f: ReturnType<typeof fixture>) => posts(f).at(-1)![3] as { runningHarnessIds: string[]; stoppedHarnessIds: string[] }
    /** The next host tick, `ms` later. */
    const after = async (f: ReturnType<typeof fixture>, ms: number) => { f.step(ms); await f.machine.tick() }
    const quiet = (f: ReturnType<typeof fixture>) => { f.pool.starts.length = 0 }

    it('publishes at once when a harness starts or stops running', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      expect(posts(f)).toHaveLength(1)
      expect(lastBody(f)).toMatchObject({ runningHarnessIds: ['running'], stoppedHarnessIds: ['stopped'] })

      // A harness comes up on this machine: the next look says so, long before a beat has passed.
      f.pool.harnessIds.push('newcomer')
      vi.mocked(f.core.agents.byAgent).mockImplementation(id => ['running', 'newcomer'].includes(id) ? { agentId: id } as never : undefined)
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      expect(lastBody(f).runningHarnessIds).toEqual(['running', 'newcomer'])

      // And one stops.
      vi.mocked(f.core.agents.stopped!).mockImplementation(async id => id === 'stopped' || id === 'running')
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(3)
      expect(lastBody(f)).toMatchObject({ runningHarnessIds: ['newcomer'], stoppedHarnessIds: ['running', 'stopped'] })
    })

    it('reports a session closed by hand, which leaves no stopped record, as stopped on the next look', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      expect(lastBody(f)).toMatchObject({ runningHarnessIds: ['running'], stoppedHarnessIds: ['stopped'] })
      // Closed or crashed: gone from the registry, and kept nowhere as a stopped agent.
      vi.mocked(f.core.agents.byAgent).mockImplementation(() => undefined)
      Object.assign(f.core.agents, { gone: vi.fn(async (id: string) => id === 'running') })
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      expect(lastBody(f)).toMatchObject({ runningHarnessIds: [], stoppedHarnessIds: ['running', 'stopped'] })
    })

    it('publishes at once when new work is paused or allowed again', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      // Paused on the machine's own grant, then allowed; paused for the whole tab, then allowed.
      for (const change of [() => { f.pool.machine.paused = true }, () => { f.pool.machine.paused = false },
        () => { f.pool.paused = true }, () => { f.pool.paused = false }]) {
        const before = posts(f).length
        change()
        await after(f, 5_000)
        expect(posts(f)).toHaveLength(before + 1)
      }
    })

    it('publishes at once when a start is waiting, and picks it up in the same look', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      expect(f.start).not.toHaveBeenCalled()
      f.pool.starts.push({ id: 'second', dispatched: false })
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      expect(f.start).toHaveBeenCalledOnce()
      expect((f.start.mock.calls as unknown[][])[0]![0]).toEqual({ tabId: 'tab', startId: 'second', hostDispatch: true })
      // Settled: that too is a change, and is sent.
      f.pool.starts.length = 0
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(3)
    })

    it('picks a waiting start up within five seconds, not fifteen', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      f.pool.starts.push({ id: 'late', dispatched: false })
      await after(f, 4_000)
      expect(f.start).not.toHaveBeenCalled()
      await after(f, 1_000)
      expect(f.start).toHaveBeenCalledOnce()
    })

    it('keeps the fifteen second heartbeat when nothing changes, and reads the machine only to send it', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      for (const ms of [5_000, 5_000]) await after(f, ms)
      expect(reads(f)).toHaveLength(3)
      expect(posts(f)).toHaveLength(1)
      expect(f.capabilities).toHaveBeenCalledOnce()
      expect(f.open).toHaveBeenCalledOnce()
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      expect(f.capabilities).toHaveBeenCalledTimes(2)
      // The beat counts from the last send.
      await after(f, 10_000)
      expect(posts(f)).toHaveLength(2)
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(3)
    })

    it('looks no more often than every five seconds', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      for (const ms of [1_000, 1_000, 1_000, 1_000]) await after(f, ms)
      expect(reads(f)).toHaveLength(1)
      await after(f, 1_000)
      expect(reads(f)).toHaveLength(2)
    })

    it('never has more than one look in flight', async () => {
      const f = fixture(); quiet(f)
      let release!: (rows: unknown) => void
      f.backend.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const first = f.machine.tick()
      // The host ticks every second whatever is in flight; none of those starts another look.
      for (const ms of [1_000, 5_000, 10_000, 20_000]) { f.step(ms); void f.machine.tick() }
      await Promise.resolve()
      expect(reads(f)).toHaveLength(1)
      release(hostForm([], { pools: [f.pool] }))
      await first
      expect(reads(f)).toHaveLength(1)
      expect(posts(f)).toHaveLength(1)
      await after(f, 5_000)
      expect(reads(f)).toHaveLength(2)
    })

    it('waits a whole beat after a look that failed, and after a send that failed', async () => {
      const f = fixture(); quiet(f)
      f.backend.mockRejectedValueOnce(new Error('backend unreachable'))
      await expect(f.machine.tick()).rejects.toThrow('backend unreachable')
      await after(f, 5_000); await after(f, 5_000)
      expect(reads(f)).toHaveLength(1)
      await after(f, 5_000)
      expect(reads(f)).toHaveLength(2)

      f.backend.mockImplementation(async (_core, method, path) => path.includes('/hosts/host/changes') ? hostForm([], { pools: [f.pool] }) : method === 'POST' ? Promise.reject(new Error('refused')) : { revision: 1 })
      await after(f, 15_000)
      expect(posts(f)).toHaveLength(2)
      await after(f, 5_000); await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(3)
    })

    it('does not reach the daemon in a look with nothing to send', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      f.open.mockClear(); f.close.mockClear()
      await after(f, 5_000)
      expect(f.open).not.toHaveBeenCalled()
      expect(f.close).not.toHaveBeenCalled()
    })

    it('sends again once a contribution comes back after it was withdrawn', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      const pools = f.backend.getMockImplementation()!
      f.backend.mockImplementation(async (core, method, path, body) => path.includes('/hosts/host/changes') ? hostForm([], { tabs: ['tab'] }) : pools(core, method, path, body))
      await after(f, 5_000)
      f.backend.mockImplementation(pools)
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
    })
  })

  // 2026-10-28: the Mac Studio's 15-second reading went out only at the end of a pass that also ran git in 22 session
  // folders and launched agents; it arrived 31 s apart, past 45 s under load, and every agent there showed as Down.
  describe('the beat while a pass is slow', () => {
    const posts = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/'))
    /** A pass that stops at its launch, until `launched` is called. */
    function stuck(f: ReturnType<typeof fixture>) {
      let launched!: () => void
      f.start.mockImplementation(() => new Promise(resolve => { launched = () => resolve({ ok: true }) }) as never)
      const pass = f.machine.tick()
      return { pass, launched: () => launched() }
    }
    const beat = async (f: ReturnType<typeof fixture>, ms: number) => { f.step(ms); f.machine.beat(); await new Promise(done => setTimeout(done, 0)) }

    it('re-sends the last reading on its own once a slow pass has sent none for fifteen seconds', async () => {
      const f = fixture()
      const { pass, launched } = stuck(f)
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
      expect(posts(f)).toHaveLength(1)
      await beat(f, 14_999)
      expect(posts(f)).toHaveLength(1)
      await beat(f, 1)
      expect(posts(f)).toHaveLength(2)
      expect(posts(f)[1]![2]).toBe(posts(f)[0]![2])
      expect(posts(f)[1]![3]).toEqual(posts(f)[0]![3])
      // The beat counts from the last send, a re-send included.
      await beat(f, 14_999)
      expect(posts(f)).toHaveLength(2)
      await beat(f, 1)
      expect(posts(f)).toHaveLength(3)
      launched(); await pass
    })

    it('never re-sends while passes keep up: the pass sends its own reading', async () => {
      const f = fixture(); f.pool.starts.length = 0
      await f.machine.tick()
      for (let i = 0; i < 4; i++) await beat(f, 16_000)
      expect(posts(f)).toHaveLength(1)
    })

    it('leaves out whether folders have uncommitted changes, which only a fresh read may vouch for', async () => {
      const f = fixture()
      vi.mocked(f.core.agents.byAgent).mockImplementation(id => id === 'running' ? { agentId: id, cwd: '/work/running' } as never : undefined)
      const git = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }))
      const machine = new ContributedMachines(f.core, 'host', { ...f.deps, git } as never)
      f.pool.starts.length = 0
      await machine.tick()
      await vi.waitFor(() => expect(git).toHaveBeenCalledOnce())
      f.step(16_000); await machine.tick()
      expect(posts(f).at(-1)![3]).toHaveProperty('harnessUncommitted', { running: false })
      f.pool.starts.push({ id: 'start', dispatched: false })
      f.start.mockImplementation(() => new Promise(() => {}) as never)
      f.step(16_000); void machine.tick()
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
      const sent = posts(f).at(-1)![3] as Record<string, unknown>
      f.step(15_000); machine.beat()
      await vi.waitFor(() => expect(posts(f).length).toBeGreaterThan(3))
      const { harnessUncommitted: _uncommitted, ...rest } = sent
      expect(posts(f).at(-1)![3]).toEqual(rest)
    })

    it('stops re-sending once a pass has run for three minutes, so a stuck daemon shows as offline', async () => {
      const f = fixture()
      const { pass, launched } = stuck(f)
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
      for (let i = 0; i < 11; i++) await beat(f, 15_000)
      // 2:45 into the pass: eleven beats.
      expect(posts(f)).toHaveLength(12)
      await beat(f, 15_000)
      await beat(f, 15_000)
      expect(posts(f)).toHaveLength(12)
      launched(); await pass
    })

    it('has one re-send in flight at most, and says why one failed', async () => {
      const f = fixture()
      const { pass, launched } = stuck(f)
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
      let answer!: (value: unknown) => void
      f.backend.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
      await beat(f, 15_000)
      await beat(f, 15_000)
      expect(posts(f)).toHaveLength(2)
      answer({ revision: 2 }); await new Promise(done => setTimeout(done, 0))
      f.backend.mockRejectedValueOnce(new SuperTabHostError('CONTRIBUTION_REVOKED', 'Read the current machine contribution.', 403))
      await beat(f, 1_000)
      expect(posts(f)).toHaveLength(3)
      expect(f.log).toHaveBeenCalledWith(expect.stringContaining('Read the current machine contribution.'))
      launched(); await pass
    })

    it('never lets a re-send land after a newer reading: the pass waits for one in flight, and none starts while it sends', async () => {
      const f = fixture(); f.pool.starts.length = 0
      await f.machine.tick()
      expect(posts(f)).toHaveLength(1)
      // The next pass is slow to measure, and a re-send goes meanwhile; the backend holds it.
      let measured!: () => void
      f.capabilities.mockImplementationOnce(() => new Promise(resolve => { measured = () => resolve({ ok: true, resources: {}, tools: { git: true } }) }) as never)
      let answer!: (value: unknown) => void
      f.step(16_000); const pass = f.machine.tick()
      await vi.waitFor(() => expect(f.capabilities).toHaveBeenCalledTimes(2))
      f.backend.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
      f.machine.beat()
      expect(posts(f)).toHaveLength(2)
      measured()
      await new Promise(done => setTimeout(done, 10))
      expect(posts(f)).toHaveLength(2)
      answer({ revision: 2 })
      await pass
      expect(posts(f)).toHaveLength(3)
      // While the pass sends its reading, no re-send starts.
      let taken!: (value: unknown) => void
      f.backend.mockImplementation(async (_core, method, path) => path.includes('/hosts/host/changes') ? hostForm([], { pools: [f.pool] })
        : method === 'POST' ? new Promise(resolve => { taken = resolve }) : { revision: 1 })
      f.step(16_000); const sending = f.machine.tick()
      await vi.waitFor(() => expect(posts(f)).toHaveLength(4))
      f.step(15_000); f.machine.beat()
      expect(posts(f)).toHaveLength(4)
      taken({ revision: 3 }); await sending
    })

    it('re-sends nothing for a Swarm that no longer lists this machine', async () => {
      const f = fixture(); f.pool.starts.length = 0
      await f.machine.tick()
      const pools = f.backend.getMockImplementation()!
      f.backend.mockImplementation(async (core, method, path, body) => path.includes('/hosts/host/changes') ? hostForm([], { tabs: ['tab'] }) : pools(core, method, path, body))
      f.step(5_000); await f.machine.tick()
      f.backend.mockImplementation(async (core, method, path, body) => path.includes('/hosts/host/changes') ? new Promise(() => {}) : pools(core, method, path, body))
      f.step(5_000); void f.machine.tick()
      await beat(f, 15_000)
      expect(posts(f)).toHaveLength(1)
    })
  })
})

describe('removed machine cleanup', () => {
  const roots: string[] = []
  afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString()
  const repo = (path: string) => { mkdirSync(path, { recursive: true }); git(path, 'init', '-q'); git(path, 'commit', '-q', '--allow-empty', '-m', 'init'); return path }
  const worktree = (source: string, path: string, branch: string) => { git(source, 'worktree', 'add', '-q', '-b', branch, path); writeFileSync(join(path, 'unpushed.txt'), 'work'); return path }
  const session = (agentId: string, cwd: string, startedBy?: 'agent') => ({ agentId, cwd, ...(startedBy ? { startedBy } : {}) }) as unknown as RegisteredSession

  /** A temporary home and Harness data folder: the tab's two Swarm folders, a Swarm clone, a person's own clone with
   *  their own worktree, and Swarm worktrees made from each, one known from this host's record, one from the tab's
   *  start receipts, and one whose receipt names another agent. */
  function machine() {
    const root = mkdtempSync(join(tmpdir(), 'swarm-cleanup-')); roots.push(root)
    const home = join(root, 'home'), data = join(root, 'data')
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home)
    const clone = repo(join(data, 'swarm-projects', 'tab', 'project'))
    const newRoot = join(home, 'harnesses', 'swarms', 'tab')
    mkdirSync(newRoot, { recursive: true }); writeFileSync(join(newRoot, 'notes.txt'), 'swarm')
    const otherTab = join(data, 'swarm-projects', 'other-tab'); mkdirSync(otherTab, { recursive: true })
    const own = repo(join(home, 'code', 'app'))
    const ownWorktree = worktree(own, join(home, 'harnesses', 'worktrees', 'app', 'mine'), 'mine')
    const recorded = worktree(clone, join(home, 'harnesses', 'worktrees', 'project', 'recorded'), 'super-tab/recorded')
    const earlier = worktree(own, join(home, 'harnesses', 'worktrees', 'app', 'earlier'), 'super-tab/earlier')
    const unproven = worktree(own, join(home, 'harnesses', 'worktrees', 'app', 'unproven'), 'super-tab/unproven')
    mkdirSync(join(data, 'super-tabs'), { recursive: true })
    writeFileSync(swarmWorktreesFile(data, 'host'), JSON.stringify({ version: 1, worktrees: [
      { tabId: 'tab', startId: 'recorded', harnessId: 'h-recorded', source: clone, path: recorded },
      { tabId: 'other-tab', startId: 'kept', harnessId: 'h-kept', source: own, path: ownWorktree },
    ] }))
    const starts = [
      { id: 'earlier', creationId: 'super-earlier', harnessId: 'h-earlier', request: { machineId: 'host', worktree: true, cwd: own } },
      { id: 'unproven', creationId: 'super-unproven', harnessId: 'h-unproven', request: { machineId: 'host', worktree: true, cwd: own } },
      { id: 'elsewhere', creationId: 'super-elsewhere', harnessId: 'h-elsewhere', request: { machineId: 'another', worktree: true, cwd: own } },
    ]
    let live = [session('h-recorded', recorded, 'agent')]
    const all = () => [...live, session('h-earlier', earlier, 'agent'), session('h-unproven', unproven, 'agent'), session('h-elsewhere', ownWorktree, 'agent')]
    const core = fakeCore({ dataDir: data, agents: {
      live: vi.fn(() => live), all: vi.fn(all),
      creationStatus: vi.fn(async (creationId: string) => ({ creationId, state: 'created' as const,
        agentId: creationId === 'super-unproven' ? 'someone-else' : `h-${creationId.slice('super-'.length)}` })),
      closeMember: vi.fn(async (agentId: string) => { live = live.filter(s => s.agentId !== agentId); return { closed: true } as never }),
    } })
    const backend = vi.fn(async (_core: unknown, method: string, path: string, _body?: unknown): Promise<unknown> =>
      method === 'GET' && path.startsWith('/api/super-tabs/tab/') ? swarmReply(path, { starts }) : { parts: [] })
    const log = vi.fn()
    let now = 0
    const open = () => new ContributedMachines(core, 'host', { backend, log, now: () => now } as never)
    const acks = () => backend.mock.calls.filter(c => c[1] === 'POST')
    return { core, backend, log, open, acks, home, data, clone, newRoot, otherTab, own, ownWorktree, recorded, earlier, unproven, starts,
      setLive: (sessions: RegisteredSession[]) => { live = sessions }, step: (ms: number) => { now += ms } }
  }

  /** Its first acknowledgement fails as an unreachable backend would; every read still answers. */
  const failFirstAck = (m: ReturnType<typeof machine>) => {
    const answer = m.backend.getMockImplementation()!
    let failed = false
    m.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && !failed) { failed = true; throw new Error('Backend offline') }
      return answer(core, method, path, body)
    })
  }

  it('removes a stopped worker\'s worktree once nothing runs there and nothing is uncommitted, and its branch once merged', async () => {
    const m = machine()
    const host = m.open()
    const recorded = () => JSON.parse(readFileSync(swarmWorktreesFile(m.data, 'host'), 'utf8')).worktrees.map((w: { startId: string }) => w.startId)
    // Its session still runs there: kept.
    await host.removeStoppedWorktree('tab', 'h-recorded')
    expect(existsSync(m.recorded)).toBe(true)
    m.setLive([])
    // A file not committed: kept, with its work.
    await host.removeStoppedWorktree('tab', 'h-recorded')
    expect(readFileSync(join(m.recorded, 'unpushed.txt'), 'utf8')).toBe('work')
    rmSync(join(m.recorded, 'unpushed.txt'))
    git(m.clone, 'config', 'branch.super-tab/recorded.harness', 'placeholder')
    await host.removeStoppedWorktree('tab', 'h-recorded')
    expect(existsSync(m.recorded)).toBe(false)
    expect(git(m.clone, 'worktree', 'list', '--porcelain')).not.toContain('/recorded\n')
    // Its branch had no commit of its own, so it went too.
    expect(git(m.clone, 'branch', '--list', 'super-tab/recorded')).toBe('')
    expect(recorded()).toEqual(['kept'])
  })

  it('keeps a stopped worker\'s branch with a commit only it has, and leaves alone a worktree it has no record of', async () => {
    const m = machine()
    m.setLive([])
    rmSync(join(m.recorded, 'unpushed.txt'))
    git(m.recorded, 'commit', '-q', '--allow-empty', '-m', 'only here')
    git(m.clone, 'config', 'branch.super-tab/recorded.harness', 'placeholder')
    const host = m.open()
    await host.removeStoppedWorktree('tab', 'h-recorded')
    expect(existsSync(m.recorded)).toBe(false)
    expect(git(m.clone, 'log', '-1', '--format=%s', 'super-tab/recorded').trim()).toBe('only here')
    rmSync(join(m.earlier, 'unpushed.txt'))
    await host.removeStoppedWorktree('tab', 'h-earlier')
    await host.removeStoppedWorktree('other-tab', 'h-recorded')
    expect(existsSync(m.earlier)).toBe(true)
  })

  const startIds = (m: ReturnType<typeof machine>) => JSON.parse(readFileSync(swarmWorktreesFile(m.data, 'host'), 'utf8')).worktrees.map((w: { startId: string }) => w.startId)
  const addRecord = (m: ReturnType<typeof machine>, row: Record<string, string>) => {
    const file = swarmWorktreesFile(m.data, 'host')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...saved, worktrees: [...saved.worktrees, row] }))
  }

  // Diego, 10-30: a worktree folder deleted by hand kept its record for good, so every later stop tried it again.
  it('drops the record of a stopped worker whose worktree folder is gone, and keeps every other record', async () => {
    const m = machine()
    m.setLive([])
    rmSync(m.recorded, { recursive: true, force: true })
    await m.open().removeStoppedWorktree('tab', 'h-recorded')
    expect(startIds(m)).toEqual(['kept'])
    expect(readFileSync(join(m.ownWorktree, 'unpushed.txt'), 'utf8')).toBe('work')
  })

  it('keeps the record when its folder cannot be read for any reason but being gone', async () => {
    const m = machine()
    m.setLive([])
    // A file where a folder should be: not "gone", so the record stays.
    addRecord(m, { tabId: 'tab', startId: 'odd', harnessId: 'h-odd', source: m.clone, path: join(m.recorded, 'unpushed.txt', 'below') })
    await m.open().removeStoppedWorktree('tab', 'h-odd')
    expect(startIds(m)).toEqual(['recorded', 'kept', 'odd'])
    expect(readFileSync(join(m.recorded, 'unpushed.txt'), 'utf8')).toBe('work')
  })

  it('never touches a recorded folder that is not provably the Swarm\'s worktree: the main checkout, a person\'s own worktree', async () => {
    const m = machine()
    m.setLive([])
    rmSync(join(m.ownWorktree, 'unpushed.txt'))
    addRecord(m, { tabId: 'tab', startId: 'main', harnessId: 'h-main', source: m.clone, path: m.clone })
    const host = m.open()
    await host.removeStoppedWorktree('tab', 'h-main')
    await host.removeStoppedWorktree('other-tab', 'h-kept')
    for (const kept of [m.clone, m.ownWorktree]) expect(existsSync(kept), kept).toBe(true)
    expect(git(m.own, 'worktree', 'list', '--porcelain')).toContain('/mine\n')
    expect(startIds(m)).toEqual(['recorded', 'kept', 'main'])
  })

  // Lead, 10-30: an ended session (host.ts endSession) and a stopped worker (releaseWorker) can remove one agent's worktree
  // at the same moment. The second waits for the first, then finds no record and does nothing.
  it('runs two removals of one agent one after the other, never both at once', async () => {
    const m = machine()
    rmSync(join(m.recorded, 'unpushed.txt'))
    const folderAtCheck: boolean[] = []
    vi.mocked(m.core.agents.live).mockImplementation(() => { folderAtCheck.push(existsSync(m.recorded)); return [] })
    const host = m.open()
    await Promise.all([host.removeStoppedWorktree('tab', 'h-recorded'), host.removeStoppedWorktree('tab', 'h-recorded')])
    expect(existsSync(m.recorded)).toBe(false)
    expect(startIds(m)).toEqual(['kept'])
    // Only the first looked for sessions in the folder; the second came once it was gone.
    expect(folderAtCheck).toEqual([true])
    expect(m.log).not.toHaveBeenCalled()
  })

  // Lead, 10-30: a removal that waited on one that kept the folder still checks for itself, or the folder waits a week.
  it('checks again after a removal that kept the folder: a session closed meanwhile keeps it no longer', async () => {
    const m = machine()
    rmSync(join(m.recorded, 'unpushed.txt'))
    // The first check sees the session still open; it closes right after.
    let open = true
    vi.mocked(m.core.agents.live).mockImplementation(() => {
      const sessions = open ? [session('h-recorded', m.recorded, 'agent')] : []
      open = false
      return sessions
    })
    const host = m.open()
    const first = host.removeStoppedWorktree('tab', 'h-recorded'), second = host.removeStoppedWorktree('tab', 'h-recorded')
    await first
    await second
    expect(existsSync(m.recorded)).toBe(false)
    expect(startIds(m)).toEqual(['kept'])
  })

  it('deletes only the tab\'s Swarm folders and Swarm-made worktrees, then acknowledges once', async () => {
    const m = machine()
    const host = m.open()
    await host.clean('tab', 'removal')
    for (const gone of [join(m.data, 'swarm-projects', 'tab'), m.newRoot, m.recorded, m.earlier]) expect(existsSync(gone), gone).toBe(false)
    for (const kept of [m.own, m.ownWorktree, m.unproven, m.otherTab]) expect(existsSync(kept), kept).toBe(true)
    expect(readFileSync(join(m.ownWorktree, 'unpushed.txt'), 'utf8')).toBe('work')
    // The person's repository forgets only the Swarm worktree it held.
    const listed = git(m.own, 'worktree', 'list', '--porcelain')
    expect(listed).toContain('/mine\n'); expect(listed).not.toContain('/earlier\n')
    expect(m.core.agents.closeMember).toHaveBeenCalledWith('h-recorded', undefined)
    expect(m.acks()).toEqual([[m.core, 'POST', '/api/super-tabs/tab/commands',
      { operationId: 'machine-cleaned-removal', command: { type: 'machine.cleaned', machineId: 'host', removalId: 'removal' } }]])
    expect(JSON.parse(readFileSync(swarmWorktreesFile(m.data, 'host'), 'utf8')).worktrees.map((w: { tabId: string }) => w.tabId)).toEqual(['other-tab'])
    expect(m.log.mock.calls.flat().join('\n')).toContain(m.unproven.split('/').pop())
    await host.clean('tab', 'removal')
    expect(m.acks()).toHaveLength(1)
    await expect(host.clean('../escape', 'other')).rejects.toThrow('Invalid machine removal.')
  })

  // 2026-10-28: once a cleanup has waited past the backend's fallback, its owner can add the machine again and the backend
  // drops the cleanup (backend machines.ts cleanupOverdue). A cleanup that starts after that must not delete the new Swarm folders.
  it.each([['added again', {}], ['added again and being removed under a newer removal', { removal: { id: 'newer', state: 'cleaning' } }]])(
    'deletes nothing and confirms nothing once this machine was %s', async (_why, listed) => {
    const m = machine()
    m.backend.mockImplementation(async (_core, method, path) => method === 'GET' && path.startsWith('/api/super-tabs/tab/')
      ? swarmReply(path, { starts: m.starts, machines: [{ machineId: 'host', contributorId: 'person', cwd: m.newRoot, ...listed }] }) : { parts: [] })
    const host = m.open()
    await host.clean('tab', 'removal')
    for (const kept of [join(m.data, 'swarm-projects', 'tab'), m.newRoot, m.recorded, m.earlier]) expect(existsSync(kept), kept).toBe(true)
    expect(m.core.agents.closeMember).not.toHaveBeenCalled()
    expect(m.acks()).toEqual([])
    expect(m.log.mock.calls.flat().join('\n')).toContain('added to that Swarm again')
    // Settled: the next poll's row, if any, does not run it again.
    await host.clean('tab', 'removal')
    expect(m.backend.mock.calls.filter(c => c[1] === 'GET')).toHaveLength(1)
  })

  // Review of #1986 (Minor 1): the Swarm was read once, at the start. An add that lands while the cleanup runs must keep its
  // clone and its worktree records, so the Swarm is read again before anything is deleted and before the records change.
  const addedOnRead = (m: ReturnType<typeof machine>, read: number) => {
    let reads = 0
    m.backend.mockImplementation(async (_core, method, path) => {
      if (method !== 'GET' || !path.startsWith('/api/super-tabs/tab/')) return { parts: [] }
      if (path.includes('/parts')) reads++
      return swarmReply(path, { starts: m.starts, ...(reads >= read ? { machines: [{ machineId: 'host', contributorId: 'person', cwd: m.newRoot }] } : {}) })
    })
  }
  const records = (m: ReturnType<typeof machine>) => JSON.parse(readFileSync(swarmWorktreesFile(m.data, 'host'), 'utf8')).worktrees.map((w: { tabId: string }) => w.tabId)

  it('closes and deletes nothing when this machine is added again after the cleanup started', async () => {
    const m = machine()
    addedOnRead(m, 2)
    await m.open().clean('tab', 'removal')
    for (const kept of [join(m.data, 'swarm-projects', 'tab'), m.newRoot, m.recorded, m.earlier]) expect(existsSync(kept), kept).toBe(true)
    expect(m.core.agents.closeMember).not.toHaveBeenCalled()
    expect(records(m)).toEqual(['tab', 'other-tab'])
    expect(m.acks()).toEqual([])
  })

  it('keeps the worktree records and confirms nothing when this machine is added again while its folders are deleted', async () => {
    const m = machine()
    m.backend.mockImplementation(async (_core, method, path) => method === 'GET' && path.startsWith('/api/super-tabs/tab/')
      ? swarmReply(path, { starts: m.starts, ...(existsSync(m.newRoot) ? {} : { machines: [{ machineId: 'host', contributorId: 'person', cwd: m.newRoot }] }) }) : { parts: [] })
    await m.open().clean('tab', 'removal')
    expect(existsSync(m.newRoot)).toBe(false)
    expect(records(m)).toEqual(['tab', 'other-tab'])
    expect(m.acks()).toEqual([])
    expect(m.log.mock.calls.flat().join('\n')).toContain('added to that Swarm again')
  })

  // Second review of #1991 (the Reviewer's regression, with real folders): the cleanup passed its Swarm read, then waited
  // on closing an old session; the owner added the machine again meanwhile and a new task wrote into its clone, which was
  // then deleted. The Swarm is read again after the sessions close and before each deletion.
  it('keeps the clone a new task wrote into when this machine is added again while an old session closes', async () => {
    const m = machine()
    let added = false
    m.backend.mockImplementation(async (_core, method, path) => {
      if (method !== 'GET' || !path.startsWith('/api/super-tabs/tab/')) return { parts: [] }
      return swarmReply(path, { starts: m.starts, ...(added ? { machines: [{ machineId: 'host', contributorId: 'person', cwd: m.newRoot }] } : {}) })
    })
    vi.mocked(m.core.agents.closeMember!).mockImplementation(async () => {
      // The close was slow; the owner re-added the machine while it was awaited and its new start reused this clone.
      added = true
      m.setLive([])
      writeFileSync(join(m.newRoot, 'new-task.txt'), 'created after re-add')
      return { closed: true } as never
    })
    await m.open().clean('tab', 'removal')
    expect(existsSync(join(m.newRoot, 'new-task.txt'))).toBe(true)
    expect(m.acks()).toEqual([])
  })

  it('cleans up while the Swarm still lists this machine under this very removal', async () => {
    const m = machine()
    m.backend.mockImplementation(async (_core, method, path) => method === 'GET' && path.startsWith('/api/super-tabs/tab/')
      ? swarmReply(path, { starts: m.starts, machines: [{ machineId: 'host', contributorId: 'person', cwd: m.newRoot, removal: { id: 'removal', state: 'cleaning' } }] }) : { parts: [] })
    await m.open().clean('tab', 'removal')
    for (const gone of [join(m.data, 'swarm-projects', 'tab'), m.newRoot, m.recorded, m.earlier]) expect(existsSync(gone), gone).toBe(false)
    expect(m.acks()).toHaveLength(1)
  })

  it('keeps a person\'s own worktree of the same repository even when the registry now lists it as the agent\'s folder', async () => {
    const m = machine()
    const outside = worktree(m.own, join(m.home, 'code', 'app-feature'), 'feature')
    vi.mocked(m.core.agents.all).mockReturnValue([session('h-earlier', m.ownWorktree, 'agent'), session('h-unproven', outside, 'agent')])
    vi.mocked(m.core.agents.creationStatus!).mockImplementation(async creationId => ({ creationId, state: 'created' as const, agentId: `h-${creationId.slice('super-'.length)}` }))
    await m.open().clean('tab', 'removal')
    for (const kept of [m.ownWorktree, outside, m.own]) expect(existsSync(kept), kept).toBe(true)
    expect(git(m.own, 'worktree', 'list', '--porcelain')).toContain('/mine\n')
    expect(m.acks()).toHaveLength(1)
  })

  it('reads git as itself, not through git settings the daemon inherited', async () => {
    const m = machine()
    vi.stubEnv('GIT_DIR', join(m.home, 'nowhere')); vi.stubEnv('GIT_WORK_TREE', join(m.home, 'nowhere'))
    await m.open().clean('tab', 'removal')
    expect(existsSync(m.recorded)).toBe(false)
    expect(existsSync(m.earlier)).toBe(false)
  })

  it('waits longer after each failed acknowledgement instead of cleaning again every pass', async () => {
    const m = machine()
    const host = m.open()
    failFirstAck(m)
    await expect(host.clean('tab', 'removal')).rejects.toThrow('Backend offline')
    const calls = m.backend.mock.calls.length
    await host.clean('tab', 'removal')
    m.step(59_000); await host.clean('tab', 'removal')
    expect(m.backend.mock.calls).toHaveLength(calls)
    m.step(1_000); await host.clean('tab', 'removal')
    expect(m.acks()).toHaveLength(2)
  })

  it('keeps a recorded folder that is no longer the worktree it recorded', async () => {
    const m = machine()
    rmSync(m.recorded, { recursive: true, force: true }); mkdirSync(m.recorded, { recursive: true })
    writeFileSync(join(m.recorded, 'mine.txt'), 'person')
    await m.open().clean('tab', 'removal')
    expect(readFileSync(join(m.recorded, 'mine.txt'), 'utf8')).toBe('person')
    expect(m.acks()).toHaveLength(1)
  })

  // Diego 10-29: a folder kept for a session still running in it was confirmed cleaned anyway, and its records dropped, so
  // nothing ever tried it again. A kept folder now leaves the cleanup unconfirmed, retried on the usual backoff.
  it('keeps a folder whose session will not close, cleans the rest and confirms nothing until it is gone', async () => {
    const m = machine()
    const person = session('person', join(m.newRoot), undefined)
    m.setLive([person])
    const host = m.open()
    await expect(host.clean('tab', 'removal')).rejects.toThrow('a session still runs in tab.')
    expect(vi.mocked(m.core.agents.closeMember!).mock.calls.map(([agentId]) => agentId)).not.toContain('person')
    expect(existsSync(m.newRoot)).toBe(true)
    expect(existsSync(join(m.data, 'swarm-projects', 'tab'))).toBe(false)
    expect(m.log.mock.calls.flat().join('\n')).toContain('Kept tab: a session still runs in it.')
    expect(m.log.mock.calls.flat().join('\n')).not.toContain(m.home)
    expect(m.acks()).toEqual([])
    expect(records(m)).toEqual(['tab', 'other-tab'])
    // The person closed it: the next try after the backoff deletes the folder and confirms.
    m.setLive([])
    m.step(60_000)
    await host.clean('tab', 'removal')
    expect(existsSync(m.newRoot)).toBe(false)
    expect(m.acks()).toHaveLength(1)
    expect(records(m)).toEqual(['other-tab'])
  })

  // Diego 10-29: under harnessd the Swarm runs in its own process, whose core API (services/processCoreApi.ts) has no
  // closeStarted, so the agents were never closed and their folders were kept. It closes through the Swarm's own close.
  it('closes the Swarm agents in its folders and deletes them when the Swarm runs in its own process', async () => {
    const m = machine()
    const cloned = join(m.data, 'swarm-projects', 'tab', 'project')
    const starts = [...m.starts, { id: 'cloned', creationId: 'super-cloned-0123456789', harnessId: 'h-cloned', request: { machineId: 'host', worktree: false, cwd: cloned } }]
    m.backend.mockImplementation(async (_core, method, path) => method === 'GET' && path.startsWith('/api/super-tabs/tab/') ? swarmReply(path, { starts }) : { parts: [] })
    let live = [session('h-recorded', m.recorded, 'agent'), session('h-cloned', cloned, 'agent')]
    const asked: [string, Record<string, unknown>][] = []
    const ask = vi.fn(async (query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      asked.push([query, payload])
      if (query === 'creation_status') return { observation: { creationId: payload.creationId, state: 'created', agentId: 'h-cloned' } }
      if (query !== 'close_member') return { error: 'UNKNOWN_QUERY' }
      live = live.filter(s => s.agentId !== payload.agentId)
      return { closed: true }
    })
    const core = processCoreApi(m.data, 'superTabs', { live: () => live, ask })
    await new ContributedMachines(core, 'host', { backend: m.backend, log: m.log, now: () => 0 } as never).clean('tab', 'removal')
    expect(asked.filter(([query]) => query === 'close_member').map(([, payload]) => payload).sort((a, b) => String(a.agentId).localeCompare(String(b.agentId))))
      .toEqual([{ agentId: 'h-cloned', creationId: 'super-cloned-0123456789' }, { agentId: 'h-recorded' }])
    for (const gone of [join(m.data, 'swarm-projects', 'tab'), m.recorded]) expect(existsSync(gone), gone).toBe(false)
    expect(m.acks()).toHaveLength(1)
    expect(records(m)).toEqual(['other-tab'])
  })

  // Review of #2070: the close's answer was thrown away, so a removal that never confirmed said nothing of why.
  it.each([
    ['refuses', (m: ReturnType<typeof machine>) => vi.mocked(m.core.agents.closeMember!).mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' } as never), 'SERVICE_UNAVAILABLE'],
    // Re-check of #2070: an error's own text can carry a full path, so a failed close is logged by a fixed code.
    ['fails', (m: ReturnType<typeof machine>) => vi.mocked(m.core.agents.closeMember!).mockRejectedValue(new Error(`EACCES: ${m.recorded}`)), 'CLOSE_FAILED'],
  ])('confirms nothing, keeps the records and logs why while a Swarm agent in the clone %s to close', async (_how, fail, reason) => {
    const m = machine()
    fail(m)
    await expect(m.open().clean('tab', 'removal')).rejects.toThrow('a session still runs in recorded.')
    expect(m.core.agents.closeMember).toHaveBeenCalledWith('h-recorded', undefined)
    expect(existsSync(m.recorded)).toBe(true)
    expect(m.acks()).toEqual([])
    expect(records(m)).toEqual(['tab', 'other-tab'])
    expect(m.log.mock.calls.flat().filter(line => String(line).startsWith('Kept recorded:')))
      .toEqual([`Kept recorded: a session still runs in it; its close was refused: ${reason}.`])
  })

  // Review of #2070: both of a tab's clone roots end in its id, and the message named it twice.
  it('names each kept folder once', async () => {
    const m = machine()
    const cloned = join(m.data, 'swarm-projects', 'tab', 'project')
    m.setLive([session('h-recorded', m.recorded, 'agent'), session('person', cloned), session('another-person', m.newRoot)])
    vi.mocked(m.core.agents.closeMember!).mockResolvedValue({ error: 'NOT_A_MEMBER' } as never)
    await expect(m.open().clean('tab', 'removal')).rejects.toThrow(
      new Error('Did not finish cleaning up Swarm tab yet: a session still runs in recorded, tab. It tries again later.'))
  })

  it('finishes a cleanup after a restart that interrupted its acknowledgement', async () => {
    const m = machine()
    failFirstAck(m)
    await expect(m.open().clean('tab', 'removal')).rejects.toThrow('Backend offline')
    expect(existsSync(m.recorded)).toBe(false)
    await m.open().clean('tab', 'removal')
    expect(m.acks()).toHaveLength(2)
    expect(m.acks()[1]![3]).toEqual({ operationId: 'machine-cleaned-removal', command: { type: 'machine.cleaned', machineId: 'host', removalId: 'removal' } })
  })

  it('waits for the tab\'s start receipts before deleting anything', async () => {
    const m = machine()
    m.backend.mockRejectedValueOnce(new Error('Backend offline'))
    await expect(m.open().clean('tab', 'removal')).rejects.toThrow('Backend offline')
    expect(existsSync(m.recorded)).toBe(true)
    expect(existsSync(m.newRoot)).toBe(true)
    expect(m.acks()).toHaveLength(0)
  })

  it('records the worktree a Swarm start made', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-record-')); roots.push(root)
    const core = fakeCore({ dataDir: root, agents: { byAgent: vi.fn(id => id === 'h-new' ? session('h-new', '/worktrees/project/new', 'agent') : undefined) } })
    const pool = { tabId: 'tab', machine: { machineId: 'host', generation: 'grant', cwd: '/repo', engines: ['codex'], paused: false },
      harnessIds: [], starts: [{ id: 'new', dispatched: true, request: { worktree: true, cwd: '/clone' } }], paused: false }
    const backend = vi.fn(async (_core: unknown, _method: string, path: string, _body?: unknown): Promise<unknown> => path.includes('/hosts/host/changes') ? hostForm([], { pools: [pool] }) : { revision: 1 })
    const open = vi.fn(async () => ({ machineId: 'host', request: vi.fn(async () => ({})), close: vi.fn() }))
    const start = vi.fn(async () => ({ ok: true, harnessId: 'h-new' }))
    await new ContributedMachines(core, 'host', { backend, open, start, now: () => 0,
      capabilities: vi.fn(async () => ({ ok: true, resources: {}, tools: {} })) } as never).tick()
    expect(JSON.parse(readFileSync(swarmWorktreesFile(root, 'host'), 'utf8'))).toEqual({ version: 1, worktrees: [
      { tabId: 'tab', startId: 'new', harnessId: 'h-new', source: '/clone', path: '/worktrees/project/new' }] })
    expect(backend.mock.calls.some(c => JSON.stringify(c[3] ?? '').includes('agent.startSettled'))).toBe(true)
  })
})

// 2026-10-29: Anthropic answered 5 quick allowance reads, then refused them for 5 minutes (HTTP 429, retry-after 300). Each
// machine read the allowance on every 15-second report, so Claude's showed as unknown on Ken's MacBook Pro while its
// agents ran there. The reading is now kept for a while, and an unknown one says why.
describe('the allowance a machine reports', () => {
  const reads = (f: ReturnType<typeof fixture>) => f.request.mock.calls.filter(c => c[0] === 'usage_read').length
  const last = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/')).at(-1)![3] as Record<string, unknown>
  const answer = (codex: Record<string, unknown>) => async (type: string): Promise<Record<string, unknown>> =>
    type === 'usage_read' ? { providers: [{ provider: 'codex', account: 'k', ...codex }] } : {}
  const limited = answer({ outcome: 'answered', httpStatus: 429, body: { error: {} } })

  it('is read from the vendor at most once in 3 minutes, however often the machine reports', async () => {
    const f = fixture()
    await f.machine.tick(); f.advance(); await f.machine.tick(); f.advance(); await f.machine.tick()
    expect(f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/')).length).toBe(3)
    expect(reads(f)).toBe(1)
    f.step(180_000); await f.machine.tick()
    expect(reads(f)).toBe(2)
  })

  it('keeps the last good windows while the vendor limits reads, and asks again only after 5 minutes', async () => {
    const f = fixture()
    await f.machine.tick()
    f.request.mockImplementation(limited)
    f.step(180_000); await f.machine.tick()
    expect(reads(f)).toBe(2)
    expect(last(f)).toMatchObject({ quotas: [{ engine: 'codex', known: true, windows: [{ usedPercent: 25 }] }] })
    expect(last(f).quotaReasons).toBeUndefined()
    f.step(180_000); await f.machine.tick()
    expect(reads(f)).toBe(2)
    f.step(120_000); await f.machine.tick()
    expect(reads(f)).toBe(3)
  })

  it('says unknown, and why, once the last good windows are 20 minutes old', async () => {
    const f = fixture()
    await f.machine.tick()
    f.request.mockImplementation(limited)
    for (let i = 0; i < 4; i++) { f.step(300_000); await f.machine.tick() }
    expect(last(f)).toMatchObject({ quotas: [{ engine: 'codex', known: true }] })
    // The next report, past the 15-second beat, still on the 429 read: the kept windows are now too old.
    f.step(16_000); await f.machine.tick()
    expect(last(f)).toMatchObject({ quotas: [{ engine: 'codex', known: false, windows: [] }],
      quotaReasons: { codex: 'OpenAI is limiting how often the allowance can be read.' } })
  })

  it('drops the kept windows at once when the engine signs out', async () => {
    const f = fixture()
    await f.machine.tick()
    f.request.mockImplementation(answer({ outcome: 'signedOut' }))
    f.step(180_000); await f.machine.tick()
    expect(last(f)).toMatchObject({ quotas: [{ engine: 'codex', known: false, windows: [] }],
      quotaReasons: { codex: 'No subscription sign-in is stored on this machine.' } })
  })

  it('reads again a minute after the reader did not answer', async () => {
    const f = fixture()
    f.request.mockImplementation(async type => { if (type === 'usage_read') throw new Error('timed out'); return {} })
    await f.machine.tick()
    expect(last(f)).toMatchObject({ quotas: [{ engine: 'codex', known: false }], quotaReasons: { codex: 'The allowance reader on this machine did not answer.' } })
    f.step(61_000); await f.machine.tick()
    expect(reads(f)).toBe(2)
  })

  it("says a Harness Team account's allowance is read on its owner's machine", async () => {
    const f = fixture({}, () => null, () => true)
    f.request.mockImplementation(answer({ outcome: 'signedOut' }))
    await f.machine.tick()
    expect(last(f).quotaReasons).toEqual({ codex: "This account runs on its owner's subscription; its allowance is read on the owner's machine." })
  })

  it('drops the reasons for a backend that refuses them, keeping the allowance, and offers them again ten minutes later', async () => {
    const f = fixture()
    f.request.mockImplementation(limited)
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && (body as Record<string, unknown>)?.quotaReasons) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: quotaReasons', 400)
      return original(core, method, path, body)
    })
    const posts = () => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/')).map(c => 'quotaReasons' in (c[3] as object))
    await f.machine.tick()
    expect(posts()).toEqual([true, false])
    expect(last(f)).toMatchObject({ quotas: [{ engine: 'codex', known: false }] })
    f.advance(); await f.machine.tick()
    expect(posts().at(-1)).toBe(false)
    expect(posts()).toHaveLength(3)
    f.step(600_000); await f.machine.tick()
    expect(posts().slice(-2)).toEqual([true, false])
  })
})
