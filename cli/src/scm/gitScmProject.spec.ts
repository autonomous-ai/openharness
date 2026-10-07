import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentProject } from '../lib/agentProject.js'
import { readGitProject } from '../lib/gitProject.js'
import { prepareProjectFolder } from '../lib/projectFolder.js'
import { GitScmProject } from './gitScmProject.js'
import type { ScmProject } from './types.js'

const exec = promisify(execFile)
// Real Git in a temporary repository, as gitProject.spec.ts does: the wrapper is only worth a test
// against the thing it wraps. Several worktrees a test: slower than the default 5s under a full run.
describe('GitScmProject wraps the git path without changing it', { timeout: 30_000 }, () => {
  let root: string, repo: string
  const scm = new GitScmProject()
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args])).stdout.trim()
  const exists = (path: string) => stat(path).then(() => true, () => false)
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-scm-git-'))
    repo = join(root, 'app')
    await mkdir(repo)
    await git(repo, 'init', '--quiet', '-b', 'main')
    await git(repo, 'remote', 'add', 'origin', 'git@github.com:Org/App.git')
    await writeFile(join(repo, 'file'), 'one')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'initial')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('detect answers exactly what readGitProject answers, named, behind the same fence', async () => {
    // The fixture lives in the temp directory, outside the browsable home, so the read names it.
    const fence = { knownRoots: [root] }
    expect(await scm.detect(repo, fence)).toEqual({ kind: 'git', git: await readGitProject(repo, fence) })
    const plain = join(root, 'plain')
    await mkdir(plain)
    expect(await scm.detect(plain, fence)).toEqual({ kind: 'none' })
    expect(await scm.detect(repo)).toEqual({ kind: 'none', error: 'FORBIDDEN' })
    expect(await scm.detect('relative/path')).toEqual({ kind: 'none', error: 'INVALID_PATH' })
  })

  it('describe answers exactly what agentProject answers, named, and nothing for a folder outside a repository', async () => {
    const nested = join(repo, 'nested')
    await mkdir(nested)
    const described = await scm.describe(nested)
    expect(described).toEqual({ kind: 'git', ...await agentProject(nested) })
    expect(described).toMatchObject({ kind: 'git', cwd: nested, remote: 'github.com/org/app', branch: 'main' })
    const plain = join(root, 'plain')
    await mkdir(plain)
    expect(await scm.describe(plain)).toBeNull()
  })

  it('forget drops the cached description, so the next describe reads the checkout again', async () => {
    expect(await scm.describe(repo)).toMatchObject({ branch: 'main' })
    await git(repo, 'switch', '--quiet', '-c', 'other')
    expect(await scm.describe(repo)).toMatchObject({ branch: 'main' })
    scm.forget(repo)
    expect(await scm.describe(repo)).toMatchObject({ branch: 'other' })
  })

  it('prepareIsolated makes the worktree prepareGitProject makes, marked as a placeholder, and a git launch record', async () => {
    const harnesses = join(root, 'harnesses')
    const { cwd, launchRecord } = await scm.prepareIsolated(repo, { root: harnesses, base: 'refs/heads/main' })
    expect(launchRecord).toEqual({ kind: 'git' })
    expect(cwd.startsWith(join(harnesses, 'worktrees', 'app') + '/')).toBe(true)
    expect(await exists(join(cwd, 'file'))).toBe(true)
    const branch = await git(cwd, 'branch', '--show-current')
    expect(await git(repo, 'config', `branch.${branch}.harness`)).toBe('placeholder')
    expect(await scm.describe(cwd)).toMatchObject({ kind: 'git', worktree: true, branchPending: true, branch })
    // The same request through projectFolder.ts lands beside it, under the same repository folder.
    const second = await prepareProjectFolder({ source: 'worktree', gitSource: repo, branchRef: 'refs/heads/main' }, { root: harnesses })
    expect(second.startsWith(join(harnesses, 'worktrees', 'app') + '/')).toBe(true)
    expect(second).not.toBe(cwd)
  })

  it('prepareIsolated passes a chosen name, an existing branch and the placeholder flag through unchanged', async () => {
    const harnesses = join(root, 'harnesses')
    await git(repo, 'branch', 'kept')
    const named = await scm.prepareIsolated(repo, { root: harnesses, base: 'refs/heads/main', name: 'feature/one' })
    expect(await git(named.cwd, 'branch', '--show-current')).toBe('feature/one')
    expect(await git(repo, 'config', 'branch.feature/one.harness')).toBe('created')
    const existing = await scm.prepareIsolated(repo, { root: harnesses, name: 'kept', existing: true })
    expect(await git(existing.cwd, 'branch', '--show-current')).toBe('kept')
    await expect(git(repo, 'config', 'branch.kept.harness')).rejects.toThrow()
    const placeholder = await scm.prepareIsolated(repo, { root: harnesses, base: 'refs/heads/main', name: 'made-up', placeholder: true })
    expect(await git(repo, 'config', 'branch.made-up.harness')).toBe('placeholder')
    await expect(scm.prepareIsolated(repo, { root: harnesses, base: 'refs/heads/main', name: 'kept' }))
      .rejects.toMatchObject({ code: 'BRANCH_EXISTS' })
    expect(placeholder.launchRecord).toEqual({ kind: 'git' })
  })

  it('prepareProjectFolder reports the record a worktree needs at relaunch, and nothing for the folder itself or a new one', async () => {
    const harnesses = join(root, 'harnesses')
    const reported: unknown[] = []
    const onPrepared = (prepared: unknown) => { reported.push(prepared) }
    const cwd = await prepareProjectFolder({ source: 'worktree', gitSource: repo, branchRef: 'refs/heads/main' }, { root: harnesses, onPrepared })
    expect(reported).toEqual([{ cwd, scmLaunchRecord: { kind: 'git' } }])
    await git(repo, 'branch', 'aside')
    expect(await prepareProjectFolder({ source: 'branch', gitSource: repo, branchRef: 'refs/heads/aside' }, { root: harnesses, onPrepared })).toBe(repo)
    expect(await git(repo, 'branch', '--show-current')).toBe('aside')
    expect(await prepareProjectFolder({ source: 'new', name: 'fresh' }, { root: harnesses, onPrepared })).toBe(join(harnesses, 'fresh'))
    expect(reported).toHaveLength(1)
  })

  it('rename names a placeholder branch after the session once, as nameBranchAfterSession does', async () => {
    const { cwd } = await scm.prepareIsolated(repo, { root: join(root, 'harnesses'), base: 'refs/heads/main' })
    const renamed = await scm.rename(cwd, 'Fix the login page')
    expect(renamed).toBeTruthy()
    expect(await git(cwd, 'branch', '--show-current')).toBe(renamed)
    expect(await git(repo, 'config', `branch.${renamed}.harness`)).toBe('created')
    expect(await scm.rename(cwd, 'A later title')).toBeNull()
    expect(await scm.rename(repo, 'Not a placeholder')).toBeNull()
    expect(await scm.rename(cwd, null)).toBeNull()
  })

  it('sweep removes an idle, unused worktree, as sweepWorktrees does', async () => {
    const harnesses = join(root, 'harnesses')
    const idle = await scm.prepareIsolated(repo, { root: harnesses, base: 'refs/heads/main' })
    const busy = await scm.prepareIsolated(repo, { root: harnesses, base: 'refs/heads/main' })
    const later = Date.now() + 8 * 24 * 3600_000
    expect(await scm.sweep({ root: harnesses, inUse: [busy.cwd, null, undefined], now: later })).toEqual([idle.cwd])
    expect(await exists(idle.cwd)).toBe(false)
    expect(await exists(busy.cwd)).toBe(true)
    expect(await scm.sweep({ root: harnesses, inUse: [busy.cwd], now: later })).toEqual([])
  })

  it('launchEnv asks nothing of the pane, and there is no prepareWrite: a worktree is the folder the row already names', () => {
    expect(scm.launchEnv({ kind: 'git' })).toEqual({})
    expect((scm as ScmProject).prepareWrite).toBeUndefined()
  })
})
