import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'
import { placeholderBranch, sessionBranchSlug, worktreeFolderName } from './agentNames.js'
import { nameBranchAfterSession } from './branchNaming.js'
import { prepareGitProject, readGitProject, validGitPath } from './gitProject.js'
import { parseProjectFolder, prepareProjectFolder } from './projectFolder.js'

const exec = promisify(execFile)
describe('launch Git preparation', () => {
  let root: string, repo: string
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim()
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-git-test-'))
    repo = join(root, 'project with spaces')
    await mkdir(repo)
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Test')
    await git('config', 'user.email', 'test@example.invalid')
    await git('config', 'commit.gpgsign', 'false')
    await git('config', 'core.hooksPath', '/dev/null')
    await mkdir(join(repo, 'src'))
    await writeFile(join(repo, 'src', 'value'), 'main')
    await git('add', '.')
    await git('commit', '-m', 'initial')
    await git('switch', '-c', 'feature')
    await writeFile(join(repo, 'src', 'value'), 'feature')
    await git('commit', '-am', 'feature')
    await git('update-ref', 'refs/remotes/origin/feature', 'HEAD')
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature')
    await git('switch', 'main')
  })
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
  const options = () => ({ root: join(root, 'harnesses'), label: 'Codex', now: () => new Date(2026, 8, 21, 12, 0) })
  const prepare = (source: 'worktree' | 'branch', branchRef = 'refs/heads/feature', path = repo, extra: Record<string, unknown> = {}) =>
    prepareProjectFolder(parseProjectFolder({ projectSource: source, gitSource: path, branchRef, ...extra })!, options())
  const worktrees = () => join(root, 'harnesses', 'worktrees', 'project with spaces')
  const current = async (path: string) => (await exec('git', ['-C', path, 'branch', '--show-current'])).stdout.trim()

  it('encrypts Git metadata requests and replies', () => {
    expect(encryptDownFrame('git_project_info')).toBe(true)
    expect(encryptRpcResult('git_project_info_result')).toBe(true)
  })

  it('reads local and remote branches without switching or creating anything', async () => {
    expect(await readGitProject(repo)).toMatchObject({ isGit: true, branch: 'main', branches: [
      { ref: 'refs/heads/feature', name: 'feature', remote: false },
      { ref: 'refs/heads/main', name: 'main', remote: false },
      { ref: 'refs/remotes/origin/feature', name: 'origin/feature', remote: true },
    ] })
    expect(await git('branch', '--show-current')).toBe('main')
    expect(await git('worktree', 'list', '--porcelain')).not.toContain('harness/')
    expect(await readGitProject(root)).toMatchObject({ isGit: false })
    expect(await readGitProject('relative/path')).toEqual({ error: 'INVALID_PATH' })
  })

  it('starts concurrent worktrees on distinct branches from the chosen ref and preserves dirty source files', async () => {
    await writeFile(join(repo, 'src', 'value'), 'my uncommitted work')
    const paths = await Promise.all([prepare('worktree'), prepare('worktree', 'refs/remotes/origin/feature')])
    expect(new Set(paths).size).toBe(2)
    const branches = []
    for (const path of paths) {
      expect(await readFile(join(path, 'src', 'value'), 'utf8')).toBe('feature')
      const branch = (await exec('git', ['-C', path, 'branch', '--show-current'])).stdout.trim()
      expect(branch).toMatch(/^tester\//)
      branches.push(branch)
    }
    expect(new Set(branches).size).toBe(2)
    expect(await readFile(join(repo, 'src', 'value'), 'utf8')).toBe('my uncommitted work')
    expect(await git('branch', '--show-current')).toBe('main')
  })

  it('makes up a two-word branch no branch uses, in a folder named for it, grouped by repository', async () => {
    expect(placeholderBranch([], 'deehw', () => 0)).toBe('deehw/amber-badger')
    expect(placeholderBranch(['refs/heads/deehw/amber-badger', 'deehw/amber-badger-2'], 'deehw', () => 0)).toBe('deehw/amber-badger-3')
    expect(worktreeFolderName('deehw/brave-otter')).toBe('brave-otter')
    expect(worktreeFolderName('fix/login page')).toBe('loginpage')
    expect(sessionBranchSlug('Worktree and branches organization')).toBe('worktree-and-branches-organization')
    expect(sessionBranchSlug('✳ Fix: the login page — redirects twice?')).toBe('fix-the-login-page-redirects-twice')
    expect(sessionBranchSlug('a'.repeat(30) + ' ' + 'b'.repeat(30))).toBe('a'.repeat(30))
    expect(sessionBranchSlug('✳ ✳')).toBeNull()
    const made = [await prepare('worktree'), await prepare('worktree')]
    expect(new Set(made).size).toBe(2)
    for (const path of made) {
      const branch = await current(path)
      expect(branch).toMatch(/^tester\/[a-z]+-[a-z]+(-\d+)?$/)
      expect(path).toBe(join(worktrees(), worktreeFolderName(branch)))
      expect(await git('config', '--get', `branch.${branch}.harness`)).toBe('placeholder')
    }
  })

  it('creates a named branch once, and refuses names Git would not take', async () => {
    const named = await prepare('worktree', 'refs/heads/feature', repo, { branchName: 'fix/login' })
    expect(named).toBe(join(worktrees(), 'login'))
    expect(await current(named)).toBe('fix/login')
    expect(await git('config', '--get', 'branch.fix/login.harness')).toBe('created')
    const made = await prepare('worktree', 'refs/heads/feature', repo, { branchName: 'tester/quiet-owl', branchMode: 'placeholder' })
    expect(await current(made)).toBe('tester/quiet-owl')
    expect(await git('config', '--get', 'branch.tester/quiet-owl.harness')).toBe('placeholder')
    const info = await readGitProject(repo) as { owner: string; branches: Array<{ name: string; harness?: true }> }
    expect(info.owner).toBe('tester')
    expect(info.branches.filter(b => b.harness).map(b => b.name).sort()).toEqual(['fix/login', 'tester/quiet-owl'])
    await expect(prepare('worktree', 'refs/heads/feature', repo, { branchName: 'fix/login' })).rejects.toMatchObject({ code: 'BRANCH_EXISTS' })
    await expect(prepare('worktree', 'refs/heads/feature', repo, { branchName: 'bad..name' })).rejects.toMatchObject({ code: 'INVALID_BRANCH' })
    for (const extra of [{ branchName: '-x' }, { branchName: 'a b' }, { branchName: 'ok', branchMode: 'other' }]) {
      expect(() => parseProjectFolder({ projectSource: 'worktree', gitSource: repo, ...extra })).toThrow()
    }
  })

  it('makes a new branch for the folder itself, keeping its uncommitted work, and refuses one that exists', async () => {
    await writeFile(join(repo, 'src', 'value'), 'in progress')
    expect(await prepare('branch', 'refs/heads/login-fix', repo, { branchName: 'login-fix' })).toBe(repo)
    expect(await git('branch', '--show-current')).toBe('login-fix')
    expect(await readFile(join(repo, 'src', 'value'), 'utf8')).toBe('in progress')
    await expect(prepare('branch', 'refs/heads/feature', repo, { branchName: 'feature' })).rejects.toMatchObject({ code: 'BRANCH_EXISTS' })
    expect(() => parseProjectFolder({ projectSource: 'branch', gitSource: repo, branchRef: 'refs/heads/other', branchName: 'login-fix' })).toThrow()
  })

  it('names a made-up worktree branch after its session once, and never a pushed or chosen one', async () => {
    const path = await prepare('worktree', 'refs/heads/feature', repo, { branchName: 'tester/quiet-owl', branchMode: 'placeholder' })
    expect(await nameBranchAfterSession(path, null)).toBeNull()
    expect(await nameBranchAfterSession(path, 'Worktree and branches organization')).toBe('tester/worktree-and-branches-organization')
    expect(await current(path)).toBe('tester/worktree-and-branches-organization')
    expect(await git('config', '--get', 'branch.tester/worktree-and-branches-organization.harness')).toBe('created')
    expect(await nameBranchAfterSession(path, 'A later name')).toBeNull()
    expect(await current(path)).toBe('tester/worktree-and-branches-organization')
    const second = await prepare('worktree', 'refs/heads/feature', repo, { branchName: 'tester/calm-fox', branchMode: 'placeholder' })
    expect(await nameBranchAfterSession(second, 'Worktree and branches organization')).toBe('tester/worktree-and-branches-organization-2')
    const chosen = await prepare('worktree', 'refs/heads/feature', repo, { branchName: 'fix/mine' })
    expect(await nameBranchAfterSession(chosen, 'Anything')).toBeNull()
    const pushed = await prepare('worktree', 'refs/heads/feature', repo, { branchName: 'tester/sunny-owl', branchMode: 'placeholder' })
    await git('config', 'branch.tester/sunny-owl.remote', 'origin')
    expect(await nameBranchAfterSession(pushed, 'Anything')).toBeNull()
    expect(await current(pushed)).toBe('tester/sunny-owl')
  })

  it('checks out an existing branch as it is in a new worktree, once', async () => {
    await git('branch', 'topic', 'main')
    const path = await prepare('worktree', 'refs/heads/topic', repo, { branchName: 'topic', branchMode: 'existing' })
    expect(path).toBe(join(worktrees(), 'topic'))
    expect(await current(path)).toBe('topic')
    expect(await readFile(join(path, 'src', 'value'), 'utf8')).toBe('main')
    await expect(prepare('worktree', 'refs/heads/topic', repo, { branchName: 'topic', branchMode: 'existing' }))
      .rejects.toMatchObject({ code: 'BRANCH_IN_USE' })
  })

  it('fetches a remote base first, reports the default, and tracks a remote branch under its own name', async () => {
    const origin = join(root, 'origin.git'), upstream = join(root, 'upstream')
    await exec('git', ['clone', '--quiet', '--bare', repo, origin])
    await git('remote', 'add', 'origin', origin)
    await git('fetch', '--quiet', 'origin')
    await git('remote', 'set-head', 'origin', 'main')
    expect(await readGitProject(repo)).toMatchObject({ defaultRef: 'refs/remotes/origin/main' })
    await exec('git', ['clone', '--quiet', origin, upstream])
    const up = (...args: string[]) => exec('git', ['-C', upstream, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args])
    await writeFile(join(upstream, 'src', 'value'), 'pushed')
    await up('commit', '-qam', 'pushed')
    await up('push', '--quiet', 'origin', 'main', 'main:fix/typo')
    await git('fetch', '--quiet', 'origin', 'fix/typo:refs/remotes/origin/fix/typo')
    const fresh = await prepare('worktree', 'refs/remotes/origin/main', repo, { branchName: 'harness/fresh' })
    expect(await readFile(join(fresh, 'src', 'value'), 'utf8')).toBe('pushed')
    await expect(exec('git', ['-C', fresh, 'rev-parse', '--abbrev-ref', '@{upstream}'])).rejects.toThrow()
    const tracking = await prepare('worktree', 'refs/remotes/origin/fix/typo', repo, { branchName: 'fix/typo' })
    expect((await exec('git', ['-C', tracking, 'rev-parse', '--abbrev-ref', '@{upstream}'])).stdout.trim()).toBe('origin/fix/typo')
  })

  it('copies ignored files named in .worktreeinclude into new worktrees', async () => {
    await writeFile(join(repo, '.gitignore'), '.env\n*.log\nlocal/\n')
    await writeFile(join(repo, '.worktreeinclude'), '.env\nlocal/\n')
    await writeFile(join(repo, '.env'), 'SECRET=1')
    await writeFile(join(repo, 'debug.log'), 'noise')
    await mkdir(join(repo, 'local'))
    await writeFile(join(repo, 'local', 'settings.json'), '{}')
    const path = await prepare('worktree')
    expect(await readFile(join(path, '.env'), 'utf8')).toBe('SECRET=1')
    expect(await readFile(join(path, 'local', 'settings.json'), 'utf8')).toBe('{}')
    await expect(readFile(join(path, 'debug.log'))).rejects.toThrow()
  })

  it('reads a linked worktree as its repository, and a worktree started from one joins the same repository', async () => {
    const linked = await prepare('worktree', 'refs/heads/feature', repo, { branchName: 'harness/linked' })
    const info = await readGitProject(join(linked, 'src'))
    expect(info).toMatchObject({ isGit: true, branch: 'harness/linked', mainBranch: 'main' })
    expect(await realpath((info as { mainFolder: string }).mainFolder)).toBe(await realpath(join(repo, 'src')))
    const branches = (info as { branches: Array<{ name: string; worktree?: string }> }).branches
    expect(await realpath(branches.find(branch => branch.name === 'harness/linked')!.worktree!)).toBe(await realpath(linked))
    expect(await realpath(branches.find(branch => branch.name === 'main')!.worktree!)).toBe(await realpath(repo))
    expect(await readGitProject(repo)).not.toHaveProperty('mainFolder')
    expect(await prepare('worktree', 'refs/heads/main', linked, { branchName: 'harness/second' })).toBe(join(worktrees(), 'second'))
  })

  it('keeps the selected subfolder in its new worktree', async () => {
    const path = await prepare('worktree', 'refs/heads/feature', join(repo, 'src'))
    expect(await readFile(join(path, 'value'), 'utf8')).toBe('feature')
    expect(path.endsWith('/src/')).toBe(false)
  })

  it('switches the shared folder only when requested, without forcing conflicting changes', async () => {
    expect(await prepare('branch')).toBe(repo)
    expect(await git('branch', '--show-current')).toBe('feature')
    await writeFile(join(repo, 'src', 'value'), 'keep this')
    await expect(prepare('branch', 'refs/heads/main')).rejects.toMatchObject({ code: 'BRANCH_SWITCH_FAILED' })
    expect(await git('branch', '--show-current')).toBe('feature')
    expect(await readFile(join(repo, 'src', 'value'), 'utf8')).toBe('keep this')
    expect(await git('stash', 'list')).toBe('')
    // Selecting the current branch is a no-op even with dirty files.
    expect(await prepare('branch')).toBe(repo)
    await git('checkout', '--', '.')
    await writeFile(join(repo, 'notes.txt'), 'untracked')
    await expect(prepare('branch', 'refs/heads/main')).rejects.toMatchObject({ code: 'BRANCH_SWITCH_FAILED' })
    expect(await git('branch', '--show-current')).toBe('feature')
  })

  it('opens a branch checked out elsewhere in its worktree, and refuses missing refs, revision expressions, and untracked subfolders', async () => {
    await git('worktree', 'add', join(root, 'other'), 'feature')
    expect(await realpath(await prepare('branch'))).toBe(await realpath(join(root, 'other')))
    expect(await realpath(await prepare('branch', 'refs/heads/feature', join(repo, 'src')))).toBe(await realpath(join(root, 'other', 'src')))
    expect(await git('branch', '--show-current')).toBe('main')
    for (const ref of ['refs/heads/missing', 'refs/heads/main~0', 'refs/heads/main^{commit}']) {
      await expect(prepare('worktree', ref)).rejects.toMatchObject({ code: 'GIT_PROJECT_UNAVAILABLE' })
    }
    await mkdir(join(repo, 'untracked'))
    await expect(prepare('worktree', 'refs/heads/main', join(repo, 'untracked'))).rejects.toMatchObject({ code: 'GIT_PROJECT_UNAVAILABLE' })
    expect(() => parseProjectFolder({ projectSource: 'branch', gitSource: repo, branchRef: 'refs/remotes/origin/feature' })).toThrow()
  })

  it('detects an empty repository but refuses a worktree until its first commit', async () => {
    const empty = join(root, 'empty')
    await mkdir(empty)
    await exec('git', ['-C', empty, 'init', '-b', 'main'])
    expect(await readGitProject(empty)).toMatchObject({ isGit: true, branch: 'main', branches: [] })
    await expect(prepareProjectFolder({ source: 'worktree', gitSource: empty }, options()))
      .rejects.toMatchObject({ code: 'GIT_PROJECT_UNAVAILABLE' })
  })

  it('validates source paths and requires an exact local branch when isolation is disabled', async () => {
    for (const path of [null, 7, '', 'relative', '/bad\npath', '/bad\0path', `/${'x'.repeat(4096)}`]) {
      expect(validGitPath(path)).toBe(false)
      expect(() => parseProjectFolder({ projectSource: 'worktree', gitSource: path })).toThrow()
    }
    await expect(prepareGitProject('relative', { ...options(), worktree: true }))
      .rejects.toMatchObject({ code: 'INVALID_PROJECT_SOURCE' })
    await expect(prepareGitProject(repo, { ...options(), worktree: true, ref: '--help' }))
      .rejects.toMatchObject({ code: 'GIT_PROJECT_UNAVAILABLE' })
    for (const ref of [undefined, 'refs/remotes/origin/feature']) {
      await expect(prepareGitProject(repo, { ...options(), worktree: false, ref }))
        .rejects.toMatchObject({ code: 'INVALID_BRANCH' })
    }
    for (const payload of [
      { branchRef: 7 }, { branchRef: 'refs/heads/bad name' },
      { branchRef: `refs/heads/${'x'.repeat(1024)}` }, { repositoryUrl: 'https://github.com/a/b' },
    ]) {
      expect(() => parseProjectFolder({ projectSource: 'worktree', gitSource: repo, ...payload })).toThrow()
    }
  })

  it('supports detached HEAD, default worktree names, and switching back to a local branch', async () => {
    await git('checkout', '--detach', 'HEAD')
    expect(await readGitProject(repo)).toMatchObject({ isGit: true, branch: null })
    const path = await prepareGitProject(repo, { root, worktree: true })
    expect(await readFile(join(path, 'src', 'value'), 'utf8')).toBe('main')
    expect(path).toMatch(/\/worktrees\/project with spaces\/[a-z]+-[a-z]+(-\d+)?$/)
    expect(await prepare('branch')).toBe(repo)
    expect(await git('branch', '--show-current')).toBe('feature')
  })

  it('distinguishes an unavailable Git executable from a non-Git folder', async () => {
    vi.stubEnv('PATH', join(root, 'missing-binaries'))
    expect(await readGitProject(repo)).toEqual({ error: 'GIT_UNAVAILABLE' })
  })

  it('reports unreadable refs instead of silently treating the repository as non-Git', async () => {
    await writeFile(join(repo, '.git', 'packed-refs'), 'invalid packed refs\n')
    expect(await readGitProject(repo)).toEqual({ error: 'GIT_UNAVAILABLE' })
  })

  it('rejects a subfolder that became a file on the selected branch', async () => {
    await git('switch', 'feature')
    await git('rm', '-r', 'src')
    await writeFile(join(repo, 'src'), 'a file now')
    await git('add', 'src')
    await git('commit', '-m', 'replace folder with file')
    await git('switch', 'main')
    await expect(prepare('worktree', 'refs/heads/feature', join(repo, 'src')))
      .rejects.toMatchObject({ code: 'GIT_PROJECT_UNAVAILABLE' })
  })

  it('keeps a worktree created before a checkout hook fails so the user can recover it', async () => {
    const hooks = join(root, 'hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await git('config', 'core.hooksPath', hooks)
    await expect(prepare('worktree')).rejects.toMatchObject({ code: 'WORKTREE_FAILED' })
    const linked = (await git('worktree', 'list', '--porcelain')).split('\n')
      .find(line => line.startsWith('worktree ') && line.includes('/worktrees/'))!.slice(9)
    expect(await readFile(join(linked, 'src', 'value'), 'utf8')).toBe('feature')
    expect(await git('branch', '--show-current')).toBe('main')
  })
})
