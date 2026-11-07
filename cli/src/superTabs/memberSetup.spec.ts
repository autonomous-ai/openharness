import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepOne } from '../lib/worktreeSweep.js'
import { copySetup, helperLine, memberLine, setUpSteps } from './memberSetup.js'

const roots: string[] = []
const root = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'member-setup-'))); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A project clone, its Member's set-up worktree (installed packages, a build, a secret file, all ignored) and a helper's new one. */
function project() {
  const dir = root(), clone = join(dir, 'clone'), member = join(dir, 'worktrees', 'member'), helper = join(dir, 'worktrees', 'helper')
  mkdirSync(clone)
  git(clone, 'init', '-b', 'main')
  writeFileSync(join(clone, '.gitignore'), 'node_modules/\nbuild/\n.env\n')
  mkdirSync(join(clone, 'cli'))
  writeFileSync(join(clone, 'cli', 'index.ts'), 'export {}\n')
  git(clone, 'add', '.'); git(clone, 'commit', '-m', 'first')
  git(clone, 'worktree', 'add', '-b', 'super-tab/member', member, 'main')
  git(clone, 'worktree', 'add', '-b', 'super-tab/helper', helper, 'main')
  for (const folder of ['node_modules/left-pad', 'cli/node_modules/tiny', 'build']) mkdirSync(join(member, folder), { recursive: true })
  writeFileSync(join(member, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(member, 'cli', 'node_modules', 'tiny', 'index.js'), 'module.exports = 2\n')
  writeFileSync(join(member, 'build', 'out.js'), 'built\n')
  writeFileSync(join(member, '.env'), 'TOKEN=not-for-helpers\n')
  return { clone, member, helper }
}

describe('a helper starts from its Member\'s ready setup', () => {
  it('gets the installed and built folders as copies of the Member\'s, never its other ignored files', async () => {
    const p = project()
    const result = await copySetup(p.member, p.helper, async (from, to) => { mkdirSync(to, { recursive: true }); execFileSync('cp', ['-R', `${from}/.`, to]) })
    expect(result).toEqual({ copied: ['build', 'cli/node_modules', 'node_modules'] })
    expect(readFileSync(join(p.helper, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(readFileSync(join(p.helper, 'cli', 'node_modules', 'tiny', 'index.js'), 'utf8')).toBe('module.exports = 2\n')
    expect(existsSync(join(p.helper, '.env'))).toBe(false)
    // A copy, not a link: the helper's install never changes the Member's.
    writeFileSync(join(p.helper, 'node_modules', 'left-pad', 'index.js'), 'changed\n')
    expect(readFileSync(join(p.member, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  })

  it('copies by the disk\'s clone where it has one, and otherwise copies nothing and says so', async () => {
    const p = project()
    const result = await copySetup(p.member, p.helper)
    if (result.skipped) {
      expect(result).toEqual({ copied: [], skipped: 'CLONE_UNSUPPORTED' })
      expect(existsSync(join(p.helper, 'node_modules'))).toBe(false)
    } else expect(readFileSync(join(p.helper, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  })

  it('leaves no half-copied folder when a copy fails part-way', async () => {
    const p = project()
    const result = await copySetup(p.member, p.helper, async (_from, to) => {
      mkdirSync(join(to, 'partial'), { recursive: true })
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    expect(result).toEqual({ copied: [], skipped: 'COPY_FAILED' })
    expect(existsSync(join(p.helper, 'build'))).toBe(false)
    expect(git(p.helper, 'status', '--porcelain', '--ignored')).toBe('')
  })

  // Security reviews of #3579: a helper's checkout may hold a tracked link where the Member has a folder.
  it('never copies through a link in the helper\'s checkout, so nothing lands outside its folder', async () => {
    const p = project(), outside = root()
    rmSync(join(p.helper, 'cli'), { recursive: true })
    symlinkSync(outside, join(p.helper, 'cli'))
    symlinkSync(join(outside, 'missing'), join(p.helper, 'build'))
    const result = await copySetup(p.member, p.helper, async (from, to) => { mkdirSync(to, { recursive: true }); execFileSync('cp', ['-R', `${from}/.`, to]) })
    expect(result).toEqual({ copied: ['node_modules'] })
    expect(readdirSync(outside)).toEqual([])
  })

  // Security review 2 of #3579: taking back a failed copy removes only what the copy made.
  it('leaves a folder that appeared during the copy, and takes back only its own', async () => {
    const p = project()
    const result = await copySetup(p.member, p.helper, async (from, to) => {
      if (to === join(p.helper, 'node_modules')) {
        mkdirSync(join(to, 'theirs'), { recursive: true })
        throw Object.assign(new Error('exists'), { code: 'ERR_FS_CP_EEXIST' })
      }
      mkdirSync(to, { recursive: true }); execFileSync('cp', ['-R', `${from}/.`, to])
    })
    expect(result).toEqual({ copied: [], skipped: 'COPY_FAILED' })
    expect(existsSync(join(p.helper, 'node_modules', 'theirs'))).toBe(true)
    expect(existsSync(join(p.helper, 'build'))).toBe(false)
    expect(existsSync(join(p.helper, 'cli', 'node_modules'))).toBe(false)
  })

  it('copies nothing from a Member folder that is gone, and starts the helper anyway', async () => {
    const p = project()
    rmSync(p.member, { recursive: true, force: true })
    expect(await copySetup(p.member, p.helper)).toEqual({ copied: [], skipped: 'NOT_READ' })
  })

  it('leaves nothing on disk when it ends: its worktree goes with the copied folders in it', async () => {
    const p = project()
    await copySetup(p.member, p.helper, async (from, to) => { mkdirSync(to, { recursive: true }); execFileSync('cp', ['-R', `${from}/.`, to]) })
    expect(await sweepOne(p.helper, Date.now(), 0)).toBe(true)
    expect(existsSync(p.helper)).toBe(false)
    expect(existsSync(join(p.member, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
  })
})

describe('what a Member and a helper are told at their start', () => {
  it('tells a Member to set its project up once, here, and to report it', () => {
    const line = memberLine('tab-1', 'project-1')
    expect(line).toContain('set the project up once')
    expect(line).toContain('harness super-tab --tab tab-1 command OPERATION_ID - <<\'JSON\'')
    expect(line).toContain('{"type":"agent.setUp","projectId":"project-1","ok":true,"steps":[')
    expect(line).toContain('"ok":false')
  })

  it('gives a helper its Member\'s steps as quoted data, one per line', () => {
    expect(helperLine(['npm ci', 'npm run build'])).toContain('\n> npm ci\n> npm run build')
    expect(helperLine([])).not.toContain('\n>')
  })

  it('takes at most ten steps, each one plain line of 300 characters or fewer', () => {
    expect(setUpSteps(['npm ci', 'npm run build'])).toEqual(['npm ci', 'npm run build'])
    expect(setUpSteps(['npm ci\nrm -rf /', 'x'.repeat(301), 7, 'ok'])).toEqual(['ok'])
    expect(setUpSteps(Array.from({ length: 12 }, (_, i) => `step ${i}`))).toHaveLength(10)
    expect(setUpSteps('npm ci')).toEqual([])
  })
})
