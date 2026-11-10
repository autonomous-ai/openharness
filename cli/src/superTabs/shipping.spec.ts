import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Run } from '../lib/github.js'
import { fakeCore } from '../testing/fakeCore.js'
import { SHIPPING_EVERY_MS, SHIPPING_FIRST_MS, SHIPPING_RETRY_MS, ShippingReporter } from './shipping.js'

const DAY = 86_400_000, WEEK = 7 * DAY
/** Monday 2026-11-09 00:00 UTC. */
const MON = Date.UTC(2026, 10, 9)
const PATH = '/api/super-tabs/hosts/machine-1/shipping'
type Reply = { status: number; body: Record<string, unknown> }
const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data } })
const refuse = (status: number, code: string): Reply => ({ status, body: { success: false, error: { code, message: code } } })
const target = (over: Record<string, unknown> = {}) => ({ tabId: 'tab-1', repositories: ['acme/web'], agents: [{ id: 'a1', name: 'Atlas', from: MON - 7 * DAY }], ...over })

let warned: string[], logged: string[]
beforeEach(() => {
  // The clock is the Thursday of that week, so what the backend names stays within the weeks a reading may start back.
  vi.useFakeTimers({ now: MON + 3 * DAY })
  warned = []
  logged = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.join(' ')) })
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')) })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

/** What GitHub says of one agent's week: an issue closed with a pull request of this person's that merged. */
const github = (issues: unknown[] = []): Run => async args => {
  const query = args.find(a => a.startsWith('query='))!
  const data = query.includes('nameWithOwner') ? { repository: { nameWithOwner: 'acme/web' } }
    : query.includes('closedByPullRequestsReferences') ? { viewer: { login: 'ann' }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues } }
      : { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }
  return { stdout: JSON.stringify({ data }) }
}
const shipped = (days: number, ...labels: string[]) => ({ closedAt: new Date(MON + days * DAY).toISOString(), stateReason: 'COMPLETED',
  labels: { nodes: ['builder:atlas', ...labels].map(name => ({ name })) },
  closedByPullRequestsReferences: { nodes: [{ number: 7, title: 'Add search', merged: true, mergedAt: new Date(MON + days * DAY).toISOString(), author: { login: 'ann' } }] } })
/** gh as `github` answers it, but the lookup of the repository named `broken` fails as `failure` does. */
const failingOn = (broken: string, failure: Record<string, unknown>): Run => async args => {
  if (args.includes(`name=${broken}`)) throw Object.assign(new Error('gh'), failure)
  return github()(args)
}
const timingOut = { killed: true, signal: 'SIGKILL' }

/** The account the core names as signed in: a service process asks it, as its own `signedIn()` is always false. */
const ann = async () => ({ accountId: 'ann', email: 'ann@example.com' })

function setup(routes: (method: string, path: string, body: unknown) => Reply, options: { run?: Run; core?: Parameters<typeof fakeCore>[0] } = {}) {
  const backend = vi.fn(async (method: string, path: string, body?: unknown) => routes(method, path, body))
  const { account, ...rest } = options.core ?? {}
  const core = fakeCore({ account: { backend, identity: ann, signedIn: () => false, ...account }, ...rest })
  const reporter = new ShippingReporter(core, { run: options.run ?? github(), random: () => 0, now: () => Date.now() })
  return { backend, core, reporter }
}
/** A backend with these Swarms to read, which keeps the reports it is given. */
function reading(swarms: unknown[], answer: (tabId: string) => Reply = () => ok({ applied: 1, skipped: 0, capped: 0 })) {
  const reports: Array<{ tabId: string; agents: unknown[] }> = []
  return { reports, routes: (method: string, _path: string, body: unknown): Reply => {
    if (method === 'GET') return ok({ swarms })
    reports.push(body as { tabId: string; agents: unknown[] })
    return answer((body as { tabId: string }).tabId)
  } }
}

describe('a pass', () => {
  it('asks what to read, reads GitHub, and reports counts per agent and week', async () => {
    const reports: unknown[] = []
    const { backend, reporter } = setup((method, _path, body) => {
      if (method === 'GET') return ok({ swarms: [target()] })
      reports.push(body)
      return ok({ applied: 1, skipped: 0, capped: 0 })
    }, { run: github([shipped(1, 'P1'), shipped(2), shipped(-3, 'P0')]) })
    await reporter.pass()
    expect(backend).toHaveBeenCalledWith('GET', PATH, undefined)
    expect(reports).toEqual([{ tabId: 'tab-1', agents: [{ agentId: 'a1', name: 'Atlas', from: MON - 7 * DAY,
      weeks: [{ week: MON - 7 * DAY, P0: 1 }, { week: MON, P1: 1, none: 1 }] }] }])
    // What it read is the measure the daemon keeps, as information: only a trouble is a warning.
    expect(logged).toEqual([expect.stringMatching(/^\[shipping\] read swarms=1 issues=3 ms=\d+$/)])
    expect(warned).toEqual([])
  })

  it('reports an agent that shipped nothing with no weeks, which settles what it read', async () => {
    const { reports, routes } = reading([target()])
    await setup(routes).reporter.pass()
    expect(reports[0]!.agents).toEqual([{ agentId: 'a1', name: 'Atlas', from: MON - 7 * DAY, weeks: [] }])
  })

  it('reports why when GitHub cannot be read, keeping the numbers there, and says it once', async () => {
    const signedOut: Run = async () => { throw Object.assign(new Error('gh'), { stderr: 'gh auth login' }) }
    const { reports, routes } = reading([target({ agents: [{ id: 'a1', name: 'Atlas', from: MON }, { id: 'a2', name: 'Nova', from: MON }] })])
    const { reporter } = setup(routes, { run: signedOut })
    await reporter.pass()
    await reporter.pass()
    expect(reports[0]).toEqual({ tabId: 'tab-1', agents: [{ agentId: 'a1', failed: 'GH_SIGNED_OUT' }, { agentId: 'a2', failed: 'GH_SIGNED_OUT' }] })
    expect(reports.length).toBe(2)
    expect(warned).toEqual(['[shipping] could not read GitHub: GH_SIGNED_OUT'])
    expect(logged).toEqual([])
  })

  it('names a failure that is not gh\'s as GH_FAILED: a reading that breaks on what it was told', async () => {
    const { reports, routes } = reading([target({ agents: [{ id: 'a1', name: 'Atlas', from: 9_000_000_000_000_000 }] })])
    await setup(routes).reporter.pass()
    expect(reports[0]!.agents).toEqual([{ agentId: 'a1', failed: 'GH_FAILED' }])
  })

  it('fails an agent whose search is too big on its own, and reports the others', async () => {
    const endless: Run = async args => {
      const query = args.find(a => a.startsWith('query='))!, q = args.find(a => a.startsWith('q='))
      if (query.includes('closedByPullRequestsReferences') && q?.includes('builder:nova')) {
        return { stdout: JSON.stringify({ data: { viewer: { login: 'ann' }, search: { pageInfo: { hasNextPage: true, endCursor: 'more' }, nodes: [] } } }) }
      }
      return github([shipped(1, 'P1')])(args)
    }
    const { reports, routes } = reading([target({ agents: [{ id: 'a1', name: 'Atlas', from: MON }, { id: 'a2', name: 'Nova', from: MON }] })])
    await setup(routes, { run: endless }).reporter.pass()
    expect(reports[0]!.agents).toEqual([{ agentId: 'a1', name: 'Atlas', from: MON, weeks: [{ week: MON, P1: 1 }] }, { agentId: 'a2', failed: 'TOO_MANY' }])
    expect(warned).toEqual(['[shipping] could not read GitHub: TOO_MANY'])
    expect(logged).toEqual([])
  })

  it('says what the backend skipped or cut', async () => {
    const { reporter } = setup(method => method === 'GET' ? ok({ swarms: [target()] }) : ok({ applied: 0, skipped: 1, capped: 2 }))
    await reporter.pass()
    expect(warned).toEqual(['[shipping] the backend skipped 1 agents and cut 2 weeks'])
    expect(logged).toEqual([expect.stringMatching(/read swarms=1/)])
  })

  it('reads and reports each Swarm on its own: one that cannot be reported does not stop the next', async () => {
    const { reports, routes } = reading([target({ tabId: 'tab-1' }), target({ tabId: 'tab-2' })], tabId => tabId === 'tab-1' ? refuse(503, 'SWARM_BUSY') : ok({ applied: 1, skipped: 0, capped: 0 }))
    await setup(routes).reporter.pass()
    expect(reports.map(report => report.tabId)).toEqual(['tab-1', 'tab-2'])
    expect(warned).toEqual(['[shipping] could not report: SWARM_BUSY 503'])
    expect(logged).toEqual([])
  })

  it('goes by the account the core names, for a service process\'s own signedIn() is false whoever is signed in', async () => {
    const { backend, reporter } = setup(() => ok({ swarms: [] }), { core: { account: { signedIn: () => false, identity: ann } } })
    await reporter.pass()
    expect(backend).toHaveBeenCalledWith('GET', PATH, undefined)
  })

  it('is nothing at all while signed out, without a machine, or with nothing to read', async () => {
    const calls = vi.fn(() => ok({ swarms: [] }))
    await setup(calls, { core: { account: { identity: async () => null } } }).reporter.pass()
    await setup(calls, { core: { account: { identity: async () => { throw new Error('Core disconnected') } } } }).reporter.pass()
    await setup(calls, { core: { daemon: { machineId: () => '' } } }).reporter.pass()
    await setup(calls).reporter.pass()
    expect(calls).toHaveBeenCalledTimes(1)
    expect(warned).toEqual([])
    expect(logged).toEqual([])
  })

  it('leaves out what the backend got wrong: a Swarm without a repository or a usable agent, a name no label can be, a start too far back', async () => {
    const { reports, routes } = reading([
      target({ tabId: 'no repository', repositories: [] }), target({ tabId: 'bad_repository', repositories: ['not a repository', 7] }),
      target({ tabId: 'tab-quotes', agents: [{ id: 'a1', name: 'say "hi"', from: MON }] }), target({ tabId: 'tab-from', agents: [{ id: 'a1', name: 'Atlas', from: 'soon' }] }),
      target({ tabId: 'tab-old', agents: [{ id: 'a1', name: 'Atlas', from: MON - 11 * WEEK }] }),
      target({ tabId: 'tab-id', agents: [{ id: 'a 1', name: 'Atlas', from: MON }, { name: 7, from: MON }] }), { agents: 'none' }, 'nothing',
      ...Array.from({ length: 101 }, (_, i) => target({ tabId: `many-${i}` }))])
    await setup(routes).reporter.pass()
    expect(reports.length).toBe(100)
  })

  it('reads at most fifty agents of a Swarm and twenty of its repositories, as the backend takes them', async () => {
    const lookups: string[] = []
    const run: Run = async args => {
      if (args.some(arg => arg.startsWith('owner='))) lookups.push(args.find(arg => arg.startsWith('name='))!)
      return github()(args)
    }
    const { reports, routes } = reading([target({ repositories: Array.from({ length: 25 }, (_, i) => `acme/repo-${i}`),
      agents: Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, name: `Agent ${i}`, from: MON })) })])
    await setup(routes, { run }).reporter.pass()
    expect(reports[0]!.agents.length).toBe(50)
    expect(lookups).toEqual(Array.from({ length: 20 }, (_, i) => `name=repo-${i}`))
  })

  it('keeps the repository names of what the backend still names, and forgets the others', async () => {
    const lookups: string[] = []
    const run: Run = async args => {
      if (args.some(arg => arg.startsWith('owner='))) lookups.push(args.find(arg => arg.startsWith('name='))!.slice(5))
      return github()(args)
    }
    let swarms = [target({ repositories: ['acme/web'] })]
    const { reporter } = setup(method => method === 'GET' ? ok({ swarms }) : ok({ applied: 1, skipped: 0, capped: 0 }), { run })
    await reporter.pass()
    await reporter.pass()
    swarms = [target({ repositories: ['acme/api'] })]
    await reporter.pass()
    swarms = [target({ repositories: ['acme/web'] })]
    await reporter.pass()
    expect(lookups).toEqual(['web', 'api', 'web'])
  })
})

describe('a pass that fails', () => {
  it('asks a backend that is busy or out of reach again a minute later, once, and then in a quarter hour', async () => {
    const { backend, reporter } = setup(() => refuse(502, 'BACKEND_UNAVAILABLE'))
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    expect(backend).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SHIPPING_RETRY_MS - 1)
    expect(backend).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(backend).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(SHIPPING_EVERY_MS - 1)
    expect(backend).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(backend).toHaveBeenCalledTimes(3)
    expect(warned).toEqual(['[shipping] could not ask what to read: BACKEND_UNAVAILABLE 502'])
    reporter.stop()
  })

  it('says once that a backend without the routes does not serve the leaderboard yet, and asks again in a quarter hour', async () => {
    const { backend, reporter } = setup(() => refuse(404, 'NOT_FOUND'))
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS + SHIPPING_EVERY_MS - 1)
    expect(backend).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(backend).toHaveBeenCalledTimes(2)
    expect(warned).toEqual(['[shipping] the backend does not serve the leaderboard yet'])
    reporter.stop()
  })

  it('waits a quarter hour after a refusal too, which a minute does not change', async () => {
    const { backend, reporter } = setup(() => refuse(426, 'UPDATE_REQUIRED'))
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS + SHIPPING_EVERY_MS - 1)
    expect(backend).toHaveBeenCalledTimes(1)
    expect(warned).toEqual(['[shipping] could not ask what to read: UPDATE_REQUIRED 426'])
    reporter.stop()
  })

  it('names a failure that is no answer of the backend\'s, and tries again a minute later', async () => {
    const { backend, reporter } = setup(() => { throw new Error('offline') })
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS + SHIPPING_RETRY_MS)
    expect(backend).toHaveBeenCalledTimes(2)
    expect(warned).toEqual(['[shipping] could not ask what to read: failed'])
    reporter.stop()
    const second = setup(method => method === 'GET' ? ok({ swarms: [target()] }) : (() => { throw new Error('offline') })())
    await second.reporter.pass()
    expect(warned[1]).toBe('[shipping] could not report: failed')
  })

  it('reads again only the Swarms that failed, once, when a minute may mend it', async () => {
    const { reports, routes } = reading([target({ tabId: 'tab-1', repositories: ['acme/web'] }), target({ tabId: 'tab-2', repositories: ['acme/api'] })])
    const { reporter } = setup(routes, { run: failingOn('web', timingOut) })
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    expect(reports.map(report => report.tabId)).toEqual(['tab-1', 'tab-2'])
    await vi.advanceTimersByTimeAsync(SHIPPING_RETRY_MS)
    expect(reports.map(report => report.tabId)).toEqual(['tab-1', 'tab-2', 'tab-1'])
    // It failed again: the next look is in a quarter hour, at both.
    await vi.advanceTimersByTimeAsync(SHIPPING_EVERY_MS - 1)
    expect(reports.length).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(reports.map(report => report.tabId)).toEqual(['tab-1', 'tab-2', 'tab-1', 'tab-1', 'tab-2'])
    expect(warned).toEqual(['[shipping] could not read GitHub: TIMEOUT'])
    reporter.stop()
  })

  it('reads again a Swarm whose report the backend could not take for a moment, not one it refused', async () => {
    for (const [status, code, again] of [[503, 'SWARM_BUSY', true], [400, 'VALIDATION_ERROR', false]] as const) {
      const { reports, routes } = reading([target()], () => refuse(status, code))
      const { reporter } = setup(routes)
      reporter.start()
      await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS + SHIPPING_RETRY_MS)
      expect(reports.length, code).toBe(again ? 2 : 1)
      reporter.stop()
    }
  })

  it('waits a quarter hour for what a minute does not change: a missing gh, a sign-in, a limit, a search too big', async () => {
    const endless: Run = async () => ({ stdout: JSON.stringify({ data: { viewer: { login: 'ann' }, search: { pageInfo: { hasNextPage: true, endCursor: 'more' }, nodes: [] } } }) })
    const failures: Array<[string, Run]> = [['GH_MISSING', failingOn('web', { code: 'ENOENT' })], ['GH_SIGNED_OUT', failingOn('web', { stderr: 'gh auth login' })],
      ['RATE_LIMITED', failingOn('web', { stderr: 'HTTP 429' })], ['TOO_MANY', async args => args.find(arg => arg.startsWith('query='))!.includes('nameWithOwner') ? github()(args) : endless(args)]]
    for (const [code, run] of failures) {
      const { reports, routes } = reading([target()])
      const { reporter } = setup(routes, { run })
      reporter.start()
      await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS + SHIPPING_EVERY_MS - 1)
      expect(reports.length, code).toBe(1)
      expect(warned.at(-1), code).toBe(`[shipping] could not read GitHub: ${code}`)
      await vi.advanceTimersByTimeAsync(1)
      expect(reports.length, code).toBe(2)
      reporter.stop()
    }
  })
})

describe('the schedule', () => {
  it('looks soon after starting, then every quarter hour, once however often it is started, until stopped', async () => {
    const { backend, reporter } = setup(method => method === 'GET' ? ok({ swarms: [] }) : ok({}))
    reporter.start()
    reporter.start()
    expect(backend).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    expect(backend).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SHIPPING_EVERY_MS)
    expect(backend).toHaveBeenCalledTimes(2)
    reporter.stop()
    await vi.advanceTimersByTimeAsync(2 * SHIPPING_EVERY_MS)
    expect(backend).toHaveBeenCalledTimes(2)
    reporter.stop()
  })

  it('spreads the first look of computers that start together, and forgets a failure when stopped', async () => {
    const core = fakeCore({ account: { backend: vi.fn(async () => refuse(500, 'X')), identity: ann } })
    const late = new ShippingReporter(core, { run: github(), random: () => 1 })
    late.start()
    await vi.advanceTimersByTimeAsync(2 * SHIPPING_FIRST_MS - 1)
    expect(core.account.backend).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(core.account.backend).toHaveBeenCalledTimes(1)
    late.stop()
    await late.pass()
    expect(warned.length).toBe(2)
  })

  it('is not scheduled again by a pass that was running when it was stopped', async () => {
    let answer: (reply: Reply) => void = () => {}
    const backend = vi.fn(() => new Promise<Reply>(resolve => { answer = resolve }))
    const reporter = new ShippingReporter(fakeCore({ account: { backend, identity: ann } }), { run: github(), random: () => 0 })
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    expect(backend).toHaveBeenCalledTimes(1)
    reporter.stop()
    answer(ok({ swarms: [] }))
    await vi.advanceTimersByTimeAsync(2 * SHIPPING_EVERY_MS)
    expect(backend).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps one chain of looks when it is stopped and started again while a pass is running', async () => {
    let finish: () => void = () => {}
    const backend = vi.fn().mockImplementationOnce(() => new Promise<Reply>(resolve => { finish = () => resolve(ok({ swarms: [] })) }))
      .mockImplementation(async () => ok({ swarms: [] }))
    const reporter = new ShippingReporter(fakeCore({ account: { backend, identity: ann } }), { run: github(), random: () => 0 })
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    expect(backend).toHaveBeenCalledTimes(1)
    reporter.stop()
    reporter.start()
    finish()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    expect(backend).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3 * SHIPPING_EVERY_MS)
    expect(backend).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(1)
    reporter.stop()
  })

  it('reports nothing of what it was reading when it is stopped meanwhile: another account may be signed in then', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>(resolve => { open = resolve })
    const run: Run = async args => { await gate; return github()(args) }
    const { reports, routes } = reading([target()])
    const { reporter } = setup(routes, { run })
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    reporter.stop()
    open()
    await vi.advanceTimersByTimeAsync(2 * SHIPPING_EVERY_MS)
    expect(reports).toEqual([])
    expect(logged).toEqual([])
  })

  it('reads no more Swarms when it is stopped between two', async () => {
    const lookups: string[] = []
    const run: Run = async args => {
      if (args.some(arg => arg.startsWith('owner='))) lookups.push(args.find(arg => arg.startsWith('name='))!)
      return github()(args)
    }
    const reports: unknown[] = []
    let stop = () => {}
    const { reporter } = setup((method, _path, body) => {
      if (method === 'GET') return ok({ swarms: [target({ tabId: 'tab-1', repositories: ['acme/web'] }), target({ tabId: 'tab-2', repositories: ['acme/api'] })] })
      reports.push(body)
      // Stopped while the first report is on its way.
      stop()
      return ok({ applied: 1, skipped: 0, capped: 0 })
    }, { run })
    stop = () => reporter.stop()
    await reporter.pass()
    expect(reports.length).toBe(1)
    expect(lookups).toEqual(['name=web'])
    expect(logged).toEqual([])
  })

  it('reads with the machine\'s own gh and spreads its first look at random, unless told otherwise', async () => {
    const core = fakeCore({ account: { backend: vi.fn(async () => ok({ swarms: [] })), identity: ann } })
    const reporter = new ShippingReporter(core)
    reporter.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2 * SHIPPING_FIRST_MS)
    expect(core.account.backend).toHaveBeenCalledTimes(1)
    reporter.stop()
  })

  it('keeps one timer, and none once stopped', async () => {
    const { reporter } = setup(() => ok({ swarms: [] }))
    reporter.start()
    expect(vi.getTimerCount()).toBe(1)
    reporter.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
