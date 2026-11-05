import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrewFolders, crewRest, pruneBranches } from './crewFolders.js'

const roots: string[] = []
const root = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crew-folders-'))); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** An origin with main, a project clone of it, and a worktree for one crew member. */
function repos() {
  const dir = root(), origin = join(dir, 'origin.git'), clone = join(dir, 'clone'), worktree = join(dir, 'worktrees', 'ada')
  git(dir, 'init', '--bare', '-b', 'main', origin)
  git(dir, 'clone', origin, clone)
  writeFileSync(join(clone, 'README.md'), 'hello\n')
  git(clone, 'add', '.'); git(clone, 'commit', '-m', 'first'); git(clone, 'push', 'origin', 'main')
  mkdirSync(join(dir, 'worktrees'))
  git(clone, 'worktree', 'add', '-b', 'super-tab/start-1', worktree, 'origin/main')
  return { dir, origin, clone, worktree }
}

describe('what a crew row asks of its host', () => {
  it('reads asleep, a dropped folder and a move from the agent record', () => {
    expect(crewRest({ asleep: { since: 1 } })).toBe('sleep')
    expect(crewRest({ asleep: { since: 1, folderDropped: true } })).toBe('drop')
    expect(crewRest({ movedTo: { machineId: 'mini' } })).toBe('moving')
    expect(crewRest({})).toBeNull()
  })
})

describe('a crew member\'s folder', () => {
  const folders = (dataDir: string, worktree: { path: string; source: string } | null, remove = vi.fn(async () => {})) =>
    ({ folders: new CrewFolders({ dataDir, machineId: 'mac', worktree: () => worktree, removeWorktree: remove, log: () => {} }), remove })

  it('is dropped through the Swarm\'s own worktree removal, and remembered so a wake brings it back at the same path', async () => {
    const r = repos(), data = root()
    const { folders: f, remove } = folders(data, { path: r.worktree, source: r.clone }, vi.fn(async () => { git(r.clone, 'worktree', 'remove', r.worktree) }))
    expect(await f.drop('tab', 'ada')).toBe('dropped')
    expect(remove).toHaveBeenCalledWith('tab', 'ada')
    expect(existsSync(r.worktree)).toBe(false)
    expect(await f.restore('tab', 'ada')).toBe('restored')
    expect(existsSync(join(r.worktree, 'README.md'))).toBe(true)
    // Restored once: nothing is remembered any more.
    expect(await f.restore('tab', 'ada')).toBe('none')
  })

  it('kept when the removal refuses it (work not committed or pushed), and nothing is remembered', async () => {
    const r = repos(), data = root()
    const { folders: f } = folders(data, { path: r.worktree, source: r.clone })
    expect(await f.drop('tab', 'ada')).toBe('kept')
    expect(await f.restore('tab', 'ada')).toBe('none')
  })

  it('none when the Swarm has no record of the folder', async () => {
    const { folders: f, remove } = folders(root(), null)
    expect(await f.drop('tab', 'ada')).toBe('none')
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('branch copies', () => {
  it('drops local branches merged into the default branch or whose remote branch is gone, never the current one or unpushed work', async () => {
    const r = repos()
    const work = r.worktree
    // merged: pushed, then merged into main on the remote.
    git(work, 'checkout', '-b', 'merged'); writeFileSync(join(work, 'a.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'a')
    git(work, 'push', '-u', 'origin', 'merged'); git(r.clone, 'fetch'); git(r.clone, 'checkout', 'main'); git(r.clone, 'merge', '--ff-only', 'origin/merged'); git(r.clone, 'push', 'origin', 'main')
    // gone: pushed, then its remote branch deleted (a closed pull request), every commit pushed before.
    git(work, 'checkout', '-b', 'gone', 'origin/main'); writeFileSync(join(work, 'b.txt'), 'b\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'b')
    git(work, 'push', '-u', 'origin', 'gone'); git(r.dir, '--git-dir', r.origin, 'branch', '-D', 'gone')
    // unpushed: commits nowhere else.
    git(work, 'checkout', '-b', 'unpushed', 'origin/main'); writeFileSync(join(work, 'c.txt'), 'c\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'c')
    // current: the branch the member works on now.
    git(work, 'checkout', '-b', 'current', 'origin/main')
    // someone-else: made in the clone itself (the person's own checkout), pushed and merged: not this member's to prune.
    git(r.clone, 'checkout', '-b', 'someone-else'); git(r.clone, 'push', '-u', 'origin', 'someone-else'); git(r.clone, 'checkout', 'main')
    git(work, 'fetch', '--prune')
    expect((await pruneBranches(work)).sort()).toEqual(['gone', 'merged'])
    const left = git(work, 'branch', '--format=%(refname:short)').split('\n').sort()
    expect(left).toEqual(['current', 'main', 'someone-else', 'super-tab/start-1', 'unpushed'].sort())
  })
})
