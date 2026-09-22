import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'
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
  const prepare = (source: 'worktree' | 'branch', branchRef = 'refs/heads/feature', path = repo) =>
    prepareProjectFolder(parseProjectFolder({ projectSource: source, gitSource: path, branchRef })!, options())

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
      expect(branch).toMatch(/^harness\//)
      branches.push(branch)
    }
    expect(new Set(branches).size).toBe(2)
    expect(await readFile(join(repo, 'src', 'value'), 'utf8')).toBe('my uncommitted work')
    expect(await git('branch', '--show-current')).toBe('main')
  })

  it('names worktrees for the harness and the time, grouped by repository, skipping names already taken', async () => {
    await git('branch', 'harness/codex-0921-1200-2', 'main')
    const paths = [await prepare('worktree'), await prepare('worktree')]
    const folder = join(root, 'harnesses', 'worktrees', 'project with spaces')
    expect(paths).toEqual([join(folder, 'codex-0921-1200'), join(folder, 'codex-0921-1200-3')])
    for (const path of paths) {
      expect((await exec('git', ['-C', path, 'branch', '--show-current'])).stdout.trim()).toBe(`harness/${basename(path)}`)
    }
  })

  it('reads a linked worktree as its repository, and a worktree started from one joins the same repository', async () => {
    const linked = await prepare('worktree')
    const info = await readGitProject(join(linked, 'src'))
    expect(info).toMatchObject({ isGit: true, branch: 'harness/codex-0921-1200', mainBranch: 'main' })
    expect(await realpath((info as { mainFolder: string }).mainFolder)).toBe(await realpath(join(repo, 'src')))
    const branches = (info as { branches: Array<{ name: string; worktree?: string }> }).branches
    expect(await realpath(branches.find(branch => branch.name === 'harness/codex-0921-1200')!.worktree!)).toBe(await realpath(linked))
    expect(await realpath(branches.find(branch => branch.name === 'main')!.worktree!)).toBe(await realpath(repo))
    expect(await readGitProject(repo)).not.toHaveProperty('mainFolder')
    const second = await prepare('worktree', 'refs/heads/main', linked)
    expect(second).toBe(join(root, 'harnesses', 'worktrees', 'project with spaces', 'codex-0921-1200-2'))
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
    expect(path).toMatch(/\/worktrees\/project with spaces\/harness-\d{4}-\d{4}$/)
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
