import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchedAgent } from './githubMentions.js'
import type { GitHubGet } from './githubRest.js'
import { agentOffers, ANSWER_GAP_MS, answerOffer, NO_ROUTE_MS, noRoom, noSuchRoute, OfferAnswers, offerTask, projectOffers, type TaskOffer, type Windows } from './taskOffers.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const GiB = 1024 ** 3
const PIP: WatchedAgent = { tabId: 'tab', agentId: 'pip', harnessId: 'h-pip', chat: 'chat-pip', names: ['Pip'], label: 'builder:pip', repos: ['acme/app'] }
const JUNO: WatchedAgent = { tabId: 'tab', agentId: 'juno', harnessId: 'h-juno', chat: 'chat-juno', names: ['Juno'], label: 'builder:juno', repos: ['acme/app'] }
/** A task of acme/app as GitHub answers for it. */
const task = (labels: string[], extra: Json = {}): Json => ({ state: 'open', labels: labels.map(name => ({ name })), ...extra })
/** A machine as readCapabilities reads it: 64 GiB with 8 used, 200 GiB free where the project is. */
const MACHINE: Json = { resources: { memoryTotalBytes: 64 * GiB, memoryUsedBytes: 8 * GiB, projectDiskFreeBytes: 200 * GiB, os: 'darwin' }, tools: { git: true } }
const UNKNOWN: Windows = { known: false, windows: [] }
const room = (labels: string[], over: Partial<Parameters<typeof noRoom>[0]> = {}) =>
  noRoom({ issue: task(labels), label: 'builder:pip', machine: MACHINE, cores: 8, held: 0, windows: UNKNOWN, ...over })

describe('the server\'s offers, as a daemon asks for them', () => {
  it('offers, lists, reads its own and answers by the routes, and reads an answer with no list as none', async () => {
    const asked: Array<[string, string, unknown]> = []
    const ask = vi.fn(async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      asked.push([method, path, body])
      return path.includes('/mine') ? { offers: [{ number: 14, state: 'offered' }], serverTime: 5 } : path.includes('repository=') ? { offers: 'none' } : {}
    })
    await offerTask(ask, 'tab', 'faye', { repository: 'acme/app', number: 14, agentId: 'pip' })
    expect(await projectOffers(ask, 'tab', 'faye', 'acme/app')).toEqual([])
    expect(await agentOffers(ask, 'tab', 'pip')).toEqual({ offers: [{ number: 14, state: 'offered' }], serverTime: 5 })
    await answerOffer(ask, 'tab', 'pip', { repository: 'acme/app', number: 14, state: 'offered' } as unknown as TaskOffer, null)
    await answerOffer(ask, 'tab', 'pip', { repository: 'acme/app', number: 14 }, 'memory')
    expect(asked).toEqual([
      ['POST', '/api/super-tabs/tab/task-offers?asAgentId=faye', { repository: 'acme/app', number: 14, agentId: 'pip' }],
      ['GET', '/api/super-tabs/tab/task-offers?repository=acme%2Fapp&asAgentId=faye', undefined],
      ['GET', '/api/super-tabs/tab/task-offers/mine?asAgentId=pip', undefined],
      ['POST', '/api/super-tabs/tab/task-offers/accept?asAgentId=pip', { repository: 'acme/app', number: 14 }],
      ['POST', '/api/super-tabs/tab/task-offers/decline?asAgentId=pip', { repository: 'acme/app', number: 14, reason: 'memory' }],
    ])
  })

  it('tells a server without the routes from the Swarm\'s own refusal', () => {
    expect(noSuchRoute(new SuperTabHostError('BACKEND_UNAVAILABLE', 'Route POST:/api/super-tabs/tab/task-offers not found', 404))).toBe(true)
    expect(noSuchRoute(new SuperTabHostError('NOT_FOUND', 'This Super Tab is not available.', 404))).toBe(false)
    expect(noSuchRoute(new SuperTabHostError('BACKEND_UNAVAILABLE', 'No answer.', 503))).toBe(false)
    expect(noSuchRoute(new Error('offline'))).toBe(false)
  })
})

describe('whether this computer has room for a task (noRoom)', () => {
  it('takes a task it has room for, sized as a middle one when no size is said', () => {
    expect(room(['size:l', 'builder:pip'])).toBeNull()
    expect(room([])).toBeNull()
  })

  it('says a task closed, a pull request, another builder\'s or one a person took is gone', () => {
    expect(noRoom({ issue: task([], { state: 'closed' }), label: 'builder:pip', machine: MACHINE, cores: 8, held: 0, windows: UNKNOWN })).toBe('gone')
    expect(noRoom({ issue: task([], { pull_request: {} }), label: 'builder:pip', machine: MACHINE, cores: 8, held: 0, windows: UNKNOWN })).toBe('gone')
    expect(room(['builder:juno'])).toBe('gone')
    expect(room(['status:taken'])).toBe('gone')
    expect(room(['status:taken', 'Builder:Pip'])).toBeNull()
  })

  it('needs every tool its labels name, its system and a GPU as the machine has them', () => {
    expect(room(['needs:git', 'needs:macos'])).toBeNull()
    expect(room(['needs:docker'])).toBe('tools')
    expect(room(['needs:gpu'])).toBe('tools')
    expect(room(['needs:gpu'], { machine: { ...MACHINE, resources: { ...MACHINE.resources as Json, gpus: [{ utilizationPercent: 40 }] } } })).toBeNull()
  })

  it('keeps the machine within its cores, beside the tasks its agents here build', () => {
    expect(room(['size:l'], { held: 4 })).toBeNull()
    expect(room(['size:l'], { held: 5 })).toBe('cores')
    expect(room(['size:s'], { cores: 2, held: 1 })).toBeNull()
  })

  it('needs the free memory its size holds, and no critical pressure; memory it cannot read is no reason', () => {
    const memory = (used: number, extra: Json = {}) => ({ ...MACHINE, resources: { ...MACHINE.resources as Json, memoryTotalBytes: 16 * GiB, memoryUsedBytes: used, ...extra } })
    expect(room(['size:l'], { machine: memory(8 * GiB) })).toBeNull()
    expect(room(['size:l'], { machine: memory(8 * GiB + 1) })).toBe('memory')
    expect(room(['size:s'], { machine: memory(0, { memoryPressure: 'critical' }) })).toBe('memory')
    expect(room(['size:l'], { machine: memory(null as never) })).toBeNull()
  })

  it('needs the disk its size holds above the ten gigabytes its person keeps; disk it cannot read is no reason', () => {
    const disk = (free: unknown) => ({ ...MACHINE, resources: { ...MACHINE.resources as Json, projectDiskFreeBytes: free } })
    expect(room(['size:m'], { machine: disk(12 * GiB) })).toBeNull()
    expect(room(['size:m'], { machine: disk(12 * GiB - 1) })).toBe('disk')
    expect(room(['size:m'], { machine: disk(null) })).toBeNull()
  })

  it('keeps each known window above its person\'s fifth, a weekly one spent a fifth as fast; an unknown one is no reason', () => {
    const windows = (...list: Array<[string, number]>): Windows => ({ known: true, windows: list.map(([name, usedPercent]) => ({ name, usedPercent })) })
    // A middle task spends ten points of a 5-hour window, and two of a weekly one.
    expect(room(['size:m'], { windows: windows(['5-hour', 70], ['weekly', 78]) })).toBeNull()
    expect(room(['size:m'], { windows: windows(['5-hour', 71]) })).toBe('quota')
    expect(room(['size:m'], { windows: windows(['weekly', 79]) })).toBe('quota')
    expect(room(['size:m'], { windows: { known: false, windows: [{ name: '5-hour', usedPercent: 100 }] } })).toBeNull()
  })
})

describe('the offers made to this computer\'s agents, answered here (OfferAnswers)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** Pip and Juno running here; the server keeps each agent's live offers, GitHub its tasks and each agent's labelled items. */
  function setup() {
    const state = { watched: [PIP, JUNO], offers: new Map<string, TaskOffer[]>(), tasks: new Map<number, Json | null>([[14, task(['size:m'], { title: 'Add the export' })]]),
      labelled: new Map<string, Json[]>(), machine: MACHINE, windows: UNKNOWN as Windows, sessions: new Map([['h-pip', { cwd: '/work/app', engine: 'claude' }]]),
      refusal: null as Error | null }
    state.offers.set('pip', [{ repository: 'acme/app', number: 14, agentId: 'pip', state: 'offered', offeredAt: 1, expiresAt: 120_001 }])
    const asked: Array<[string, string, unknown]> = []
    const ask = vi.fn(async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      asked.push([method, path, body])
      if (state.refusal) throw state.refusal
      const mine = /\/mine\?asAgentId=(\w+)$/.exec(path)
      return mine ? { offers: state.offers.get(mine[1]!) ?? [], serverTime: 60_000 } : {}
    })
    const get: GitHubGet = async path => {
      const url = new URL(`https://api.github.com${path}`)
      const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(url.pathname)
      // Another repository's task, open: only that it is of no project of the agent's makes it gone.
      if (url.pathname === '/repos/other/thing/issues/1') return { status: 200, etag: null, body: task(['size:s']), resetAt: null }
      if (one) {
        const found = state.tasks.get(Number(one[1]))
        return found ? { status: 200, etag: null, body: found, resetAt: null } : { status: 404, etag: null, body: null, resetAt: null }
      }
      return { status: 200, etag: null, body: state.labelled.get(url.searchParams.get('labels')!) ?? [], resetAt: null }
    }
    const listeners = new Set<(notice: { type: string; tabId?: string }) => void>()
    const machine = vi.fn(async (_cwd: string | null, _tools: string[]) => state.machine)
    const windows = vi.fn(async (_engine: string) => state.windows)
    const say = vi.fn(async (_agent: WatchedAgent, _operationId: string, _text: string) => ({}))
    const accepted = vi.fn((_agent: WatchedAgent) => {})
    const log = vi.fn()
    const answers = new OfferAnswers({ watched: async () => state.watched, ask, get, session: harnessId => state.sessions.get(harnessId) ?? null, machine, windows,
      cores: () => 8, onNotice: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, say, accepted, log, now: () => Date.now() })
    const answered = () => asked.filter(([method]) => method === 'POST').map(([, path, body]) => [path.replace('/api/super-tabs/tab/task-offers/', ''), body])
    const notice = (tabId?: string, type = 'swarm_host_changed') => { for (const listener of listeners) listener({ type, ...tabId ? { tabId } : {} }) }
    return { state, asked, ask, answers, answered, listeners, notice, machine, windows, say, accepted, log }
  }

  it('checks an offer against this machine and the agent\'s window, and accepts it once, as it starts and as a push says', async () => {
    const f = setup()
    f.answers.start()
    f.answers.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.answered()).toEqual([['accept?asAgentId=pip', { repository: 'acme/app', number: 14 }]])
    expect(f.machine).toHaveBeenCalledWith('/work/app', [])
    expect(f.windows).toHaveBeenCalledWith('claude')
    expect(f.accepted).toHaveBeenCalledWith(PIP)
    expect(f.log).toHaveBeenCalledWith('[super-tab] Pip accepted acme/app#14')
    expect(f.listeners.size).toBe(1)
    // The same offer read again, while the server still lists it as offered, is not answered twice.
    f.notice('tab')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.answered()).toHaveLength(1)
    // One accepted already, and another Swarm's push, read nothing to answer.
    f.state.offers.set('pip', [{ repository: 'acme/app', number: 14, agentId: 'pip', state: 'accepted', offeredAt: 2, expiresAt: 900_000 }])
    await f.answers.answer('tab')
    f.notice('other')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.answered()).toHaveLength(1)
    f.answers.stop()
  })

  it('reads a Swarm\'s offers once in the gap after its last read, however many pushes come, and no other notice', async () => {
    const f = setup()
    f.answers.start()
    await vi.advanceTimersByTimeAsync(0)
    const reads = () => f.asked.filter(([, path]) => path.includes('/mine')).length
    expect(reads()).toBe(2)
    f.notice('tab')
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(4)
    f.notice('tab')
    f.notice('tab')
    f.notice()
    f.notice('tab', 'super_tab_deliveries')
    await vi.advanceTimersByTimeAsync(ANSWER_GAP_MS - 1)
    expect(reads()).toBe(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(reads()).toBe(6)
    // Any other notice, with no read waiting, reads nothing.
    await vi.advanceTimersByTimeAsync(ANSWER_GAP_MS)
    f.notice('tab', 'super_tab_deliveries')
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(6)
    // Stopped, a push waiting for its gap reads nothing, and no push is heard.
    f.notice('tab')
    f.answers.stop()
    f.notice('tab')
    await vi.advanceTimersByTimeAsync(ANSWER_GAP_MS)
    expect(reads()).toBe(6)
    expect(f.listeners.size).toBe(0)
  })

  it('declines with its reason, and tells its person once for each reason until it accepts again', async () => {
    const f = setup()
    f.state.machine = { ...MACHINE, resources: { ...MACHINE.resources as Json, memoryUsedBytes: 62 * GiB } }
    const offer = (number: number, offeredAt: number): TaskOffer => ({ repository: 'acme/app', number, agentId: 'pip', state: 'offered', offeredAt, expiresAt: offeredAt + 120_000 })
    for (const number of [15, 16, 17, 18]) f.state.tasks.set(number, task(['size:m']))
    f.state.offers.set('pip', [offer(14, 1), offer(15, 2)])
    f.state.offers.set('juno', [{ ...offer(18, 5), agentId: 'juno' }])
    await f.answers.answer('tab')
    expect(f.answered()).toEqual([['decline?asAgentId=pip', { repository: 'acme/app', number: 14, reason: 'memory' }],
      ['decline?asAgentId=pip', { repository: 'acme/app', number: 15, reason: 'memory' }], ['decline?asAgentId=juno', { repository: 'acme/app', number: 18, reason: 'memory' }]])
    expect(f.say.mock.calls).toEqual([[PIP, 'offer-pip|acme/app#14@1', 'I was offered acme/app#14, and this computer has no room for it: not enough free memory.'],
      [JUNO, 'offer-juno|acme/app#18@5', 'I was offered acme/app#18, and this computer has no room for it: not enough free memory.']])
    expect(f.log).toHaveBeenCalledWith('[super-tab] Pip declined acme/app#14: memory')
    // It accepts one, and the next it declines for memory is told again.
    f.state.machine = MACHINE
    f.state.offers.set('pip', [offer(16, 3)])
    await f.answers.answer('tab')
    f.state.machine = { ...MACHINE, resources: { ...MACHINE.resources as Json, memoryUsedBytes: 62 * GiB } }
    f.state.offers.set('pip', [offer(17, 4)])
    await f.answers.answer('tab')
    expect(f.say.mock.calls.filter(call => call[0] === PIP).map(call => call[2])).toEqual(['I was offered acme/app#14, and this computer has no room for it: not enough free memory.',
      'I was offered acme/app#17, and this computer has no room for it: not enough free memory.'])
  })

  it('probes the tools a task needs on this machine, and declines one it lacks', async () => {
    const f = setup()
    f.state.tasks.set(14, task(['size:s', 'needs:docker']))
    await f.answers.answer('tab')
    expect(f.machine).toHaveBeenCalledWith('/work/app', ['docker'])
    expect(f.answered()).toEqual([['decline?asAgentId=pip', { repository: 'acme/app', number: 14, reason: 'tools' }]])
    expect(f.say.mock.calls[0]![2]).toBe('I was offered acme/app#14, and this computer has no room for it: it lacks a tool the task needs.')
  })

  it('declines a task gone, closed, of no project of its or not there, and tells its person nothing of it', async () => {
    const f = setup()
    f.state.tasks.set(14, task(['builder:juno']))
    f.state.offers.set('pip', [{ repository: 'acme/app', number: 14, agentId: 'pip', state: 'offered', offeredAt: 1, expiresAt: 120_001 },
      { repository: 'acme/app', number: 99, agentId: 'pip', state: 'offered', offeredAt: 2, expiresAt: 120_002 },
      { repository: 'other/thing', number: 1, agentId: 'pip', state: 'offered', offeredAt: 3, expiresAt: 120_003 }])
    await f.answers.answer('tab')
    expect(f.answered().map(([, body]) => body)).toEqual([{ repository: 'acme/app', number: 14, reason: 'gone' }, { repository: 'acme/app', number: 99, reason: 'gone' },
      { repository: 'other/thing', number: 1, reason: 'gone' }])
    expect(f.say).not.toHaveBeenCalled()
  })

  it('counts the cores of what its other agents here build: a task taken with no pull request of its yet', async () => {
    const f = setup()
    f.state.tasks.set(14, task(['size:l']))
    const item = (number: number, labels: string[], extra: Json = {}): Json => ({ number, labels: labels.map(name => ({ name })), ...extra })
    // Juno builds #20 (large); #21 has its pull request up, and #22 is only given to it.
    f.state.labelled.set('builder:juno', [item(20, ['builder:juno', 'status:taken', 'size:l']), item(21, ['builder:juno', 'status:taken', 'size:l']),
      item(22, ['builder:juno', 'size:l']), item(30, ['builder:juno'], { pull_request: {}, body: 'Closes #21' }), { number: 23 }, { number: 24, labels: [{}] }])
    await f.answers.answer('tab')
    expect(f.answered()).toEqual([['accept?asAgentId=pip', { repository: 'acme/app', number: 14 }]])
    f.state.labelled.set('builder:juno', [item(20, ['builder:juno', 'status:taken', 'size:l']), item(21, ['builder:juno', 'status:taken', 'size:s'])])
    f.state.offers.set('pip', [{ repository: 'acme/app', number: 14, agentId: 'pip', state: 'offered', offeredAt: 2, expiresAt: 120_002 }])
    await f.answers.answer('tab')
    expect(f.answered()[1]).toEqual(['decline?asAgentId=pip', { repository: 'acme/app', number: 14, reason: 'cores' }])
  })

  it('reads an agent with no session here as one whose window is unknown, and its machine without its folder', async () => {
    const f = setup()
    f.state.sessions.clear()
    f.state.windows = { known: true, windows: [{ name: '5-hour', usedPercent: 99 }] }
    await f.answers.answer(null)
    expect(f.machine).toHaveBeenCalledWith(null, [])
    expect(f.windows).not.toHaveBeenCalled()
    expect(f.answered()).toEqual([['accept?asAgentId=pip', { repository: 'acme/app', number: 14 }]])
  })

  it('asks a server without the routes again after ten minutes, and says each failure once until it passes', async () => {
    const f = setup()
    f.state.refusal = new SuperTabHostError('BACKEND_UNAVAILABLE', 'Route GET:/api/super-tabs/tab/task-offers/mine not found', 404)
    await f.answers.answer('tab')
    await f.answers.answer('tab')
    expect(f.asked).toHaveLength(1)
    expect(f.log.mock.calls).toEqual([['[super-tab] Task offers: this Swarm\'s server takes no offers yet']])
    await vi.advanceTimersByTimeAsync(NO_ROUTE_MS)
    f.state.refusal = new SuperTabHostError('BACKEND_UNAVAILABLE', 'No answer.', 503)
    await f.answers.answer('tab')
    await f.answers.answer('tab')
    expect(f.log.mock.calls.slice(1)).toEqual([['[super-tab] Task offers: BACKEND_UNAVAILABLE']])
    f.state.refusal = null
    await f.answers.answer('tab')
    f.state.refusal = new SuperTabHostError('BACKEND_UNAVAILABLE', 'No answer.', 503)
    await f.answers.answer('tab')
    expect(f.log.mock.calls.slice(1).filter(([line]) => line.startsWith('[super-tab] Task offers:'))).toEqual([['[super-tab] Task offers: BACKEND_UNAVAILABLE'], ['[super-tab] Task offers: BACKEND_UNAVAILABLE']])
  })

  it('remembers the last five hundred offers it answered, the oldest forgotten first', async () => {
    const f = setup()
    f.state.offers.set('pip', Array.from({ length: 501 }, (_, i) => ({ repository: 'acme/app', number: 14, agentId: 'pip', state: 'offered' as const, offeredAt: i, expiresAt: i + 120_000 })))
    await f.answers.answer('tab')
    expect(f.answered()).toHaveLength(501)
    // The first one answered is no longer remembered: read again, it is answered again; the last is not.
    f.state.offers.set('pip', [f.state.offers.get('pip')![0]!, f.state.offers.get('pip')![500]!])
    await f.answers.answer('tab')
    expect(f.answered()).toHaveLength(502)
  })

  it('says its failures in the daemon\'s log when it is given no log of its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = new OfferAnswers({ watched: async () => { throw new Error('offline') }, ask: vi.fn(), get: vi.fn(), session: () => null, machine: vi.fn(),
      windows: vi.fn(), cores: () => 8, onNotice: () => () => {}, say: vi.fn(), accepted: vi.fn() })
    await answers.answer(null)
    expect(warn).toHaveBeenCalledWith('[super-tab] Task offers: Error')
    warn.mockRestore()
  })
})
