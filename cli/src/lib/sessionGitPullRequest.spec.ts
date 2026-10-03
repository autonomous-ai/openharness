import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTokenUsageCache, agentTokenUsage } from './agentTokenUsage.js'
import { agentFrame } from './agentFrame.js'
import { forgetAgentProject } from './agentProject.js'
import { SessionGitHistoryStore, sessionGitHistory } from './sessionGitHistory.js'
import { readSessionGitPullRequest } from './sessionGitPullRequest.js'
import * as github from './gitPullRequest.js'
import type { RegisteredSession } from './registry.js'

describe('session work from transcript through Git and PR history', () => {
  let directory: string, home: string, ship: string, agent: RegisteredSession
  let usage: AgentTokenUsageCache, history: SessionGitHistoryStore, now: number
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  const line = (v: unknown) => JSON.stringify(v) + '\n'
  const pr = (number: number, branch: string, merged = false) => ({
    number, html_url: `https://github.com/acme/app/pull/${number}`, title: `Fix ${branch}`,
    state: merged ? 'closed' : 'open', merged_at: merged ? '2026-09-27T15:00:00Z' : null,
    head: { ref: branch, repo: { full_name: 'acme/app' } }, base: { ref: 'main' },
  })
  let rows: ReturnType<typeof pr>[]
  const execute = async (command: string, args: string[], cwd: string) => {
    if (command === 'git') return git(cwd, ...args)
    const endpoint = args.at(-1)!
    if (/\/pulls\/\d+$/.test(endpoint)) return JSON.stringify(rows.find(p => endpoint.endsWith(`/${p.number}`)))
    if (endpoint.includes('/pulls?')) {
      const query = new URLSearchParams(endpoint.split('?')[1])
      return JSON.stringify(rows.filter(p => query.get('head') === `acme:${p.head.ref}` && query.get('state') === p.state))
    }
    return JSON.stringify({ full_name: 'acme/app' })
  }
  const receipt = async (id: string, cwd: string, number?: number) => {
    const at = new Date(now += 30_000).toISOString()
    await appendFile(agent.transcriptPath!, [
      { timestamp: at, sessionId: 'hn', cwd: home, type: 'assistant', message: { content: [
        { type: 'tool_use', id, name: 'Bash', input: { command: `cd '${cwd}' && ${number ? 'gh pr create --title Fix' : 'git status --short'}` } },
      ] } },
      { timestamp: at, sessionId: 'hn', cwd: home, type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: id, content: number ? `https://github.com/acme/app/pull/${number}` : '' },
      ] } },
    ].map(line).join(''))
    usage.changed(agent); await usage.settled()
    for (const path of [home, ship, join(ship, 'tui')]) forgetAgentProject(path)
  }
  const frame = () => agentFrame(agent, { selectedModel: null, terminalAvailable: true, tokenUsage: usage.get(agent) })
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'session-work-e2e-')))
    home = join(directory, 'silent-beacon'); ship = join(directory, 'ship-hn')
    await mkdir(home)
    git(home, 'init', '-b', 'original')
    git(home, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial')
    git(home, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
    git(home, 'worktree', 'add', '-b', 'hn/nfc', ship)
    await mkdir(join(ship, 'tui'))
    agent = { agentId: 'hn-agent', sessionId: 'hn', engine: 'claude', cwd: home, registeredAt: 1,
      boundAt: 1, lastHookAt: 1, transcriptPath: join(directory, 'hn.jsonl'), runtimes: [], active: true, title: 'hn' } as unknown as RegisteredSession
    await writeFile(agent.transcriptPath!, '')
    now = Date.parse('2026-09-27T13:00:00Z')
    usage = new AgentTokenUsageCache(join(directory, 'usage'), { now: () => now })
    history = new SessionGitHistoryStore(join(directory, 'history'))
    vi.spyOn(agentTokenUsage, 'get').mockImplementation(target => usage.get(target))
    vi.spyOn(sessionGitHistory, 'get').mockImplementation(target => history.get(target))
    vi.spyOn(sessionGitHistory, 'observe').mockImplementation((target, context) => history.observe(target, context))
    vi.spyOn(sessionGitHistory, 'recordPullRequest').mockImplementation((...args) => history.recordPullRequest(...args))
    vi.spyOn(github, 'readGitPullRequest').mockImplementation(github.createPullRequestReader(execute, () => now))
    vi.spyOn(github, 'readBranchPullRequest').mockImplementation(github.createBranchPullRequestReader(execute, () => now))
    vi.spyOn(github, 'readPullRequestUrl').mockImplementation(github.createPullRequestUrlReader(execute, () => now))
    rows = [pr(12, 'hn/nfc'), pr(13, 'hn/preview')]
  })
  afterEach(async () => {
    usage.dispose(); await usage.settled(); await history.settled()
    vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true })
  })

  it.each(['claude', 'codex', 'grok'] as const)('tracks %s branches and PRs without any tool receipts', async engine => {
    agent.engine = engine
    agent.cwd = ship
    agent.transcriptPath = null
    const first = await frame()
    expect(first.gitContext).toMatchObject({ state: 'workspace', current: { branch: 'hn/nfc' },
      history: { branches: [{ branch: 'hn/nfc' }] } })
    expect(await readSessionGitPullRequest(agent, { history: true })).toMatchObject({
      history: { pullRequests: [{ result: { number: 12, state: 'Open' } }] },
    })
    git(ship, 'switch', '-c', 'hn/preview')
    forgetAgentProject(ship)
    const next = await frame()
    expect(next.gitContext.current?.branch).toBe('hn/preview')
    expect(next.gitContext.history?.branches.map(b => b.branch).sort()).toEqual(['hn/nfc', 'hn/preview'])
    rows[0] = pr(12, 'hn/nfc', true)
    now += 61_000
    const refreshed = await readSessionGitPullRequest(agent, { history: true })
    expect('history' in refreshed && refreshed.history.pullRequests.map(p => p.result?.status === 'found' && [p.result.number, p.result.state]))
      .toEqual([[13, 'Open'], [12, 'Merged']])
    // Another session's branch exists in the same repository, but has no association here.
    expect(next.gitContext.history?.branches.some(b => b.branch === 'original')).toBe(false)
  })

  it('discovers earlier PRs from saved branch identities even after the branch is deleted', async () => {
    agent.engine = 'grok'; agent.cwd = ship; agent.transcriptPath = null
    await frame() // Branch observed, but nobody opened its PR badge or details.
    git(ship, 'switch', '-c', 'hn/preview')
    git(ship, 'branch', '-D', 'hn/nfc')
    forgetAgentProject(ship)
    rows[0] = pr(12, 'hn/nfc', true)
    const result = await readSessionGitPullRequest(agent, { history: true })
    expect('history' in result && result.history.pullRequests.map(p => p.result?.status === 'found' && [p.result.number, p.result.state]))
      .toEqual([[13, 'Open'], [12, 'Merged']])
  })

  it('keeps completed PRs when the same branch also has open work', async () => {
    agent.cwd = ship; agent.transcriptPath = null
    rows = [pr(12, 'hn/nfc', true), pr(14, 'hn/nfc')]
    const result = await readSessionGitPullRequest(agent, { history: true })
    expect('history' in result && result.history.pullRequests.map(p => p.result?.status === 'found' && [p.result.number, p.result.state]))
      .toEqual([[14, 'Open'], [12, 'Merged']])
  })

  it('shows the observed checkout, follows branch switches, and retains merged PRs after removal/restart', async () => {
    agent.cwd = ship
    await receipt('nfc', join(ship, 'tui'), 12)
    const first = await frame()
    expect(first.project?.branch).toBe('hn/nfc')
    expect(first.gitContext.current).toMatchObject({ cwd: ship, branch: 'hn/nfc', worktree: true })
    const expected = { cwd: ship, branch: 'hn/nfc', remote: 'github.com/acme/app' }
    expect(await readSessionGitPullRequest(agent, { expected })).toMatchObject({ status: 'found', number: 12, context: expected })

    git(ship, 'switch', '-c', 'hn/preview')
    await receipt('preview', join(ship, 'tui'), 13)
    const second = await frame()
    expect(second.gitContext.current?.branch).toBe('hn/preview')
    expect(second.gitContext.version!.revision).toBeGreaterThan(first.gitContext.version!.revision)
    expect((await readSessionGitPullRequest(agent, { expected })).status).toBe('unavailable')
    expect(await readSessionGitPullRequest(agent)).toMatchObject({ status: 'found', number: 13 })
    expect(agent.cwd).toBe(ship)

    git(home, 'worktree', 'remove', '--force', ship)
    git(home, 'branch', '-D', 'hn/nfc', 'hn/preview')
    rows = rows.map(p => pr(p.number, p.head.ref, true))
    const removed = await readSessionGitPullRequest(agent, { history: true })
    expect(removed).toMatchObject({ status: 'unavailable', gitContext: { checkouts: [] } })
    expect('history' in removed && removed.history.pullRequests.map(p => p.result?.status === 'found' && p.result.state)).toEqual(['Merged', 'Merged'])
    await history.settled()
    const restarted = await new SessionGitHistoryStore(join(directory, 'history')).get(agent)
    expect(restarted.branches.map(b => b.branch).sort()).toEqual(['hn/nfc', 'hn/preview'])
    expect(restarted.pullRequests).toHaveLength(2)
    vi.mocked(github.readPullRequestUrl).mockResolvedValue({ status: 'unavailable' })
    const offline = await readSessionGitPullRequest(agent, { history: true })
    expect('history' in offline && offline.history.pullRequests).toEqual(restarted.pullRequests)
  })

  it('recovers recorded Codex batches into branch history and a merged PR despite later unknown activity', async () => {
    agent.engine = 'codex'
    const recorded = (await readFile(new URL('./fixtures/session-work-codex.jsonl', import.meta.url), 'utf8'))
      .replaceAll('/workspace/happy-owl/cli', `${ship}/tui`).replaceAll('/workspace/happy-owl', ship)
    await writeFile(agent.transcriptPath!, line({ timestamp: new Date(now).toISOString(), type: 'turn_context', payload: { cwd: ship } }) + recorded + [
      { timestamp: '2026-09-28T00:30:00Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'unknown', name: 'exec', input: 'await arbitraryScript();' } },
      { timestamp: '2026-09-28T00:30:01Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'unknown', output: 'Script completed\nOutput:\n' } },
    ].map(line).join(''))
    usage.changed(agent); await usage.settled()
    rows = [pr(397, 'hn/nfc', true)]
    const value = await frame()
    expect(value.gitContext).toMatchObject({ state: 'multiple', current: null,
      history: { pullRequests: [{ url: 'https://github.com/acme/app/pull/397' }] } })
    expect(value.gitContext.checkouts?.map(p => p.branch)).toEqual(['original', 'hn/nfc'])
    expect(value.gitContext.history?.branches.map(p => p.branch).sort()).toEqual(['hn/nfc', 'original'])
    const result = await readSessionGitPullRequest(agent, { history: true })
    expect(result).toMatchObject({ history: { pullRequests: [{ result: { status: 'found', number: 397, state: 'Merged' } }] } })
    expect(agent.cwd).toBe(home)
  })

  it('rejects a badge if work moves while GitHub is answering', async () => {
    agent.cwd = ship
    await receipt('nfc', ship)
    vi.mocked(github.readGitPullRequest).mockImplementation(async () => {
      await receipt('elsewhere', home)
      return { status: 'found', number: 12, state: 'Open', url: rows[0].html_url }
    })
    expect(await readSessionGitPullRequest(agent, {
      expected: { cwd: ship, branch: 'hn/nfc', remote: 'github.com/acme/app' },
    })).toMatchObject({ status: 'unavailable', context: { cwd: home, branch: 'original', remote: 'github.com/acme/app' } })
  })

  it('binds the header PR to recent work while retaining the assigned checkout and other branches', async () => {
    await receipt('ship', join(ship, 'tui'))
    const value = await frame()
    expect(value.project?.branch).toBe('original')
    expect(value.gitContext).toMatchObject({ state: 'multiple', current: null,
      recentWork: { project: { cwd: ship, branch: 'hn/nfc' } } })
    const expected = { cwd: ship, branch: 'hn/nfc', remote: 'github.com/acme/app' }
    expect(await readSessionGitPullRequest(agent, { expected })).toMatchObject({ status: 'found', number: 12, context: expected })
    expect((await readSessionGitPullRequest(agent, { expected: { ...expected, cwd: home, branch: 'original' } })).status).toBe('unavailable')
    expect(agent.cwd).toBe(home)
  })

  it('refreshes the visible open-first page, including multiple PRs for one branch', async () => {
    await receipt('nfc', ship)
    rows = [pr(12, 'hn/nfc'), pr(14, 'hn/nfc')]
    await readSessionGitPullRequest(agent)
    for (const number of [20, 21, 22, 23]) {
      const item = pr(number, 'old', true); rows.push(item)
      await history.recordPullRequest(agent, { url: item.html_url, cwd: ship, at: '2026-09-27T16:00:00Z' },
        { status: 'found', number, url: item.html_url, state: 'Merged' }, '2026-09-27T16:00:00Z')
    }
    const result = await readSessionGitPullRequest(agent, { history: true })
    expect('lookups' in result && result.lookups.map(p => p.url)).toEqual([12, 14, 20, 21].map(n => `https://github.com/acme/app/pull/${n}`))
  })
})
