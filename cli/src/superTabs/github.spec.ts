import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import type { RegisteredSession } from '../lib/registry.js'
import { swarmGitHubSessionDir } from '../lib/swarmGitHub.js'
import { GitHubTokenRefresher, githubToken, RENEW_BELOW_MS } from './github.js'

const root = mkdtempSync(join(tmpdir(), 'super-tab-github-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0

type Reply = { status: number; body: Record<string, unknown> }
const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data } })
const refuse = (status: number, code: string, message = code): Reply => ({ status, body: { success: false, error: { code, message } } })
const issued = (token: string, expiresAt = '2026-10-24T13:00:00.000Z') => ok({ token, expiresAt, repository: 'acme/app',
  trailers: ['Co-authored-by: Ada <ada@example.com>', 'Harness-Agent: Atlas'] })
const row = (tabId: string, agentId: string, harnessId = 'harness-1', extra: Record<string, unknown> = {}) =>
  ({ tabId, agent: { id: agentId, harnessId, machineId: 'machine-1' }, ...extra })

/** A core whose backend answers by path; one session per harness id, started to use the app unless `plain`. */
function setup(routes: (method: string, path: string, body: unknown) => Reply, sessions: Array<{ id: string; plain?: boolean }> = [{ id: 'harness-1' }]) {
  const dataDir = join(root, `data-${made++}`)
  const live = sessions.map(s => ({ agentId: s.id, swarmSkill: { role: 'dev', key: `harness-codex-${s.id}`, ...(s.plain ? {} : { github: true }) } }) as unknown as RegisteredSession)
  const backend = vi.fn(async (method: string, path: string, body?: unknown) => routes(method, path, body))
  const core = fakeCore({ dataDir, account: { backend }, agents: { live: vi.fn(() => live), byAgent: vi.fn((id: string) => live.find(s => s.agentId === id)) } })
  const hosts = (id = 'harness-1') => readFileSync(join(swarmGitHubSessionDir(dataDir, `harness-codex-${id}`)!, 'gh', 'hosts.yml'), 'utf8')
  const trailers = (id = 'harness-1') => readFileSync(join(swarmGitHubSessionDir(dataDir, `harness-codex-${id}`)!, 'trailers'), 'utf8')
  return { core, backend, hosts, trailers }
}

describe('a local agent\'s GitHub token', () => {
  it('is asked for as the agent the roster lists for that harness on this machine, and written into its gh login', async () => {
    const { core, backend, hosts, trailers } = setup((method, path) => method === 'GET' ? ok([row('tab-1', 'agent-1')])
      : path === '/api/super-tabs/tab-1/github-token?asAgentId=agent-1' ? issued('ghs_fixtureToken0000001') : refuse(404, 'NOT_FOUND'))
    const answer = await githubToken(core, 'harness-1')
    expect(answer).toMatchObject({ ok: true, value: { token: 'ghs_fixtureToken0000001', repository: 'acme/app', tabId: 'tab-1', agentId: 'agent-1' } })
    expect(backend).toHaveBeenCalledWith('GET', '/api/super-tabs/hosts/machine-1', undefined)
    expect(backend).toHaveBeenCalledWith('POST', '/api/super-tabs/tab-1/github-token?asAgentId=agent-1', { machineId: 'machine-1' })
    expect(hosts()).toContain('oauth_token: ghs_fixtureToken0000001')
    expect(trailers()).toBe('Co-authored-by: Ada <ada@example.com>\nHarness-Agent: Atlas\n')
  })

  it('tries the harness\'s next Swarm when one has no task for it, and skips stopping and closing rows and other harnesses', async () => {
    const { core, backend } = setup((method, path) => method === 'GET'
      ? ok([row('tab-0', 'agent-0', 'harness-2'), row('tab-x', 'agent-x', 'harness-1', { stopRequested: true }), row('tab-y', 'agent-y', 'harness-1', { closeSession: true }),
        row('tab-1', 'agent-1'), row('tab-2', 'agent-2')])
      : path.startsWith('/api/super-tabs/tab-1/') ? refuse(409, 'NO_ASSIGNMENT') : issued('ghs_fixtureToken0000002'))
    expect(await githubToken(core, 'harness-1')).toMatchObject({ ok: true, value: { tabId: 'tab-2' } })
    expect(backend.mock.calls.filter(c => c[0] === 'POST').map(c => c[1])).toEqual([
      '/api/super-tabs/tab-1/github-token?asAgentId=agent-1', '/api/super-tabs/tab-2/github-token?asAgentId=agent-2'])
  })

  it('passes on the most telling refusal and empties the gh login when the server decided', async () => {
    const answers: Record<string, Reply> = { 'tab-1': refuse(409, 'NO_ASSIGNMENT'), 'tab-2': refuse(409, 'GITHUB_APP_NOT_INSTALLED', 'Install it: https://github.com/apps/x/installations/new') }
    const { core, hosts } = setup((method, path) => method === 'GET' ? ok([row('tab-1', 'agent-1'), row('tab-2', 'agent-2')])
      : path.includes('tab-0') ? issued('x') : answers[path.split('/')[3]!]!)
    expect(await githubToken(core, 'harness-1')).toEqual({ error: 'GITHUB_APP_NOT_INSTALLED', detail: 'Install it: https://github.com/apps/x/installations/new', status: 409 })
    expect(hosts()).toBe('{}\n')
  })

  it('keeps an unexpired token when the server cannot be reached, and empties it when the app is not configured', async () => {
    let reply = issued('ghs_fixtureToken0000003')
    const { core, hosts } = setup((method) => method === 'GET' ? ok([row('tab-1', 'agent-1')]) : reply)
    await githubToken(core, 'harness-1')
    reply = refuse(503, 'BACKEND_UNAVAILABLE')
    expect(await githubToken(core, 'harness-1')).toMatchObject({ error: 'BACKEND_UNAVAILABLE' })
    expect(hosts()).toContain('ghs_fixtureToken0000003')
    reply = refuse(503, 'GITHUB_APP_NOT_CONFIGURED')
    await githubToken(core, 'harness-1')
    expect(hosts()).toBe('{}\n')
  })

  it('refuses a harness that is not running here, one in no Swarm, and a reply without a token', async () => {
    const { core } = setup(method => method === 'GET' ? ok([]) : ok({}))
    expect(await githubToken(core, 'harness-9')).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
    expect(await githubToken(core, '../x')).toEqual({ error: 'INVALID_REQUEST' })
    expect(await githubToken(core, 'harness-1')).toMatchObject({ error: 'NOT_A_SWARM_AGENT' })
    const broken = setup(method => method === 'GET' ? ok([row('tab-1', 'agent-1')]) : ok({ token: 7 }))
    expect(await githubToken(broken.core, 'harness-1')).toMatchObject({ error: 'GITHUB_UNAVAILABLE' })
    const offline = setup(() => refuse(502, 'BACKEND_UNAVAILABLE'))
    expect(await githubToken(offline.core, 'harness-1')).toMatchObject({ error: 'BACKEND_UNAVAILABLE' })
  })

  it('writes nothing for a person\'s own agent, which keeps its own GitHub login', async () => {
    const { core } = setup(method => method === 'GET' ? ok([row('tab-1', 'agent-1')]) : issued('ghs_fixtureToken0000004'), [{ id: 'harness-1', plain: true }])
    expect(await githubToken(core, 'harness-1')).toMatchObject({ ok: true })
    expect(() => readFileSync(join(core.dataDir, 'swarm-github'))).toThrow()
  })
})

describe('keeping gh\'s token fresh', () => {
  const clock = () => { let t = Date.parse('2026-10-24T12:00:00.000Z'); return { now: () => t, advance: (ms: number) => { t += ms } } }

  it('gives a session with a task a token, renews it ten minutes before it expires, and takes it away when the task ends', async () => {
    const time = clock()
    let work = [{ tabId: 'tab-1', assignmentId: 'attempt-1', harnessId: 'harness-1' }]
    let next = 1
    const { core, backend, hosts } = setup((method, path) => path.endsWith('/assignments') ? ok(work)
      : method === 'GET' ? ok([row('tab-1', 'agent-1')])
      : issued(`ghs_fixtureToken000000${next++}`, new Date(time.now() + 3600_000).toISOString()))
    const refresher = new GitHubTokenRefresher(core, { now: time.now })
    await refresher.tick()
    expect(hosts()).toContain('ghs_fixtureToken0000001')
    const asked = () => backend.mock.calls.filter(c => c[0] === 'POST').length
    time.advance(60_000)
    await refresher.tick()
    expect(asked()).toBe(1)
    time.advance(3600_000 - 60_000 - RENEW_BELOW_MS)
    await refresher.tick()
    expect(asked()).toBe(2)
    expect(hosts()).toContain('ghs_fixtureToken0000002')
    // A new task asks again at once.
    work = [{ tabId: 'tab-1', assignmentId: 'attempt-2', harnessId: 'harness-1' }]
    await refresher.tick()
    expect(asked()).toBe(3)
    work = []
    await refresher.tick()
    expect(hosts()).toBe('{}\n')
    expect(asked()).toBe(3)
  })

  it('reads nothing from the backend while no session uses the app, and leaves tokens be while it is away', async () => {
    const quiet = setup(() => ok([]), [{ id: 'harness-1', plain: true }])
    await new GitHubTokenRefresher(quiet.core).tick()
    expect(quiet.backend).not.toHaveBeenCalled()
    let away = false
    const { core, hosts } = setup((method, path) => away ? refuse(502, 'BACKEND_UNAVAILABLE')
      : path.endsWith('/assignments') ? ok([{ tabId: 'tab-1', assignmentId: 'attempt-1', harnessId: 'harness-1' }])
      : method === 'GET' ? ok([row('tab-1', 'agent-1')]) : issued('ghs_fixtureToken0000009'))
    const refresher = new GitHubTokenRefresher(core)
    await refresher.tick()
    away = true
    await refresher.tick()
    expect(hosts()).toContain('ghs_fixtureToken0000009')
  })

  it('starts once, looks again on its interval, and stops', async () => {
    vi.useFakeTimers()
    try {
      const { core, backend } = setup(path => path === 'GET' ? ok([]) : ok([]))
      const refresher = new GitHubTokenRefresher(core, { intervalMs: 1000 })
      refresher.start()
      refresher.start()
      await vi.advanceTimersByTimeAsync(2500)
      expect(backend.mock.calls.filter(c => String(c[1]).endsWith('/assignments')).length).toBe(3)
      refresher.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(backend.mock.calls.filter(c => String(c[1]).endsWith('/assignments')).length).toBe(3)
    } finally { vi.useRealTimers() }
  })

  it('logs a look that fails and goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const core = fakeCore({ agents: { live: vi.fn(() => { throw new Error('registry gone') }) } })
    await new GitHubTokenRefresher(core).tick()
    expect(warn).toHaveBeenCalledWith('[super-tab] GitHub tokens not refreshed · registry gone')
    warn.mockRestore()
  })
})
