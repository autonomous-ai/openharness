import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchedAgent } from './githubMentions.js'
import type { GitHubGet } from './githubRest.js'
import { agentOffers, AGENTS_MS, ANSWER_GAP_MS, ANSWER_QUIET_MS, answerOffer, NO_ROUTE_MS, noRoom, noSuchRoute, OFFER_NUMBERS_MAX, OfferAnswers, offerTask, projectOffers,
  type TaskOffer, type Windows } from './taskOffers.js'
import { SuperTabHostError } from './wire.js'

const root = mkdtempSync(join(tmpdir(), 'super-tab-offers-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let files = 0

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
  it('offers, lists the tasks asked a hundred at a time, reads its own and answers by the routes, and reads an answer with no list as none', async () => {
    const asked: Array<[string, string, unknown]> = []
    const ask = vi.fn(async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      asked.push([method, path, body])
      return path.includes('/mine') ? { offers: [{ number: 14, state: 'offered' }], serverTime: 5 }
        : path.includes('numbers=1,') ? { offers: [{ number: 1, state: 'offered' }] } : path.includes('repository=') ? { offers: 'none' }
        : { offer: { number: 14, state: 'accepted', expiresAt: 605 }, serverTime: 5 }
    })
    await offerTask(ask, 'tab', 'faye', { repository: 'acme/app', number: 14, agentId: 'pip' })
    const numbers = Array.from({ length: OFFER_NUMBERS_MAX + 1 }, (_, i) => i + 1)
    expect(await projectOffers(ask, 'tab', 'faye', 'acme/app', numbers)).toEqual([{ number: 1, state: 'offered' }])
    expect(await projectOffers(ask, 'tab', 'faye', 'acme/app', [])).toEqual([])
    expect(await agentOffers(ask, 'tab', 'pip')).toEqual({ offers: [{ number: 14, state: 'offered' }], serverTime: 5 })
    expect(await answerOffer(ask, 'tab', 'pip', { repository: 'acme/app', number: 14, state: 'offered' } as unknown as TaskOffer, null))
      .toEqual({ offer: { number: 14, state: 'accepted', expiresAt: 605 }, serverTime: 5 })
    await answerOffer(ask, 'tab', 'pip', { repository: 'acme/app', number: 14 }, 'memory')
    expect(asked).toEqual([
      ['POST', '/api/super-tabs/tab/task-offers?asAgentId=faye', { repository: 'acme/app', number: 14, agentId: 'pip' }],
      ['GET', `/api/super-tabs/tab/task-offers?repository=acme%2Fapp&numbers=${numbers.slice(0, OFFER_NUMBERS_MAX).join(',')}&asAgentId=faye`, undefined],
      ['GET', `/api/super-tabs/tab/task-offers?repository=acme%2Fapp&numbers=${OFFER_NUMBERS_MAX + 1}&asAgentId=faye`, undefined],
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
  function setup(options: { file?: string } = {}) {
    const state = { watched: [PIP, JUNO], offers: new Map<string, TaskOffer[]>(), tasks: new Map<number, Json | null>([[14, task(['size:m'], { title: 'Add the export' })]]),
      labelled: new Map<string, Json[]>(), machine: MACHINE, windows: UNKNOWN as Windows, sessions: new Map([['h-pip', { cwd: '/work/app', engine: 'claude' }]]),
      cores: 8, refusal: null as Error | null, mineDown: new Set<string>(), answerDown: 0, answerTimes: true, slowMs: 0 }
    state.offers.set('pip', [{ repository: 'acme/app', number: 14, agentId: 'pip', state: 'offered', offeredAt: 1, expiresAt: 120_001 }])
    const asked: Array<[string, string, unknown]> = []
    const ask = vi.fn(async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      asked.push([method, path, body])
      if (state.refusal) throw state.refusal
      const mine = /\/mine\?asAgentId=(\w+)$/.exec(path)
      // One slow read, as a server under load answers one.
      if (mine && state.slowMs) { const slow = state.slowMs; state.slowMs = 0; await new Promise(resolve => setTimeout(resolve, slow)) }
      if (mine && state.mineDown.has(mine[1]!)) throw new SuperTabHostError('BACKEND_UNAVAILABLE', 'No answer.', 503)
      if (mine) return { offers: state.offers.get(mine[1]!) ?? [], serverTime: 60_000 }
      if (state.answerDown > 0) { state.answerDown--; throw new SuperTabHostError('BACKEND_UNAVAILABLE', 'No answer.', 503) }
      // The server holds an accepted task ten minutes, and says so by its own clock.
      return state.answerTimes ? { offer: { ...body as Json, expiresAt: 660_000 }, serverTime: 60_000 } : {}
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
    const watched = vi.fn(async () => state.watched)
    const machine = vi.fn(async (_cwd: string | null, _tools: string[]) => state.machine)
    const windows = vi.fn(async (_engine: string) => state.windows)
    const say = vi.fn(async (_agent: WatchedAgent, _operationId: string, _text: string) => ({}))
    const accepted = vi.fn((_agent: WatchedAgent) => {})
    const log = vi.fn()
    const file = options.file ?? join(root, `told-${files++}.json`)
    const make = () => new OfferAnswers({ watched, ask, get, session: harnessId => state.sessions.get(harnessId) ?? null, machine, windows,
      cores: () => state.cores, onNotice: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, say, accepted, log, file,
      now: () => Date.now() })
    const answered = () => asked.filter(([method]) => method === 'POST').map(([, path, body]) => [path.replace('/api/super-tabs/tab/task-offers/', ''), body])
    const reads = () => asked.filter(([, path]) => path.includes('/mine')).length
    const notice = (tabId?: string, type = 'swarm_host_changed') => { for (const listener of listeners) listener({ type, ...tabId ? { tabId } : {} }) }
    const offer = (number: number, offeredAt: number, agentId = 'pip'): TaskOffer => ({ repository: 'acme/app', number, agentId, state: 'offered', offeredAt, expiresAt: offeredAt + 120_000 })
    return { state, asked, ask, answers: make(), make, answered, reads, listeners, notice, watched, machine, windows, say, accepted, log, file, offer }
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
    await vi.advanceTimersByTimeAsync(ANSWER_GAP_MS)
    f.notice('tab')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.reads()).toBe(4)
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
    expect(f.reads()).toBe(2)
    f.notice('tab')
    f.notice('tab')
    f.notice()
    f.notice('tab', 'super_tab_deliveries')
    await vi.advanceTimersByTimeAsync(ANSWER_GAP_MS - 1)
    expect(f.reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.reads()).toBe(4)
    // Any other notice, with no read waiting, reads nothing.
    await vi.advanceTimersByTimeAsync(ANSWER_GAP_MS)
    f.notice('tab', 'super_tab_deliveries')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.reads()).toBe(4)
    // Stopped, a push waiting for its gap reads nothing, and no push is heard; stopped again, or never started, nothing happens.
    f.notice('tab')
    f.answers.stop()
    f.notice('tab')
    await vi.advanceTimersByTimeAsync(ANSWER_QUIET_MS)
    expect(f.reads()).toBe(4)
    expect(f.listeners.size).toBe(0)
    f.answers.stop()
    setup().answers.stop()
  })

  // Review of #4153: answers were read only on a push, and the server gives an offer two minutes for an answer on the strength of
  // a read once a minute besides.
  it('reads once a minute a Swarm no push named, and not one a push read a moment ago', async () => {
    const f = setup()
    f.answers.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(ANSWER_QUIET_MS)
    expect(f.reads()).toBe(4)
    // A push read it ten seconds before the minute: that minute reads nothing, the next does.
    await vi.advanceTimersByTimeAsync(ANSWER_QUIET_MS - 10_000)
    f.notice('tab')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.reads()).toBe(6)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.reads()).toBe(6)
    await vi.advanceTimersByTimeAsync(ANSWER_QUIET_MS)
    expect(f.reads()).toBe(8)
    f.answers.stop()
  })

  // Review of #4153, round two: the gap was measured from when a pass began, so pushes heard while a slow pass ran each made one
  // more pass (16 reads where 7 were due).
  it('keeps the gap between a Swarm\'s reads however slow a read is', async () => {
    const f = setup()
    f.state.watched = [PIP]
    f.state.slowMs = 50_000
    f.answers.start()
    for (let second = 0; second < 120; second += 5) {
      f.notice('tab')
      await vi.advanceTimersByTimeAsync(5_000)
    }
    // A push at once (its read the slow one, fifty seconds), then one every twenty seconds: 20 (read when the slow one ends),
    // 40, 60, 80 and 100, and one more as the pushes end.
    expect(f.reads()).toBe(7)
    f.answers.stop()
  })

  it('reads nothing for a pass still waiting when it is stopped', async () => {
    const f = setup()
    f.state.watched = [PIP]
    f.state.slowMs = 10_000
    f.answers.start()
    await vi.advanceTimersByTimeAsync(1_000)
    void f.answers.answer('tab')
    f.answers.stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.reads()).toBe(1)
  })

  // Review of #4153: this computer's agents were read on every pass: a busy Swarm's pushes read them three times a minute.
  it('reads this computer\'s agents at most once a minute, however many pushes come', async () => {
    const f = setup()
    f.answers.start()
    for (let second = 0; second < 3_600; second += 5) {
      f.notice('tab')
      await vi.advanceTimersByTimeAsync(5_000)
    }
    // An hour of a push every five seconds: a pass every twenty seconds, the agents read once a minute at most. Read every pass, they
    // were read 182 times (measured on the first version).
    expect(f.reads()).toBe(2 * 181)
    expect(f.watched.mock.calls.length).toBeLessThanOrEqual(61)
    f.answers.stop()
  })

  it('declines with its reason, and tells its person once for each reason until it accepts again', async () => {
    const f = setup()
    f.state.machine = { ...MACHINE, resources: { ...MACHINE.resources as Json, memoryUsedBytes: 62 * GiB } }
    for (const number of [15, 16, 17, 18]) f.state.tasks.set(number, task(['size:m']))
    f.state.offers.set('pip', [f.offer(14, 1), f.offer(15, 2)])
    f.state.offers.set('juno', [f.offer(18, 5, 'juno')])
    await f.answers.answer('tab')
    expect(f.answered()).toEqual([['decline?asAgentId=pip', { repository: 'acme/app', number: 14, reason: 'memory' }],
      ['decline?asAgentId=pip', { repository: 'acme/app', number: 15, reason: 'memory' }], ['decline?asAgentId=juno', { repository: 'acme/app', number: 18, reason: 'memory' }]])
    // Under an id the server takes (review of #4153: the key itself was refused, and the line never said): the key's hash.
    const id = (key: string) => `offer-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`
    expect(f.say.mock.calls).toEqual([[PIP, id('pip|acme/app#14@1'), 'I was offered acme/app#14, and this computer has no room for it: not enough free memory.'],
      [JUNO, id('juno|acme/app#18@5'), 'I was offered acme/app#18, and this computer has no room for it: not enough free memory.']])
    for (const [, operationId] of f.say.mock.calls) expect(operationId).toMatch(/^[A-Za-z0-9_-]{1,160}$/)
    expect(f.log).toHaveBeenCalledWith('[super-tab] Pip declined acme/app#14: memory')
    // It accepts one, and the next it declines for memory is told again.
    f.state.machine = MACHINE
    f.state.offers.set('pip', [f.offer(16, 3)])
    await f.answers.answer('tab')
    f.state.machine = { ...MACHINE, resources: { ...MACHINE.resources as Json, memoryUsedBytes: 62 * GiB } }
    f.state.offers.set('pip', [f.offer(17, 4)])
    await f.answers.answer('tab')
    expect(f.say.mock.calls.filter(call => call[0] === PIP).map(call => call[2])).toEqual(['I was offered acme/app#14, and this computer has no room for it: not enough free memory.',
      'I was offered acme/app#17, and this computer has no room for it: not enough free memory.'])
  })

  // Review of #4153: what each person was told lived in memory alone, so a restart (every release) said each again.
  it('keeps what each person was told across a restart, and says it again only after an accept', async () => {
    const f = setup()
    f.state.machine = { ...MACHINE, resources: { ...MACHINE.resources as Json, memoryUsedBytes: 62 * GiB } }
    f.state.tasks.set(15, task(['size:m']))
    await f.answers.answer('tab')
    expect(f.say).toHaveBeenCalledOnce()
    const again = f.make()
    f.state.offers.set('pip', [f.offer(15, 2)])
    await again.answer('tab')
    expect(f.answered()).toHaveLength(2)
    expect(f.say).toHaveBeenCalledOnce()
    // A file that is not what this keeps reads as nothing told; one that cannot be written is said, and the line still goes.
    writeFileSync(f.file, 'not json')
    const unread = f.make()
    f.state.offers.set('pip', [f.offer(16, 3)])
    f.state.tasks.set(16, task(['size:m']))
    await unread.answer('tab')
    expect(f.say).toHaveBeenCalledTimes(2)
    const g = setup({ file: join(root, 'not-a-folder', 'told.json') })
    writeFileSync(join(root, 'not-a-folder'), 'a file where its folder would be')
    g.state.machine = f.state.machine
    await g.answers.answer('tab')
    expect(g.say).toHaveBeenCalledOnce()
    expect(g.log).toHaveBeenCalledWith(expect.stringMatching(/^\[super-tab\] Task offers: what each person was told could not be kept: /))
    writeFileSync(f.file, JSON.stringify({ told: 'none' }))
    const odd = f.make()
    f.state.offers.set('pip', [f.offer(17, 4)])
    f.state.tasks.set(17, task(['size:m']))
    await odd.answer('tab')
    expect(f.say).toHaveBeenCalledTimes(3)
  })

  // Review of #4153, round two: its agents read a minute ago, an agent that joined a project since was offered one of its tasks and
  // declined it as gone.
  it('reads its agents again before it declines an offer of a repository it did not know of', async () => {
    const f = setup()
    await f.answers.answer('tab')
    f.state.watched = [{ ...PIP, repos: ['acme/app', 'other/thing'] }, JUNO]
    f.state.offers.set('pip', [{ ...f.offer(1, 2), repository: 'other/thing' }])
    await f.answers.answer('tab')
    expect(f.answered().at(-1)).toEqual(['accept?asAgentId=pip', { repository: 'other/thing', number: 1 }])
    expect(f.watched).toHaveBeenCalledTimes(2)
    // Read again and gone from them, it declines it.
    f.state.watched = [JUNO]
    f.state.offers.set('pip', [{ ...f.offer(2, 3), repository: 'acme/other' }])
    await f.answers.answer('tab')
    expect(f.answered().at(-1)).toEqual(['decline?asAgentId=pip', { repository: 'acme/other', number: 2, reason: 'gone' }])
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
    f.state.offers.set('pip', [f.offer(14, 1), f.offer(99, 2), { ...f.offer(1, 3), repository: 'other/thing' }])
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
    f.state.offers.set('pip', [f.offer(31, 2)])
    f.state.tasks.set(31, task(['size:s']))
    await f.answers.answer('tab')
    // Juno's 5 and Pip's 4 accepted a moment ago, beside a small one: 10 of 8.
    expect(f.answered()[1]).toEqual(['decline?asAgentId=pip', { repository: 'acme/app', number: 31, reason: 'cores' }])
  })

  // Review of #4153: two agents here could both accept work their cores could not hold together, as only taken tasks counted.
  it('counts the cores of what this computer accepted until its hold ends, and a task taken and accepted once', async () => {
    const f = setup()
    f.state.cores = 6
    for (const [number, size] of [[14, 'l'], [15, 'm'], [16, 's'], [17, 's']] as const) f.state.tasks.set(number, task([`size:${size}`]))
    await f.answers.answer('tab')
    f.state.offers.set('pip', [])
    f.state.offers.set('juno', [f.offer(15, 2, 'juno')])
    await f.answers.answer('tab')
    f.state.offers.set('juno', [f.offer(16, 3, 'juno')])
    await f.answers.answer('tab')
    expect(f.answered().map(([path, body]) => [path, (body as Json).number, (body as Json).reason])).toEqual([['accept?asAgentId=pip', 14, undefined],
      ['accept?asAgentId=juno', 15, undefined], ['decline?asAgentId=juno', 16, 'cores']])
    // Pip took #14: counted once, as taken and as accepted, so a small one fits seven cores (4 + 2 + 1).
    f.state.cores = 7
    f.state.labelled.set('builder:pip', [{ number: 14, labels: [{ name: 'builder:pip' }, { name: 'status:taken' }, { name: 'size:l' }] }])
    f.state.offers.set('juno', [f.offer(17, 4, 'juno')])
    await f.answers.answer('tab')
    expect(f.answered().at(-1)).toEqual(['accept?asAgentId=juno', { repository: 'acme/app', number: 17 }])
    // Once the holds end, the cores are free again.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    f.state.labelled.clear()
    f.state.cores = 4
    f.state.tasks.set(18, task(['size:l']))
    f.state.offers.set('juno', [f.offer(18, 5, 'juno')])
    await f.answers.answer('tab')
    expect(f.answered().at(-1)).toEqual(['accept?asAgentId=juno', { repository: 'acme/app', number: 18 }])
    // An answer that does not say its hold counts the server's ten minutes.
    const g = setup()
    g.state.cores = 4
    g.state.answerTimes = false
    g.state.tasks.set(14, task(['size:l']))
    g.state.tasks.set(15, task(['size:s']))
    await g.answers.answer('tab')
    g.state.offers.set('pip', [])
    g.state.offers.set('juno', [g.offer(15, 2, 'juno')])
    await g.answers.answer('tab')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    g.state.offers.set('juno', [g.offer(15, 3, 'juno')])
    await g.answers.answer('tab')
    expect(g.answered().map(([path]) => path)).toEqual(['accept?asAgentId=pip', 'decline?asAgentId=juno', 'accept?asAgentId=juno'])
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

  // Review of #4153: one failure ended the pass for every agent after it, and an offer marked answered before its answer was
  // taken was never answered again.
  it('passes over one agent\'s failure and one offer\'s alone, and makes again an answer the server did not take', async () => {
    const f = setup()
    f.state.mineDown.add('pip')
    f.state.offers.set('juno', [f.offer(15, 2, 'juno'), f.offer(16, 3, 'juno')])
    f.state.tasks.set(15, task(['size:s']))
    f.state.tasks.set(16, task(['size:s']))
    f.state.answerDown = 1
    await f.answers.answer('tab')
    expect(f.answered().map(([path, body]) => [path, (body as Json).number])).toEqual([['accept?asAgentId=juno', 15], ['accept?asAgentId=juno', 16]])
    expect(f.log.mock.calls.filter(([line]) => String(line).startsWith('[super-tab] Task offers:'))).toEqual([['[super-tab] Task offers: BACKEND_UNAVAILABLE'],
      ['[super-tab] Task offers: BACKEND_UNAVAILABLE']])
    f.state.mineDown.clear()
    await vi.advanceTimersByTimeAsync(ANSWER_GAP_MS)
    await f.answers.answer('tab')
    expect(f.answered().map(([path, body]) => [path, (body as Json).number])).toEqual([['accept?asAgentId=juno', 15], ['accept?asAgentId=juno', 16],
      ['accept?asAgentId=pip', 14], ['accept?asAgentId=juno', 15]])
    expect(f.log.mock.calls.filter(([line]) => String(line).startsWith('[super-tab] Task offers:'))).toHaveLength(2)
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
    expect(f.log.mock.calls.slice(1)).toEqual([['[super-tab] Task offers: BACKEND_UNAVAILABLE'], ['[super-tab] Task offers: BACKEND_UNAVAILABLE']])
    f.state.refusal = null
    await f.answers.answer('tab')
    f.state.refusal = new SuperTabHostError('BACKEND_UNAVAILABLE', 'No answer.', 503)
    await f.answers.answer('tab')
    expect(f.log.mock.calls.slice(1).filter(([line]) => line.startsWith('[super-tab] Task offers:'))).toHaveLength(4)
    // Its agents unread: said once, and the pass reads nothing.
    const g = setup()
    g.watched.mockRejectedValue(new Error('offline'))
    await g.answers.answer('tab')
    await vi.advanceTimersByTimeAsync(AGENTS_MS)
    await g.answers.answer('tab')
    expect(g.log.mock.calls).toEqual([['[super-tab] Task offers: Error']])
    expect(g.asked).toEqual([])
    g.watched.mockResolvedValue([PIP])
    await vi.advanceTimersByTimeAsync(AGENTS_MS)
    await g.answers.answer('tab')
    expect(g.answered()).toHaveLength(1)
  })

  it('remembers the last five hundred offers it answered, the oldest forgotten first', async () => {
    const f = setup()
    f.state.offers.set('pip', Array.from({ length: 501 }, (_, i) => ({ repository: 'acme/app', number: 14, agentId: 'pip', state: 'offered' as const, offeredAt: i, expiresAt: i + 120_000 })))
    await f.answers.answer('tab')
    expect(f.answered()).toHaveLength(501)
    // The first one answered is no longer remembered: read again, it is answered again; the last is not.
    f.state.offers.set('pip', [f.state.offers.get('pip')![0]!, f.state.offers.get('pip')![500]!])
    await vi.advanceTimersByTimeAsync(ANSWER_GAP_MS)
    await f.answers.answer('tab')
    expect(f.answered()).toHaveLength(502)
    // Five hundred and one offers that fail are said, and the oldest forgotten.
    const g = setup()
    g.state.answerDown = 501
    g.state.offers.set('pip', Array.from({ length: 501 }, (_, i) => ({ repository: 'acme/app', number: 14, agentId: 'pip', state: 'offered' as const, offeredAt: i, expiresAt: i + 120_000 })))
    await g.answers.answer('tab')
    expect(g.log.mock.calls.filter(([line]) => String(line).startsWith('[super-tab] Task offers:'))).toHaveLength(501)
  })

  it('says its failures in the daemon\'s log when it is given no log of its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = new OfferAnswers({ watched: async () => { throw new Error('offline') }, ask: vi.fn(), get: vi.fn(), session: () => null, machine: vi.fn(),
      windows: vi.fn(), cores: () => 8, onNotice: () => () => {}, say: vi.fn(), accepted: vi.fn(), file: join(root, 'never.json') })
    await answers.answer(null)
    expect(warn).toHaveBeenCalledWith('[super-tab] Task offers: Error')
    warn.mockRestore()
  })
})
