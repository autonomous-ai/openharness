import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { folderTrust } from '../engines/launchPrep.js'
import { launchEnvironment } from '../engines/kit/launchExecutable.js'
import { readGitProject } from '../lib/gitProject.js'
import { recordTrustIn } from '../engines/kit/folderTrust.js'
import { prepareContribution } from './contribution.js'
import { prepareSwarmProject } from './projectFolder.js'
import { ContributedMachines } from './machines.js'

// Never read the person's login profile: the fixture owns the engine locations.
vi.mock('../engines/kit/launchExecutable.js', () => ({ launchEnvironment: vi.fn(async () => ({ ...process.env })) }))
vi.mock('../lib/gitProject.js', async original => {
  const real = await original<typeof import('../lib/gitProject.js')>()
  return { ...real, readGitProject: vi.fn(real.readGitProject) }
})
vi.mock('../engines/kit/folderTrust.js', async original => {
  const real = await original<typeof import('../engines/kit/folderTrust.js')>()
  return { ...real, recordTrustIn: vi.fn(real.recordTrustIn) }
})
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, lstat: vi.fn(real.lstat) }
})
let home = ''
beforeEach(() => {
  vi.clearAllMocks()
  // Discovery uses physical paths. On macOS tmpdir's /var spelling resolves through /private/var;
  // keep fixture comparisons physical too, and exercise intentional aliases in the symlink tests.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-clone-trust-')))
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude')); vi.stubEnv('CODEX_HOME', join(home, 'codex'))
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true }); mkdirSync(process.env.CODEX_HOME!, { recursive: true })
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'), JSON.stringify({ theme: 'dark', projects: {} }))
  writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'model = "unchanged"\n')
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8',
  }).trim()
}
function clone(path: string) {
  mkdirSync(path, { recursive: true }); git(path, 'init', '-q', '-b', 'main'); git(path, 'commit', '-qm', 'fixture', '--allow-empty')
  return path
}
function fixture(legacy = false) {
  const core = fakeCore({ dataDir: join(home, 'data') })
  const root = join(home, 'harnesses', 'swarms', 'tab'), oldRoot = join(core.dataDir, 'swarm-projects', 'tab'), cwd = legacy ? oldRoot : root
  const row = { tabId: 'tab', machine: { machineId: core.daemon.machineId(), generation: 'grant', scope: 'swarm', cwd, engines: ['claude', 'codex'] },
    projects: [{ id: 'project', repository: { machineId: 'another', repositoryUrl: 'https://github.com/example/project' }, conversationIds: ['work'] }], starts: [], harnessIds: [] }
  const deps = { backend: vi.fn(async () => ({ state: { projects: row.projects, machines: [row.machine] } })),
    open: vi.fn(async () => ({ request: vi.fn(async () => ({ engines: [{ engine: 'codex', installed: true, signedIn: true }] })), close: vi.fn() })),
    prepare: vi.fn(async () => join(cwd, 'project')),
    capacity: vi.fn(async () => ({ ok: true, resources: { projectDiskFreeBytes: 1, memoryTotalBytes: 8 * 1024 ** 3, memoryUsedBytes: 0 } })) }
  return { core, root, oldRoot, cwd, row, deps }
}
function expectTrusted(path: string, trusted = true) {
  for (const engine of ['claude', 'codex'] as const) expect(folderTrust(engine)!.trusts(path), engine + ': ' + path).toBe(trusted)
}

describe('consented Swarm clones', () => {
  it('places new contributions in the visible Swarm root and preserves earlier roots', async () => {
    const f = fixture()
    f.deps.backend.mockResolvedValueOnce({ state: { projects: f.row.projects } } as never)
    expect((await prepareContribution(f.core, { tabId: 'tab', scope: 'swarm' }, f.deps as never)).cwd).toBe(f.root)
    expect(existsSync(f.root)).toBe(true)
    f.row.machine.cwd = f.oldRoot
    expect((await prepareContribution(f.core, { tabId: 'tab', scope: 'swarm' }, f.deps as never)).cwd).toBe(f.oldRoot)
  })
  it('adding or configuring trusts clones in both roots, never another repo or the parent', async () => {
    const f = fixture(true), current = clone(join(f.root, 'project')), earlier = clone(join(f.oldRoot, 'earlier'))
    const personal = clone(join(home, 'personal')), otherSwarm = clone(join(home, 'harnesses', 'swarms', 'other', 'project'))
    symlinkSync(personal, join(f.oldRoot, 'linked-personal'), 'dir'); mkdirSync(join(f.oldRoot, 'not-a-clone'))
    await prepareContribution(f.core, { tabId: 'tab', scope: 'swarm' }, f.deps as never)
    expectTrusted(current); expectTrusted(earlier)
    for (const path of [personal, otherSwarm, f.root, f.oldRoot, join(f.oldRoot, 'not-a-clone')]) expectTrusted(path, false)
    const claude = join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'), codex = join(process.env.CODEX_HOME!, 'config.toml')
    const before = [readFileSync(claude, 'utf8'), readFileSync(codex, 'utf8')]
    await prepareContribution(f.core, { tabId: 'tab', scope: 'swarm' }, f.deps as never)
    expect([readFileSync(claude, 'utf8'), readFileSync(codex, 'utf8')]).toEqual(before)
    for (const engine of ['claude', 'codex'] as const) expect(folderTrust(engine)!.record(current)).toBe('already')
    expect(JSON.parse(before[0]!).theme).toBe('dark'); expect(before[1]).toContain('model = "unchanged"')
    expect(homedir()).toBe(home)
  })
  it('trusts the exact prepared clone before native worktree launch for both engines', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    await prepareSwarmProject(f.core, f.row, { request: { conversationId: 'work', cwd: source }, dispatched: false }, async () => source)
    expectTrusted(source)
  })
  it('repairs an earlier contribution and its Swarm worktrees on a tick without pending starts', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project')), current = clone(join(f.root, 'project'))
    const tree = join(home, 'harnesses', 'worktrees', 'project', 'worker'), unrelated = join(home, 'harnesses', 'worktrees', 'project', 'personal')
    git(source, 'worktree', 'add', '-q', '-b', 'super-tab/worker', tree); git(source, 'worktree', 'add', '-q', '-b', 'personal', unrelated)
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const start = vi.fn(), close = vi.fn()
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close }), capabilities: f.deps.capacity, start, now: () => 1 } as never)
    await machine.tick()
    expectTrusted(source); expectTrusted(current); expectTrusted(tree); expectTrusted(unrelated, false)
    expect(start).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); machine.stop()
  })
  it('repairs a renamed Swarm worktree in the agent profile while preserving unrelated worktrees', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    const tree = join(home, 'harnesses', 'worktrees', 'project', 'worker')
    git(source, 'worktree', 'add', '-q', '-b', 'super-tab/worker', tree)
    git(tree, 'branch', '-m', 'fix-renamed-by-session')
    const profile = join(home, 'profile')
    mkdirSync(profile); writeFileSync(join(profile, 'config.toml'), '')
    Object.assign(f.row, { harnessIds: ['worker'] })
    vi.mocked(f.core.agents.all).mockReturnValue([{ agentId: 'worker', engine: 'codex', cwd: tree, codexHome: profile }] as never)
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => 1 } as never)
    await machine.tick()
    expectTrusted(tree)
    expect(folderTrust('codex', profile)!.trusts(source)).toBe(true)
    expect(folderTrust('codex', profile)!.trusts(tree)).toBe(true)
    machine.stop()
  })
  it('does not follow a Swarm root symlink into the owner repository', async () => {
    const f = fixture(true), personal = clone(join(home, 'personal'))
    mkdirSync(join(home, 'harnesses', 'swarms'), { recursive: true })
    symlinkSync(home, f.root, 'dir')
    mkdirSync(f.oldRoot, { recursive: true })
    await prepareContribution(f.core, { tabId: 'tab', scope: 'swarm' }, f.deps as never)
    expectTrusted(personal, false)
  })
  it('an unreadable engine config does not starve the other engine or machine observation', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    const config = join(process.env.CODEX_HOME!, 'config.toml')
    rmSync(config); mkdirSync(config)
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => 1 } as never)
    await machine.tick()
    expect(folderTrust('claude')!.trusts(source)).toBe(true)
    expect(f.deps.capacity).toHaveBeenCalledOnce()
    expect(backend.mock.calls.some(call => call[1] === 'POST')).toBe(true)
    machine.stop()
  })
  it('records the authorized legacy spelling as well as its physical path for worktree inheritance', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    const alias = join(home, 'data-alias')
    symlinkSync(f.core.dataDir, alias, 'dir')
    const core = fakeCore({ dataDir: alias }), root = join(alias, 'swarm-projects', 'tab'), lexical = join(root, 'project')
    f.row.machine.cwd = root
    await prepareSwarmProject(core, f.row, { request: { conversationId: 'work', cwd: lexical }, dispatched: false }, async () => lexical)
    expectTrusted(source); expectTrusted(lexical)
  })
  it('uses the native home when the login shell unsets an inherited CODEX_HOME', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    const nativeHome = join(home, 'native'), codexHome = join(nativeHome, '.codex')
    mkdirSync(codexHome, { recursive: true }); writeFileSync(join(codexHome, 'config.toml'), '')
    vi.mocked(launchEnvironment).mockResolvedValueOnce({ HOME: nativeHome })
    await prepareSwarmProject(f.core, f.row, { request: { conversationId: 'work', cwd: source }, dispatched: false }, async () => source)
    expect(folderTrust('codex', codexHome)!.trusts(source)).toBe(true)
    expect(folderTrust('codex')!.trusts(source)).toBe(false)
  })
  it('publishes observations before repair and does no trust work on a second successful tick', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    await machine.tick()
    expectTrusted(source)
    const work = () => [vi.mocked(readGitProject).mock.calls.length, vi.mocked(launchEnvironment).mock.calls.length, vi.mocked(recordTrustIn).mock.calls.length]
    const before = work()
    const observation = backend.mock.calls.findIndex(call => call[1] === 'POST')
    expect(backend.mock.invocationCallOrder[observation]).toBeLessThan(vi.mocked(readGitProject).mock.invocationCallOrder[0]!)
    now += 16_000
    await machine.tick()
    expect(work()).toEqual(before)
    expect(f.deps.capacity).toHaveBeenCalledTimes(2)
    f.row.machine.generation = 'new-grant'
    const added = clone(join(f.root, 'another-project'))
    now += 16_000
    await machine.tick()
    expectTrusted(added)
    expect(vi.mocked(readGitProject).mock.calls.length).toBeGreaterThan(before[0]!)
    machine.stop()
  })
  it('retries only failed settings after migration without rediscovering clones or a shell', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project')), file = join(process.env.CODEX_HOME!, 'config.toml')
    rmSync(file); mkdirSync(file)
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    await machine.tick()
    const reads = vi.mocked(readGitProject).mock.calls.length, shells = vi.mocked(launchEnvironment).mock.calls.length
    const claudeWrites = () => vi.mocked(recordTrustIn).mock.calls.filter(call => call[0].format === 'json').length
    const before = claudeWrites()
    rmSync(file, { recursive: true }); writeFileSync(file, '')
    now += 16_000
    await machine.tick()
    expectTrusted(source)
    expect(vi.mocked(readGitProject)).toHaveBeenCalledTimes(reads)
    expect(vi.mocked(launchEnvironment)).toHaveBeenCalledTimes(shells)
    expect(claudeWrites()).toBe(before)
    machine.stop()
  })
  it('does not write a backend-selected Codex home that no local agent uses', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project')), home = join(process.env.HOME!, '.cargo')
    mkdirSync(home)
    const file = join(home, 'config.toml'), original = '[build]\ntarget = "unchanged"\n'
    writeFileSync(file, original)
    await prepareSwarmProject(f.core, f.row, { request: { conversationId: 'work', cwd: source, codexHome: home }, dispatched: false }, async () => source)
    expect(readFileSync(file, 'utf8')).toBe(original)
    expectTrusted(source)
  })
  it('accepts a selected Codex profile already used by a local Codex agent', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project')), profile = join(home, 'local-codex-profile')
    mkdirSync(profile); writeFileSync(join(profile, 'config.toml'), '')
    vi.mocked(f.core.agents.all).mockReturnValue([{ agentId: 'local', engine: 'codex', codexHome: profile }] as never)
    await prepareSwarmProject(f.core, f.row, { request: { conversationId: 'work', cwd: source, codexHome: profile }, dispatched: false }, async () => source)
    expect(folderTrust('codex', profile)!.trusts(source)).toBe(true)
  })
  it('retries failed discovery without rescanning another successfully discovered clone', async () => {
    const f = fixture(true), failed = clone(join(f.oldRoot, 'project')), ready = clone(join(f.root, 'ready'))
    const actual = await vi.importActual<typeof import('../lib/gitProject.js')>('../lib/gitProject.js')
    let unavailable = true, now = 1
    vi.mocked(readGitProject).mockImplementation(async (path, options) => path === failed && unavailable ? { error: 'GIT_UNAVAILABLE' } : actual.readGitProject(path, options))
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    try {
      await machine.tick()
      expectTrusted(ready); expectTrusted(failed, false)
      const readyReads = vi.mocked(readGitProject).mock.calls.filter(call => call[0] === ready).length
      unavailable = false; now += 16_000
      await machine.tick()
      expectTrusted(failed)
      expect(vi.mocked(readGitProject).mock.calls.filter(call => call[0] === ready)).toHaveLength(readyReads)
    } finally { vi.mocked(readGitProject).mockImplementation(actual.readGitProject); machine.stop() }
  })
  it('does not reuse a pending write authorization after the clone becomes an escaping symlink', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project')), personal = clone(join(home, 'personal'))
    const claude = join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'), codex = join(process.env.CODEX_HOME!, 'config.toml')
    writeFileSync(claude, 'invalid JSON'); rmSync(codex); mkdirSync(codex)
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    await machine.tick()
    expect(folderTrust('claude')!.trusts(source)).toBe(false)
    renameSync(source, join(home, 'old-clone')); symlinkSync(personal, source, 'dir')
    writeFileSync(claude, '{}'); rmSync(codex, { recursive: true }); writeFileSync(codex, '')
    now += 300_000
    await machine.tick()
    expectTrusted(source, false); expectTrusted(personal, false)
    machine.stop()
  })
  it('backs off unavailable login shells while five-second polls still dispatch starts', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    Object.assign(f.row, { starts: [{ id: 'start', dispatched: true }] })
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const start = vi.fn(async () => ({ ok: false }))
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start, now: () => now } as never)
    vi.mocked(launchEnvironment).mockResolvedValue(null)
    try {
      await machine.tick()
      expect(start).toHaveBeenCalledTimes(1)
      expect(launchEnvironment).toHaveBeenCalledTimes(1)
      now = 5_001; await machine.tick()
      expect(start).toHaveBeenCalledTimes(2)
      expect(launchEnvironment).toHaveBeenCalledTimes(1)
      // Failures wait 15, 30, 60, 120, 240 seconds, then at most five minutes.
      for (const [at, calls] of [[15_001, 2], [40_001, 2], [45_001, 3], [100_001, 3],
        [105_001, 4], [225_001, 5], [465_001, 6], [760_001, 6], [765_001, 7]]) {
        now = at!; await machine.tick()
        expect(launchEnvironment).toHaveBeenCalledTimes(calls!)
      }
      vi.mocked(launchEnvironment).mockResolvedValue({ ...process.env })
      now = 1_065_001; await machine.tick()
      expectTrusted(source)
    } finally { vi.mocked(launchEnvironment).mockImplementation(async () => ({ ...process.env })); machine.stop() }
  })
  it('defers skipped configs without repeated trust path checks and repairs them on the slow recheck', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project')), codex = join(process.env.CODEX_HOME!, 'config.toml')
    rmSync(codex)
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    try {
      await machine.tick()
      expect(existsSync(codex)).toBe(false)
      const stats = vi.mocked(lstat).mock.calls.length, records = vi.mocked(recordTrustIn).mock.calls.length
      now = 5_001; await machine.tick()
      expect(lstat).toHaveBeenCalledTimes(stats)
      expect(recordTrustIn).toHaveBeenCalledTimes(records)
      expect(backend.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1)
      writeFileSync(codex, '')
      now = 300_001; await machine.tick()
      expectTrusted(source)
    } finally { machine.stop() }
  })
  it('repairs a newly registered Codex profile and worktree before the next observation is due', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    try {
      await machine.tick()
      const profile = join(home, 'later-profile'), tree = join(home, 'harnesses', 'worktrees', 'project', 'worker')
      mkdirSync(profile); writeFileSync(join(profile, 'config.toml'), '')
      git(source, 'worktree', 'add', '-qb', 'super-tab/later', tree)
      Object.assign(f.row, { harnessIds: ['worker'] })
      vi.mocked(f.core.agents.all).mockReturnValue([{ agentId: 'worker', engine: 'codex', cwd: tree, codexHome: profile }] as never)
      now = 5_001; await machine.tick()
      expect(folderTrust('codex', profile)!.trusts(source)).toBe(true)
      expect(folderTrust('codex', profile)!.trusts(tree)).toBe(true)
      expect(f.deps.capacity).toHaveBeenCalledTimes(1)
    } finally { machine.stop() }
  })
  it.each([
    { existing: false, failure: 'shell' }, { existing: true, failure: 'shell' },
    { existing: false, failure: 'config' }, { existing: true, failure: 'config' },
  ])('discovers a later clone after one-shot $failure failure (existing=$existing)', async ({ existing, failure }) => {
    const f = fixture(true), earlier = existing ? clone(join(f.oldRoot, 'earlier')) : undefined
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    try {
      await machine.tick()
      const earlierReads = vi.mocked(readGitProject).mock.calls.filter(call => call[0] === earlier).length
      const source = clone(join(f.oldRoot, 'project')), codex = join(process.env.CODEX_HOME!, 'config.toml')
      if (failure === 'shell') vi.mocked(launchEnvironment).mockResolvedValueOnce(null)
      else { rmSync(codex); mkdirSync(codex) }
      await prepareSwarmProject(f.core, f.row, { request: { conversationId: 'work', cwd: source }, dispatched: false }, async () => source)
      if (failure === 'config') { rmSync(codex, { recursive: true }); writeFileSync(codex, '') }
      expect(folderTrust('codex')!.trusts(source)).toBe(false)
      const readsAfterPreparation = vi.mocked(readGitProject).mock.calls.filter(call => call[0] === earlier).length
      now = 5_001; await machine.tick()
      expectTrusted(source)
      // The one-shot scan may revisit it; the periodic pass must reuse successful Git discovery.
      expect(vi.mocked(readGitProject).mock.calls.filter(call => call[0] === earlier)).toHaveLength(readsAfterPreparation)
      if (existing) expect(earlierReads).toBe(1)
    } finally { machine.stop() }
  })
  it('retries a clone directory first seen before git initialization completes', async () => {
    const f = fixture(true), source = join(f.oldRoot, 'project')
    mkdirSync(source, { recursive: true })
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    try {
      await machine.tick()
      clone(source)
      now = 15_001; await machine.tick()
      expectTrusted(source)
    } finally { machine.stop() }
  })
  it('dispatches starts and backs off even when repair throws', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project'))
    Object.assign(f.row, { starts: [{ id: 'start', dispatched: true }] })
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const start = vi.fn(async () => ({ ok: false }))
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start, now: () => now } as never)
    vi.mocked(launchEnvironment).mockRejectedValueOnce(new Error('temporary repair failure'))
    try {
      await machine.tick()
      expect(start).toHaveBeenCalledTimes(1)
      now = 5_001; await machine.tick()
      expect(start).toHaveBeenCalledTimes(2)
      expect(launchEnvironment).toHaveBeenCalledTimes(1)
      now = 15_001; await machine.tick()
      expectTrusted(source)
    } finally { machine.stop() }
  })
  it('settles an existing untrusted Codex entry without rewriting or retrying it', async () => {
    const f = fixture(true), source = clone(join(f.oldRoot, 'project')), codex = join(process.env.CODEX_HOME!, 'config.toml')
    const original = `[projects.${JSON.stringify(source)}]\ntrust_level = "untrusted"\n`
    writeFileSync(codex, original)
    let now = 1
    const backend = vi.fn(async (_core: unknown, _method: string, path: string) => path.endsWith('/pools') ? [f.row] : {})
    const machine = new ContributedMachines(f.core, f.core.daemon.machineId(), { backend,
      open: async () => ({ request: async () => ({}), close: vi.fn() }), capabilities: f.deps.capacity, start: vi.fn(), now: () => now } as never)
    try {
      await machine.tick()
      expect(folderTrust('codex')!.trusts(source)).toBe(false)
      const stats = vi.mocked(lstat).mock.calls.length, records = vi.mocked(recordTrustIn).mock.calls.length
      now = 300_001; await machine.tick()
      expect(lstat).toHaveBeenCalledTimes(stats)
      expect(recordTrustIn).toHaveBeenCalledTimes(records)
      expect(readFileSync(codex, 'utf8')).toBe(original)
    } finally { machine.stop() }
  })

})
