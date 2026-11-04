import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUDDY_COPIES_FILE, buddyProjectsOf, folderName, prepareBuddyHome, pruneBuddyHome, buddyHomeDue, refreshBuddyHome, removeBuddyHome, trustBuddyHome } from './buddyHome.js'

// A person's one Buddy's folder (spec 2026-10-31-one-buddy-per-swarm, Folder): one worktree per project checkout on the
// machine, each from its own checkout, and a lost project's out before the next turn. Real git, in a throwaway folder.
const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString()

/** A checkout with one committed file saying which project it is. */
function checkout(root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'WHO'), `${name}\n`)
  git(dir, 'add', 'WHO')
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'first')
  return dir
}
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-home-'))
  made.push(dir)
  return dir
}

describe('a person\'s one Buddy\'s folder', () => {
  // Task #2832: a Codex Buddy runs too, and would sit at Codex's own folder question in a terminal no Swarm view shows.
  it('answers Claude Code\'s and Codex\'s folder question for it, and leaves any other engine to ask', async () => {
    const claude = root(), codex = root(), home = join(root(), 'home'), config = join(claude, '.claude.json'), toml = join(codex, 'config.toml')
    mkdirSync(home)
    writeFileSync(config, '{}')
    writeFileSync(toml, '')
    const moved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }
    process.env.CLAUDE_CONFIG_DIR = claude
    process.env.CODEX_HOME = codex
    try {
      await trustBuddyHome(home, 'opencode')
      expect([readFileSync(config, 'utf8'), readFileSync(toml, 'utf8')]).toEqual(['{}', ''])
      await trustBuddyHome(home, 'claude')
      const saved = Object.values(JSON.parse(readFileSync(config, 'utf8')).projects as Record<string, { hasTrustDialogAccepted: boolean }>)
      expect(saved.map(p => p.hasTrustDialogAccepted)).toEqual([true])
      await trustBuddyHome(home, 'codex')
      expect(readFileSync(toml, 'utf8')).toMatch(/trust_level = "trusted"/)
      expect(readFileSync(toml, 'utf8')).toContain(home.split('/').pop()!)
    } finally {
      if (moved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = moved.claude
      if (moved.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = moved.codex
    }
  })

  it('holds a worktree of each project checkout on this machine, each its own project\'s, and names the ones not here', async () => {
    const r = root(), web = checkout(r, 'web-src'), app = checkout(r, 'app-src'), home = join(r, 'home')
    const result = await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }, { id: 'app', name: 'App', cwd: app },
      { id: 'far', name: 'Far', cwd: join(r, 'not-cloned') }])
    expect(result).toEqual({ ready: ['Web', 'App'], missing: ['Far'] })
    expect(readFileSync(join(home, 'projects', 'Web', 'WHO'), 'utf8')).toBe('web-src\n')
    expect(readFileSync(join(home, 'projects', 'App', 'WHO'), 'utf8')).toBe('app-src\n')
    expect(existsSync(join(home, 'projects', 'Far'))).toBe(false)
    // Made again, it keeps what it made.
    expect(await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }])).toEqual({ ready: ['Web'], missing: [] })
  })

  it('takes out a project its person no longer reads, and only that one', async () => {
    const r = root(), web = checkout(r, 'web-src'), secret = checkout(r, 'secret-src'), home = join(r, 'home')
    await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }, { id: 'secret', name: 'Secret', cwd: secret }])
    expect(await pruneBuddyHome(home, new Set(['web']))).toEqual(['Secret'])
    expect(existsSync(join(home, 'projects', 'Secret'))).toBe(false)
    expect(existsSync(join(home, 'projects', 'Web', 'WHO'))).toBe(true)
    // Its checkout no longer lists the worktree.
    expect(git(secret, 'worktree', 'list')).not.toContain(join(home, 'projects', 'Secret'))
    expect(await pruneBuddyHome(home, new Set(['web']))).toEqual([])
  })

  it('goes whole with its Buddy, worktrees included, read-only files too', async () => {
    const r = root(), web = checkout(r, 'web-src'), home = join(r, 'home')
    await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }])
    execFileSync('chmod', ['-R', 'a-w', join(home, 'projects', 'Web', 'WHO')])
    await removeBuddyHome(home)
    expect(existsSync(home)).toBe(false)
    expect(git(web, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
  })

  it('drops at the start a project the new list no longer names, before the Buddy\'s first turn', async () => {
    const r = root(), web = checkout(r, 'web-src'), secret = checkout(r, 'secret-src'), home = join(r, 'home')
    await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }, { id: 'secret', name: 'Secret', cwd: secret }])
    await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }])
    expect(existsSync(join(home, 'projects', 'Secret'))).toBe(false)
    expect(existsSync(join(home, 'projects', 'Web', 'WHO'))).toBe(true)
  })

  it('never removes outside its projects folder, whatever its list says (security review 1 of #2436)', async () => {
    const r = root(), web = checkout(r, 'web-src'), home = join(r, 'home')
    await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }])
    const outside = join(r, 'keep-me')
    mkdirSync(outside)
    writeFileSync(join(outside, 'file'), 'mine')
    writeFileSync(join(home, '.buddy-projects.json'), JSON.stringify([{ id: 'web', name: 'Web', dir: 'Web' },
      { id: 'evil', name: 'Evil', dir: '../../keep-me' }, { id: 'dot', name: 'Dot', dir: '..' }]))
    await pruneBuddyHome(home, new Set(['web']))
    await removeBuddyHome(home)
    expect(readFileSync(join(outside, 'file'), 'utf8')).toBe('mine')
  })

  it('never follows a link in its projects folder: another worktree a project folder links to is left whole (security re-check 2 of #2436)', async () => {
    const r = root(), web = checkout(r, 'web-src'), other = checkout(r, 'other-src'), home = join(r, 'home')
    await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }])
    // Another worktree, someone else's, and the Web folder replaced by a link to it.
    const theirs = join(r, 'their-worktree')
    git(other, 'worktree', 'add', '--detach', '--', theirs, 'HEAD')
    rmSync(join(home, 'projects', 'Web'), { recursive: true, force: true })
    symlinkSync(theirs, join(home, 'projects', 'Web'))
    await pruneBuddyHome(home, new Set())
    expect(readFileSync(join(theirs, 'WHO'), 'utf8')).toBe('other-src\n')
    expect(git(other, 'worktree', 'list')).toContain(theirs)
    expect(existsSync(join(home, 'projects', 'Web'))).toBe(false)
    // Made again, a link in a project's place is replaced by its own worktree, never kept.
    const again = join(r, 'home2')
    await prepareBuddyHome(again, [{ id: 'web', name: 'Web', cwd: web }])
    rmSync(join(again, 'projects', 'Web'), { recursive: true, force: true })
    symlinkSync(theirs, join(again, 'projects', 'Web'))
    await prepareBuddyHome(again, [{ id: 'web', name: 'Web', cwd: web }])
    expect(readFileSync(join(again, 'projects', 'Web', 'WHO'), 'utf8')).toBe('web-src\n')
    expect(readFileSync(join(theirs, 'WHO'), 'utf8')).toBe('other-src\n')
  })

  it('refuses a Buddy folder whose projects folder, or which itself, is a link: nothing outside it is removed or made (security review 1 re-check of #2436)', async () => {
    const r = root(), web = checkout(r, 'web-src'), other = checkout(r, 'other-src')
    // Someone else's worktree, and a folder of its own beside it.
    const theirs = join(r, 'their-worktree')
    git(other, 'worktree', 'add', '--detach', '--', theirs, 'HEAD')
    const elsewhere = join(r, 'elsewhere')
    mkdirSync(join(elsewhere, 'Web'), { recursive: true })
    symlinkSync(theirs, join(elsewhere, 'Web', 'x'))
    // projects/ is a link to a folder holding a "Web" folder; and a Buddy folder that is itself a link.
    const home = join(r, 'home')
    await prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }])
    rmSync(join(home, 'projects'), { recursive: true, force: true })
    git(web, 'worktree', 'prune')
    symlinkSync(elsewhere, join(home, 'projects'))
    await expect(pruneBuddyHome(home, new Set())).rejects.toThrow('BUDDY_FOLDER_NOT_OWN')
    await expect(prepareBuddyHome(home, [{ id: 'web', name: 'Web', cwd: web }])).rejects.toThrow('BUDDY_FOLDER_NOT_OWN')
    await removeBuddyHome(home)
    const linked = join(r, 'linked-home')
    symlinkSync(elsewhere, linked)
    await expect(prepareBuddyHome(linked, [{ id: 'web', name: 'Web', cwd: web }])).rejects.toThrow('BUDDY_FOLDER_NOT_OWN')
    await removeBuddyHome(linked)
    expect(existsSync(join(elsewhere, 'Web'))).toBe(true)
    expect(readFileSync(join(theirs, 'WHO'), 'utf8')).toBe('other-src\n')
    expect(existsSync(home)).toBe(false)
    expect(existsSync(linked)).toBe(false)
    expect(existsSync(join(elsewhere, 'projects'))).toBe(false)
  })

  it('names folders safely and apart, and reads only well-formed projects from a start', () => {
    expect(folderName('../etc', new Set())).toBe('etc')
    expect(folderName('.hidden', new Set())).toBe('hidden')
    expect(folderName('Web App', new Set(['Web-App']))).toBe('Web-App-2')
    expect(folderName('///', new Set())).toBe('project')
    expect(buddyProjectsOf({ buddyProjects: [{ id: 'a', name: 'A', cwd: '/x' }, { id: '../b', name: 'B', cwd: '/y' }, { id: 'c', name: 'C', cwd: 'relative' }] }))
      .toEqual([{ id: 'a', name: 'A', cwd: '/x' }])
  })
})

// Scholes, 11-02: the Buddy kept saying a merged button was "not in my copy of the code yet". Real git: a bare origin, the
// person's clone of it, and new commits pushed from another clone.
// Each test here runs dozens of real git commands: a busy machine takes more than the default 5 s (seen with a hook added).
describe('a Buddy\'s copy of a project follows its default branch', { timeout: 30_000 }, () => {
  const commit = (dir: string, file: string, text: string) => {
    writeFileSync(join(dir, file), text)
    git(dir, 'add', file)
    git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', file)
  }
  /** origin, the person's clone, and a teammate's clone that pushes. */
  function project(r: string) {
    const first = checkout(r, 'first'), origin = join(r, 'origin.git')
    git(r, 'clone', '-q', '--bare', first, origin)
    const clone = join(r, 'clone'), teammate = join(r, 'teammate')
    git(r, 'clone', '-q', origin, clone)
    git(r, 'clone', '-q', origin, teammate)
    return { origin, clone, teammate, home: join(r, 'home'), web: [{ id: 'web', name: 'Web', cwd: clone }] }
  }
  const advance = (teammate: string, file = 'NEW', text = 'new\n') => { commit(teammate, file, text); git(teammate, 'push', '-q', 'origin', 'main') }
  const head = (dir: string) => git(dir, 'rev-parse', 'HEAD').trim()
  const copy = (home: string) => join(home, 'projects', 'Web')
  const copies = (home: string) => readFileSync(join(home, BUDDY_COPIES_FILE), 'utf8')

  it('moves a Buddy home made at an old commit to the new origin head on the next prepare, and says where it is', async () => {
    const p = project(root())
    await prepareBuddyHome(p.home, p.web)
    const old = head(copy(p.home))
    expect(copies(p.home)).toContain(`Web: at ${old.slice(0, 7)}`)
    advance(p.teammate)
    await prepareBuddyHome(p.home, p.web)
    expect(head(copy(p.home))).toBe(head(p.teammate))
    expect(readFileSync(join(copy(p.home), 'NEW'), 'utf8')).toBe('new\n')
    // Still detached, as a Buddy holds no branch.
    expect(() => git(copy(p.home), 'symbolic-ref', '--quiet', 'HEAD')).toThrow()
    expect(copies(p.home)).toContain(`Web: at ${head(p.teammate).slice(0, 7)}`)
    expect(copies(p.home)).toContain('latest default branch')
  })

  it('makes a new copy at the default branch too, not at wherever its person\'s checkout stands', async () => {
    const p = project(root())
    git(p.clone, 'checkout', '-q', '-b', 'my-private-work')
    commit(p.clone, 'PRIVATE', 'mine\n')
    await prepareBuddyHome(p.home, p.web)
    expect(existsSync(join(copy(p.home), 'PRIVATE'))).toBe(false)
    expect(head(copy(p.home))).toBe(head(p.teammate))
  })

  it('leaves the person\'s checkout as it is: HEAD, branches, working files, tags, FETCH_HEAD and hooks', async () => {
    const p = project(root())
    git(p.clone, 'checkout', '-q', '-b', 'my-work')
    commit(p.clone, 'MINE', 'mine\n')
    writeFileSync(join(p.clone, 'WHO'), 'uncommitted\n')
    writeFileSync(join(p.clone, 'UNTRACKED'), 'untracked\n')
    const marker = join(p.clone, 'HOOK_RAN')
    writeFileSync(join(p.clone, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
    await prepareBuddyHome(p.home, p.web)
    rmSync(marker, { force: true })
    git(p.teammate, 'tag', 'v9')
    advance(p.teammate)
    git(p.teammate, 'push', '-q', 'origin', 'v9')
    git(p.teammate, 'push', '-q', 'origin', 'main:refs/heads/other')
    const before = { head: head(p.clone), status: git(p.clone, 'status', '--porcelain'), mine: git(p.clone, 'rev-parse', 'refs/heads/main'),
      branch: git(p.clone, 'symbolic-ref', 'HEAD'), config: readFileSync(join(p.clone, '.git', 'config'), 'utf8') }
    const fetchHead = join(p.clone, '.git', 'FETCH_HEAD'), fetched = existsSync(fetchHead) ? readFileSync(fetchHead, 'utf8') : null
    await refreshBuddyHome(p.home)
    expect(head(copy(p.home))).toBe(head(p.teammate))
    expect({ head: head(p.clone), status: git(p.clone, 'status', '--porcelain'), mine: git(p.clone, 'rev-parse', 'refs/heads/main'),
      branch: git(p.clone, 'symbolic-ref', 'HEAD'), config: readFileSync(join(p.clone, '.git', 'config'), 'utf8') }).toEqual(before)
    expect(readFileSync(join(p.clone, 'WHO'), 'utf8')).toBe('uncommitted\n')
    expect(existsSync(fetchHead) ? readFileSync(fetchHead, 'utf8') : null).toBe(fetched)
    expect(existsSync(marker)).toBe(false)
    // Only the one remote-tracking ref moved.
    expect(git(p.clone, 'tag')).toBe('')
    expect(git(p.clone, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(head(p.teammate))
    expect(() => git(p.clone, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/other')).toThrow()
  })

  it.each([
    ['a changed file', (dir: string) => { chmodSync(join(dir, 'WHO'), 0o644); writeFileSync(join(dir, 'WHO'), 'changed\n') }],
    ['an untracked file', (dir: string) => writeFileSync(join(dir, 'SCRATCH'), 'x\n')],
  ])('leaves a copy with %s alone, and says it may be behind', async (_, dirty) => {
    const p = project(root())
    await prepareBuddyHome(p.home, p.web)
    const old = head(copy(p.home))
    dirty(copy(p.home))
    advance(p.teammate)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await refreshBuddyHome(p.home)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    expect(head(copy(p.home))).toBe(old)
    expect(copies(p.home)).toContain('may be behind')
  })

  it('leaves a missing copy missing, and still moves the others', async () => {
    const r = root(), p = project(r), other = checkout(r, 'other-src')
    await prepareBuddyHome(p.home, [...p.web, { id: 'other', name: 'Other', cwd: other }])
    rmSync(copy(p.home), { recursive: true, force: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await refreshBuddyHome(p.home)
    warn.mockRestore()
    expect(existsSync(copy(p.home))).toBe(false)
    expect(copies(p.home)).toContain('Web: revision not known')
    expect(copies(p.home)).toContain('Other: at')
    expect(copies(p.home)).toContain('no remote default branch')
  })

  it('moves nothing above a copy that lost its .git: another repository around it is left alone', async () => {
    const r = root(), p = project(r), outer = checkout(r, 'outer')
    const home = join(outer, 'home')
    git(outer, 'remote', 'add', 'origin', p.origin)
    git(outer, 'fetch', '-q', 'origin')
    await prepareBuddyHome(home, p.web)
    rmSync(join(copy(home), '.git'))
    const before = head(outer)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await refreshBuddyHome(home)
    warn.mockRestore()
    expect(head(outer)).toBe(before)
    expect(copies(home)).toContain('Web: revision not known')
  })

  it('offline: keeps the old copy, says so, logs one line with no address, and tries no more that pass', async () => {
    const p = project(root())
    await prepareBuddyHome(p.home, p.web)
    const old = head(copy(p.home))
    git(p.clone, 'remote', 'set-url', 'origin', 'https://user:s3cret-token@127.0.0.1:9/nothing.git')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await refreshBuddyHome(p.home)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0])).not.toMatch(/s3cret|127\.0\.0\.1/)
    warn.mockRestore()
    expect(head(copy(p.home))).toBe(old)
    expect(copies(p.home)).toContain('may be behind')
    expect(copies(p.home)).not.toContain('s3cret')
  })

  // Task #2832: a Buddy works in its copies as its owner would, so a move leaves the files it wrote as git writes them.
  it('leaves the files a move wrote writable, as git writes them, and never touches a link\'s target', async () => {
    const r = root(), p = project(r), target = join(r, 'outside')
    writeFileSync(target, 'x', { mode: 0o644 })
    await prepareBuddyHome(p.home, p.web)
    commit(p.teammate, 'WHO', 'changed\n')
    symlinkSync(target, join(p.teammate, 'LINK'))
    git(p.teammate, 'add', 'LINK')
    advance(p.teammate, 'RUN', 'new\n')
    chmodSync(join(p.teammate, 'RUN'), 0o755)
    git(p.teammate, 'add', 'RUN')
    git(p.teammate, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'run')
    git(p.teammate, 'push', '-q', 'origin', 'main')
    await refreshBuddyHome(p.home)
    expect(readFileSync(join(copy(p.home), 'WHO'), 'utf8')).toBe('changed\n')
    for (const file of ['WHO', 'RUN']) expect(statSync(join(copy(p.home), file)).mode & 0o200).toBe(0o200)
    expect(statSync(join(copy(p.home), 'RUN')).mode & 0o111).not.toBe(0)
    expect(statSync(target).mode & 0o777).toBe(0o644)
    expect(git(copy(p.home), 'status', '--porcelain')).toBe('')
    advance(p.teammate, 'LATER')
    await refreshBuddyHome(p.home)
    expect(head(copy(p.home))).toBe(head(p.teammate))
  })

  it('never changes a file outside through a folder a commit turned into a link (review of #2524)', async () => {
    const r = root(), p = project(r), outside = join(r, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'b.txt'), 'theirs', { mode: 0o644 })
    mkdirSync(join(p.teammate, 'a'))
    commit(p.teammate, 'a/b.txt', 'in the folder\n')
    git(p.teammate, 'push', '-q', 'origin', 'main')
    await prepareBuddyHome(p.home, p.web)
    expect(existsSync(join(copy(p.home), 'a', 'b.txt'))).toBe(true)
    git(p.teammate, 'rm', '-q', '-r', 'a')
    symlinkSync(outside, join(p.teammate, 'a'))
    git(p.teammate, 'add', 'a')
    git(p.teammate, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'link')
    git(p.teammate, 'push', '-q', 'origin', 'main')
    await refreshBuddyHome(p.home)
    expect(head(copy(p.home))).toBe(head(p.teammate))
    expect(statSync(join(outside, 'b.txt')).mode & 0o222).not.toBe(0)
  })

  it('is due at most hourly, across restarts, by the age of its file; a clock moved back does not stop it for good', async () => {
    const p = project(root())
    await prepareBuddyHome(p.home, p.web)
    const file = join(p.home, BUDDY_COPIES_FILE), now = Date.now()
    expect(buddyHomeDue(p.home, now + 59 * 60_000)).toBe(false)
    expect(buddyHomeDue(p.home, now + 61 * 60_000)).toBe(true)
    const later = new Date(now + 3_600_000)
    utimesSync(file, later, later)
    expect(buddyHomeDue(p.home, now)).toBe(true)
    rmSync(file)
    expect(buddyHomeDue(p.home)).toBe(true)
  })

  it('a lost project: its name leaves the file, and a pass running then stops and writes nothing back', async () => {
    const r = root(), p = project(r), otherRoot = join(r, 'o')
    mkdirSync(otherRoot)
    const other = project(otherRoot)
    const both = [...p.web, { id: 'secret', name: 'Secret', cwd: other.clone }]
    await prepareBuddyHome(p.home, both)
    expect(copies(p.home)).toContain('Secret')
    advance(p.teammate)
    const pass = refreshBuddyHome(p.home)
    expect(await pruneBuddyHome(p.home, new Set(['web']))).toEqual(['Secret'])
    await pass
    expect(existsSync(join(p.home, BUDDY_COPIES_FILE))).toBe(false)
    expect(existsSync(join(p.home, 'projects', 'Secret'))).toBe(false)
    await refreshBuddyHome(p.home)
    expect(copies(p.home)).not.toContain('Secret')
    expect(copies(p.home)).toContain('Web: at')
  })

  it('a Buddy ending during a pass: the folder goes whole and nothing comes back', async () => {
    const p = project(root())
    await prepareBuddyHome(p.home, p.web)
    advance(p.teammate)
    let finished = false
    void refreshBuddyHome(p.home).then(() => { finished = true })
    await removeBuddyHome(p.home)
    // Nothing of the pass is left running to write in the folder after it is gone.
    expect(finished).toBe(true)
    expect(existsSync(p.home)).toBe(false)
    expect(git(p.clone, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
  })

  it('joins a pass already running instead of starting a second, and never throws for a folder that is a link', async () => {
    const r = root(), p = project(r)
    await prepareBuddyHome(p.home, p.web)
    expect(refreshBuddyHome(p.home)).toBe(refreshBuddyHome(p.home))
    await refreshBuddyHome(p.home)
    const linked = join(r, 'linked')
    symlinkSync(p.home, linked)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(refreshBuddyHome(linked)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
