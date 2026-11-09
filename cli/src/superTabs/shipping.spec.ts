import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Run } from '../lib/github.js'
import { fakeCore } from '../testing/fakeCore.js'
import { SHIPPING_EVERY_MS, SHIPPING_FIRST_MS, SHIPPING_RETRY_MS, ShippingReporter } from './shipping.js'

const DAY = 86_400_000
/** Monday 2026-11-09 00:00 UTC. */
const MON = Date.UTC(2026, 10, 9)
const PATH = '/api/super-tabs/hosts/machine-1/shipping'
type Reply = { status: number; body: Record<string, unknown> }
const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data } })
const refuse = (status: number, code: string): Reply => ({ status, body: { success: false, error: { code, message: code } } })
const target = (over: Record<string, unknown> = {}) => ({ tabId: 'tab-1', repositories: ['acme/web'], agents: [{ id: 'a1', name: 'Atlas', from: MON - 7 * DAY }], ...over })

let warned: string[]
beforeEach(() => {
  vi.useFakeTimers()
  warned = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.join(' ')) })
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

function setup(routes: (method: string, path: string, body: unknown) => Reply, options: { run?: Run; core?: Parameters<typeof fakeCore>[0] } = {}) {
  const backend = vi.fn(async (method: string, path: string, body?: unknown) => routes(method, path, body))
  const core = fakeCore({ account: { backend }, ...options.core })
  const reporter = new ShippingReporter(core, { run: options.run ?? github(), random: () => 0, now: () => Date.now() })
  return { backend, core, reporter }
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
    expect(warned).toEqual([expect.stringMatching(/^\[shipping\] read swarms=1 issues=3 ms=\d+$/)])
  })

  it('reports an agent that shipped nothing with no weeks, which settles what it read', async () => {
    const reports: any[] = []
    const { reporter } = setup((method, _path, body) => method === 'GET' ? ok({ swarms: [target()] }) : (reports.push(body), ok({ applied: 1, skipped: 0, capped: 0 })))
    await reporter.pass()
    expect(reports[0].agents).toEqual([{ agentId: 'a1', name: 'Atlas', from: MON - 7 * DAY, weeks: [] }])
  })

  it('reports why when GitHub cannot be read, keeping the numbers there, and says it once', async () => {
    const reports: any[] = []
    const signedOut: Run = async () => { throw Object.assign(new Error('gh'), { stderr: 'gh auth login' }) }
    const { reporter } = setup((method, _path, body) => method === 'GET' ? ok({ swarms: [target({ agents: [{ id: 'a1', name: 'Atlas', from: MON }, { id: 'a2', name: 'Nova', from: MON }] })] })
      : (reports.push(body), ok({ applied: 2, skipped: 0, capped: 0 })), { run: signedOut })
    await reporter.pass()
    await reporter.pass()
    expect(reports[0]).toEqual({ tabId: 'tab-1', agents: [{ agentId: 'a1', failed: 'GH_SIGNED_OUT' }, { agentId: 'a2', failed: 'GH_SIGNED_OUT' }] })
    expect(reports.length).toBe(2)
    expect(warned).toEqual(['[shipping] could not read GitHub: GH_SIGNED_OUT'])
  })

  it('names a failure that is not gh\'s as GH_FAILED: a reading that breaks on what it was told', async () => {
    const reports: any[] = []
    const { reporter } = setup((method, _path, body) => method === 'GET' ? ok({ swarms: [target({ agents: [{ id: 'a1', name: 'Atlas', from: 9_000_000_000_000_000 }] })] })
      : (reports.push(body), ok({ applied: 1, skipped: 0, capped: 0 })))
    await reporter.pass()
    expect(reports[0].agents).toEqual([{ agentId: 'a1', failed: 'GH_FAILED' }])
  })

  it('says what the backend skipped or cut', async () => {
    const { reporter } = setup(method => method === 'GET' ? ok({ swarms: [target()] }) : ok({ applied: 0, skipped: 1, capped: 2 }))
    await reporter.pass()
    expect(warned).toEqual(['[shipping] the backend skipped 1 agents and cut 2 weeks', expect.stringMatching(/read swarms=1/)])
  })

  it('reads and reports each Swarm on its own: one that cannot be reported does not stop the next', async () => {
    const posted: string[] = []
    const { reporter } = setup((method, _path, body) => {
      if (method === 'GET') return ok({ swarms: [target({ tabId: 'tab-1' }), target({ tabId: 'tab-2' })] })
      posted.push((body as { tabId: string }).tabId)
      return (body as { tabId: string }).tabId === 'tab-1' ? refuse(503, 'SWARM_BUSY') : ok({ applied: 1, skipped: 0, capped: 0 })
    })
    await reporter.pass()
    expect(posted).toEqual(['tab-1', 'tab-2'])
    expect(warned).toEqual(['[shipping] could not report: SWARM_BUSY 503'])
  })

  it('is nothing at all while signed out, without a machine, or with nothing to read', async () => {
    const calls = vi.fn(() => ok({ swarms: [] }))
    await setup(calls, { core: { account: { backend: vi.fn(), signedIn: () => false } } }).reporter.pass()
    await setup(calls, { core: { daemon: { machineId: () => '' } } }).reporter.pass()
    await setup(calls).reporter.pass()
    expect(calls).toHaveBeenCalledTimes(1)
    expect(warned).toEqual([])
  })

  it('leaves out what the backend got wrong: a Swarm without a repository or a usable agent, a name no label can be', async () => {
    const { backend, reporter } = setup(method => method === 'GET' ? ok({ swarms: [
      target({ tabId: 'no repository', repositories: [] }), target({ tabId: 'bad_repository', repositories: ['not a repository', 7] }),
      target({ tabId: 'tab-quotes', agents: [{ id: 'a1', name: 'say "hi"', from: MON }] }), target({ tabId: 'tab-from', agents: [{ id: 'a1', name: 'Atlas', from: 'soon' }] }),
      target({ tabId: 'tab-id', agents: [{ id: 'a 1', name: 'Atlas', from: MON }, { name: 7, from: MON }] }), { agents: 'none' }, 'nothing',
      ...Array.from({ length: 101 }, (_, i) => target({ tabId: `many-${i}` }))] }) : ok({ applied: 1, skipped: 0, capped: 0 }))
    await reporter.pass()
    expect(backend.mock.calls.filter(([method]) => method === 'POST').length).toBe(100)
  })
})

describe('a pass that fails', () => {
  it('says once that it could not ask, and is tried again sooner, doubling from the minute, no later than the quarter hour', async () => {
    const { backend, reporter } = setup(() => refuse(502, 'BACKEND_UNAVAILABLE'))
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    expect(backend).toHaveBeenCalledTimes(1)
    for (const wait of [SHIPPING_RETRY_MS, 2 * SHIPPING_RETRY_MS, 4 * SHIPPING_RETRY_MS, 8 * SHIPPING_RETRY_MS, SHIPPING_EVERY_MS]) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      const before = backend.mock.calls.length
      await vi.advanceTimersByTimeAsync(1)
      expect(backend.mock.calls.length, `after ${wait}`).toBe(before + 1)
    }
    expect(warned).toEqual(['[shipping] could not ask what to read: BACKEND_UNAVAILABLE 502'])
    reporter.stop()
  })

  it('names a failure that is no answer of the backend\'s', async () => {
    const { reporter } = setup(() => { throw new Error('offline') })
    await reporter.pass()
    expect(warned).toEqual(['[shipping] could not ask what to read: failed'])
    const second = setup(method => method === 'GET' ? ok({ swarms: [target()] }) : (() => { throw new Error('offline') })())
    await second.reporter.pass()
    expect(warned[1]).toBe('[shipping] could not report: failed')
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
    const core = fakeCore({ account: { backend: vi.fn(async () => refuse(500, 'X')) } })
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
    const reporter = new ShippingReporter(fakeCore({ account: { backend } }), { run: github(), random: () => 0 })
    reporter.start()
    await vi.advanceTimersByTimeAsync(SHIPPING_FIRST_MS)
    expect(backend).toHaveBeenCalledTimes(1)
    reporter.stop()
    answer(ok({ swarms: [] }))
    await vi.advanceTimersByTimeAsync(2 * SHIPPING_EVERY_MS)
    expect(backend).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads with the machine\'s own gh and spreads its first look at random, unless told otherwise', async () => {
    const core = fakeCore({ account: { backend: vi.fn(async () => ok({ swarms: [] })) } })
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
