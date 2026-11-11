import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GOAL_MAX, goalOf, goalRows, LINE_MAX, scoreOf } from './goal.js'
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

  // The same file Desktop's swarm_goal_test.dart reads: the bar must list the milestones the daemon scores.
  it('reads every case of the fixture Desktop reads too', () => {
    const { cases } = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'goal-rows.json'), 'utf8')) as { cases: { name: string; text: string | null; rows: unknown[] }[] }
    expect(cases.length).toBeGreaterThan(0)
    for (const { name, text, rows } of cases) expect(goalRows(text), name).toEqual(rows)
  })

  // As one pattern a row was read in time by the cube of its line's length: a 1,000-character line of spaces took a fifth of a
  // second, and a file of them minutes, in the daemon and in the workflow (review of the Desktop score, 2026-11-11). Read by
  // plain searches from the row's end, a megabyte of the worst lines is read at once: under the old reader this test ran out
  // of its time.
  it('reads a file of the slowest lines there are at once, and the rows among them', () => {
    const slow = [`|${' '.repeat(LINE_MAX - 2)}a`, `|${' '.repeat(500)}|${' '.repeat(490)}\`a\` x`, `| a |${' '.repeat(LINE_MAX - 10)}\`x`, `|${' |'.repeat(498)} x`]
    for (const line of slow) expect(line.length).toBeLessThanOrEqual(LINE_MAX)
    const file = [...Array.from({ length: 1_000 }, (_, n) => slow[n % slow.length]), '| Sync | `a` |'].join('\n')
    expect(goalRows(file)).toEqual([{ milestone: 'Sync', check: 'a' }])
  })

  it('reads a row by its last two backticks and the bars around them, whatever else its line holds', () => {
    expect(goalRows('| a | b | `x` |')).toEqual([{ milestone: 'a | b', check: 'x' }])
    expect(goalRows('| a `q` | `x | y` |')).toEqual([{ milestone: 'a `q`', check: 'x | y' }])
    expect(goalRows('|a|`x`|')).toEqual([{ milestone: 'a', check: 'x' }])
    // No milestone, no bar between the cells, nothing in the backticks, something after them: no row.
    for (const none of ['|', '||', '|`x`|', '|  | `x` |', '| a | `` |', '| a | ` ` |', '| a | `x` y |', '| a  `x` |', '| a | x` |', '` | a | `x` |', '| a | `x`']) {
      expect(goalRows(none), none).toEqual([])
    }
    // A milestone is one line's words: one with a line's end inside it (a lone return, U+2028, U+2029) is none, at its ends it is space.
    expect(goalRows('| a\rb | `x` |\n| a\u2028b | `x` |\n| a\u2029b | `x` |')).toEqual([])
    expect(goalRows('|\u2028 a \u2029| `x` |')).toEqual([{ milestone: 'a', check: 'x' }])
  })

  it('reads no row from a line too long to be one', () => {
    expect(goalRows(`| Sync | \`${'b'.repeat(LINE_MAX - 13)}\` |`)).toHaveLength(1)
    expect(goalRows(`| Sync | \`${'b'.repeat(LINE_MAX - 12)}\` |`)).toEqual([])
    expect(goalRows(`| a${' '.repeat(400_000)}| x\n| Sync | \`a\` |`)).toEqual([{ milestone: 'Sync', check: 'a' }])
  })
})

describe('a goal\'s score on one commit', () => {
  const rows = goalRows(FILE)
  it('passes a milestone whose check concluded success, fails one that concluded anything else, and waits for the rest', () => {
    expect(scoreOf(rows, [run(1, 'Settings sync offline', 'success'), run(2, 'The app starts in a second', 'failure')])).toEqual({ total: 3, passed: 1, failed: 1, waiting: 1 })
    // Cancelled too: GitHub ends a check that ran past its limit as `cancelled`, and a hang is a failure the PM is told.
    for (const conclusion of ['failure', 'timed_out', 'action_required', 'stale', 'cancelled']) {
      expect(scoreOf(rows.slice(0, 1), [run(1, 'Settings sync offline', conclusion)]), conclusion).toEqual({ total: 1, passed: 0, failed: 1, waiting: 0 })
    }
    // Running, queued, skipped and neutral say nothing yet.
    for (const waiting of [run(1, 'Settings sync offline', null, 'in_progress'), run(1, 'Settings sync offline', null, 'queued'), run(1, 'Settings sync offline', 'skipped'),
      run(1, 'Settings sync offline', 'neutral')]) {
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
  const SHA = (n: number) => n.toString(16).padStart(2, '0').repeat(20)
  /** A repository's goal file and its branch's commits, the newest first: each with its check runs and the commits it stands
   *  on, its first parent first (the one before it in the list unless it says another). */
  function github(file: string | null, commits: Array<Json[] | { runs: Json[]; parents: number[] }>, branch = 'main') {
    const asked: string[] = []
    const all = commits.map((commit, n) => Array.isArray(commit) ? { runs: commit, parents: n + 1 < commits.length ? [n + 1] : [] } : commit)
    const get: GitHubGet = async (path, etag) => {
      asked.push(`${path}${etag ? ' (with an ETag)' : ''}`)
      const url = new URL(`https://api.github.com${path}`), page = Number(url.searchParams.get('page') ?? 1), ok = (body: unknown) => ({ status: 200, etag: '"kept"', resetAt: null, body })
      if (url.pathname === '/repos/acme/app/contents/agents/GOAL.md') return file === null ? { status: 404, etag: null, body: null, resetAt: null } : ok({ content: Buffer.from(file).toString('base64'), encoding: 'base64' })
      if (url.pathname === '/repos/acme/app/commits' && url.searchParams.get('sha') === branch && url.searchParams.get('per_page') === '100') {
        return ok(all.map((commit, n) => ({ sha: SHA(n + 1), parents: commit.parents.map(parent => ({ sha: SHA(parent + 1) })) })))
      }
      const runs = /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs$/.exec(url.pathname)
      if (runs) return ok({ check_runs: all[parseInt(runs[1]!.slice(0, 2), 16) - 1]!.runs.slice((page - 1) * 100, page * 100) })
      return { status: 500, etag: null, body: null, resetAt: null }
    }
    return { reads: new GitHubReads(get), asked: () => asked.map(path => path.replace('/repos/acme/app', '')) }
  }
  const done = [run(1, 'Settings sync offline', 'success'), run(2, 'The app starts in a second', 'success'), run(3, 'Every screen has a test', 'failure')]
  const running = [run(1, 'Settings sync offline', 'success'), run(2, 'The app starts in a second', null, 'in_progress')]

  it('scores the file\'s milestones on the branch\'s tip when all its checks have ended', async () => {
    const t = github(FILE, [done, [run(9, 'Settings sync offline', 'failure')]])
    expect(await goalOf(t.reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 2, failed: 1, waiting: 0 })
    expect(t.asked()).toEqual(['/contents/agents/GOAL.md', '/commits?sha=main&per_page=100', `/commits/${SHA(1)}/check-runs?per_page=100`])
  })

  // After each landing the tip has no run yet, and a tip pushed with [skip ci] never has one: the goal is what the last landing
  // that was checked through says, not "0 of 60 pass, 60 wait".
  it('scores the newest of the branch\'s last five landings whose checks have all ended', async () => {
    const t = github(FILE, [[], running, done, [run(9, 'Settings sync offline', 'failure')]])
    expect(await goalOf(t.reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 2, failed: 1, waiting: 0 })
    expect(t.asked().slice(2)).toEqual([1, 2, 3].map(n => `/commits/${SHA(n)}/check-runs?per_page=100`))
  })

  // A train that lands as a merge commit brings its members' own commits and the train's merges of them: none was pushed to the
  // branch, so none has a check of it. Counted among "the last five commits", they hid the landing before (second review).
  it('follows the branch\'s own line of landings, not every commit a landing brought with it', async () => {
    // The tip is a train's landing of three pull requests, still running; the landing before it was checked through.
    const brought = Array.from({ length: 6 }, () => ({ runs: [] as Json[], parents: [7] }))
    const t = github(FILE, [{ runs: running, parents: [7, 1] }, ...brought, done, []])
    expect(await goalOf(t.reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 2, failed: 1, waiting: 0 })
    expect(t.asked().slice(2)).toEqual([`/commits/${SHA(1)}/check-runs?per_page=100`, `/commits/${SHA(8)}/check-runs?per_page=100`])
  })

  it('scores the landing with the fewest checks still waiting when none of the five has ended, the newest of those', async () => {
    const one = [run(1, 'Settings sync offline', 'success')]
    const none = github(FILE, [[], running, one, running, [], done])
    expect(await goalOf(none.reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 1, failed: 0, waiting: 2 })
    expect(none.asked()).toHaveLength(2 + 5)
    expect(await goalOf(github(FILE, [[], one, [run(1, 'Settings sync offline', 'failure')]]).reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 1, failed: 0, waiting: 2 })
    // After a milestone is added, every older landing waits on it: the one that lacks only that is the goal, not a tip with none.
    const added = `${FILE}| A new milestone | \`make new\` |\n`
    expect(await goalOf(github(added, [[], done]).reads, 'acme/app', 'main')).toEqual({ total: 4, passed: 2, failed: 1, waiting: 1 })
    // A branch GitHub lists no commit of, or commits it names by nothing readable: every milestone waits, and nothing more is asked.
    expect(await goalOf(github(FILE, []).reads, 'acme/app', 'main')).toEqual({ total: 3, passed: 0, failed: 0, waiting: 3 })
    const paths: string[] = []
    const unread = new GitHubReads(async path => { paths.push(path); return { status: 200, etag: null, resetAt: null,
      body: path.includes('/contents/') ? { content: Buffer.from(FILE).toString('base64'), encoding: 'base64' } : path.includes('/check-runs') ? { total_count: 0 }
        : path.includes('unlisted') ? { message: 'not a list' } : [{ sha: '../../pulls' }, {}, { sha: SHA(1), parents: 'none' }] } })
    expect(await goalOf(unread, 'acme/app', 'main')).toEqual({ total: 3, passed: 0, failed: 0, waiting: 3 })
    expect(paths.filter(path => path.includes('/check-runs'))).toEqual([`/repos/acme/app/commits/${SHA(1)}/check-runs?per_page=100`])
    expect(await goalOf(unread, 'acme/app', 'unlisted')).toEqual({ total: 3, passed: 0, failed: 0, waiting: 3 })
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
    expect(t.asked().slice(1)).toEqual(['/commits?sha=release%2F1%20beta&per_page=100', `/commits/${SHA(1)}/check-runs?per_page=100`, `/commits/${SHA(1)}/check-runs?per_page=100&page=2`,
      `/commits/${SHA(1)}/check-runs?per_page=100&page=3`])
    const far = github(FILE, [[...Array.from({ length: 300 }, (_, n) => other(n + 1)), ...done]])
    expect(await goalOf(far.reads, 'acme/app', 'main')).toMatchObject({ passed: 0, waiting: 3 })
    expect(far.asked()).toHaveLength(2 + 3)
  })

  // A commit's check runs are hundreds of kilobytes, asked for once: kept under their ETag as other reads are, a few hundred
  // of them filled the Swarm's process (second review).
  it('keeps nothing of the commits and checks it read: asked again, they are asked outright', async () => {
    const t = github(FILE, [done])
    await goalOf(t.reads, 'acme/app', 'main')
    await goalOf(t.reads, 'acme/app', 'main')
    expect(t.asked().slice(3)).toEqual(['/contents/agents/GOAL.md (with an ETag)', '/commits?sha=main&per_page=100', `/commits/${SHA(1)}/check-runs?per_page=100`])
  })
})
