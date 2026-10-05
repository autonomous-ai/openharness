import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RegisteredSession } from './registry.js'
import { inspectWorkspace, inspectWorktree, removeReviewedWorktree } from './worktreeDeletion.js'

const exec = promisify(execFile)
describe('explicit worktree deletion', { timeout: 30_000 }, () => {
  let root: string, repo: string, tree: string, session: RegisteredSession
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args])).stdout.trim()
  const exists = (path: string) => stat(path).then(() => true, () => false)
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'harness-worktree-delete-')))
    repo = join(root, 'project'); tree = join(root, 'temporary worktree ')
    await mkdir(repo)
    await git(repo, 'init', '--quiet', '-b', 'main')
    await writeFile(join(repo, 'source'), 'keep main')
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'initial')
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'feature', tree)
    session = { agentId: 'selected', cwd: tree } as RegisteredSession
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('describes full working, worktree and main paths without changing files, including subfolders', async () => {
    await mkdir(join(tree, 'src'))
    expect(await inspectWorkspace({ ...session, cwd: join(tree, 'src') }, [session])).toMatchObject({
      kind: 'worktree', path: join(tree, 'src'), worktreePath: tree, mainPath: repo, canDelete: true,
    })
    expect(await inspectWorkspace({ ...session, cwd: repo }, [])).toMatchObject({ kind: 'main', path: repo, mainPath: repo, canDelete: false })
    expect(await inspectWorkspace({ ...session, cwd: root }, [])).toMatchObject({ kind: 'folder', path: root, canDelete: false })
    expect(await inspectWorkspace({ ...session, cwd: join(root, 'missing') }, [])).toMatchObject({ kind: 'unavailable', canDelete: false })
    const shared = await inspectWorkspace(session, [session, { ...session, agentId: 'other' }])
    expect(shared).toMatchObject({ kind: 'worktree', worktreePath: tree, mainPath: repo, canDelete: false })
    expect(shared.reason).toContain('Another harness')
    expect(await exists(tree)).toBe(true)
    expect(await git(repo, 'show', 'feature:source')).toBe('keep main')
  })

  it('removes the reviewed linked checkout and ignored output, retaining main and its branch', async () => {
    await mkdir(join(tree, 'node_modules'))
    await writeFile(join(tree, 'node_modules', 'package'), 'temporary dependencies')
    await writeFile(join(tree, 'source'), 'committed feature')
    await git(tree, 'commit', '--quiet', '-am', 'feature work')
    const review = await inspectWorktree(session, [session])
    expect(review).toMatchObject({ path: tree, main: repo, branch: 'feature', dirty: false })
    expect(review.bytes).toBeGreaterThan(0)
    await removeReviewedWorktree(review, session, [session], false)
    expect(await exists(tree)).toBe(false)
    expect(await exists(join(repo, 'source'))).toBe(true)
    expect(await git(repo, 'show', 'feature:source')).toBe('committed feature')
  })
  it('refuses the main checkout, locked worktrees, overlapping harnesses and nested worktrees', async () => {
    await expect(inspectWorktree({ ...session, cwd: repo }, [session])).rejects.toThrow('main project')
    await git(repo, 'worktree', 'lock', tree)
    await expect(inspectWorktree(session, [session])).rejects.toThrow('locked')
    await git(repo, 'worktree', 'unlock', tree)
    await expect(inspectWorktree(session, [session, { ...session, agentId: 'saved', active: false }])).rejects.toThrow('Another harness')
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'nested', join(tree, 'nested'))
    await expect(inspectWorktree(session, [session])).rejects.toThrow('Another Git worktree')
  })
  it('requires explicit consent for uncommitted files and refuses a stale review', async () => {
    const clean = await inspectWorktree(session, [session])
    await writeFile(join(tree, 'draft'), 'cannot recover')
    await expect(removeReviewedWorktree(clean, session, [session], true)).rejects.toThrow('changed')
    const dirty = await inspectWorktree(session, [session])
    expect(dirty.dirty).toBe(true)
    await expect(removeReviewedWorktree(dirty, session, [session], false)).rejects.toThrow('Confirm discarding')
    expect(await exists(tree)).toBe(true)
    await removeReviewedWorktree(dirty, session, [session], true)
    expect(await exists(tree)).toBe(false)
  })
  it('protects a detached unique commit and conversation data inside a worktree', async () => {
    await expect(inspectWorktree({ ...session, transcriptPath: join(tree, 'source') }, [session])).rejects.toThrow('history')
    await git(tree, 'checkout', '--detach')
    await writeFile(join(tree, 'source'), 'only here')
    await git(tree, 'commit', '--quiet', '-am', 'detached work')
    await expect(inspectWorktree(session, [session])).rejects.toThrow('no saved branch')
    expect(await exists(tree)).toBe(true)
  })
})
