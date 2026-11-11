import { describe, expect, it } from 'vitest'
import { GOAL_MAX, goalOf, goalRows, scoreOf } from './goal.js'
import { GitHubReads, type GitHubGet } from './githubRest.js'

type Json = Record<string, unknown>
const FILE = `# Goal

Harness counts a milestone as done when its check passes on main.

| Milestone | Check |
|---|---|
| Settings sync offline | \`npm test -- sync.offline\` |
   |  The  app   starts in a second| \`scripts/start-time --under 1000\`|
| Every screen has a test | \`make desktop-test\` |
`
const run = (id: number, milestone: string, conclusion: string | null, status = 'completed'): Json => ({ id, name: `goal: ${milestone}`, status, conclusion })

describe('a project\'s goal file', () => {
  it('reads each row that names a milestone and its check, in the file\'s order', () => {
    expect(goalRows(FILE)).toEqual([{ milestone: 'Settings sync offline', check: 'npm test -- sync.offline' },
      { milestone: 'The app starts in a second', check: 'scripts/start-time --under 1000' }, { milestone: 'Every screen has a test', check: 'make desktop-test' }])
  })

  it('reads no row from a file that is missing, empty, or no table of checks', () => {
    for (const text of [null, '', '# Goal\n\nShip it.', '| Milestone | Check |\n|---|---|\n| Sync works | npm test |', '| Only one cell |', 'Sync | `npm test` |',
      // A check of nothing would pass by running nothing.
      '| Sync works | ` ` |']) {
      expect(goalRows(text), String(text)).toEqual([])
    }
  })

  it('counts a milestone named twice once, leaves out one too long to name a check, and reads no more than a goal holds', () => {
    expect(goalRows('| Sync | `a` |\r\n| Sync | `b` |\n| Start | `c` |')).toEqual([{ milestone: 'Sync', check: 'a' }, { milestone: 'Start', check: 'c' }])
    expect(goalRows(`| ${'x'.repeat(101)} | \`a\` |\n| ${'y'.repeat(100)} | \`b\` |`)).toEqual([{ milestone: 'y'.repeat(100), check: 'b' }])
    const many = goalRows(Array.from({ length: GOAL_MAX + 5 }, (_, n) => `| Milestone ${n} | \`check ${n}\` |`).join('\n'))
    expect(many).toHaveLength(GOAL_MAX)
    expect(many.at(-1)).toEqual({ milestone: `Milestone ${GOAL_MAX - 1}`, check: `check ${GOAL_MAX - 1}` })
  })
})

describe('a goal\'s score on one commit', () => {
  const rows = goalRows(FILE)
  it('passes a milestone whose check concluded success, fails one that concluded anything else, and waits for the rest', () => {
    expect(scoreOf(rows, [run(1, 'Settings sync offline', 'success'), run(2, 'The app starts in a second', 'failure')])).toEqual({ total: 3, passed: 1, failed: 1, waiting: 1 })
    for (const conclusion of ['failure', 'timed_out', 'action_required', 'stale']) {
      expect(scoreOf(rows.slice(0, 1), [run(1, 'Settings sync offline', conclusion)]), conclusion).toEqual({ total: 1, passed: 0, failed: 1, waiting: 0 })
    }
    // Running, queued, skipped, neutral and cancelled (a newer push took its place) say nothing yet.
    for (const waiting of [run(1, 'Settings sync offline', null, 'in_progress'), run(1, 'Settings sync offline', null, 'queued'), run(1, 'Settings sync offline', 'skipped'),
      run(1, 'Settings sync offline', 'neutral'), run(1, 'Settings sync offline', 'cancelled')]) {
      expect(scoreOf(rows.slice(0, 1), [waiting])).toEqual({ total: 1, passed: 0, failed: 0, waiting: 1 })
    }
  })

  it('reads a milestone by the newest run of its own check, and no other check as one', () => {
    expect(scoreOf(rows, [run(5, 'Settings sync offline', 'failure'), run(9, 'Settings sync offline', 'success'), run(7, 'Settings sync offline', 'failure'),
      // The project's own checks, a check of another milestone's name, and one that only starts like it.
      { id: 20, name: 'ci/required', status: 'completed', conclusion: 'success' }, { id: 21, name: 'Every screen has a test', status: 'completed', conclusion: 'success' },
      run(22, 'Every screen has a test and more', 'success'), { id: 23, name: 'Goal: The app starts in a second', status: 'completed', conclusion: 'success' }]))
      .toEqual({ total: 3, passed: 1, failed: 0, waiting: 2 })
    // A run with no name or no id is no milestone's; a named one with no id is read as the oldest of its name.
    expect(scoreOf(rows.slice(0, 1), [{ status: 'completed', conclusion: 'success' }, { name: 'goal: Settings sync offline', status: 'completed', conclusion: 'failure' },
      { id: 4, name: 'goal: Settings sync offline', status: 'completed', conclusion: 'success' }])).toEqual({ total: 1, passed: 1, failed: 0, waiting: 0 })
  })
})

describe('a project\'s goal as GitHub has it', () => {
  const SHA = (n: number) => String(n).repeat(40).slice(0, 40)
  /** A repository's goal file, its branch's last commits (the newest first) and the check runs of each, by page. */
  function github(file: string | null, commits: Json[][], branch = 'main') {
    const asked: string[] = []
    const get: GitHubGet = async path => {
      asked.push(path)
      const url = new URL(`https://api.github.com${path}`), page = Number(url.searchParams.get('page') ?? 1), ok = (body: unknown) => ({ status: 200, etag: null, resetAt: null, body })
      if (url.pathname === '/repos/acme/app/contents/agents/GOAL.md') return file === null ? { status: 404, etag: null, body: null, resetAt: null } : ok({ content: Buffer.from(file).toString('base64'), encoding: 'base64' })
      if (url.pathname === '/repos/acme/app/commits' && url.searchParams.get('sha') === branch) return ok(commits.map((_, n) => ({ sha: SHA(n + 1) })).slice(0, Number(url.searchParams.get('per_page'))))
      const runs = /^\/repos\/acme\/app\/commits\/(\d{40})\/check-runs$/.exec(url.pathname)
      if (runs) return ok({ check_runs: commits[Number(runs[1]![0]) - 1]!.slice((page - 1) * 100, page * 100) })
      return { status: 500, etag: null, body: null, resetAt: null }
    }
    return { reads: new GitHubReads(get), asked: () => asked.map(path => path.replace('/repos/acme/app', '')) }
  }
  const done = [run(1, 'Settings sync offline', 'success'), run(2, 'The app starts in a second', 'success'), run(3, 'Every screen has a test', 'failure')]

  it('scores the file\'s milestones on the branch\'s tip when all its checks have ended', async () => {
    const t = github(FILE, [done, [run(9, 'Settings sync offline', 'failure')]])
    expect(await goalOf(t.reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 2, failed: 1, waiting: 0 })
    expect(t.asked()).toEqual(['/contents/agents/GOAL.md', '/commits?sha=main&per_page=5', `/commits/${SHA(1)}/check-runs?per_page=100`])
  })

  // After each landing the tip has no run yet, and a tip pushed with [skip ci] never has one: the goal is what the last commit
  // that was checked through says, not "0 of 60 pass, 60 wait".
  it('scores the newest of the branch\'s last five commits whose checks have all ended, and its tip when none has', async () => {
    const running = [run(1, 'Settings sync offline', 'success'), run(2, 'The app starts in a second', null, 'in_progress')]
    const t = github(FILE, [[], running, done, [run(9, 'Settings sync offline', 'failure')]])
    expect(await goalOf(t.reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 2, failed: 1, waiting: 0 })
    expect(t.asked().slice(2)).toEqual([1, 2, 3].map(n => `/commits/${SHA(n)}/check-runs?per_page=100`))
    const none = github(FILE, [running, [], [], [], [], done])
    expect(await goalOf(none.reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 1, failed: 0, waiting: 2 })
    expect(none.asked()).toHaveLength(2 + 5)
    // A branch GitHub lists no commit of, or commits it names by nothing readable: every milestone waits.
    expect(await goalOf(github(FILE, []).reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 0, failed: 0, waiting: 3 })
    const paths: string[] = []
    const unread = new GitHubReads(async path => { paths.push(path); return { status: 200, etag: null, resetAt: null,
      body: path.includes('/contents/') ? { content: Buffer.from(FILE).toString('base64'), encoding: 'base64' } : path.includes('/check-runs') ? { total_count: 0 } : [{ sha: '../../pulls' }, {}, { sha: SHA(1) }] } })
    expect(await goalOf(unread, 'acme/app', 'main')).toEqual({ total: 3, passed: 0, failed: 0, waiting: 3 })
    // Only what is a commit's name is asked after.
    expect(paths.filter(path => path.includes('/check-runs'))).toEqual([`/repos/acme/app/commits/${SHA(1)}/check-runs?per_page=100`])
  })

  it('says nothing of a project with no goal file or no row, and reads no commit for it', async () => {
    for (const file of [null, '# Goal\n\nNot written yet.']) {
      const t = github(file, [done])
      expect(await goalOf(t.reads, 'acme/app', 'main')).toBeNull()
      expect(t.asked()).toEqual(['/contents/agents/GOAL.md'])
    }
  })

  it('asks for the branch by its name as an address takes it, and reads a commit\'s checks past the first hundred, as far as three pages', async () => {
    const other = (id: number): Json => ({ id, name: `build ${id}`, status: 'completed', conclusion: 'success' })
    const t = github(FILE, [[...Array.from({ length: 250 }, (_, n) => other(n + 1)), ...done.map(each => ({ ...each, id: 900 + Number(each.id) }))]], 'release/1 beta')
    expect(await goalOf(t.reads, 'acme/app', 'release/1 beta')).toMatchObject({ passed: 2, failed: 1 })
    expect(t.asked().slice(1)).toEqual(['/commits?sha=release%2F1%20beta&per_page=5', `/commits/${SHA(1)}/check-runs?per_page=100`, `/commits/${SHA(1)}/check-runs?per_page=100&page=2`,
      `/commits/${SHA(1)}/check-runs?per_page=100&page=3`])
    const far = github(FILE, [[...Array.from({ length: 300 }, (_, n) => other(n + 1)), ...done]])
    expect(await goalOf(far.reads, 'acme/app', 'main')).toMatchObject({ passed: 0, waiting: 3 })
    expect(far.asked()).toHaveLength(2 + 3)
  })
})
