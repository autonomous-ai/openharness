import { describe, expect, it } from 'vitest'
import type { Run } from '../lib/github.js'
import { labelFor, MAX_PAGES, readShipped, weekStart, type ReadAgent } from './shippingRead.js'

const DAY = 86_400_000, WEEK = 7 * DAY
/** Monday 2026-11-09 00:00 UTC. */
const MON = Date.UTC(2026, 10, 9)
/** What the clock says in these specs: the Thursday of that week. */
const NOW = MON + 3 * DAY
const at = (days: number, hours = 12) => new Date(MON + days * DAY + hours * 3_600_000).toISOString()
const atlas: ReadAgent = { id: 'a1', name: 'Atlas', label: 'builder:atlas', from: MON - WEEK }
const nova: ReadAgent = { id: 'a2', name: 'Nova', label: 'builder:nova', from: MON - WEEK }

const pr = (over: Record<string, unknown> = {}) => ({ number: 7, title: 'Add search', merged: true, mergedAt: at(1), author: { login: 'Ann' }, ...over })
const issue = (over: Record<string, unknown> = {}, ...labels: string[]) => ({ closedAt: at(1), stateReason: 'COMPLETED',
  labels: { nodes: (labels.length ? labels : ['builder:atlas']).map(name => ({ name })) }, closedByPullRequestsReferences: { nodes: [pr()] }, ...over })
const found = (nodes: unknown[], next?: string) => ({ data: { viewer: { login: 'ann' }, search: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes } } })
const reverts = (nodes: unknown[], next?: string) => ({ data: { search: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes } } })
const revert = (over: Record<string, unknown> = {}) => ({ number: 9, title: 'Revert "Add search"', body: '', mergedAt: at(2), ...over })

/** `gh api graphql`, answered by what is asked: a repository's name, a label's closed issues, or the reverts. Every call is kept. */
function gh(answers: { name?: (repository: string) => unknown; issues?: (q: string, after: string | undefined) => unknown; reverts?: (q: string) => unknown }) {
  const calls: string[] = []
  const run: Run = async args => {
    const field = (name: string) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
    const query = field('query')!, q = field('q'), owner = field('owner'), name = field('name'), after = field('after')
    calls.push(q ?? `${owner}/${name}`)
    const answer = query.includes('nameWithOwner') ? (answers.name ?? ((r: string) => ({ data: { repository: { nameWithOwner: r } } })))(`${owner}/${name}`)
      : query.includes('closedByPullRequestsReferences') ? (answers.issues ?? (() => found([])))(q!, after) : (answers.reverts ?? (() => reverts([])))(q!)
    if (answer instanceof Error) throw answer
    return { stdout: typeof answer === 'string' ? answer : JSON.stringify(answer) }
  }
  return { run, calls }
}
const failure = (fields: Record<string, unknown>) => Object.assign(new Error('gh failed'), fields)
/** What was read for each agent: its weeks with the counts above zero, or why it could not be read. */
const counts = async (run: Run, agents: ReadAgent[] = [atlas], repositories = ['acme/web']) =>
  Object.fromEntries((await readShipped(run, repositories, agents, new Map(), NOW)).map(read => [read.agent.id,
    'failed' in read ? read.failed : read.weeks.map(({ week, ...shipped }) => [week, Object.fromEntries(Object.entries(shipped).filter(([, n]) => n > 0))])]))

describe('what an agent shipped', () => {
  it('is its closed issues by week and priority label, the highest label counting, none for none', async () => {
    const { run } = gh({ issues: () => found([issue({ closedAt: at(-6) }, 'builder:atlas', 'P2'), issue({ closedAt: at(1) }, 'builder:atlas', 'p3', 'P1'), issue({ closedAt: at(2) }), issue({ closedAt: at(3) }, 'builder:atlas', 'P0')]) })
    expect(await counts(run)).toEqual({ a1: [[MON - WEEK, { P2: 1 }], [MON, { P1: 1, none: 1, P0: 1 }]] })
  })

  it('asks for the agent\'s label since its first week, by the name GitHub gives the repository', async () => {
    const { run, calls } = gh({ name: () => ({ data: { repository: { nameWithOwner: 'acme/web-next' } } }), issues: () => found([]) })
    await counts(run)
    expect(calls).toEqual(['acme/web', `repo:acme/web-next is:issue is:closed closed:>=${new Date(MON - WEEK).toISOString().slice(0, 10)} label:"builder:atlas"`])
  })

  it('counts only what a pull request of this person\'s own merged for: the label names the agent, the login says whose', async () => {
    const { run } = gh({ issues: () => found([
      issue({ closedByPullRequestsReferences: { nodes: [pr({ merged: false })] } }),
      issue({ closedByPullRequestsReferences: { nodes: [pr({ author: { login: 'bob' } })] } }),
      issue({ closedByPullRequestsReferences: { nodes: [pr({ author: null })] } }),
      issue({ closedByPullRequestsReferences: { nodes: [pr({ mergedAt: null })] } }),
      issue({ closedByPullRequestsReferences: { nodes: [] } }),
      issue({ closedByPullRequestsReferences: null }),
      issue({ closedByPullRequestsReferences: { nodes: [pr({ author: { login: 'bob' } }), pr({ number: 8, author: { login: 'ANN' } })] } })]) })
    expect(await counts(run)).toEqual({ a1: [[MON, { none: 1 }]] })
  })

  it('leaves out what was closed as not planned or a duplicate, before its first week, or without its label', async () => {
    const { run } = gh({ issues: () => found([issue({ stateReason: 'NOT_PLANNED' }), issue({ stateReason: 'DUPLICATE' }), issue({ stateReason: null }), issue({ closedAt: at(-8) }),
      issue({ closedAt: 'never' }), issue({}, 'builder:nova'), issue({ labels: null }), issue({}, 'Builder:Atlas')]) })
    expect(await counts(run)).toEqual({ a1: [[MON, { none: 2 }]] })
  })

  it('is each agent\'s own, in every repository', async () => {
    const { run } = gh({ issues: q => found(q.includes('builder:atlas') ? [issue({}, 'builder:atlas', 'P1')] : [issue({ closedAt: at(8) }, 'builder:nova', 'P3')]) })
    expect(await counts(run, [atlas, nova], ['acme/web', 'acme/api'])).toEqual({ a1: [[MON, { P1: 2 }]], a2: [[MON + WEEK, { P3: 2 }]] })
  })

  it('has nothing from a repository this person cannot see, and no failure for it', async () => {
    const { run, calls } = gh({ name: r => r === 'acme/secret' ? failure({ stderr: "Could not resolve to a Repository with the name 'acme/secret'." }) : { data: { repository: { nameWithOwner: r } } },
      issues: () => found([issue()]) })
    expect(await counts(run, [atlas], ['acme/secret', 'acme/web'])).toEqual({ a1: [[MON, { none: 1 }]] })
    expect(calls.filter(call => call.includes('is:issue')).length).toBe(1)
    const none = gh({ name: () => ({ data: { repository: null } }) })
    expect(await counts(none.run)).toEqual({ a1: [] })
  })

  it('names any other trouble with a repository as a failure, not as one this person cannot see', async () => {
    for (const stderr of ['HTTP 404', 'Resource not found', 'sh: gh: command not found']) {
      expect(await counts(gh({ name: () => failure({ stderr }) }).run), stderr).toEqual({ a1: 'GH_FAILED' })
    }
  })

  it('keeps the names GitHub gave, asking again only for one it did not find', async () => {
    const { run, calls } = gh({ name: r => r === 'acme/new' ? { data: { repository: null } } : { data: { repository: { nameWithOwner: r } } } })
    const names = new Map<string, string>()
    await readShipped(run, ['acme/web', 'acme/new'], [atlas], names)
    await readShipped(run, ['acme/web', 'acme/new'], [atlas], names)
    expect(calls.filter(call => !call.startsWith('repo:'))).toEqual(['acme/web', 'acme/new', 'acme/new'])
  })
})

describe('what a revert takes back', () => {
  const merged = (days: number, over: Record<string, unknown> = {}) => issue({ closedByPullRequestsReferences: { nodes: [pr({ mergedAt: at(days), ...over })] } })
  const only = async (candidate: unknown, ...undoing: unknown[]) => {
    const { run, calls } = gh({ issues: () => found([candidate]), reverts: () => reverts(undoing) })
    const read = (await counts(run)).a1
    if (!Array.isArray(read)) throw new Error(`the reading failed: ${read}`)
    return { shipped: read.length > 0, calls }
  }

  it('is looked for once a repository, since the earliest merge, and only when something merged', async () => {
    const asked = await only(merged(1), revert({ mergedAt: at(1, 18) }))
    expect(asked.calls.filter(call => call.includes('is:pr'))).toEqual([`repo:acme/web is:pr is:merged merged:>=${at(1).slice(0, 10)} revert in:title`])
    expect((await only(issue({ closedByPullRequestsReferences: { nodes: [] } }))).calls.some(call => call.includes('is:pr'))).toBe(false)
  })

  it('is GitHub\'s own Revert "<title>" within a week of the merge', async () => {
    expect((await only(merged(1), revert({ mergedAt: at(1, 18) }))).shipped).toBe(false)
    expect((await only(merged(1), revert({ title: 'revert "add search"', mergedAt: at(8, 11) }))).shipped).toBe(false)
    expect((await only(merged(1), revert({ mergedAt: at(8, 13) }))).shipped).toBe(true)
    expect((await only(merged(1), revert({ mergedAt: at(0) }))).shipped).toBe(true)
  })

  it('is a pull request that names it: Reverts #7, owner/name#7, its address, or a title that says Revert and #7', async () => {
    for (const body of ['Reverts #7.', 'reverts acme/web#7 (merged in a batch)', 'This reverts https://github.com/acme/web/pull/7', 'Reverted #7 because it broke search', 'Reverts ACME/Web#7']) {
      expect((await only(merged(1), revert({ title: 'Back it out', body }))).shipped, body).toBe(false)
    }
    expect((await only(merged(1), revert({ title: 'Revert the search box (#7)', body: '' }))).shipped).toBe(false)
    for (const body of ['Reverts #70', 'Reverts #8', 'Mentions #7 only', 'Reverts nothing']) {
      expect((await only(merged(1), revert({ title: 'Back it out', body }))).shipped, body).toBe(true)
    }
    expect((await only(merged(1), revert({ title: 'Revert the search box (#70)', body: '' }))).shipped).toBe(true)
  })

  it('is not another repository\'s pull request of the same number', async () => {
    for (const body of ['Reverts other/repo#7', 'Reverts https://github.com/other/repo/pull/7', 'Reverts acme/web-next#7', 'Reverts other/repo#7 and #8']) {
      expect((await only(merged(1), revert({ title: 'Back it out', body }))).shipped, body).toBe(true)
    }
    expect((await only(merged(1), revert({ title: 'Back it out', body: 'Reverts other/repo#7. Reverts acme/web#7' }))).shipped).toBe(false)
  })

  it('names its repository as the project holds it or as GitHub calls it now', async () => {
    for (const [body, shipped] of [['Reverts acme/web#7', false], ['Reverts acme/web-next#7', false], ['Reverts acme/other#7', true]] as const) {
      const { run } = gh({ name: () => ({ data: { repository: { nameWithOwner: 'acme/web-next' } } }), issues: () => found([merged(1)]), reverts: () => reverts([revert({ title: 'Back it out', body })]) })
      expect((await counts(run)).a1, body).toEqual(shipped ? [[MON, { none: 1 }]] : [])
    }
  })

  it('never takes a pull request back by itself', async () => {
    expect((await only(merged(1, { number: 9, title: 'Revert the old box (#9)' }), revert({ number: 9, title: 'Revert the old box (#9)', mergedAt: at(1, 13) }))).shipped).toBe(true)
  })

  it('leaves an issue shipped while a pull request that closed it stands', async () => {
    const two = issue({ closedByPullRequestsReferences: { nodes: [pr(), pr({ number: 8, title: 'Fix search' })] } })
    expect((await only(two, revert({ body: 'Reverts #7' }))).shipped).toBe(true)
    expect((await only(two, revert({ body: 'Reverts #7' }), revert({ number: 10, body: 'Reverts #8' }))).shipped).toBe(false)
  })
})

describe('a search', () => {
  const endless = found([], 'more')

  it('is read over its pages', async () => {
    const pages = gh({ issues: (_, after) => after === 'c1' ? found([issue({}, 'builder:atlas', 'P2')]) : found([issue({}, 'builder:atlas', 'P1')], 'c1') })
    expect(await counts(pages.run)).toEqual({ a1: [[MON, { P1: 1, P2: 1 }]] })
  })

  it('is read a week at a time when one search cannot hold it, so a busy agent is still read', async () => {
    const sliced = gh({ issues: q => q.includes('closed:>=') ? endless : q.includes('2026-11-02..2026-11-08') ? found([issue({ closedAt: at(-3) }, 'builder:atlas', 'P2')])
      : q.includes('2026-11-09..2026-11-15') ? found([issue({ closedAt: at(1) }, 'builder:atlas', 'P1')]) : found([]) })
    expect(await counts(sliced.run)).toEqual({ a1: [[MON - WEEK, { P2: 1 }], [MON, { P1: 1 }]] })
    expect(sliced.calls.filter(call => call.includes('is:issue')).length).toBe(MAX_PAGES + 2)
  })

  it('is read a week at a time for the reverts too', async () => {
    const run = gh({ issues: () => found([issue()]), reverts: q => q.includes('merged:>=') ? { data: { search: { pageInfo: { hasNextPage: true, endCursor: 'more' }, nodes: [] } } }
      : q.includes(`${at(1).slice(0, 10)}..`) ? reverts([revert({ mergedAt: at(1, 13) })]) : reverts([]) }).run
    expect(await counts(run)).toEqual({ a1: [] })
  })

  it('fails as too many, for its agent only, when a week of it is more than a search may take', async () => {
    const busy = gh({ issues: q => q.includes('builder:nova') ? endless : found([issue({}, 'builder:atlas', 'P1')]) })
    expect(await counts(busy.run, [atlas, nova], ['acme/web', 'acme/api'])).toEqual({ a1: [[MON, { P1: 2 }]], a2: 'TOO_MANY' })
    // The window, then its first week, and the agent is not asked again in the next repository.
    expect(busy.calls.filter(call => call.includes('builder:nova')).length).toBe(2 * MAX_PAGES)
  })

  it('fails every agent, never a smaller reading, naming why gh could not read', async () => {
    const reading = async (issues: () => unknown) => (await counts(gh({ issues }).run)).a1
    expect(await reading(() => failure({ code: 'ENOENT' }))).toBe('GH_MISSING')
    expect(await reading(() => failure({ stderr: 'To get started with GitHub CLI, please run: gh auth login' }))).toBe('GH_SIGNED_OUT')
    expect(await reading(() => failure({ stderr: 'HTTP 403: API rate limit exceeded' }))).toBe('RATE_LIMITED')
    expect(await reading(() => failure({ killed: true, signal: 'SIGKILL' }))).toBe('TIMEOUT')
    expect(await reading(() => failure({ stderr: 'HTTP 502' }))).toBe('GH_FAILED')
    expect(await reading(() => 'not json')).toBe('GH_FAILED')
    expect(await reading(() => ({ errors: [{ message: 'boom' }], data: null }))).toBe('GH_FAILED')
    expect(await reading(() => ({ data: {} }))).toBe('GH_FAILED')
    expect(await reading(() => ({ data: { viewer: { login: 'ann' }, search: null } }))).toBe('GH_FAILED')
    expect(await counts(gh({ issues: () => failure({ stderr: 'HTTP 502' }) }).run, [atlas, nova])).toEqual({ a1: 'GH_FAILED', a2: 'GH_FAILED' })
    const second = gh({ issues: q => q.includes('acme/api') ? failure({ stderr: 'HTTP 429' }) : found([issue()]) })
    expect(await counts(second.run, [atlas], ['acme/web', 'acme/api'])).toEqual({ a1: 'RATE_LIMITED' })
    const lost = gh({ issues: () => found([issue()]), reverts: () => failure({ stderr: 'HTTP 429' }) })
    expect(await counts(lost.run, [atlas, nova])).toEqual({ a1: 'RATE_LIMITED', a2: 'RATE_LIMITED' })
    expect(await counts(gh({ name: () => ({ data: { repository: { nameWithOwner: 5 } } }) }).run)).toEqual({ a1: [] })
  })

  it('fails with GH_FAILED when a reading breaks on what it was told, not on gh', async () => {
    expect(await counts(gh({}).run, [{ ...atlas, from: 9_000_000_000_000_000 }])).toEqual({ a1: 'GH_FAILED' })
  })
})

describe('a label and a week', () => {
  it('names an agent\'s issues as the team does, lower case with dashes, when it fits a label and the search', () => {
    expect(labelFor('Atlas')).toBe('builder:atlas')
    expect(labelFor('  Atlas  Prime ')).toBe('builder:atlas-prime')
    expect(labelFor('a'.repeat(42))).toBe(`builder:${'a'.repeat(42)}`)
    expect(labelFor('line\nbreak')).toBe('builder:line-break')
    for (const name of ['a'.repeat(43), 'say "hi"', 'one, two', 'back\\slash', 'bell\u0007', '  ', '']) expect(labelFor(name)).toBeNull()
  })

  it('starts on Monday 00:00 UTC', () => {
    expect([MON, MON + WEEK - 1, MON + WEEK, MON - 1].map(weekStart)).toEqual([MON, MON, MON + WEEK, MON - WEEK])
  })
})
