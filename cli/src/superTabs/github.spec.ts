import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import type { RegisteredSession } from '../lib/registry.js'
import { swarmGitHubLaunch, swarmGitHubSessionDir, writeSessionGitHub } from '../lib/swarmGitHub.js'
import { GitHubTokenRefresher, githubToken, RENEW_BELOW_MS } from './github.js'
import { hostForm } from './fixtures/read/index.js'
import { HostFeed } from './hostFeed.js'
import { SwarmReads } from './swarmReads.js'
import type { CoreApi } from '../core/api.js'

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
/** The machine's host form and Swarm reads, as the service hands them over. */
const sourcesOf = (core: CoreApi, now?: () => number) => { const held = { feed: new HostFeed(core, 'machine-1', { now }), reads: new SwarmReads(core) }; return () => held }
const HOST = '/api/super-tabs/hosts/machine-1/changes'
/** Makes [dir] and everything in it look untouched for [ms]. */
const age = (dir: string, ms: number) => {
  const then = new Date(Date.now() - ms)
  for (const path of [dir, join(dir, 'gh'), join(dir, 'gh', 'hosts.yml'), join(dir, 'gh', 'config.yml'), join(dir, 'gitconfig'), join(dir, 'trailers')]) {
    if (existsSync(path)) utimesSync(path, then, then)
  }
}

/** A core whose backend answers by path; one session per harness id, started to use the app unless `plain`. */
function setup(routes: (method: string, path: string, body: unknown) => Reply, sessions: Array<{ id: string; plain?: boolean }> = [{ id: 'harness-1' }]) {
  const dataDir = join(root, `data-${made++}`)
  const session = (s: { id: string; plain?: boolean }) =>
    ({ agentId: s.id, swarmSkill: { role: 'dev', key: `harness-codex-${s.id}`, ...(s.plain ? {} : { github: true }) } }) as unknown as RegisteredSession
  const live = sessions.map(session)
  /** Sessions stopped but still on this machine, which may run again. */
  const stopped: RegisteredSession[] = []
  const backend = vi.fn(async (method: string, path: string, body?: unknown) => routes(method, path, body))
  const core = fakeCore({ dataDir, account: { backend }, agents: { live: vi.fn(() => live), all: vi.fn(() => [...live, ...stopped]),
    byAgent: vi.fn((id: string) => live.find(s => s.agentId === id)) } })
  const hosts = (id = 'harness-1') => readFileSync(join(swarmGitHubSessionDir(dataDir, `harness-codex-${id}`)!, 'gh', 'hosts.yml'), 'utf8')
  const trailers = (id = 'harness-1') => readFileSync(join(swarmGitHubSessionDir(dataDir, `harness-codex-${id}`)!, 'trailers'), 'utf8')
  return { core, backend, hosts, trailers, live, stopped, session, dataDir }
}

describe('a local agent\'s GitHub token', () => {
  it('is asked for as the agent the roster lists for that harness on this machine, and written into its gh login', async () => {
    const { core, backend, hosts, trailers } = setup((method, path) => method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1')]))
      : path === '/api/super-tabs/tab-1/github-token?asAgentId=agent-1' ? issued('ghs_fixtureToken0000001') : refuse(404, 'NOT_FOUND'))
    const answer = await githubToken(core, 'harness-1', sourcesOf(core)())
    expect(answer).toMatchObject({ ok: true, value: { token: 'ghs_fixtureToken0000001', repository: 'acme/app', tabId: 'tab-1', agentId: 'agent-1' } })
    expect(backend).toHaveBeenCalledWith('GET', `${HOST}?full=1`, undefined)
    expect(backend).toHaveBeenCalledWith('POST', '/api/super-tabs/tab-1/github-token?asAgentId=agent-1', { machineId: 'machine-1' })
    expect(hosts()).toContain('oauth_token: ghs_fixtureToken0000001')
    expect(trailers()).toBe('Co-authored-by: Ada <ada@example.com>\nHarness-Agent: Atlas\n')
  })

  it('tries the harness\'s next Swarm when one has no task for it, and skips stopping and closing rows and other harnesses', async () => {
    const { core, backend } = setup((method, path) => method === 'GET'
      ? ok(hostForm([row('tab-0', 'agent-0', 'harness-2'), row('tab-x', 'agent-x', 'harness-1', { stopRequested: true }), row('tab-y', 'agent-y', 'harness-1', { closeSession: true }),
        row('tab-1', 'agent-1'), row('tab-2', 'agent-2')]))
      : path.startsWith('/api/super-tabs/tab-1/') ? refuse(409, 'NO_ASSIGNMENT') : issued('ghs_fixtureToken0000002'))
    expect(await githubToken(core, 'harness-1', sourcesOf(core)())).toMatchObject({ ok: true, value: { tabId: 'tab-2' } })
    expect(backend.mock.calls.filter(c => c[0] === 'POST').map(c => c[1])).toEqual([
      '/api/super-tabs/tab-1/github-token?asAgentId=agent-1', '/api/super-tabs/tab-2/github-token?asAgentId=agent-2'])
  })

  it('passes on the most telling refusal and empties the gh login when the server decided', async () => {
    const answers: Record<string, Reply> = { 'tab-1': refuse(409, 'NO_ASSIGNMENT'), 'tab-2': refuse(409, 'GITHUB_APP_NOT_INSTALLED', 'Install it: https://github.com/apps/x/installations/new') }
    const { core, hosts } = setup((method, path) => method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1'), row('tab-2', 'agent-2')]))
      : path.includes('tab-0') ? issued('x') : answers[path.split('/')[3]!]!)
    expect(await githubToken(core, 'harness-1', sourcesOf(core)())).toEqual({ error: 'GITHUB_APP_NOT_INSTALLED', detail: 'Install it: https://github.com/apps/x/installations/new', status: 409 })
    expect(hosts()).toBe('{}\n')
  })

  it('keeps an unexpired token when the server cannot be reached, and empties it when the app is not configured', async () => {
    let reply = issued('ghs_fixtureToken0000003')
    const { core, hosts } = setup((method) => method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1')])) : reply)
    await githubToken(core, 'harness-1', sourcesOf(core)())
    reply = refuse(503, 'BACKEND_UNAVAILABLE')
    expect(await githubToken(core, 'harness-1', sourcesOf(core)())).toMatchObject({ error: 'BACKEND_UNAVAILABLE' })
    expect(hosts()).toContain('ghs_fixtureToken0000003')
    reply = refuse(503, 'GITHUB_APP_NOT_CONFIGURED')
    await githubToken(core, 'harness-1', sourcesOf(core)())
    expect(hosts()).toBe('{}\n')
  })

  // Security review of #2390: a server whose app GitHub refuses (backend github/app.ts `misconfigured`: GitHub answered 401
  // to the app's own credentials) answers a 503 the backend decided, unlike GitHub not answering (GITHUB_UNAVAILABLE).
  it('empties the gh login when GitHub refuses the server\'s app, and keeps it while GitHub does not answer', async () => {
    let reply = issued('ghs_fixtureToken0000004')
    const { core, hosts } = setup((method) => method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1')])) : reply)
    await githubToken(core, 'harness-1', sourcesOf(core)())
    reply = refuse(503, 'GITHUB_UNAVAILABLE')
    await githubToken(core, 'harness-1', sourcesOf(core)())
    expect(hosts()).toContain('ghs_fixtureToken0000004')
    reply = refuse(503, 'GITHUB_APP_MISCONFIGURED')
    expect(await githubToken(core, 'harness-1', sourcesOf(core)())).toMatchObject({ error: 'GITHUB_APP_MISCONFIGURED', status: 503 })
    expect(hosts()).toBe('{}\n')
  })

  it('refuses a harness that is not running here, one in no Swarm, and a reply without a token', async () => {
    const { core } = setup(method => method === 'GET' ? ok(hostForm([])) : ok({}))
    expect(await githubToken(core, 'harness-9', sourcesOf(core)())).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
    expect(await githubToken(core, '../x', sourcesOf(core)())).toEqual({ error: 'INVALID_REQUEST' })
    expect(await githubToken(core, 'harness-1', sourcesOf(core)())).toMatchObject({ error: 'NOT_A_SWARM_AGENT' })
    const broken = setup(method => method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1')])) : ok({ token: 7 }))
    expect(await githubToken(broken.core, 'harness-1', sourcesOf(broken.core)())).toMatchObject({ error: 'GITHUB_UNAVAILABLE' })
    const offline = setup(() => refuse(502, 'BACKEND_UNAVAILABLE'))
    expect(await githubToken(offline.core, 'harness-1', sourcesOf(offline.core)())).toMatchObject({ error: 'BACKEND_UNAVAILABLE' })
  })

  it('writes nothing for a person\'s own agent, which keeps its own GitHub login', async () => {
    const { core } = setup(method => method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1')])) : issued('ghs_fixtureToken0000004'), [{ id: 'harness-1', plain: true }])
    expect(await githubToken(core, 'harness-1', sourcesOf(core)())).toMatchObject({ ok: true })
    expect(() => readFileSync(join(core.dataDir, 'swarm-github'))).toThrow()
  })
})

describe('keeping gh\'s token fresh', () => {
  const clock = () => { let t = Date.parse('2026-10-24T12:00:00.000Z'); return { now: () => t, advance: (ms: number) => { t += ms } } }

  it('gives a session with a task a token, renews it ten minutes before it expires, and takes it away when the task ends', async () => {
    const time = clock()
    let work = [{ tabId: 'tab-1', assignmentId: 'attempt-1', harnessId: 'harness-1' }]
    let next = 1
    const { core, backend, hosts } = setup(method => method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1')], { assignments: work }))
      : issued(`ghs_fixtureToken000000${next++}`, new Date(time.now() + 3600_000).toISOString()))
    const refresher = new GitHubTokenRefresher(core, sourcesOf(core, time.now), { now: time.now })
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

  // Local Team account run, 2026-10-28: a task cancelled as its agent stopped left the last token in that session's gh login,
  // since the refresher looks only at running sessions.
  it('empties the gh login of a session that stopped, also one left from before the daemon started', async () => {
    const { core, hosts, live, stopped, dataDir } = setup(method => method === 'GET'
      ? ok(hostForm([row('tab-1', 'agent-1')], { assignments: [{ tabId: 'tab-1', assignmentId: 'attempt-1', harnessId: 'harness-1' }] }))
      : issued('ghs_fixtureToken0000007'))
    const refresher = new GitHubTokenRefresher(core, sourcesOf(core))
    await refresher.tick()
    expect(hosts()).toContain('ghs_fixtureToken0000007')
    stopped.push(...live.splice(0))
    await refresher.tick()
    expect(hosts()).toBe('{}\n')
    // A session that stopped while no daemon ran, and is gone from this machine since: its folder is removed.
    const old = swarmGitHubSessionDir(dataDir, 'harness-codex-old')!
    writeSessionGitHub(old, 'ghs_fixtureToken0000008')
    age(old, 16 * 60_000)
    await new GitHubTokenRefresher(core, sourcesOf(core)).tick()
    expect(existsSync(old)).toBe(false)
  })

  // Security review of #1978, Minor: a pass read every stopped session's folder, so passes grew with every session ever run.
  it('keeps the folder of a stopped session that may run again, emptied, and removes one whose session is gone', async () => {
    const { core, live, stopped, session, dataDir } = setup(() => ok(hostForm([])))
    const kept = swarmGitHubSessionDir(dataDir, 'harness-codex-harness-1')!, gone = swarmGitHubSessionDir(dataDir, 'harness-codex-old')!
    writeSessionGitHub(kept, 'ghs_fixtureToken0000003', ['Harness-Agent: Atlas'])
    writeSessionGitHub(gone, 'ghs_fixtureToken0000002')
    age(gone, 16 * 60_000)
    live.length = 0
    stopped.push(session({ id: 'harness-1' }))
    await new GitHubTokenRefresher(core, sourcesOf(core)).tick()
    expect(readFileSync(join(kept, 'gh', 'hosts.yml'), 'utf8')).toBe('{}\n')
    expect(readFileSync(join(kept, 'trailers'), 'utf8')).toBe('Harness-Agent: Atlas\n')
    expect(existsSync(gone)).toBe(false)
  })

  // Review of #1998: a start writes its session's folder before the session is registered (core/agents/create.ts), and a
  // pass in that gap removed it. Only a folder untouched for 15 minutes, longer than any start waits, goes.
  it('keeps the folder of a session still starting, and of one not read just now, until it is 15 minutes untouched', async () => {
    const dataDir = mkdtempSync(join(root, 'starting-'))
    const core = fakeCore({ dataDir, agents: { live: vi.fn(() => []), all: vi.fn(() => []), byAgent: vi.fn(() => undefined) } })
    swarmGitHubLaunch('harness-codex-starting', { dataDir, command: '/bin/true', port: 1, machineId: 'machine-1' }, 'darwin')
    const dir = swarmGitHubSessionDir(dataDir, 'harness-codex-starting')!
    expect(existsSync(dir)).toBe(true)
    await new GitHubTokenRefresher(core, () => ({}) as never).tick()
    expect(existsSync(dir), 'folder of a session still starting').toBe(true)
    // A token in a young folder of no known session is still taken out.
    writeSessionGitHub(dir, 'ghs_fixtureToken0000001')
    await new GitHubTokenRefresher(core, () => ({}) as never).tick()
    expect(readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8')).toBe('{}\n')
    age(dir, 14 * 60_000)
    await new GitHubTokenRefresher(core, () => ({}) as never).tick()
    expect(existsSync(dir)).toBe(true)
    age(dir, 16 * 60_000)
    await new GitHubTokenRefresher(core, () => ({}) as never).tick()
    expect(existsSync(dir)).toBe(false)
  })

  // Security review of #1978: a token fetch still in flight as its session stopped wrote the token after the folder was
  // emptied, and the folder was not looked at again until the daemon restarted.
  it('empties a stopped session\'s gh login again when a late write puts a token back', async () => {
    const { core, hosts, live, stopped, dataDir } = setup(() => ok(hostForm([])))
    stopped.push(...live.splice(0))
    const dir = swarmGitHubSessionDir(dataDir, 'harness-codex-harness-1')!
    writeSessionGitHub(dir, 'ghs_fixtureToken0000005')
    const refresher = new GitHubTokenRefresher(core, sourcesOf(core))
    await refresher.tick()
    expect(hosts()).toBe('{}\n')
    writeSessionGitHub(dir, 'ghs_fixtureToken0000006')
    await refresher.tick()
    expect(hosts()).toBe('{}\n')
  })

  // Security review of #1978: a file with a session's name in the sessions folder failed every look, and no token was renewed.
  it('skips anything in the sessions folder that is not a session\'s folder, and renews as before', async () => {
    const { core, hosts, dataDir } = setup(method => method === 'GET'
      ? ok(hostForm([row('tab-1', 'agent-1')], { assignments: [{ tabId: 'tab-1', assignmentId: 'attempt-1', harnessId: 'harness-1' }] }))
      : issued('ghs_fixtureToken0000004'))
    const sessions = dirname(swarmGitHubSessionDir(dataDir, 'harness-codex-stray')!)
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'harness-codex-stray'), 'not a folder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await new GitHubTokenRefresher(core, sourcesOf(core)).tick()
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
    expect(hosts()).toContain('ghs_fixtureToken0000004')
  })

  it('reads nothing from the backend while no session uses the app, and leaves tokens be while it is away', async () => {
    const quiet = setup(() => ok(hostForm([])), [{ id: 'harness-1', plain: true }])
    await new GitHubTokenRefresher(quiet.core, sourcesOf(quiet.core)).tick()
    expect(quiet.backend).not.toHaveBeenCalled()
    let away = false
    const { core, hosts } = setup((method, path) => away ? refuse(502, 'BACKEND_UNAVAILABLE')
      : method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1')], { assignments: [{ tabId: 'tab-1', assignmentId: 'attempt-1', harnessId: 'harness-1' }] }))
      : issued('ghs_fixtureToken0000009'))
    const refresher = new GitHubTokenRefresher(core, sourcesOf(core))
    await refresher.tick()
    away = true
    await refresher.tick()
    expect(hosts()).toContain('ghs_fixtureToken0000009')
  })

  // Mac Auto, 2026-10-29: the gh login stayed empty until the minute's pass, so a Builder's first `gh auth status` said
  // "You are not logged into any GitHub hosts" and it stopped.
  it('gives a task its token as soon as the host reads it, once per task, and only while it runs', async () => {
    let work: Array<Record<string, unknown>> = []
    let refuseToken = false
    const { core, backend, hosts } = setup(method => method === 'GET' ? ok(hostForm([row('tab-1', 'agent-1')], { assignments: work }))
      : refuseToken ? refuse(503, 'GITHUB_UNAVAILABLE') : issued('ghs_fixtureToken0000001', '2099-01-01T00:00:00.000Z'))
    const sources = sourcesOf(core)
    const refresher = new GitHubTokenRefresher(core, sources, { intervalMs: 3600_000 })
    const stopWatching = sources().feed.watch(read => refresher.assigned(read))
    const asked = () => backend.mock.calls.filter(c => c[0] === 'POST').length
    // Not running: a read changes nothing.
    work = [{ tabId: 'tab-1', assignmentId: 'attempt-1', harnessId: 'harness-1' }]
    await sources().feed.refresh()
    expect(asked()).toBe(0)
    refresher.start()
    await refresher.tick()
    expect(asked()).toBe(1)
    work = [{ tabId: 'tab-1', assignmentId: 'attempt-2', harnessId: 'harness-1' }]
    await sources().feed.refresh()
    await refresher.tick()
    expect(asked()).toBe(2)
    expect(hosts()).toContain('ghs_fixtureToken0000001')
    // The same task read again asks nothing more; nor does a task whose token could not be had, until the minute's pass.
    await sources().feed.refresh()
    await refresher.tick()
    expect(asked()).toBe(2)
    refuseToken = true
    work = [{ tabId: 'tab-1', assignmentId: 'attempt-3', harnessId: 'harness-1' }]
    await sources().feed.refresh()
    await refresher.tick()
    expect(asked()).toBe(3)
    await sources().feed.refresh()
    await new Promise(resolve => setImmediate(resolve))
    expect(asked()).toBe(3)
    // A session that does not use the app is never looked at for it.
    refresher.stop()
    stopWatching()
  })

  it('reads on when a watcher of the host form throws, and stops telling one that stopped watching', async () => {
    const { core } = setup(() => ok(hostForm([])))
    const feed = sourcesOf(core)().feed
    const thrower = vi.fn(() => { throw new Error('watcher broke') }), told = vi.fn()
    feed.watch(thrower)
    const stop = feed.watch(told)
    await expect(feed.refresh()).resolves.toMatchObject({ roster: [] })
    expect(told).toHaveBeenCalledOnce()
    stop()
    await feed.refresh()
    expect(told).toHaveBeenCalledOnce()
    expect(thrower).toHaveBeenCalledTimes(2)
  })

  it('starts once, looks again on its interval, and stops', async () => {
    vi.useFakeTimers()
    try {
      const { core, backend } = setup(() => ok(hostForm([])))
      const refresher = new GitHubTokenRefresher(core, sourcesOf(core), { intervalMs: 1000 })
      refresher.start()
      refresher.start()
      await vi.advanceTimersByTimeAsync(2500)
      expect(backend.mock.calls.filter(c => String(c[1]).startsWith(HOST)).length).toBe(3)
      refresher.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(backend.mock.calls.filter(c => String(c[1]).startsWith(HOST)).length).toBe(3)
    } finally { vi.useRealTimers() }
  })

  it('logs a look that fails and goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const core = fakeCore({ agents: { live: vi.fn(() => { throw new Error('registry gone') }) } })
    await new GitHubTokenRefresher(core, sourcesOf(core)).tick()
    expect(warn).toHaveBeenCalledWith('[super-tab] GitHub tokens not refreshed · registry gone')
    warn.mockRestore()
  })
})
