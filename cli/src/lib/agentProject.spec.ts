import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentProject, canonicalRepository } from './agentProject.js'

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
})
