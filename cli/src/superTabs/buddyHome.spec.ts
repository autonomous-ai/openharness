import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buddyProjectsOf, folderName, prepareBuddyHome, pruneBuddyHome, removeBuddyHome } from './buddyHome.js'

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

  it('names folders safely and apart, and reads only well-formed projects from a start', () => {
    expect(folderName('../etc', new Set())).toBe('etc')
    expect(folderName('.hidden', new Set())).toBe('hidden')
    expect(folderName('Web App', new Set(['Web-App']))).toBe('Web-App-2')
    expect(folderName('///', new Set())).toBe('project')
    expect(buddyProjectsOf({ buddyProjects: [{ id: 'a', name: 'A', cwd: '/x' }, { id: '../b', name: 'B', cwd: '/y' }, { id: 'c', name: 'C', cwd: 'relative' }] }))
      .toEqual([{ id: 'a', name: 'A', cwd: '/x' }])
  })
})
