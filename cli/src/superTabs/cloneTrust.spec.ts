import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { folderTrust } from '../engines/launchPrep.js'
import { launchEnvironment } from '../engines/kit/launchExecutable.js'
import { prepareContribution } from './contribution.js'
import { prepareSwarmProject } from './projectFolder.js'
import { ContributedMachines } from './machines.js'

// Never read the person's login profile: the fixture owns the engine locations.
vi.mock('../engines/kit/launchExecutable.js', () => ({ launchEnvironment: vi.fn(async () => ({ ...process.env })) }))
let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'swarm-clone-trust-'))
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
    vi.mocked(f.core.agents.all).mockReturnValue([{ agentId: 'worker', cwd: tree, codexHome: profile }] as never)
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
})
