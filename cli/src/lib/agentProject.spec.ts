import { execFileSync } from 'node:child_process'
import { appendFile, mkdtemp, mkdir, readFile, rm, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentProject, canonicalRepository, createAgentProjectReader, type AgentProject } from './agentProject.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
describe('owning-machine project metadata', () => {
  it('canonicalizes transports and strips credentials and URL tokens', () => {
    expect(canonicalRepository('git@github.com:Org/App.git')).toBe('github.com/org/app')
    expect(canonicalRepository('https://user:secret@github.com/Org/App.git?token=secret')).toBe('github.com/org/app')
    expect(canonicalRepository('ssh://git@github.com:22/Org/App.git')).toBe('github.com/org/app')
    expect(canonicalRepository('ssh://git@example.com:2222/Org/App.git')).toBe('example.com:2222/Org/App')
    expect(canonicalRepository('/private/checkouts/app')).toBeNull()
    expect(canonicalRepository('file:///private/checkouts/app')).toBeNull()
    expect(canonicalRepository('ssh://git@example.com/CaseSensitive.git')).toBe('example.com/CaseSensitive')
  })
  it('reads the current checkout and branch, including branch changes after cache expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-v2-project-')); roots.push(root)
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    git('remote', 'add', 'origin', 'git@github.com:Org/App.git')
    await mkdir(join(root, 'nested'))
    const cwd = join(root, 'nested')
    expect(await agentProject(cwd, 100)).toMatchObject({ cwd, root: await realpath(root), remote: 'github.com/org/app', branch: 'main' })
    git('symbolic-ref', 'HEAD', 'refs/heads/feature/real-branch')
    expect(await agentProject(cwd, 20_000)).toMatchObject({ branch: 'feature/real-branch' })
    expect(await agentProject(cwd, 40_000)).toMatchObject({ branch: 'feature/real-branch' })
    git('remote', 'set-url', 'origin', 'git@github.com:Org/Other.git')
    git('symbolic-ref', 'HEAD', 'refs/heads/next')
    expect(await agentProject(cwd, 60_000)).toMatchObject({ remote: 'github.com/org/other', branch: 'next' })
  })
  it.each([
    { mode: 'attached', processes: 2 },
    { mode: 'unborn', processes: 3 },
    { mode: 'detached', processes: 3 },
    { mode: 'ambiguous', processes: 2 },
  ])('inspects an $mode HEAD with $processes Git processes', async ({ mode, processes }) => {
    const root = await mkdtemp(join(tmpdir(), 'harness-project-processes-')); roots.push(root)
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    if (mode !== 'unborn') git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
    if (mode === 'detached') git('checkout', '--quiet', '--detach')
    if (mode === 'ambiguous') {
      git('tag', 'main')
      git('config', 'core.warnAmbiguousRefs', 'false')
    }
    const branch = mode === 'detached' ? `Detached ${git('rev-parse', '--short', 'HEAD').toString().trim()}`
      : git('symbolic-ref', '--quiet', '--short', 'HEAD').toString().trim()
    git('config', 'remote.origin.url', 'git@github.com:Org/App.git')
    if (mode !== 'detached') git('config', `branch.${branch}.harness`, 'placeholder')
    const trace = join(root, 'git-trace.jsonl')
    vi.stubEnv('GIT_TRACE2_EVENT', trace)
    try {
      expect(await createAgentProjectReader().read(root)).toMatchObject({
        cwd: root, root: await realpath(root), branch,
        remote: 'github.com/org/app', ...(mode !== 'detached' ? { branchPending: true } : {}),
      })
    } finally { vi.unstubAllEnvs() }
    const starts = (await readFile(trace, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line)).filter(event => event.event === 'start')
    expect(starts).toHaveLength(processes)
  })
  it('retains symbolic-ref semantics when HEAD is also a ref name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-project-ambiguous-head-')); roots.push(root)
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString().trim()
    git('init', '-b', 'main')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
    git('update-ref', 'refs/heads/HEAD', git('rev-parse', 'HEAD'))
    git('symbolic-ref', 'HEAD', 'refs/heads/HEAD')
    const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD')
    git('config', `branch.${branch}.harness`, 'placeholder')
    expect(await createAgentProjectReader().read(root)).toMatchObject({
      root: await realpath(root), branch, branchPending: true,
    })
  })
  it('names a linked worktree for its repository rather than its folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-v2-worktree-')); roots.push(root)
    const repo = join(root, 'app')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    await mkdir(repo)
    git('init', '-b', 'main')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
    const linked = join(root, 'worktrees', 'app', 'claude-0922-1136')
    git('worktree', 'add', '-b', 'harness/claude-0922-1136', linked)
    expect(await agentProject(linked)).toMatchObject({ name: 'app', root: await realpath(linked), branch: 'harness/claude-0922-1136', worktree: true })
    expect(await agentProject(repo)).toMatchObject({ name: 'app', branch: 'main' })
    expect(await agentProject(repo)).not.toHaveProperty('worktree')
    expect(await agentProject(linked)).not.toHaveProperty('branchPending')
    git('config', 'branch.harness/claude-0922-1136.harness', 'placeholder')
    expect(await agentProject(linked, Date.now() + 20_000)).toMatchObject({ branchPending: true })
    git('checkout', '--quiet', '--detach')
    expect((await agentProject(repo, Date.now() + 20_000))?.branch).toMatch(/^Detached [0-9a-f]{7,}$/)
  })
  it('keeps a non-repository project branchless and rejects absent cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-v2-folder-')); roots.push(root)
    expect(await agentProject(root)).toMatchObject({ cwd: root, root: null, remote: null, branch: null })
    expect(await agentProject(null)).toBeNull()
    expect(await agentProject('relative')).toBeNull()
    expect(await agentProject('/tmp/unsafe\n')).toBeNull()
  })

  it('discovers a missing historical folder when it becomes a checkout again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-project-missing-')); roots.push(root)
    const cwd = join(root, 'checkout')
    const reader = createAgentProjectReader()
    expect(await reader.read(cwd, 0)).toMatchObject({ cwd, root: null, branch: null })
    await writeFile(cwd, 'not a directory')
    expect(await reader.read(cwd, 20_000)).toMatchObject({ cwd, root: null, branch: null })
    await rm(cwd); await mkdir(cwd)
    execFileSync('git', ['-C', cwd, 'init', '-b', 'returned'], { stdio: 'pipe' })
    expect(await reader.read(cwd, 40_000)).toMatchObject({ cwd, root: await realpath(cwd), branch: 'returned' })
  })

  it('keeps the repository identity through symlinked and nested worktree paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-project-paths-')); roots.push(root)
    const repo = join(root, 'main repository'); await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
    const linked = join(root, 'linked'); git('worktree', 'add', '-b', 'topic', linked)
    await mkdir(join(linked, 'nested'))
    const alias = join(root, 'alias'); await symlink(linked, alias, 'dir')
    const reader = createAgentProjectReader()
    for (const cwd of [linked, join(linked, 'nested'), alias, join(alias, 'nested')]) {
      expect(await reader.read(cwd)).toMatchObject({ cwd, name: 'main repository', root: await realpath(linked), branch: 'topic', worktree: true })
    }
    const mainAlias = join(root, 'main alias'); await symlink(repo, mainAlias, 'dir')
    expect(await reader.read(mainAlias)).toMatchObject({ cwd: mainAlias, root: await realpath(repo), branch: 'main' })
    expect(await reader.read(mainAlias)).not.toHaveProperty('worktree')
  })

  it('retains separate path reads when a symlink resolves to a newline in the repository name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-project-newline-')); roots.push(root)
    const repo = join(root, 'repository\nname'); await mkdir(repo)
    execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'pipe' })
    const alias = join(root, 'alias'); await symlink(repo, alias, 'dir')
    expect(await createAgentProjectReader().read(alias)).toMatchObject({ cwd: alias, name: 'repository\nname', root: await realpath(repo), branch: 'main' })
  })

  it('uses exact branch keys and the last config value, including empty and valueless overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-project-config-')); roots.push(root)
    const branch = 'Topic/a.b+(review)'
    const marker = `branch.${branch}.harness`
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    git('init', '-b', branch)
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
    const included = join(root, 'included config')
    git('config', '--file', included, 'remote.origin.url', 'git@github.com:Org/Included.git')
    git('config', '--file', included, marker, 'placeholder')
    git('config', 'include.path', included)
    git('config', '--add', 'remote.origin.url', 'https://user:secret@github.com/Org/Current.git?token=secret')
    const reader = createAgentProjectReader()
    expect(await reader.read(root)).toMatchObject({ branch, remote: 'github.com/org/current', branchPending: true })
    git('config', '--add', marker, '')
    reader.forget(root)
    expect(await reader.read(root)).not.toHaveProperty('branchPending')
    git('config', '--add', marker, 'placeholder')
    reader.forget(root)
    expect(await reader.read(root)).toHaveProperty('branchPending', true)
    await appendFile(join(root, '.git', 'config'), `\n[branch "${branch}"]\nharness\n[remote "origin"]\nurl\n`)
    reader.forget(root)
    const cleared = await reader.read(root)
    expect(cleared).toMatchObject({ branch, remote: null })
    expect(cleared).not.toHaveProperty('branchPending')
  })

  it('honours linked-worktree config overrides without changing the shared checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-project-worktree-config-')); roots.push(root)
    const repo = join(root, 'main'); await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
    git('config', 'remote.origin.url', 'git@github.com:Org/Main.git')
    git('config', 'extensions.worktreeConfig', 'true')
    const linked = join(root, 'linked')
    git('worktree', 'add', '-b', 'topic', linked)
    git('config', 'branch.topic.harness', 'placeholder')
    execFileSync('git', ['-C', linked, 'config', '--worktree', 'remote.origin.url', 'git@github.com:Org/Linked.git'])
    execFileSync('git', ['-C', linked, 'config', '--worktree', 'branch.topic.harness', 'named'])
    const reader = createAgentProjectReader()
    const project = await reader.read(linked)
    expect(project).toMatchObject({ branch: 'topic', remote: 'github.com/org/linked', worktree: true })
    expect(project).not.toHaveProperty('branchPending')
    expect(await reader.read(repo)).toMatchObject({ branch: 'main', remote: 'github.com/org/main' })
  })

  it('retains metadata when duplicate config values exceed the combined output bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-project-large-config-')); roots.push(root)
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    await appendFile(join(root, '.git', 'config'), '\n[remote "origin"]\n' +
      `url = https://example.invalid/${'x'.repeat(1000)}\n`.repeat(20) +
      'url = git@github.com:Org/Current.git\n[branch "main"]\nharness = placeholder\n')
    expect(await createAgentProjectReader().read(root)).toMatchObject({ remote: 'github.com/org/current', branchPending: true })
  })

  it('checks metadata without running Git again for unchanged historical folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-v2-project-cache-')); roots.push(root)
    let calls = 0
    const reader = createAgentProjectReader(async cwd => {
      calls++
      return { name: 'folder', cwd, root: null, remote: null, branch: null }
    })
    await reader.read(root, 0)
    await reader.read(root, 20_000) // establish stable inputs across a lookup
    const stable = await reader.read(root, 40_000)
    expect(calls).toBe(2)
    expect(await reader.read(root, 60_000)).toBe(stable)
    expect(calls).toBe(2)
    await reader.read(root, 90_000) // included config files get a bounded full refresh
    expect(calls).toBe(3)
    reader.forget(root)
    await reader.read(root, 90_001)
    expect(calls).toBe(4)
  })

  it('does not extend reuse across a nested repository appearing or a racing checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-v2-project-race-')); roots.push(root)
    const cwd = join(root, 'nested'); await mkdir(cwd)
    const marker = join(cwd, '.git')
    let calls = 0
    const reader = createAgentProjectReader(async path => {
      calls++
      if (calls >= 3) {
        await writeFile(join(marker, 'HEAD'), `ref: refs/heads/branch-${calls}\n`)
        return { name: 'nested', cwd: path, root: cwd, remote: null, branch: `branch-${calls - 1}` }
      }
      return { name: 'folder', cwd: path, root: null, remote: null, branch: null }
    })
    await reader.read(cwd, 0)
    await reader.read(cwd, 20_000)
    await reader.read(cwd, 40_000)
    expect(calls).toBe(2)
    await mkdir(marker)
    await writeFile(join(marker, 'HEAD'), 'ref: refs/heads/branch-2\n')
    await reader.read(cwd, 60_000)
    expect(calls).toBe(3)
    await reader.read(cwd, 80_000)
    await reader.read(cwd, 100_000)
    expect(calls).toBe(5) // each lookup changed HEAD; none can become a stable cached fact
  })

  it('shares queued work past TTL and cache capacity instead of duplicating subprocesses', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    let calls = 0
    const reader = createAgentProjectReader(async cwd => {
      calls++
      await gate
      return { name: 'folder', cwd, root: null, remote: null, branch: null } satisfies AgentProject
    })
    const first = reader.read('/missing/harness-project-0', 0)
    const rest = Array.from({ length: 1050 }, (_, i) => reader.read(`/missing/harness-project-${i + 1}`, 0))
    expect(reader.read('/missing/harness-project-0', 90_000)).toBe(first)
    expect(calls).toBe(1051)
    finish()
    await Promise.all([first, ...rest])
  })
})
