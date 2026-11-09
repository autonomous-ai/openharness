import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authorOf, checksOf, GitHubMerge, ledProjects, verdicts } from './githubMerge.js'
import type { Crew } from './assign/crew.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'

type Json = Record<string, unknown>
const HEAD = 'f6edb44c0ffee0000000000000000000000000ab'
const OLD = 'a1b2c3d4e5f60000000000000000000000000000'
const comment = (body: string, extra: Json = {}): Json => ({ body, author_association: 'MEMBER', user: { login: 'deehw' }, created_at: '2026-11-09T12:00:00Z', ...extra })
const pull = (extra: Json = {}): Json => ({ number: 4, draft: false, base: { ref: 'main' }, head: { sha: HEAD, ref: 'pip/2' }, labels: [{ name: 'builder:pip' }],
  body: 'Closes #2', ...extra })

/** One repository as GitHub's REST API answers for it, with ETags, and what was sent to it. */
function fakeGitHub() {
  const repo = { pulls: [pull()], comments: new Map<number, Json[]>([[4, [comment('Juno, 14:20, to **Pip**: READ-OK f6edb44')]]]),
    runs: new Map<string, Json[]>([[HEAD, [{ name: 'test', status: 'completed', conclusion: 'success' }]]]), statuses: new Map<string, Json[]>(),
    state: 'clean', mergeAnswer: 200, signedOut: false }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const get: GitHubGet = async (path, etag) => {
    if (repo.signedOut) throw Object.assign(new Error('gh is not signed in on this computer: run `gh auth login`.'), { code: 'GH_SIGNED_OUT' })
    const url = new URL(`https://api.github.com${path}`)
    const p = url.pathname
    const body = p === '/repos/acme/app' ? { default_branch: 'main' }
      // A page of the list, as GitHub pages it.
      : p === '/repos/acme/app/pulls' ? repo.pulls.slice((Number(url.searchParams.get('page') ?? 1) - 1) * Number(url.searchParams.get('per_page') ?? 30),
        Number(url.searchParams.get('page') ?? 1) * Number(url.searchParams.get('per_page') ?? 30))
      : /\/issues\/\d+\/comments$/.test(p) ? repo.comments.get(Number(p.split('/').at(-2))) ?? []
      : /\/commits\/[0-9a-f]+\/check-runs$/.test(p) ? { check_runs: repo.runs.get(p.split('/').at(-2)!) ?? [] }
      : /\/commits\/[0-9a-f]+\/status$/.test(p) ? { statuses: repo.statuses.get(p.split('/').at(-2)!) ?? [] }
      : /\/pulls\/\d+$/.test(p) ? { mergeable_state: repo.state }
      : null
    if (body === null) return { status: 404, etag: null, body: null, resetAt: null }
    const tag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
    return etag === tag ? { status: 304, etag: tag, body: null, resetAt: null } : { status: 200, etag: tag, body, resetAt: null }
  }
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ method, path, body })
    if (method === 'PUT') return { status: repo.mergeAnswer, etag: null, body: { merged: repo.mergeAnswer === 200 }, resetAt: null }
    return { status: 201, etag: null, body: {}, resetAt: null }
  }
  return { repo, sent, get, send }
}

function setup() {
  const github = fakeGitHub()
  const log = vi.fn()
  // Pip builds; Juno is the PM.
  const crew: Crew = { builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' }], machines: [] }
  const team = vi.fn(async () => crew)
  const merger = new GitHubMerge({ projects: async () => [{ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }],
    crew: team, get: github.get, send: github.send, now: () => Date.parse('2026-11-09T07:31:00Z'), log })
  const merges = () => github.sent.filter(s => s.method === 'PUT')
  const comments = () => github.sent.filter(s => s.method === 'POST').map(s => String((s.body as Json).body))
  return { github, merger, log, merges, comments, crew: team }
}

describe('Harness merges by rule, as lampOS\'s train bot does (githubMerge.ts)', () => {
  it('merges a pull request whose head has a READ-OK from another reader and green checks, squashed at that head', async () => {
    const f = setup()
    await f.merger.tick()
    expect(f.merges()).toEqual([{ method: 'PUT', path: '/repos/acme/app/pulls/4/merge', body: { merge_method: 'squash', sha: HEAD } }])
    expect(f.comments()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d: merged\. READ-OK on f6edb44 by Juno, checks green\.$/)])
  })

  it('never merges on its author\'s own READ-OK, however its two-word name is written', async () => {
    const f = setup()
    f.crew.mockResolvedValue({ builders: [{ id: 'pip-two', name: 'Pip Two', label: 'builder:pip-two', machineId: 'mac', engine: 'claude' }], machines: [] })
    f.github.repo.pulls = [pull({ labels: [{ name: 'builder:pip-two' }], head: { sha: HEAD, ref: 'pip-two/2' } })]
    f.github.repo.comments.set(4, [comment('Pip Two, 14:20, to **Juno**: READ-OK f6edb44')])
    await f.merger.tick()
    expect(f.merges()).toEqual([])
  })

  it('merges the team\'s pull request wherever it is among a busy repository\'s hundred and more', async () => {
    const f = setup()
    const people = Array.from({ length: 119 }, (_, i) => pull({ number: 100 + i, labels: [], head: { sha: HEAD, ref: `fix-${i}` } }))
    f.github.repo.pulls = [...people.slice(0, 110), pull(), ...people.slice(110)]
    await f.merger.tick()
    expect(f.merges()).toEqual([{ method: 'PUT', path: '/repos/acme/app/pulls/4/merge', body: { merge_method: 'squash', sha: HEAD } }])
  })

  it('reads the team only when a pull request is open', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ draft: true })]
    await f.merger.tick()
    expect(f.crew).not.toHaveBeenCalled()
    f.github.repo.pulls = [pull()]
    await f.merger.tick()
    expect(f.crew).toHaveBeenCalledTimes(1)
  })

  it('merges only the team\'s own pull requests: a person\'s, or a branch no builder of the team made, is theirs to merge', async () => {
    for (const other of [{ head: { sha: HEAD, ref: 'ken/fix-login' }, labels: [] }, { head: { sha: HEAD, ref: 'fix-login' }, labels: [] }]) {
      const f = setup()
      f.github.repo.pulls = [pull(other)]
      await f.merger.tick()
      expect(f.merges()).toEqual([])
    }
  })

  it('merges nothing on a READ-OK of an older head, by its author, by a stranger, or while a HOLD stands', async () => {
    for (const said of [[comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')], [comment('Pip, 14:21: READ-OK f6edb44')],
      [comment('READ-OK f6edb44', { author_association: 'NONE', user: { login: 'stranger' } })],
      [comment('Juno, 14:20: READ-OK f6edb44'), comment('Kai, 14:25: HOLD f6edb44 quotes.py:12 off by one', { created_at: '2026-11-09T12:05:00Z' })]]) {
      const f = setup()
      f.github.repo.comments.set(4, said)
      await f.merger.tick()
      expect(f.merges()).toEqual([])
    }
  })

  it('lifts a HOLD with the same reader\'s later READ-OK, and asks two readers for TWO READS', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Kai, 14:10: HOLD a1b2c3d fix the test'), comment('Kai, 14:30: READ-OK f6edb44', { created_at: '2026-11-09T12:30:00Z' })])
    await f.merger.tick()
    expect(f.merges()).toHaveLength(1)
    const two = setup()
    two.github.repo.pulls = [pull({ body: 'Closes #2\n\nTWO READS: it changes the default voice.' })]
    await two.merger.tick()
    expect(two.merges()).toEqual([])
    two.github.repo.comments.set(4, [comment('Juno, 14:20: READ-OK f6edb44'), comment('Kai, 14:22: READ-OK f6edb44')])
    await two.merger.tick()
    expect(two.merges()).toHaveLength(1)
  })

  it('leaves drafts and pull requests into other branches alone, and waits for running checks', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ draft: true }), pull({ number: 5, base: { ref: 'release' } })]
    await f.merger.tick()
    const running = setup()
    running.github.repo.runs.set(HEAD, [{ name: 'test', status: 'in_progress', conclusion: null }])
    await running.merger.tick()
    expect([...f.merges(), ...running.merges(), ...running.comments()]).toEqual([])
  })

  it('tells the author by name once for each head when its checks failed, it is behind, or it conflicts', async () => {
    const f = setup()
    f.github.repo.runs.set(HEAD, [{ name: 'test (ubuntu)', status: 'completed', conclusion: 'failure' }])
    await f.merger.tick()
    await f.merger.tick()
    expect(f.comments()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*pip\*\*: not merged yet: checks failed on f6edb44: test \(ubuntu\)\. Fix them and push\.$/)])
    for (const [state, words] of [['behind', 'it is behind main'], ['dirty', 'it conflicts with main'], ['blocked', 'GitHub\'s rules for main block the merge']]) {
      const g = setup()
      g.github.repo.state = state
      await g.merger.tick()
      expect(g.merges()).toEqual([])
      expect(g.comments()).toEqual([expect.stringContaining(words)])
    }
  })

  it('reads a refused merge again next pass and says nothing on the pull request', async () => {
    const f = setup()
    f.github.repo.mergeAnswer = 409
    await f.merger.tick()
    expect(f.comments()).toEqual([])
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('MERGE_REFUSED acme/app#4: GitHub answered 409'))
    f.github.repo.mergeAnswer = 200
    await f.merger.tick()
    expect(f.merges()).toHaveLength(2)
  })

  it('stops while gh is signed out and says so once', async () => {
    const f = setup()
    f.github.repo.signedOut = true
    await f.merger.tick()
    await f.merger.tick()
    expect(f.log).toHaveBeenCalledTimes(1)
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('GH_SIGNED_OUT'))
  })
})

describe('the rule\'s parts', () => {
  it('reads each reader\'s last verdict by the name it signs with, or its login unsigned, and TWO READS', () => {
    const { readers, twoReads } = verdicts([comment('Juno, 14:20, to **Pip**: READ-OK f6edb44'), comment('**Faye** (PM): HOLD 1234567 wait'),
      comment('READ-OK abcdef0', { user: { login: 'kenmore' } }), comment('Harness, 14:31: merged. READ-OK on f6edb44 by juno, checks green.'),
      comment('Kai, 14:00: TWO READS for this one')], '')
    expect(Object.fromEntries(readers)).toEqual({ juno: { verdict: 'READ-OK', sha: 'f6edb44', name: 'Juno' },
      faye: { verdict: 'HOLD', sha: '1234567', name: 'Faye' }, kenmore: { verdict: 'READ-OK', sha: 'abcdef0', name: 'kenmore' } })
    expect(twoReads).toBe(true)
  })

  it('knows a pull request\'s author by its builder label, else its branch', () => {
    expect(authorOf(pull())).toBe('pip')
    expect(authorOf(pull({ labels: [], head: { sha: HEAD, ref: 'Juno/7' } }))).toBe('juno')
    expect(authorOf(pull({ labels: [], head: { sha: HEAD, ref: 'fix-tests' } }))).toBeNull()
  })

  it('passes checks only when every run and status passed, and none at all passes', () => {
    expect(checksOf([], {}).state).toBe('passed')
    expect(checksOf([{ status: 'completed', conclusion: 'skipped' }], { statuses: [{ state: 'success' }] }).state).toBe('passed')
    expect(checksOf([{ status: 'queued' }], {}).state).toBe('running')
    expect(checksOf([{ name: 'lint', status: 'completed', conclusion: 'failure' }], { statuses: [{ state: 'error', context: 'ci/required' }] }))
      .toEqual({ state: 'failed', failed: ['lint', 'ci/required'] })
  })

  it('merges only for projects whose PM is this person\'s agent running here, on a GitHub repository', async () => {
    const row = (agent: Json, extra: Json = {}) => ({ tabId: 'tab', lead: true, ledConversationId: 'lead', agent: { id: 'juno', harnessId: 'h-juno',
      name: 'Juno', contributorId: 'dee', machineOwnerId: 'dee', ...agent }, ...extra })
    const read = async () => ({ projects: [{ id: 'app', leadConversationId: 'lead', repository: { repositoryUrl: 'git@github.com:acme/app.git' } }] })
    const found = await ledProjects({ me: 'dee', live: id => id === 'h-juno', read, roster: async () => [row({}), row({ id: 'ken', contributorId: 'ken' }),
      row({ id: 'pip' }, { lead: false }), row({ id: 'gone', harnessId: 'h-gone' })] })
    expect(found).toEqual([{ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }])
  })

  it('counts a PM stopped here as leading, as the service asks the core whether it is stopped', async () => {
    const row = { tabId: 'tab', lead: true, ledConversationId: 'lead', agent: { id: 'juno', harnessId: 'h-juno', name: 'Juno', contributorId: 'dee',
      machineOwnerId: 'dee' } }
    const read = async () => ({ projects: [{ id: 'app', leadConversationId: 'lead', repository: { repositoryUrl: 'https://github.com/acme/app' } }] })
    expect(await ledProjects({ me: 'dee', live: async () => true, read, roster: async () => [row] })).toHaveLength(1)
    expect(await ledProjects({ me: 'dee', live: async () => false, read, roster: async () => [row] })).toEqual([])
  })
})
