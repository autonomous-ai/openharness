import { execFile } from 'node:child_process'
import { constants, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, sep, win32 } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOutputIn, sweepOne, sweepWorktrees, WorktreeKept } from './worktreeSweep.js'

const exec = promisify(execFile)
/** Folders the sweep's own check reads as writable whatever their mode. */
const writable = vi.hoisted(() => ({ folders: new Set<string>() }))
/** A step a test takes when the sweep first looks at a path: the folder changes between git's listing and the removal. */
const looked = vi.hoisted(() => ({ at: null as null | ((file: string) => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    access: (file: string, mode?: number) => writable.folders.has(file) ? Promise.resolve() : fs.access(file, mode),
    lstat: async (file: string, options?: object) => { await looked.at?.(String(file)); return fs.lstat(file, options as never) },
  }
})
/** Whether this disk reads a name in other letters as the same folder: a Mac's and Windows's do, Linux's does not. */
const caseInsensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'case-probe-'))
  try { return existsSync(join(dirname(probe), basename(probe).toUpperCase())) } finally { rmSync(probe, { recursive: true }) }
})()
const nothing = { removed: [], freed: [], failed: [], left: 0 }
type Over = { root?: string; inUse?: Array<string | null>; busy?: () => string[]; now?: number; limit?: { freed: number; ms: number } }

// Real Git, several worktrees a test: slower than the default 5s under a full, parallel run.
describe('sweeping unused worktrees', { timeout: 30_000 }, () => {
  let root: string, repo: string, home: string
  const gitWith = async (env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', ...args], { env })).stdout.trim()
  const git = (cwd: string, ...args: string[]) => gitWith(process.env, cwd, ...args)
  const later = () => Date.now() + 8 * 24 * 3600_000
  /** A sweep a week from now, of worktrees no harness is in unless the test names one. */
  const sweep = (over: Over = {}) => sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], busy: () => [], now: later(), ...over })
  const add = async (name: string, branch: string, from = 'main') => {
    const path = join(home, 'app', name)
    await git(repo, 'worktree', 'add', '--quiet', '-b', branch, path, from)
    return path
  }
  const exists = (path: string) => stat(path).then(() => true, () => false)
  const branches = async () => (await git(repo, 'branch', '--format=%(refname:short)')).split('\n')
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-sweep-'))
    repo = join(root, 'app')
    home = join(root, 'harnesses', 'worktrees')
    await mkdir(repo)
    await git(repo, 'init', '--quiet', '-b', 'main')
    await writeFile(join(repo, 'file'), 'one')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'initial')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('removes a clean, idle, unused worktree and the harness branch that has nothing of its own', async () => {
    const path = await add('brave-otter', 'harness/brave-otter')
    expect(await sweep()).toEqual({ ...nothing, removed: [path] })
    expect(await exists(path)).toBe(false)
    expect(await exists(join(home, 'app')), 'the repository folder goes with its last worktree').toBe(false)
    expect(await exists(home), 'the worktrees folder stays').toBe(true)
    expect(await branches()).toEqual(['main'])
  })

  it('keeps worktrees a live or stopped harness uses, recently touched ones, and uncommitted work', async () => {
    const used = await add('used', 'harness/used')
    const recent = await add('recent', 'harness/recent')
    const dirty = await add('dirty', 'harness/dirty')
    await writeFile(join(dirty, 'draft'), 'not committed')
    const old = new Date(Date.now() - 30 * 24 * 3600_000)
    for (const path of [used, dirty]) await utimes(path, old, old)
    const { removed } = await sweep({ inUse: [join(used, 'src'), null] })
    expect(removed).toEqual([recent])
    expect((await sweep({ inUse: [used], now: Date.now() })).removed).toEqual([])
    expect(await exists(used)).toBe(true)
    expect(await exists(dirty)).toBe(true)
  })

  it('removes a branch Harness marked in the config, whatever its name', async () => {
    const path = await add('quiet-owl', 'deehw/quiet-owl')
    await git(repo, 'config', 'branch.deehw/quiet-owl.harness', 'placeholder')
    expect((await sweep()).removed).toEqual([path])
    expect(await branches()).toEqual(['main'])
  })

  it('keeps branches with commits of their own, and branches Harness did not name', async () => {
    const own = await add('own', 'harness/own')
    await writeFile(join(own, 'file'), 'two')
    await git(own, 'commit', '--quiet', '-am', 'work')
    await git(repo, 'branch', 'topic')
    const topic = join(home, 'app', 'topic')
    await git(repo, 'worktree', 'add', '--quiet', topic, 'topic')
    const { removed } = await sweep()
    expect(removed.sort()).toEqual([own, topic].sort())
    expect(await branches()).toEqual(expect.arrayContaining(['harness/own', 'topic', 'main']))
  })

  it('keeps a detached worktree holding a commit no branch has, and sweeps the flat layout older builds made', async () => {
    const detached = join(home, 'app', 'detached')
    await git(repo, 'worktree', 'add', '--quiet', '--detach', detached, 'main')
    await writeFile(join(detached, 'file'), 'lost?')
    await git(detached, 'commit', '--quiet', '-am', 'only here')
    const flat = join(home, 'app-claude-2026-09-22-11-36-13-abcdef')
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'harness/app-claude-2026-09-22-11-36-13-abcdef', flat, 'main')
    expect((await sweep()).removed).toEqual([flat])
    expect(await exists(detached)).toBe(true)
    expect(await exists(home)).toBe(true)
  })

  // Lead, 10-30 (#2266): before Harness's ignore file ignored itself, it was untracked in every worktree, so none ever read as
  // clean; 19 piled up on one Mac. The exact file an older Harness wrote is upgraded first; anything else stays as it is.
  const OLDER = 'runtime/\nlegacy-AGENTS.md\n'
  const withHarnessFolder = async (path: string, ignore: string) => {
    await mkdir(join(path, '.harness', 'runtime'), { recursive: true })
    await writeFile(join(path, '.harness', 'runtime', 'SKILL.md'), 'session skill')
    await writeFile(join(path, '.harness', '.gitignore'), ignore)
  }

  it('removes an idle worktree whose only untracked file is the ignore file an older Harness wrote', async () => {
    const path = await add('older-ignore', 'harness/older-ignore')
    await withHarnessFolder(path, OLDER)
    expect((await sweep()).removed).toEqual([path])
    expect(await exists(path)).toBe(false)
  })

  // Review of #2266: the upgraded rule names only Harness's own file; an ignore file someone added deeper is still work.
  it('upgrades the older ignore file to a rule that still shows an ignore file someone added deeper', async () => {
    const path = await add('nested-ignore', 'harness/nested-ignore')
    await withHarnessFolder(path, OLDER)
    await mkdir(join(path, '.harness', 'mine'))
    await writeFile(join(path, '.harness', 'mine', '.gitignore'), 'scratch/\n')
    expect((await sweep()).removed).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(`${OLDER}/.gitignore\n`)
  })

  it('keeps a worktree whose ignore file someone edited, and leaves that file as it was', async () => {
    const path = await add('edited-ignore', 'harness/edited-ignore')
    await withHarnessFolder(path, `${OLDER}mine/\n`)
    expect((await sweep()).removed).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(`${OLDER}mine/\n`)
  })

  it('never rewrites a committed ignore file, which would be a change of its own', async () => {
    await mkdir(join(repo, '.harness'))
    await writeFile(join(repo, '.harness', '.gitignore'), OLDER)
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'ignore file committed by an earlier git add -A')
    const path = await add('committed-ignore', 'harness/committed-ignore')
    await writeFile(join(path, 'draft'), 'not committed')
    expect((await sweep()).removed).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(OLDER)
  })

  it('never writes through a Harness folder that points elsewhere', async () => {
    const path = await add('linked-ignore', 'harness/linked-ignore')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, '.gitignore'), OLDER)
    await symlink(outside, join(path, '.harness'))
    expect((await sweep()).removed).toEqual([])
    expect(await readFile(join(outside, '.gitignore'), 'utf8')).toBe(OLDER)
  })

  // One Mac, 10-28: a stopped worker's worktree held a skill folder its agent had copied in read-only. git deleted a third of
  // the folder, stopped there, and deleted the worktree's record anyway, so git and gh failed in what was left.
  // Folder permissions do not stop root or Windows from deleting.
  const permissions = process.platform !== 'win32' && process.getuid?.() !== 0
  const withReadOnlyFolder = async (path: string) => {
    await withHarnessFolder(path, '/*\n')
    const folder = join(path, '.harness', 'tools', 'skills', 'copied')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'SKILL.md'), 'copied in read-only')
    await chmod(folder, 0o555)
    return folder
  }

  it.runIf(permissions)('keeps, untouched and still a worktree, one holding a folder git could not empty, and says why', async () => {
    const path = await add('read-only', 'harness/read-only')
    const folder = await withReadOnlyFolder(path)
    try {
      expect(await sweep()).toEqual({ ...nothing, failed: ['WORKTREE_UNWRITABLE'] })
      expect(await exists(join(path, 'file')), 'nothing in it was deleted').toBe(true)
      expect(await git(path, 'status', '--porcelain')).toBe('')
      expect(await git(path, 'rev-parse', '--git-dir')).toContain('/.git/worktrees/')
      await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_UNWRITABLE'))
    } finally { await chmod(folder, 0o755) }
  })

  it.runIf(permissions)('puts the record back when git began removing the worktree and could not finish, and says so', async () => {
    const path = await add('half-removed', 'harness/half-removed')
    // A folder that turns read-only while the worktree is removed: the check above reads it as writable.
    await withHarnessFolder(path, '/*\n')
    const folder = join(path, '.harness', 'late')
    await mkdir(folder)
    await writeFile(join(folder, 'held'), 'held')
    await chmod(folder, 0o555)
    writable.folders.add(folder)
    try {
      // Review of package 6, 11-12: the weekly sweep said nothing of it.
      expect(await sweep()).toEqual({ ...nothing, failed: ['WORKTREE_NOT_REMOVED'] })
      expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'git still works in what is left').toBe('harness/half-removed')
      expect(await git(path, 'rev-parse', '--git-dir')).toContain('/.git/worktrees/')
      expect(await branches()).toContain('harness/half-removed')
    } finally { writable.folders.clear(); await chmod(folder, 0o755) }
  })

  // Security review 1 of #2417: git empties the folder in directory order, so its .git file often went before git reached
  // what it could not delete (8 of 30 trials), and the record alone written back left nothing pointing to it.
  it.runIf(permissions)('puts the .git file and the record back whichever folder git stops at', async () => {
    const held: string[] = []
    // Beside .git at the top, where the order of a folder's entries decides which goes first (on this Mac's APFS, stop-long
    // came before .git; on ext4 the order is the filesystem's own); ignored, so nothing reads as work.
    await writeFile(join(repo, '.git', 'info', 'exclude'), '/stop-*/\n')
    try {
      for (const name of ['stop-a', 'stop-g', 'stop-m', 'stop-s', 'stop-z', 'stop-0', 'stop-9', 'stop-_', 'stop-~', 'stop-long']) {
        const path = await add(`stops-${held.length}`, `harness/stops-${held.length}`)
        const folder = join(path, name)
        await mkdir(folder, { recursive: true })
        await writeFile(join(folder, 'held'), 'held')
        await chmod(folder, 0o555)
        held.push(folder); writable.folders.add(folder)
        await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_NOT_REMOVED'))
        expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), `git still works when it stopped at ${name}`).toBe(`harness/stops-${held.length - 1}`)
      }
    } finally { writable.folders.clear(); for (const folder of held) await chmod(folder, 0o755) }
  })

  // The same review: a locked file passes a check of folder permissions, and git stops at it.
  it.runIf(process.platform === 'darwin' && process.getuid?.() !== 0)('keeps a worktree, still one, when git stops at a locked file', async () => {
    const path = await add('locked', 'harness/locked')
    await mkdir(join(path, 'src'))
    await writeFile(join(path, 'src', 'kept'), 'locked')
    await git(path, 'add', '.')
    await git(path, 'commit', '--quiet', '-m', 'locked file')
    await exec('chflags', ['uchg', join(path, 'src', 'kept')])
    try {
      await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_NOT_REMOVED'))
      expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('harness/locked')
      expect(await branches()).toContain('harness/locked')
    } finally { await exec('chflags', ['nouchg', join(path, 'src', 'kept')]) }
  })

  // Security review 2 of #2417: the record also holds the refs only this worktree has.
  it.runIf(permissions)('writes back the refs only the worktree held with its record', async () => {
    const path = await add('own-refs', 'harness/own-refs')
    await git(path, 'update-ref', 'refs/worktree/mark', 'HEAD')
    await git(path, 'update-ref', 'refs/bisect/bad', 'HEAD')
    const before = await git(path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/worktree', 'refs/bisect')
    await withHarnessFolder(path, '/*\n')
    const folder = join(path, '.harness', 'late')
    await mkdir(folder)
    await writeFile(join(folder, 'held'), 'held')
    await chmod(folder, 0o555)
    writable.folders.add(folder)
    try {
      await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_NOT_REMOVED'))
      expect(await git(path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/worktree', 'refs/bisect')).toBe(before)
    } finally { writable.folders.clear(); await chmod(folder, 0o755) }
  })

  it('leaves a worktree alone that came into use while it was being checked', async () => {
    const path = await add('opened', 'harness/opened')
    expect(await sweepOne(path, later(), 0, () => false)).toBe(false)
    expect(await sweepOne(path, later(), 0, async () => false)).toBe(false)
    expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('harness/opened')
    expect(await exists(join(path, 'file'))).toBe(true)
  })

  // Review of package 6, 11-12: a worktree whose repository is gone was passed over in silence, twice a day for good.
  it('says by its code a worktree git cannot read, and goes on to the next', async () => {
    const broken = await add('broken', 'harness/broken')
    const next = await add('next', 'harness/next')
    await writeFile(join(broken, '.git'), `gitdir: ${join(root, 'gone', '.git', 'worktrees', 'broken')}\n`)
    expect(await sweep()).toEqual({ ...nothing, removed: [next], failed: ['WORKTREE_CHECK_FAILED'] })
    expect(await exists(join(broken, 'file'))).toBe(true)
  })

  // Review of package 6, 11-12: the sweep's git ran the program a repository's config names (core.fsmonitor), and its
  // hooks, which the daemon's other git never does (lib/gitProject.ts, lib/worktreeDeletion.ts). And a repository that tells
  // git to show no untracked files had a worktree with new work read as clean, which `git worktree remove` then removed too.
  it.runIf(process.platform !== 'win32')('runs no program the repository names, and sees untracked work whatever it says', async () => {
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'what this project ignores')
    const stopped = await add('stopped', 'harness/stopped')
    const clean = await add('clean', 'harness/clean')
    const fresh = await add('fresh', 'harness/fresh')
    await mkdir(join(stopped, 'node_modules'))
    await writeFile(join(stopped, 'node_modules', 'index.js'), 'built')
    await writeFile(join(fresh, 'new-work.md'), 'not added yet')
    const ran = join(root, 'ran'), program = join(root, 'program'), hook = join(repo, '.git', 'hooks', 'reference-transaction')
    for (const file of [program, hook]) {
      await writeFile(file, `#!/bin/sh\necho "$0" >> "${ran}"\nexit 1\n`)
      await chmod(file, 0o755)
    }
    await git(repo, 'config', 'core.fsmonitor', program)
    await git(repo, 'config', 'status.showUntrackedFiles', 'no')
    expect(await sweep({ inUse: [stopped] })).toEqual({ ...nothing, removed: [clean], freed: [join(stopped, 'node_modules')] })
    expect(await readFile(ran, 'utf8').catch(() => ''), 'a program the repository names').toBe('')
    expect(await readFile(join(fresh, 'new-work.md'), 'utf8')).toBe('not added yet')
  })

  // The allocator's package 6, 11-11. One Mac held 29 worktrees Harness made, 21.6 GB. A stopped harness kept 22 of them and
  // uncommitted work 10, so their checkouts stay; 4.7 GB of them was what an install or a build makes again.
  describe('freeing build output in the worktrees that stay', () => {
    const DAY = 24 * 3600_000
    const put = async (folder: string, ...files: string[]) => {
      for (const file of files) {
        await mkdir(dirname(join(folder, file)), { recursive: true })
        await writeFile(join(folder, file), file)
      }
    }
    const under = (tree: string, ...folders: string[]) => folders.map(folder => join(tree, folder))
    /** Git with the clock a reflog line is stamped from set to [at]. */
    const gitAt = (at: Date, cwd: string, ...args: string[]) => gitWith({ ...process.env, GIT_COMMITTER_DATE: at.toISOString() }, cwd, ...args)
    const gitDirOf = (tree: string) => git(tree, 'rev-parse', '--absolute-git-dir')
    beforeEach(async () => {
      await writeFile(join(repo, '.gitignore'), 'node_modules/\n.dart_tool/\nbuild/\n/web/.next/\ndist/\n.env\n.harness/\n*.log\n')
      await mkdir(join(repo, 'src'))
      await writeFile(join(repo, 'src', 'app.ts'), 'source')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '--quiet', '-m', 'what this project ignores')
    })

    it('frees node_modules, .dart_tool and .next where a stopped harness is, and keeps the checkout, build and all else', async () => {
      const tree = await add('stopped', 'harness/stopped')
      await put(tree, 'node_modules/pkg/index.js', 'app/.dart_tool/package_config.json', 'app/build/app.bin', 'web/.next/cache/page',
        '.env', '.harness/evidence/run.txt', 'dist/bundle.js', 'notes.md')
      await writeFile(join(tree, 'file'), 'not committed')
      const swept = await sweep({ inUse: [tree] })
      expect(swept).toEqual({ ...nothing, freed: under(tree, 'app/.dart_tool', 'node_modules', 'web/.next') })
      for (const gone of swept.freed) expect(await exists(gone), gone).toBe(false)
      // Review of package 6, 11-12: `build` is a name people give their own folders. This repository's firmware ignores
      // `build/` and keeps a pet's hand-drawn frames in a folder of that name.
      for (const kept of under(tree, 'app/build/app.bin', '.env', '.harness/evidence/run.txt', 'dist/bundle.js', 'notes.md')) {
        expect(await exists(kept), kept).toBe(true)
      }
      expect(await readFile(join(tree, 'file'), 'utf8')).toBe('not committed')
      expect(await git(tree, 'status', '--porcelain')).toBe('M file\n?? notes.md')
      expect(await branches()).toContain('harness/stopped')
    })

    it('frees it in a worktree nothing uses that stays for a commit only it has', async () => {
      const tree = join(home, 'app', 'detached')
      await git(repo, 'worktree', 'add', '--quiet', '--detach', tree, 'main')
      await writeFile(join(tree, 'file'), 'only here')
      await git(tree, 'commit', '--quiet', '-am', 'only here')
      await put(tree, 'node_modules/pkg/index.js')
      expect(await sweep()).toEqual({ ...nothing, freed: under(tree, 'node_modules') })
      expect(await git(tree, 'log', '-1', '--format=%s')).toBe('only here')
    })

    it('frees nothing where a harness is running, in the worktree or in a folder of it', async () => {
      const top = await add('running', 'harness/running')
      const inside = await add('inside', 'harness/inside')
      await put(top, 'node_modules/pkg/index.js')
      await put(inside, 'cli/node_modules/pkg/index.js')
      const cwds = [top, join(inside, 'cli')]
      expect(await sweep({ inUse: cwds, busy: () => cwds })).toEqual(nothing)
      expect(await exists(join(top, 'node_modules', 'pkg', 'index.js'))).toBe(true)
      expect(await exists(join(inside, 'cli', 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    it('frees it beside a worktree with a running harness whose name only begins the same', async () => {
      const stopped = await add('calm-river', 'harness/calm-river')
      const running = await add('calm-river-2', 'harness/calm-river-2')
      await put(stopped, 'node_modules/pkg/index.js')
      await put(running, 'node_modules/pkg/index.js')
      expect(await sweep({ inUse: [stopped, running], busy: () => [running] })).toEqual({ ...nothing, freed: under(stopped, 'node_modules') })
      expect(await exists(join(running, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    // Review of package 6, 11-12: a harness in a folder spelled another way read as no harness there, so a clean worktree
    // went whole, and the build output of one with work in it was freed under the running harness.
    const spellings: Array<[string, (tree: string) => Promise<string>]> = [
      ['as the disk names it', tree => realpath(tree)],
      ['through a link to it', async (tree) => { const link = join(root, 'link-to-tree'); await symlink(tree, link, 'junction'); return link }],
      ['through a link to a folder above it', async (tree) => {
        const link = join(root, 'link-to-harnesses')
        await symlink(join(root, 'harnesses'), link, 'junction')
        return join(link, 'worktrees', 'app', basename(tree))
      }],
      ...caseInsensitive ? [['in other letters', async (tree: string) => tree.replace(`${sep}worktrees${sep}`, `${sep}WorkTrees${sep}`)] as [string, (tree: string) => Promise<string>]] : [],
    ]
    it.each(spellings)('touches nothing where a harness runs in a folder spelled %s', async (_how, spell) => {
      const tree = await add('spelled', 'harness/spelled')
      await put(tree, 'node_modules/pkg/index.js')
      const cwd = await spell(tree)
      expect(await sweep({ inUse: [cwd], busy: () => [cwd] })).toEqual(nothing)
      expect(await exists(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    it('touches nothing where a harness runs when it reaches the worktrees through a link', async () => {
      const tree = await add('linked-root', 'harness/linked-root')
      await put(tree, 'node_modules/pkg/index.js')
      const link = join(root, 'home-link')
      await symlink(join(root, 'harnesses'), link, 'junction')
      const cwd = await realpath(tree)
      expect(await sweep({ root: link, inUse: [cwd], busy: () => [cwd] })).toEqual(nothing)
      expect(await exists(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    // Review of package 6, 11-12: the sweep takes minutes now, and it read the harnesses once, at its start.
    it('acts on no worktree a harness starts in while the sweep runs', async () => {
      const first = await add('first', 'harness/first')
      const second = await add('second', 'harness/second')
      await put(first, 'node_modules/pkg/index.js')
      await put(second, 'node_modules/pkg/index.js')
      // Made last, so the longest unused go first and git would remove this one after the sweep acted on another.
      const clean = await add('clean', 'harness/clean')
      const trees = [first, second, clean]
      const acted = (tree: string) => tree === clean ? !existsSync(clean) : !existsSync(join(tree, 'node_modules'))
      // Once the sweep has acted on one of them, a harness starts in each of the others.
      const busy = () => trees.some(acted) ? trees.filter(tree => !acted(tree)) : []
      const swept = await sweep({ inUse: [first, second], busy })
      expect(swept.removed.length + swept.freed.length).toBe(1)
      expect(trees.filter(acted)).toHaveLength(1)
    })

    // A worktree of a bare repository is not one Harness made: the sweep never removes it, and frees nothing in it.
    it('leaves a checkout alone that is not a linked worktree of a repository with files', async () => {
      const bare = join(root, 'bare.git'), tree = join(home, 'app', 'of-bare')
      await git(root, 'clone', '--quiet', '--bare', repo, bare)
      await git(bare, 'worktree', 'add', '--quiet', '-b', 'harness/of-bare', tree, 'main')
      await put(tree, 'node_modules/pkg/index.js')
      expect(await sweep()).toEqual(nothing)
      expect(await exists(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    // Review of package 6, 11-12: "used" read git's own writes alone. A person or an agent at work there writes files.
    it.each<[string, (tree: string, recent: Date) => Promise<unknown>]>([
      ['something was made at its top', (tree, recent) => utimes(tree, recent, recent)],
      ['its index was written', async (tree, recent) => utimes(join(await gitDirOf(tree), 'index'), recent, recent)],
      ['its HEAD was written', async (tree, recent) => utimes(join(await gitDirOf(tree), 'HEAD'), recent, recent)],
      // `git reset --soft` and a ref moved by hand write neither HEAD nor the index: only the reflog says HEAD moved.
      ['its HEAD moved', (tree, recent) => gitAt(recent, tree, 'commit', '--quiet', '--allow-empty', '-m', 'yesterday')],
      ['a tracked file in a folder was edited and not staged', async (tree, recent) => {
        await writeFile(join(tree, 'src', 'app.ts'), 'edited')
        await utimes(join(tree, 'src', 'app.ts'), recent, recent)
      }],
      ['a new file was made in a folder', async (tree, recent) => {
        await writeFile(join(tree, 'src', 'new.ts'), 'new')
        await utimes(join(tree, 'src', 'new.ts'), recent, recent)
      }],
      ['a test run wrote a log git ignores', async (tree, recent) => {
        await writeFile(join(tree, 'src', 'test.log'), 'ran')
        await utimes(join(tree, 'src', 'test.log'), recent, recent)
      }],
      ['an install wrote one build folder', (tree, recent) => utimes(join(tree, 'node_modules'), recent, recent)],
      // Review of package 6, round 3: git listed a folder it does not track yet as one entry, by the folder's own time.
      ['a file deep in a folder git does not track yet was written', async (tree, recent) => {
        await put(tree, 'newwork/a/b/old.ts')
        await writeFile(join(tree, 'newwork', 'a', 'b', 'new.ts'), 'new work')
        await utimes(join(tree, 'newwork', 'a', 'b', 'new.ts'), recent, recent)
      }],
      // Nobody can say when a file that is gone went: it counts as now.
      ['a tracked file was deleted', (tree) => rm(join(tree, 'src', 'app.ts'))],
    ])('frees nothing in a worktree used within the week: %s', async (_what, use) => {
      const tree = await add('used', 'harness/used')
      await put(tree, 'node_modules/pkg/index.js', 'web/.next/cache/page')
      await use(tree, new Date(later() - DAY))
      expect(await sweep({ inUse: [tree] })).toEqual(nothing)
      expect(await exists(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
      expect(await exists(join(tree, 'web', '.next', 'cache', 'page'))).toBe(true)
    })

    /** A worktree where every time the sweep reads is a month old, as when nobody has worked there since. */
    const monthOld = async (name: string, ...files: string[]) => {
      const tree = join(home, 'app', name), old = new Date(Date.now() - 30 * DAY)
      await gitAt(old, repo, 'worktree', 'add', '--quiet', '-b', `harness/${name}`, tree, 'main')
      await put(tree, ...files)
      const gitDir = await gitDirOf(tree)
      for (const file of [...under(tree, ...files.map(file => file.split('/')[0]!)), tree, join(gitDir, 'HEAD'), join(gitDir, 'index')]) await utimes(file, old, old)
      return tree
    }

    // One Mac, 11-10: `git gc`, which git runs by itself after fetches, wrote the reflog of 15 worktrees of one repository again
    // in one second, and of 85 of another's 88. Read as use, that restarted the idle week for every worktree, worked in or not.
    it('frees build output though git gc wrote the reflog again today', async () => {
      const tree = await monthOld('collected', 'node_modules/pkg/index.js')
      await git(repo, 'gc', '--quiet')
      expect(await sweep({ inUse: [tree], now: Date.now() })).toEqual({ ...nothing, freed: under(tree, 'node_modules') })
    })

    it('frees nothing while the clock reads earlier than the worktree was last written', async () => {
      const tree = await monthOld('clock-behind', 'node_modules/pkg/index.js')
      expect(await sweep({ inUse: [tree], now: Date.now() - 365 * DAY })).toEqual(nothing)
      expect(await exists(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    // Review of package 6, 11-12: git lists a folder whole when everything in it is ignored, by whatever rule. Here no rule
    // matches `deploy/build`, `gen/.next` or `lib/node_modules`, only the files in them: they are someone's, and they stay.
    it('frees only a folder a rule matches itself, never one whose files are each ignored by a rule of their own', async () => {
      await writeFile(join(repo, '.gitignore'), '/node_modules/\n*.log\n.env\n.env.*\n*.pem\n*.sqlite\n/web/.next/\n')
      await git(repo, 'commit', '--quiet', '-am', 'only these')
      const tree = await add('contents', 'harness/contents')
      const theirs = ['deploy/build/.env', 'deploy/build/prod.pem', 'data/build/customers.sqlite', 'gen/.next/run.log', 'lib/node_modules/.env.local']
      await put(tree, ...theirs, 'node_modules/pkg/index.js')
      expect(await git(tree, 'check-ignore', '-q', '--', 'gen/.next').then(() => 'ignored', () => 'not ignored')).toBe('not ignored')
      expect(await sweep({ inUse: [tree] })).toEqual({ ...nothing, freed: under(tree, 'node_modules') })
      for (const kept of theirs) expect(await exists(join(tree, kept)), kept).toBe(true)
    })

    it('frees a folder a rule matches inside one no rule matches, and leaves the outer one', async () => {
      const tree = await add('inside', 'harness/inside')
      await put(tree, 'gen/.next/run.log', 'gen/.next/web/node_modules/pkg/index.js', 'node_modules/pkg/index.js')
      expect(await sweep({ inUse: [tree] })).toEqual({ ...nothing, freed: under(tree, 'gen/.next/web/node_modules', 'node_modules') })
      expect(await exists(join(tree, 'gen', '.next', 'run.log'))).toBe(true)
    })

    // Review of package 6, 11-12: a bare repository has no `.git` of its own; HEAD, objects and refs side by side are one.
    it('keeps a folder with a tracked file in it, a link, and one holding a repository or a checkout of its own', async () => {
      const tree = await add('guarded', 'harness/guarded')
      const outside = join(root, 'shared-modules')
      await put(outside, 'pkg/index.js')
      await put(tree, 'tracked/node_modules/kept.txt', 'tracked/node_modules/out.o', 'cloned/node_modules/dep/src.c',
        'bare/node_modules/mirror/readme', 'plain/node_modules/pkg/index.js')
      await git(tree, 'add', '-f', 'tracked/node_modules/kept.txt')
      await git(tree, 'commit', '--quiet', '-m', 'a file kept in a build folder')
      await mkdir(join(tree, 'linked'))
      await symlink(outside, join(tree, 'linked', 'node_modules'), 'junction')
      await git(join(tree, 'cloned', 'node_modules', 'dep'), 'init', '--quiet')
      await git(join(tree, 'bare', 'node_modules', 'mirror'), 'init', '--quiet', '--bare', 'app.git')
      await git(repo, 'worktree', 'add', '--quiet', '-b', 'inner', join(tree, 'inner', '.dart_tool', 'checkout'), 'main')
      expect(await sweep({ inUse: [tree] })).toEqual({ ...nothing, freed: under(tree, 'plain/node_modules') })
      for (const kept of [...under(tree, 'tracked/node_modules/kept.txt', 'tracked/node_modules/out.o', 'cloned/node_modules/dep/src.c',
        'bare/node_modules/mirror/app.git/HEAD', 'inner/.dart_tool/checkout/file', 'linked/node_modules'), join(outside, 'pkg', 'index.js')]) {
        expect(await exists(kept), kept).toBe(true)
      }
    })

    // `npm link` puts a link to someone's own checkout in node_modules: a link on a Mac or Linux, a junction on Windows.
    it('removes a link in a build folder, never what it points to', async () => {
      const tree = await add('npm-link', 'harness/npm-link')
      const theirs = join(root, 'their-package')
      await put(theirs, 'index.js', 'src/lib.ts')
      await put(tree, 'node_modules/pkg/index.js')
      await symlink(theirs, join(tree, 'node_modules', 'their-package'), 'junction')
      expect(await sweep({ inUse: [tree] })).toEqual({ ...nothing, freed: under(tree, 'node_modules') })
      expect(await exists(join(theirs, 'src', 'lib.ts'))).toBe(true)
    })

    // Review of package 6, 11-12: Git for Windows may walk into a junction as a folder, and then `vendor\node_modules` would
    // be removed where the junction points, outside the worktree.
    it('never frees build output it reaches through a link or a junction', async () => {
      const tree = await add('junction', 'harness/junction')
      const shared = join(root, 'shared')
      await put(shared, 'node_modules/kept/index.js', 'src/lib.ts')
      await symlink(shared, join(tree, 'vendor'), 'junction')
      await put(tree, 'node_modules/pkg/index.js')
      expect(await sweep({ inUse: [tree] })).toEqual({ ...nothing, freed: under(tree, 'node_modules') })
      expect(await exists(join(shared, 'node_modules', 'kept', 'index.js'))).toBe(true)
    })

    it('never removes through a folder that became a link after git listed it', async () => {
      const tree = await add('swapped', 'harness/swapped')
      const elsewhere = join(root, 'elsewhere')
      await put(elsewhere, 'node_modules/kept/index.js')
      await put(tree, 'vendor/node_modules/pkg/index.js')
      const folder = join(tree, 'vendor', 'node_modules')
      looked.at = async (file) => {
        if (file !== folder) return
        looked.at = null
        await rm(join(tree, 'vendor'), { recursive: true })
        await symlink(elsewhere, join(tree, 'vendor'), 'junction')
      }
      try {
        expect(await sweep({ inUse: [tree] })).toEqual(nothing)
      } finally { looked.at = null }
      expect(await exists(join(elsewhere, 'node_modules', 'kept', 'index.js'))).toBe(true)
    })

    // Review of package 6, round 3: a folder reached through a link that points inside the worktree was removed where the link
    // points, here a node_modules holding a tracked file and a change nobody committed.
    it('never removes through a folder that became a link to another folder of the worktree after git listed it', async () => {
      await mkdir(join(repo, 'src', 'node_modules'), { recursive: true })
      await writeFile(join(repo, 'src', 'node_modules', 'fixture.js'), 'committed\n')
      await git(repo, 'add', '-f', 'src/node_modules/fixture.js')
      await git(repo, 'commit', '--quiet', '-m', 'a tracked fixture in a node_modules')
      const tree = await add('inside', 'harness/inside')
      await put(tree, 'vendor/node_modules/pkg/index.js')
      await writeFile(join(tree, 'src', 'node_modules', 'fixture.js'), 'committed\nmy change, not committed\n')
      const changed = new Date(Date.now() - 30 * DAY)
      await utimes(join(tree, 'src', 'node_modules', 'fixture.js'), changed, changed)
      const folder = join(tree, 'vendor', 'node_modules')
      looked.at = async (file) => {
        if (file !== folder) return
        looked.at = null
        await rm(join(tree, 'vendor'), { recursive: true })
        await symlink(join(tree, 'src'), join(tree, 'vendor'), 'junction')
      }
      try {
        expect(await sweep({ inUse: [tree] })).toEqual(nothing)
      } finally { looked.at = null }
      expect(await readFile(join(tree, 'src', 'node_modules', 'fixture.js'), 'utf8')).toBe('committed\nmy change, not committed\n')
    })

    // The same review: Git for Windows takes only a symbolic link for a link, so it walks a junction as a folder and lists
    // `web/node_modules/` through `web -> packages/web`. Elsewhere git lists a link as one entry, and this holds as it is.
    it('never frees build output through a junction to another folder of the worktree', async () => {
      await mkdir(join(repo, 'packages', 'web', 'node_modules'), { recursive: true })
      await writeFile(join(repo, 'packages', 'web', 'node_modules', 'fixture.js'), 'committed\n')
      await git(repo, 'add', '-f', 'packages/web/node_modules/fixture.js')
      await git(repo, 'commit', '--quiet', '-m', 'a tracked fixture in a package\'s node_modules')
      const tree = await add('junction-inside', 'harness/junction-inside')
      await writeFile(join(tree, 'packages', 'web', 'node_modules', 'fixture.js'), 'committed\nmy change, not committed\n')
      await put(tree, 'packages/web/node_modules/pkg/index.js')
      await symlink(join(tree, 'packages', 'web'), join(tree, 'web'), 'junction')
      expect((await sweep({ inUse: [tree] })).freed).toEqual([])
      expect(await readFile(join(tree, 'packages', 'web', 'node_modules', 'fixture.js'), 'utf8')).toBe('committed\nmy change, not committed\n')
    })

    // Review of package 6, round 3: with core.ignorecase=false on a disk that ignores case, git reads `lib/node_modules/` on
    // the disk as no folder of its index, whose file it spells `lib/Node_Modules/`, and lists it as ignored whole.
    it.runIf(caseInsensitive)('keeps a build folder holding a file the index spells in other letters', async () => {
      const tree = await add('spelled-index', 'harness/spelled-index')
      await git(repo, 'config', 'core.ignorecase', 'false')
      await put(tree, 'lib/node_modules/fixture.js')
      await git(tree, 'add', '-f', 'lib/Node_Modules/fixture.js')
      await git(tree, 'commit', '--quiet', '-m', 'a fixture, its folder spelled in other letters')
      await writeFile(join(tree, 'lib', 'node_modules', 'fixture.js'), 'committed\nmy change, not committed\n')
      expect(await git(tree, 'status', '--porcelain', '--ignored=matching')).toContain('!! lib/node_modules/')
      expect((await sweep({ inUse: [tree] })).freed).toEqual([])
      expect(await readFile(join(tree, 'lib', 'node_modules', 'fixture.js'), 'utf8')).toBe('committed\nmy change, not committed\n')
    })

    it('never removes a build folder that became a link after git listed it, though it points inside the worktree', async () => {
      const tree = await add('relinked', 'harness/relinked')
      await put(tree, 'node_modules/pkg/index.js')
      const folder = join(tree, 'node_modules')
      looked.at = async (file) => {
        if (file !== folder) return
        looked.at = null
        await rm(folder, { recursive: true })
        await symlink(join(tree, 'src'), folder, 'junction')
      }
      try {
        expect(await sweep({ inUse: [tree] })).toEqual(nothing)
      } finally { looked.at = null }
      expect(await readFile(join(tree, 'src', 'app.ts'), 'utf8')).toBe('source')
    })

    // Review of package 6, round 3: a harness that starts while a big folder goes would install into it as it is emptied.
    it('stops removing a folder within a few hundred entries once a harness starts there, and says so', async () => {
      const tree = await add('started', 'harness/started')
      await put(tree, 'web/.next/cache/page')
      for (let at = 0; at < 20; at++) {
        await mkdir(join(tree, 'node_modules', `pkg-${at}`), { recursive: true })
        for (let file = 0; file < 100; file++) await writeFile(join(tree, 'node_modules', `pkg-${at}`, `file-${file}.js`), '')
      }
      const order = await readdir(join(tree, 'node_modules'))
      // The harness starts once the first package went.
      const busy = () => existsSync(join(tree, 'node_modules', order[0]!)) ? [] : [tree]
      const swept = await sweep({ inUse: [tree], busy })
      expect(swept).toEqual({ ...nothing, freed: [], failed: ['BUILD_OUTPUT_STOPPED'] })
      expect((await readdir(join(tree, 'node_modules'))).length, 'what is left of node_modules').toBeGreaterThan(10)
      expect(await exists(join(tree, 'web', '.next', 'cache', 'page')), 'nothing more is removed').toBe(true)
    })

    it.runIf(permissions)('leaves a build folder whole when a folder in it could not be emptied', async () => {
      const tree = await add('held', 'harness/held')
      await put(tree, 'node_modules/a/index.js', 'node_modules/z/held/file')
      const folder = join(tree, 'node_modules', 'z', 'held')
      await chmod(folder, 0o555)
      try {
        expect(await sweep({ inUse: [tree] })).toEqual(nothing)
        expect(await exists(join(tree, 'node_modules', 'a', 'index.js')), 'nothing in it was deleted').toBe(true)
      } finally { await chmod(folder, 0o755) }
    })

    // Review of package 6, 11-12: Node's own recursive removal went on deleting after it had failed, and held every path it had
    // not reached in memory. One entry at a time stops where it cannot go on.
    it.runIf(permissions)('stops at the first entry it cannot remove, says so by its code, and frees the other folders', async () => {
      const tree = await add('late', 'harness/late')
      await put(tree, ...Array.from({ length: 12 }, (_, at) => `node_modules/pkg-${at}/index.js`), 'web/.next/cache/page')
      // Removed in the order the disk lists them. The middle one turns read-only while it is removed: the check before reads
      // it as writable.
      const order = await readdir(join(tree, 'node_modules'))
      const held = join(tree, 'node_modules', order[6]!)
      await chmod(held, 0o555)
      writable.folders.add(held)
      try {
        expect(await sweep({ inUse: [tree] })).toEqual({ ...nothing, freed: under(tree, 'web/.next'), failed: ['BUILD_OUTPUT_STUCK:EACCES'] })
        expect(await exists(join(held, 'index.js'))).toBe(true)
        for (const after of order.slice(7)) expect(await exists(join(tree, 'node_modules', after, 'index.js')), `${after} is never reached`).toBe(true)
      } finally { writable.folders.clear(); await chmod(held, 0o755) }
    })

    // Review of package 6, 11-12: on Windows nothing says beforehand that a file is held open; the removal stops at it.
    it.runIf(process.platform === 'win32')('says a build folder it could not finish when a file in it is held open, and frees the rest', async () => {
      const tree = await add('open', 'harness/open')
      await put(tree, 'node_modules/held/addon.node', 'web/.next/cache/page')
      // Held as a running program holds its own file, shared with nobody: UV_FS_O_EXLOCK (libuv's include/uv/win.h).
      const handle = await open(join(tree, 'node_modules', 'held', 'addon.node'), constants.O_RDONLY | 0x10000000)
      try {
        const swept = await sweep({ inUse: [tree] })
        expect(swept.freed).toEqual(under(tree, 'web/.next'))
        expect(swept.failed).toEqual([expect.stringMatching(/^BUILD_OUTPUT_STUCK/)])
        expect(await exists(join(tree, 'node_modules', 'held', 'addon.node'))).toBe(true)
      } finally { await handle.close() }
    })

    // Review of package 6, 11-12: one sweep had no bound; 60 idle worktrees cost 4.8 to 5.7 s of reads.
    it('frees build output in so many worktrees a sweep, the longest unused first; the rest wait for the next sweep', async () => {
      // The longest unused of all, with nothing to free: it does not count.
      const empty = await monthOld('empty')
      await monthOld('one', 'node_modules/pkg/index.js')
      await monthOld('two', 'node_modules/pkg/index.js')
      // The one the disk lists first was used more lately: the order the sweep finds them in is not the order it frees them in.
      const [newer, older] = (await readdir(join(home, 'app'))).filter(name => name !== 'empty').map(name => join(home, 'app', name)) as [string, string]
      for (const [tree, days] of [[newer, 10], [older, 20]] as const) await utimes(tree, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY))
      const inUse = [empty, newer, older], limit = { freed: 1, ms: 600_000 }
      expect(await sweep({ inUse, limit })).toEqual({ ...nothing, freed: under(older, 'node_modules'), left: 1 })
      expect((await sweep({ inUse, limit })).freed).toEqual(under(newer, 'node_modules'))
    })

    it('begins no new worktree once a sweep has run its time, and always does one', async () => {
      const first = await monthOld('first', 'node_modules/pkg/index.js')
      const second = await monthOld('second', 'node_modules/pkg/index.js')
      const swept = await sweep({ inUse: [first, second], limit: { freed: 10, ms: 0 } })
      expect(swept.freed).toHaveLength(1)
      expect(swept.left).toBe(1)
    })

    // Git writes its paths with a slash on every platform; the folder is the platform's own. No Windows computer runs this
    // suite by itself, so its paths are checked here too.
    it('finds build output in git\'s listing on Windows as on a Mac or Linux', () => {
      const listing = ['!! cli/node_modules/', '!! desktop/.dart_tool/', '!! desktop/build/', '!! web/.next/', '!! .env', '!! dist/',
        '?? notes/node_modules/', '!! cli/node_modules', '!! gen/out.log', '!! my build/', ' M src/app.ts',
        // A rename is followed by the path it came from, which is no entry of its own.
        'R  moved/app.ts', '!! looks/like/node_modules/', ''].join('\0')
      expect(buildOutputIn('C:\\h\\worktrees\\app\\calm-river', listing, win32.join)).toEqual([
        'C:\\h\\worktrees\\app\\calm-river\\cli\\node_modules', 'C:\\h\\worktrees\\app\\calm-river\\desktop\\.dart_tool',
        'C:\\h\\worktrees\\app\\calm-river\\web\\.next',
      ])
      expect(buildOutputIn('/h/worktrees/app/calm-river', listing, posix.join)).toEqual([
        '/h/worktrees/app/calm-river/cli/node_modules', '/h/worktrees/app/calm-river/desktop/.dart_tool', '/h/worktrees/app/calm-river/web/.next',
      ])
    })
  })

  it('ignores a missing worktrees folder and checkouts that are not worktrees', async () => {
    expect(await sweep({ root: join(root, 'nothing') })).toEqual(nothing)
    await mkdir(join(home, 'app', 'plain'), { recursive: true })
    await git(repo, 'clone', '--quiet', repo, join(home, 'clone'))
    expect((await sweep()).removed).toEqual([])
  })
})
