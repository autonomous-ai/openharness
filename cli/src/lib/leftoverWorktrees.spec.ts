import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanWorktrees, listLeftoverWorktrees, WALK_MS } from './leftoverWorktrees.js'
import { TrashError } from './trash.js'

const exec = promisify(execFile)

// Real Git, several worktrees a test: slower than the default 5s under a full, parallel run.
describe('leftover worktrees', { timeout: 30_000 }, () => {
  let root: string, repo: string, home: string, harnesses: string, bin: string
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args])).stdout.trim()
  const add = async (name: string, branch: string | null) => {
    const path = join(home, 'app', name)
    await git(repo, 'worktree', 'add', '--quiet', ...(branch ? ['-b', branch, path] : ['--detach', path]), 'main')
    return path
  }
  const exists = (path: string) => stat(path).then(() => true, () => false)
  /** A trash that moves the folder aside, as the system's would: never the person's real Trash. */
  const moved: string[] = []
  const trash = vi.fn(async (path: string) => {
    moved.push(path)
    await exec('mv', [path, join(bin, `${moved.length}`)])
  })
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'harness-leftover-')))
    repo = join(root, 'app')
    harnesses = join(root, 'harnesses')
    home = join(harnesses, 'worktrees')
    bin = join(root, 'bin')
    await mkdir(repo)
    await mkdir(bin)
    await git(repo, 'init', '--quiet', '-b', 'main')
    await writeFile(join(repo, 'file'), 'one')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'initial')
    moved.length = 0
    trash.mockClear()
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  describe('listing them', () => {
    it('lists each unused worktree with its repository, branch, size, last change and uncommitted work, oldest first', async () => {
      const clean = await add('clean', 'harness/clean')
      const dirty = await add('dirty', 'feature/dirty')
      const detached = await add('detached', null)
      const used = await add('used', 'harness/used')
      await writeFile(join(dirty, 'draft'), 'x'.repeat(20_000))
      // Harness's own runtime folder is not the person's work.
      await mkdir(join(clean, '.harness'))
      await writeFile(join(clean, '.harness', 'state.json'), '{}')
      // The draft is the newest change of all, by an hour.
      const newest = new Date(Date.now() + 3600_000)
      await utimes(join(dirty, 'draft'), newest, newest)
      const { worktrees, more } = await listLeftoverWorktrees({ root: harnesses, inUse: [join(used, 'src'), null, ''] })
      expect(more).toBe(false)
      expect(worktrees.map((w) => w.path).sort()).toEqual([clean, detached, dirty])
      const byPath = new Map(worktrees.map((w) => [w.path, w]))
      expect(byPath.get(clean)).toMatchObject({ repository: repo, branch: 'harness/clean', uncommitted: false, sizeComplete: true })
      expect(byPath.get(dirty)).toMatchObject({ repository: repo, branch: 'feature/dirty', uncommitted: true, sizeComplete: true })
      expect(byPath.get(detached)).toMatchObject({ repository: repo, branch: null, uncommitted: false })
      expect(byPath.get(dirty)!.sizeBytes).toBeGreaterThan(byPath.get(clean)!.sizeBytes)
      expect(byPath.get(dirty)!.sizeBytes).toBeGreaterThanOrEqual(20_000)
      expect(worktrees.at(-1)!.path).toBe(dirty)
      expect(byPath.get(dirty)!.lastChangeMs).toBe(newest.getTime())
    })

    it('lists none in use, none outside the worktrees folder, and nothing when there is no folder', async () => {
      expect(await listLeftoverWorktrees({ root: harnesses, inUse: [] })).toEqual({ worktrees: [], more: false })
      const only = await add('only', 'harness/only')
      expect(await listLeftoverWorktrees({ root: harnesses, inUse: [only] })).toEqual({ worktrees: [], more: false })
    })

    it('stops at its bounds and says so: the number listed, each walk\'s entries, and the list\'s time', async () => {
      await add('one', 'harness/one')
      await add('two', 'harness/two')
      const listed = await listLeftoverWorktrees({ root: harnesses, inUse: [], listMax: 1 })
      expect(listed.more).toBe(true)
      expect(listed.worktrees).toHaveLength(1)
      const cut = await listLeftoverWorktrees({ root: harnesses, inUse: [], entriesMax: 1 })
      expect(cut.worktrees.map((w) => w.sizeComplete)).toEqual([false, false])
      let clock = 0
      const late = await listLeftoverWorktrees({ root: harnesses, inUse: [], now: () => (clock += WALK_MS) })
      expect(late.worktrees.map((w) => w.sizeComplete)).toEqual([false, false])
    })

    it('still lists a worktree whose repository is gone, with what git cannot say left empty', async () => {
      const orphan = await add('orphan', 'harness/orphan')
      await rm(repo, { recursive: true })
      const { worktrees } = await listLeftoverWorktrees({ root: harnesses, inUse: [] })
      expect(worktrees).toEqual([expect.objectContaining({ path: orphan, repository: null, branch: null, uncommitted: null, sizeComplete: true })])
    })
  })

  describe('cleaning the chosen ones', () => {
    it('moves each to the Trash, keeps its branch, prunes the repository\'s record, and lets the empty repository folder go', async () => {
      const a = await add('a', 'harness/a')
      const b = await add('b', 'harness/b')
      expect(await cleanWorktrees({ root: harnesses, inUse: [], paths: [a, b, a], trash })).toEqual([
        { path: a, state: 'trashed', pruned: true },
        { path: b, state: 'trashed', pruned: true },
      ])
      expect(moved).toEqual([a, b])
      expect(await exists(join(bin, '1', '.git'))).toBe(true)
      expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(a)
      expect((await git(repo, 'branch', '--format=%(refname:short)')).split('\n').sort()).toEqual(['harness/a', 'harness/b', 'main'])
      expect(await exists(join(home, 'app')), 'the repository folder goes with its last worktree').toBe(false)
      expect(await exists(home), 'the worktrees folder stays').toBe(true)
    })

    it('checks again: one now in use, gone, outside the folder, a link or no worktree is left alone and said so', async () => {
      const used = await add('used', 'harness/used')
      const kept = await add('kept', 'harness/kept')
      await symlink(kept, join(home, 'app', 'link'))
      await mkdir(join(home, 'app', 'plain'))
      const paths = [used, join(home, 'app', 'gone'), repo, join(home, 'app', 'link'), join(home, 'app', 'plain'), `${kept}/../kept`]
      expect(await cleanWorktrees({ root: harnesses, inUse: [used], paths, trash })).toEqual([
        { path: used, state: 'in_use' },
        ...paths.slice(1).map((path) => ({ path, state: 'not_found' })),
      ])
      expect(trash).not.toHaveBeenCalled()
      expect(await exists(kept)).toBe(true)
    })

    it('says why one could not go, leaves it as it was, and goes on with the rest', async () => {
      const declined = await add('declined', 'harness/declined')
      const broken = await add('broken', 'harness/broken')
      const fine = await add('fine', 'harness/fine')
      trash.mockRejectedValueOnce(new TrashError('TRASH_DECLINED')).mockRejectedValueOnce(new Error('spawn EACCES'))
      expect(await cleanWorktrees({ root: harnesses, inUse: [], paths: [declined, broken, fine], trash })).toEqual([
        { path: declined, state: 'failed', reason: 'TRASH_DECLINED' },
        { path: broken, state: 'failed', reason: 'TRASH_FAILED' },
        { path: fine, state: 'trashed', pruned: true },
      ])
      expect(await exists(join(declined, '.git'))).toBe(true)
      expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(declined)
    })

    it('moves a worktree whose repository is gone, with nothing to prune', async () => {
      const orphan = await add('orphan', 'harness/orphan')
      await rm(repo, { recursive: true })
      expect(await cleanWorktrees({ root: harnesses, inUse: [], paths: [orphan], trash })).toEqual([{ path: orphan, state: 'trashed', pruned: false }])
    })
  })
})
