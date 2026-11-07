import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memberBranch, memberProjectIds, memberSetUp, memberWorktreesFile, readMemberWorktrees, writeMemberWorktrees, type MemberWorktree } from './memberHome.js'

// Task #4543 (spec #4489 section 2): a Member's task sessions work in a worktree of their own per project, kept apart from its
// chat home, made once and used by every later task there. The host keeps which, so it reports them set up and reuses them.
describe('a Member\'s project worktrees on this machine', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const folder = () => { const root = mkdtempSync(join(tmpdir(), 'member-home-')); roots.push(root); return root }
  const row = (root: string, memberId: string, projectId: string, tabId = 'tab', made = true): MemberWorktree => {
    const path = join(root, 'worktrees', 'repo', `m-${projectId}`)
    if (made) mkdirSync(path, { recursive: true })
    return { tabId, memberId, projectId, startId: `start-${projectId}`, source: join(root, 'clone'), path }
  }

  it('names its branch, and so its folder, short: the project\'s id and the start\'s, eight characters each', () => {
    expect(memberBranch('0123456789abcdef01234567', 'fedcba9876543210fedcba98')).toBe('m/01234567-fedcba98')
  })

  it('is kept in this machine\'s own record, which drops any row it cannot trust', () => {
    const root = folder(), file = memberWorktreesFile(join(root, 'data'), 'host')
    const rows = [row(root, 'member-1', 'p1'), row(root, 'member-1', 'p2')]
    writeMemberWorktrees(file, rows)
    expect(readMemberWorktrees(file)).toEqual(rows)
    writeFileSync(file, JSON.stringify({ version: 1, worktrees: [...rows, { ...rows[0], path: 'relative/path' }, { ...rows[0], memberId: '../x' }, null] }))
    expect(readMemberWorktrees(file)).toEqual(rows)
    expect(readMemberWorktrees(join(root, 'missing.json'))).toEqual([])
  })

  it('reports, per Member of a Swarm, the projects whose worktree is still there, at most five', () => {
    const root = folder()
    const rows = [row(root, 'member-1', 'p1'), row(root, 'member-1', 'gone', 'tab', false), row(root, 'member-2', 'p3'),
      row(root, 'member-1', 'other', 'other-tab'), ...['a', 'b', 'c', 'd', 'e'].map(p => row(root, 'member-3', p))]
    expect(memberSetUp(rows, 'tab')).toEqual({ 'member-1': ['p1'], 'member-2': ['p3'], 'member-3': ['a', 'b', 'c', 'd', 'e'] })
    expect(memberProjectIds(rows)).toEqual(['p1', 'p3', 'other', 'a', 'b', 'c', 'd', 'e'])
  })
})
