import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHerdr, RECORDED, type FakeHerdr } from '../../testing/fakeHerdr.js'
import { createHerdrAdapter } from './herdr.js'
import { createHerdrClient, type HerdrPrompt } from './herdrClient.js'
import { HerdrSource, type HerdrSourceDeps } from './herdrSource.js'
import type { HostAgent } from './types.js'

const KINDS = [{ type: 'pane.agent_detected' }, { type: 'pane.closed' }, { type: 'pane.exited' }]
const statusEntry = (pane: string) => ({ type: 'pane.agent_status_changed', pane_id: pane })
/** The wall clock the test starts at. */
const WALL = 1_700_000_000_000
/** The stamp (`<inode>:<ctime in ns>`) of a socket made at that wall clock time. A real socket of the fake's is made
 *  after WALL, so it is never young. */
const stampAt = (ms: number) => `7:${BigInt(ms) * 1_000_000n}`

const agent = (pane: string, status = 'idle', more: Record<string, unknown> = {}) =>
  ({ pane_id: pane, agent: 'claude', agent_status: status, cwd: '/work/api', ...more })
const lines = (recorded: string[]) => `${recorded.join('\n')}\n`
const statusLine = (pane: string, status: string) =>
  JSON.stringify({ data: { agent: 'claude', agent_status: status, pane_id: pane, workspace_id: pane.split(':')[0] }, event: 'pane.agent_status_changed' })
const detected = (pane: string, more: Record<string, unknown> = {}) =>
  ({ agent: 'claude', pane_id: pane, type: 'pane_agent_detected', workspace_id: pane.split(':')[0], ...more })
const refusal = (code: string) => ({ line: { error: { code, message: code } } })
const method = (request: unknown) => (request as { method: string }).method
const LOG_LINE = /^\[herdr\] (listed · \d+ agents|over · \d+ left out|list · [a-z_]+|closed · [a-z_]+|retry · \d+|socket · (none|stale|live))$/

describe.skipIf(process.platform === 'win32')('the herdr source (docs/specs/2026-11-16-device-herdr.md)', () => {
  let server: FakeHerdr

  beforeEach(async () => { server = await fakeHerdr() })
  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  const herdrClient = () => createHerdrClient({ socketPath: server.path, home: dirname(server.path), uid: process.getuid!(), platform: process.platform })

  /** A source on the real client and the fake server, its words through the real adapter as the devices wire it, with a
   *  timer queue, a watch and two clocks the test runs by hand. */
  function setup(over: Partial<HerdrSourceDeps> = {}) {
    const client = herdrClient()
    const adapter = createHerdrAdapter({
      run: async () => ({ code: 0, stdout: '' }), onPath: () => null, exists: () => false, platform: process.platform, client,
    })
    let mono = 0
    let wall = WALL
    const timers: Array<{ at: number; ms: number; run: () => void }> = []
    const watchers = new Set<() => void>()
    const log: string[] = []
    const counts: string[] = []
    // What `until` waits for, asked again on each change, log line, count, timer and watch of the source's.
    const checks = new Set<() => boolean>()
    const settle = () => { for (const check of checks) if (check()) checks.delete(check) }
    let ids = 0
    let changes = 0
    const prompt = vi.fn((pane: string, kind: string, text: string): Promise<HerdrPrompt> => adapter.prompt(pane, kind, text))
    const focus = vi.fn(async (_pane: string) => true)
    const deps: HerdrSourceDeps = {
      client,
      watch: (changed) => {
        watchers.add(changed)
        settle()
        return () => { watchers.delete(changed) }
      },
      prompt,
      focus,
      after: (ms, run) => {
        const timer = { at: mono + ms, ms, run }
        timers.push(timer)
        settle()
        return () => {
          const at = timers.indexOf(timer)
          if (at >= 0) timers.splice(at, 1)
        }
      },
      now: () => wall,
      monotonic: () => mono,
      uuid: () => `u${++ids}`,
      platform: process.platform,
      log: (line) => {
        log.push(line)
        settle()
      },
      count: (what) => {
        counts.push(what)
        settle()
      },
      ...over,
    }
    const source = new HerdrSource(deps)
    source.onChange(() => {
      changes++
      settle()
    })
    const due = () => timers.filter(({ at }) => at <= mono).sort((a, b) => a.at - b.at)[0]
    return {
      source, client, prompt, focus, timers, watchers, log, counts,
      get changes() { return changes },
      until: (check: () => boolean) => new Promise<void>((resolve) => {
        const done = () => {
          if (!check()) return false
          resolve()
          return true
        }
        if (!done()) checks.add(done)
      }),
      /** Moves both clocks on, and runs each timer that falls due, in order. */
      advance: (ms: number) => {
        mono += ms
        wall += ms
        for (let timer = due(); timer; timer = due()) {
          timers.splice(timers.indexOf(timer), 1)
          timer.run()
        }
      },
      /** A change where herdr's socket lives. */
      fire: () => { for (const changed of [...watchers]) changed() },
    }
  }
  type Setup = ReturnType<typeof setup>

  const row = (s: Setup, pane: string): HostAgent | undefined => s.source.list().find((a) => a.paneKeys?.[0] === `herdr:${pane}`)

  /** A source whose socket's stamp holds still: a server that died and left its socket, which the fake's own `stale()`
   *  would give another stamp. */
  const holding = (stamp: string) => setup({ client: { ...herdrClient(), socketStamp: () => stamp } })

  /** Once the n-th agent.list's answer has been read: the server's end of a connection closes only after the client read
   *  the line and closed its own. */
  async function listRead(n: number): Promise<void> {
    const { connection } = await server.got('agent.list', n)
    await server.ended(connection)
  }

  /** Starts the source and follows it to its second subscription, which names each listed pane: live, with no timer. */
  async function live(s: Setup): Promise<void> {
    s.source.start()
    await listRead(1)
    s.advance(1000)
    await listRead(2)
  }

  /** Lines on a subscription come in order: once a status sent after them has changed that pane's row, each line before
   *  it has been heard. It goes between working and blocked, so each one changes the row. */
  async function heard(s: Setup, pane: string): Promise<void> {
    const next = row(s, pane)!.state === 'working' ? 'blocked' : 'working'
    server.send(`${statusLine(pane, next)}\n`)
    await s.until(() => row(s, pane)?.state === (next === 'working' ? 'working' : 'needs-you'))
  }

  it('started with herdr running, its agents are listed with their fields', async () => {
    server.agents = [{ pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle', cwd: '/work/api' }]
    const s = setup()
    expect(s.source.id).toBe('herdr')
    s.source.start()
    await listRead(1)
    expect(s.source.list()).toEqual([{
      id: 'u1', engine: 'claude', cwd: '/work/api', name: 'api', host: 'herdr', app: 'herdr', state: 'idle',
      unseenDone: false, lastActivityAt: WALL, paneKeys: ['herdr:w1:p1'],
    }])
    expect(s.changes).toBe(1)
    expect(s.log).toEqual(['[herdr] socket · live', '[herdr] listed · 1 agents'])
    expect(s.source.capabilities()).toEqual({ status: true, voice: true, focus: true, answer: false })
  })

  it('the first subscription names the three kinds; the next adds one status entry a pane', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    s.source.start()
    await listRead(1)
    expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
    s.advance(999)
    expect(s.timers).toHaveLength(1)
    s.advance(1)
    await listRead(2)
    expect(server.requests.map(({ request }) => request)).toEqual([
      { id: expect.any(String), method: 'events.subscribe', params: { subscriptions: KINDS } },
      { id: expect.any(String), method: 'agent.list', params: {} },
      { id: expect.any(String), method: 'events.subscribe', params: { subscriptions: [...KINDS, statusEntry('w1:p1')] } },
      { id: expect.any(String), method: 'agent.list', params: {} },
    ])
    expect(s.timers).toEqual([])
  })

  it('the new subscription opens before the old one closes', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    s.source.start()
    await listRead(1)
    const { connection } = await server.got('events.subscribe', 1)
    let closed = false
    void server.ended(connection).then(() => { closed = true })
    s.advance(1000)
    await server.got('events.subscribe', 2)
    expect(closed).toBe(false)
    await server.ended(connection)
  })

  it('each herdr state is its dial state', async () => {
    server.agents = [agent('w1:p1', 'idle'), agent('w2:p1', 'done'), agent('w3:p1', 'working'), agent('w4:p1', 'blocked'), agent('w5:p1', 'unknown')]
    const listed = setup()
    listed.source.start()
    await listRead(1)
    expect(listed.source.list().map(({ state, unseenDone }) => [state, unseenDone])).toEqual([
      ['idle', false], ['done', true], ['working', false], ['needs-you', false], ['idle', false],
    ])
    listed.source.stop()

    server.agents = [agent('w1:p1')]
    const s = setup()
    s.source.start()
    await listRead(2)
    s.advance(1000)
    await listRead(3)
    for (const [status, state, unseenDone] of [
      ['done', 'done', true], ['working', 'working', false], ['blocked', 'needs-you', false], ['unknown', 'idle', false],
    ] as const) {
      const changes = s.changes
      server.event('pane.agent_status_changed', { agent: 'claude', agent_status: status, pane_id: 'w1:p1' })
      await s.until(() => s.changes > changes)
      expect(row(s, 'w1:p1'), status).toMatchObject({ state, unseenDone })
    }
  })

  it('a turn that ends idle is done with nothing unseen; herdr\'s done is done and unseen', async () => {
    // w2:p1 shows when each status before it has been heard.
    server.agents = [agent('w1:p1'), agent('w2:p1')]
    const s = setup()
    await live(s)
    const hear = async (...statuses: string[]) => {
      const changes = s.changes
      server.send(lines(statuses.map((status) => statusLine('w1:p1', status))))
      await heard(s, 'w2:p1')
      // w2:p1's own change is the last.
      return s.changes - changes - 1
    }
    const w1 = () => { const { state, unseenDone } = row(s, 'w1:p1')!; return { state, unseenDone } }

    expect(await hear('working')).toBe(1)
    const at = row(s, 'w1:p1')!.lastActivityAt
    s.advance(5000)
    expect(await hear('idle')).toBe(1)
    expect(w1()).toEqual({ state: 'done', unseenDone: false })
    expect(row(s, 'w1:p1')!.lastActivityAt).toBe(at + 5000)
    expect(await hear('blocked', 'idle')).toBe(2)
    expect(w1()).toEqual({ state: 'done', unseenDone: false })
    // An idle herdr says again tells nothing.
    expect(await hear('idle')).toBe(0)
    expect(w1()).toEqual({ state: 'done', unseenDone: false })

    expect(await hear('working', 'done')).toBe(2)
    expect(w1()).toEqual({ state: 'done', unseenDone: true })
    expect(await hear('idle')).toBe(1)
    expect(w1()).toEqual({ state: 'idle', unseenDone: false })
    expect(await hear('unknown', 'idle')).toBe(0)
    expect(w1()).toEqual({ state: 'idle', unseenDone: false })
    expect(await hear('working', 'unknown')).toBe(2)
    expect(w1()).toEqual({ state: 'idle', unseenDone: false })
  })

  it('a list read after a reconnect ends the turn the same way, and a list that repeats idle leaves it done', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    await live(s)
    server.event('pane.agent_status_changed', { agent: 'claude', agent_status: 'working', pane_id: 'w1:p1' })
    await s.until(() => row(s, 'w1:p1')?.state === 'working')

    // The turn ends while no subscription hears it: the next list says idle.
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    s.advance(1000)
    await s.until(() => row(s, 'w1:p1')?.state === 'done')
    expect(row(s, 'w1:p1')!.unseenDone).toBe(false)

    const changes = s.changes
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 2')
    s.advance(2000)
    await listRead(4)
    expect(row(s, 'w1:p1')).toMatchObject({ state: 'done', unseenDone: false })
    expect(s.changes).toBe(changes)
  })

  it('a status event sets the state, and tells once', async () => {
    server.agents = [agent('w1:p1', 'idle', { cwd: '/work/hh' })]
    const s = setup()
    await live(s)
    const seen: Array<[string, boolean]> = []
    s.source.onChange(() => { const { state, unseenDone } = row(s, 'w1:p1')!; seen.push([state, unseenDone]) })
    const changes = s.changes
    // The recorded turn: its detection of a listed pane, two panes created, and three statuses.
    server.send(lines(RECORDED.status.slice(1)))
    await s.until(() => s.changes === changes + 3)
    expect(seen).toEqual([['working', false], ['needs-you', false], ['done', false]])
    await heard(s, 'w1:p1')
    expect(seen).toHaveLength(4)
  })

  it('a replay for listed panes changes nothing and opens nothing', async () => {
    server.agents = [agent('w1:p1'), agent('w2:p1')]
    server.answer('events.subscribe', { raw: lines(RECORDED.replay) })
    const s = setup()
    await live(s)
    const changes = s.changes
    server.send(lines(RECORDED.replay.slice(1)))
    await heard(s, 'w1:p1')
    expect(s.changes).toBe(changes + 1)
    expect(s.timers).toEqual([])
    expect(server.requests.filter(({ request }) => method(request) === 'events.subscribe')).toHaveLength(2)
  })

  it('a released detection, a closed pane and an exited pane each drop the pane at once', async () => {
    server.agents = [agent('w1:p1'), agent('w2:p1'), agent('w3:p1'), agent('w4:p1')]
    const s = setup()
    await live(s)
    const seen: string[][] = []
    s.source.onChange(() => seen.push(s.source.list().map(({ paneKeys }) => paneKeys![0])))
    // The recording: w2:p1's agent is released, its status goes unknown, and its pane closes.
    server.send(lines(RECORDED.released.slice(3)))
    server.event('pane_closed', { pane_id: 'w3:p1', type: 'pane_closed', workspace_id: 'w3' })
    server.event('pane_exited', { pane_id: 'w4:p1', type: 'pane_exited', workspace_id: 'w4' })
    await heard(s, 'w1:p1')
    expect(seen).toEqual([
      ['herdr:w1:p1', 'herdr:w3:p1', 'herdr:w4:p1'],
      ['herdr:w1:p1', 'herdr:w4:p1'],
      ['herdr:w1:p1'],
      ['herdr:w1:p1'],
    ])
    expect(s.timers).toEqual([])
    expect(server.requests.filter(({ request }) => method(request) === 'events.subscribe')).toHaveLength(2)
  })

  it('what a subscription tells while its list is in flight wins over that list', async () => {
    server.agents = [agent('w1:p1', 'working'), agent('w2:p1')]
    const real = herdrClient()
    let lists = 0
    let held!: () => void
    const holding = new Promise<void>((resolve) => { held = resolve })
    let release!: () => void
    // The third list's answer is read only after events herdr told once it had made that list.
    const s = setup({
      client: {
        ...real,
        request: async (method, params) => {
          const answer = await real.request(method, params)
          if (method === 'agent.list' && ++lists === 3) await new Promise<void>((resolve) => { release = resolve; held() })
          return answer
        },
      },
    })
    await live(s)
    // w3:p1 asks, so the third subscription names it before any list has.
    server.event('pane_agent_detected', detected('w3:p1'))
    await s.until(() => s.timers.length === 1)
    server.agents = [agent('w1:p1', 'working'), agent('w2:p1'), agent('w3:p1', 'working')]
    s.advance(1000)
    await holding
    server.event('pane.agent_status_changed', { agent: 'claude', agent_status: 'idle', pane_id: 'w3:p1' })
    server.event('pane_closed', { pane_id: 'w2:p1', type: 'pane_closed', workspace_id: 'w2' })
    server.event('pane.agent_status_changed', { agent: 'claude', agent_status: 'idle', pane_id: 'w1:p1' })
    await s.until(() => row(s, 'w1:p1')?.state === 'done' && !row(s, 'w2:p1'))
    release()
    await s.until(() => row(s, 'w3:p1') !== undefined)
    expect(s.source.list().map(({ paneKeys, state }) => [paneKeys![0], state])).toEqual([['herdr:w1:p1', 'done'], ['herdr:w3:p1', 'idle']])
    expect(s.timers).toEqual([])
  })

  it('a pane not yet known asks for one new subscription, and detections within the second join it', async () => {
    server.agents = [agent('w9:p1')]
    const s = setup()
    await live(s)
    server.send(lines(['w1:p1', 'w2:p1', 'w3:p1'].map((pane) => JSON.stringify({ data: detected(pane), event: 'pane_agent_detected' }))))
    await heard(s, 'w9:p1')
    expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
    server.agents = [agent('w9:p1'), agent('w1:p1'), agent('w2:p1'), agent('w3:p1')]
    s.advance(1000)
    const third = await server.got('events.subscribe', 3)
    expect(third.request).toMatchObject({
      params: { subscriptions: [...KINDS, ...['w9:p1', 'w1:p1', 'w2:p1', 'w3:p1'].map(statusEntry)] },
    })
    await listRead(3)
    expect(s.source.list()).toHaveLength(4)
    expect(s.timers).toEqual([])
  })

  it('a pane the list left out asks for no second subscription', async () => {
    // herdr replays a detection of each agent on every subscription, and the list leaves out one of a status it may add.
    server.agents = [agent('w1:p1'), agent('w2:p1', 'paused')]
    const s = setup()
    s.source.start()
    await listRead(1)
    s.advance(1000)
    const second = await server.got('events.subscribe', 2)
    expect(second.request).toMatchObject({ params: { subscriptions: [...KINDS, statusEntry('w1:p1'), statusEntry('w2:p1')] } })
    await listRead(2)
    // The second subscription's replay of w2:p1 has been heard.
    await heard(s, 'w1:p1')
    expect(s.source.list().map(({ paneKeys }) => paneKeys)).toEqual([['herdr:w1:p1']])
    expect(s.timers).toEqual([])
  })

  it('a detection while a subscription opens joins it', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    await live(s)
    server.event('pane_agent_detected', detected('w2:p1'))
    await s.until(() => s.timers.length === 1)
    server.answer('events.subscribe', 'hold')
    s.advance(1000)
    await server.got('events.subscribe', 3)
    server.event('pane_agent_detected', detected('w3:p1'))
    await heard(s, 'w1:p1')
    expect(s.timers).toEqual([])
    s.source.stop()
  })

  it('65 agents: 64 listed, one log line, and a detection of another pane starts no subscription', async () => {
    server.agents = Array.from({ length: 65 }, (_, i) => agent(`w${i + 1}:p1`))
    // No replay: no pane has asked, so only the 64 listed stop the next one.
    server.answer('events.subscribe', { raw: lines(RECORDED.replay.slice(0, 1)) })
    const s = setup()
    s.source.start()
    await listRead(1)
    expect(s.source.list()).toHaveLength(64)
    expect(s.log).toEqual(['[herdr] socket · live', '[herdr] listed · 64 agents', '[herdr] over · 1 left out'])
    s.advance(1000)
    const second = await server.got('events.subscribe', 2)
    expect(second.request).toMatchObject({
      params: { subscriptions: [...KINDS, ...Array.from({ length: 64 }, (_, i) => statusEntry(`w${i + 1}:p1`))] },
    })
    await listRead(2)
    expect(s.log).toEqual(['[herdr] socket · live', '[herdr] listed · 64 agents', '[herdr] over · 1 left out', '[herdr] over · 1 left out'])
    server.event('pane_agent_detected', detected('w99:p1'))
    await heard(s, 'w1:p1')
    expect(s.timers).toEqual([])
  })

  it('panes that asked and are never listed are 64 at most', async () => {
    server.agents = [agent('w1:p1')]
    // No replay: only the detections sent here ask.
    server.answer('events.subscribe', { raw: lines(RECORDED.replay.slice(0, 1)) })
    const s = setup()
    await live(s)
    const detections = (from: number, to: number) => lines(Array.from({ length: to - from + 1 }, (_, i) =>
      JSON.stringify({ data: detected(`w${from + i}:p9`), event: 'pane_agent_detected' })))
    server.send(detections(1, 64))
    await heard(s, 'w1:p1')
    s.advance(1000)
    const third = await server.got('events.subscribe', 3)
    expect(third.request).toMatchObject({
      params: { subscriptions: [...KINDS, statusEntry('w1:p1'), ...Array.from({ length: 63 }, (_, i) => statusEntry(`w${i + 1}:p9`))] },
    })
    await listRead(3)
    server.send(detections(65, 65))
    await heard(s, 'w1:p1')
    expect(s.timers).toEqual([])
  })

  it('a pane that asked is named only until it is listed', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    await live(s)
    server.event('pane_agent_detected', detected('w2:p1'))
    await s.until(() => s.timers.length === 1)
    server.agents = [agent('w1:p1'), agent('w2:p1')]
    s.advance(1000)
    await listRead(3)
    // w2:p1 closes while no subscription hears it.
    server.drop()
    server.agents = [agent('w1:p1')]
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    s.advance(1000)
    await listRead(4)
    server.event('pane_agent_detected', detected('w3:p1'))
    await s.until(() => s.timers.length === 1)
    s.advance(1000)
    const fifth = await server.got('events.subscribe', 5)
    expect(fifth.request).toMatchObject({ params: { subscriptions: [...KINDS, statusEntry('w1:p1'), statusEntry('w3:p1')] } })
  })

  it('an entry with a bad pane id, kind or status is left out, the rest listed', async () => {
    server.agents = [
      agent('w1'), { ...agent('w2:p1'), agent: 'Claude' }, agent('w3:p1', null as unknown as string), agent('w4:p1', 'paused'),
      'not an agent' as unknown as Record<string, unknown>, agent('w5:p1'),
    ]
    const s = setup()
    s.source.start()
    await listRead(1)
    expect(s.source.list().map(({ paneKeys }) => paneKeys)).toEqual([['herdr:w5:p1']])
  })

  it('a name is herdr\'s, else the folder\'s, else the kind; cut to 64, control characters removed; a title is not read', async () => {
    server.agents = [
      agent('w1:p1', 'idle', { name: 'review\u001b[2J bot\n' }),
      agent('w2:p1', 'idle', { name: 'n'.repeat(70) }),
      agent('w3:p1', 'idle', { title: 'Fixing the login', cwd: '/work/web' }),
      agent('w4:p1', 'idle', { name: '\u0007', cwd: '/work/a\tb' }),
      { pane_id: 'w5:p1', agent: 'codex', agent_status: 'idle' },
      agent('w6:p1', 'idle', { name: `${'é'.repeat(63)}😀😀` }),
    ]
    const s = setup()
    s.source.start()
    await listRead(1)
    expect(s.source.list().map(({ name }) => name)).toEqual([
      'review[2J bot', 'n'.repeat(64), 'web', 'ab', 'codex', `${'é'.repeat(63)}😀`,
    ])
  })

  it('a cwd is cut to 4096 characters', async () => {
    server.agents = [agent('w1:p1', 'idle', { cwd: `/${'d'.repeat(5000)}` })]
    const s = setup()
    s.source.start()
    await listRead(1)
    expect(s.source.list()[0].cwd).toBe(`/${'d'.repeat(4095)}`)
  })

  it('a session id is taken only for kind id, the pane\'s own agent, in its form', async () => {
    const session = (value: string, kind = 'id', of = 'claude') => ({ agent_session: { agent: of, kind, value } })
    server.agents = [
      agent('w1:p1', 'idle', session('abc-123')),
      agent('w2:p1', 'idle', session('/work/api/.claude/session.jsonl', 'path')),
      agent('w3:p1', 'idle', session('abc-123', 'id', 'codex')),
      agent('w4:p1', 'idle', session('a'.repeat(129))),
      agent('w5:p1', 'idle', session('abc\n123')),
    ]
    const s = setup()
    s.source.start()
    await listRead(1)
    expect(s.source.list().map(({ sessionId }) => sessionId)).toEqual(['abc-123', undefined, undefined, undefined, undefined])
  })

  it('the id is kept across a reconnect while the pane stays listed, and is another once it left', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    await live(s)
    expect(s.source.list()[0].id).toBe('u1')
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    s.advance(1000)
    await listRead(3)
    expect(s.source.list()[0].id).toBe('u1')

    server.event('pane_agent_detected', detected('w1:p1', { final_status: 'done', released: true }))
    await s.until(() => s.source.list().length === 0)
    // Its agent comes back: the pane asks again, and is another agent.
    server.event('pane_agent_detected', detected('w1:p1'))
    await s.until(() => s.timers.length === 1)
    s.advance(1000)
    await listRead(4)
    expect(s.source.list()[0].id).toBe('u2')
  })

  it('done is unseen until the dial turns to it; a list that repeats done leaves it seen', async () => {
    server.agents = [agent('w1:p1', 'done')]
    const s = setup()
    s.source.start()
    await listRead(1)
    expect(s.source.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
    const changes = s.changes
    s.source.markSeen('u1')
    expect(s.source.list()[0]).toMatchObject({ state: 'done', unseenDone: false })
    expect(s.changes).toBe(changes + 1)
    s.source.markSeen('u1')
    s.source.markSeen('unknown')
    expect(s.changes).toBe(changes + 1)
    s.advance(1000)
    await listRead(2)
    expect(s.source.list()[0]).toMatchObject({ state: 'done', unseenDone: false })
    expect(s.changes).toBe(changes + 1)
    // It asks herdr nothing.
    expect(server.requests.map(({ request }) => method(request))).toEqual(['events.subscribe', 'agent.list', 'events.subscribe', 'agent.list'])
  })

  it('with no socket it watches, and connects when the socket appears', async () => {
    await server.stop()
    const s = setup()
    s.source.start()
    expect(s.watchers.size).toBe(1)
    expect(s.timers).toEqual([])
    s.fire()
    expect(s.watchers.size).toBe(1)
    expect(server.connections).toBe(0)

    server.agents = [agent('w1:p1')]
    await server.start()
    s.fire()
    expect(s.watchers.size).toBe(0)
    await s.until(() => s.source.list().length === 1)
  })

  it('a socket that appears after it found none, before its watch started, connects', async () => {
    server.agents = [agent('w1:p1')]
    const real = herdrClient()
    let looks = 0
    // herdr's socket appears just after the source first looked and found none.
    const s = setup({ client: { ...real, socketStamp: () => (looks++ === 0 ? undefined : real.socketStamp()) } })
    s.source.start()
    expect(s.watchers.size).toBe(0)
    await s.until(() => s.source.list().length === 1)
  })

  it('a dropped subscription keeps its agents until the first retry; that retry failing empties the list', async () => {
    server.agents = [agent('w1:p1')]
    const s = holding(stampAt(WALL - 60_000))
    await live(s)
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    expect(s.log.slice(-2)).toEqual(['[herdr] closed · ended', '[herdr] retry · 1'])
    expect(s.source.list()).toHaveLength(1)

    await server.stale()
    const changes = s.changes
    s.advance(1000)
    await s.until(() => s.log.at(-1) === '[herdr] retry · 2')
    expect(s.log.slice(-2)).toEqual(['[herdr] closed · refused', '[herdr] retry · 2'])
    expect(s.source.list()).toEqual([])
    expect(s.changes).toBe(changes + 1)

    // herdr starts again with as many agents: its list is said again.
    await server.start()
    s.advance(2000)
    await s.until(() => s.source.list().length === 1)
    expect(s.log.at(-1)).toBe('[herdr] listed · 1 agents')
  })

  // A herdr that starts again numbers its panes afresh: a pane id it reuses is another agent's, whose first status ends no
  // turn of the old one's.
  it('a herdr that starts again before the first retry lists its agents afresh: a reused pane id is no done', async () => {
    server.agents = [agent('w1:p1', 'working')]
    const s = setup()
    await live(s)
    const was = row(s, 'w1:p1')!
    expect(was.state).toBe('working')
    await server.stale()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    expect(s.source.list()).toHaveLength(1)
    server.agents = [agent('w1:p1', 'idle')]
    await server.start()
    const shown: string[] = []
    s.source.onChange(() => shown.push(...s.source.list().map(({ state }) => state)))
    s.advance(1000)
    await listRead(3)
    expect(shown).not.toContain('done')
    expect(row(s, 'w1:p1')).toMatchObject({ state: 'idle', unseenDone: false })
    expect(row(s, 'w1:p1')!.id).not.toBe(was.id)
  })

  it('a stale socket is said once, and nothing retries', async () => {
    await server.stale()
    const s = holding(stampAt(WALL - 60_000))
    s.source.start()
    await s.until(() => s.log.length > 0)
    const still = () => {
      expect(s.log).toEqual(['[herdr] socket · stale'])
      expect(s.timers).toEqual([])
      expect(server.connections).toBe(0)
      expect(s.watchers.size).toBe(1)
    }
    still()
    s.fire()
    s.advance(120_000)
    still()
  })

  it('a socket younger than 2 s that refuses is tried once more after 1 s, then is stale', async () => {
    await server.stale()
    const s = holding(stampAt(WALL - 500))
    s.source.start()
    await s.until(() => s.timers.length === 1)
    expect(s.log).toEqual(['[herdr] retry · 1'])
    expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
    s.advance(1000)
    await s.until(() => s.watchers.size === 1)
    expect(s.log).toEqual(['[herdr] retry · 1', '[herdr] socket · stale'])
    expect(s.timers).toEqual([])
  })

  it('a young socket whose server listens by the retry is followed as any other', async () => {
    server.agents = [agent('w1:p1')]
    await server.stale()
    const s = holding(stampAt(WALL - 500))
    s.source.start()
    await s.until(() => s.timers.length === 1)
    await server.start()
    s.advance(1000)
    await s.until(() => s.source.list().length === 1)
    expect(s.log).toEqual(['[herdr] retry · 1', '[herdr] socket · live', '[herdr] listed · 1 agents'])
  })

  it('a socket 2 s old, or with a ctime ahead of the clock, is stale at once', async () => {
    await server.stale()
    for (const stamp of [stampAt(WALL - 2_000), stampAt(WALL + 5_000)]) {
      const s = holding(stamp)
      s.source.start()
      await s.until(() => s.log.length > 0)
      expect(s.log, stamp).toEqual(['[herdr] socket · stale'])
      expect(s.timers, stamp).toEqual([])
      s.source.stop()
    }
  })

  it('a socket gets its one young retry once, across a detach too', async () => {
    await server.stale()
    const s = holding(stampAt(WALL - 500))
    // Refused: given up on, or retried.
    const refused = () => s.until(() => s.watchers.size === 1 || s.timers.length > 0)
    s.source.start()
    await refused()
    s.advance(1000)
    await refused()
    const said = [...s.log]
    s.source.stop()
    s.source.start()
    s.advance(1000)
    await refused()
    expect(s.log).toEqual(said)
    expect(s.timers).toEqual([])
  })

  it('a socket refused after a subscription started on it keeps the retries, then is stale, said once', async () => {
    server.agents = [agent('w1:p1')]
    // Young, which a subscription started on it overrules.
    const s = holding(stampAt(WALL - 500))
    await live(s)
    const from = s.log.length
    await server.stale()
    for (const seconds of [1, 2, 4, 8, 16, 32, 60]) {
      await s.until(() => s.log.at(-1) === `[herdr] retry · ${seconds}`)
      s.advance(seconds * 1000)
    }
    await s.until(() => s.watchers.size === 1)
    expect(s.log.slice(from)).toEqual([
      '[herdr] closed · ended', '[herdr] retry · 1',
      ...[2, 4, 8, 16, 32, 60].flatMap((seconds) => ['[herdr] closed · refused', `[herdr] retry · ${seconds}`]),
      '[herdr] closed · refused', '[herdr] socket · stale',
    ])
    expect(s.timers).toEqual([])
  })

  it('the socket\'s word is said when it changes, never twice', async () => {
    await server.stop()
    const s = setup()
    s.source.start()
    expect(s.log).toEqual(['[herdr] socket · none'])
    s.source.stop()
    s.source.start()
    expect(s.log).toEqual(['[herdr] socket · none'])

    server.agents = [agent('w1:p1')]
    await server.start()
    s.fire()
    await listRead(1)
    expect(s.log).toEqual(['[herdr] socket · none', '[herdr] socket · live', '[herdr] listed · 1 agents'])
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    s.advance(1000)
    await listRead(2)
    expect(s.log).toEqual(['[herdr] socket · none', '[herdr] socket · live', '[herdr] listed · 1 agents', '[herdr] closed · ended', '[herdr] retry · 1'])
  })

  it('a herdr that answers and never lists is given up on after the last retry, and is not called stale', async () => {
    server.answer('agent.list', refusal('agent_not_found'))
    const s = setup()
    s.source.start()
    for (const seconds of [1, 2, 4, 8, 16, 32, 60]) {
      await s.until(() => s.log.at(-1) === `[herdr] retry · ${seconds}`)
      s.advance(seconds * 1000)
    }
    await s.until(() => s.watchers.size === 1)
    expect(s.timers).toEqual([])
    expect(s.log).toEqual(['[herdr] socket · live',
      ...[1, 2, 4, 8, 16, 32, 60].flatMap((seconds) => ['[herdr] list · rejected', `[herdr] retry · ${seconds}`]), '[herdr] list · rejected'])
  })

  it('after giving up, a change beside the same stale socket connects nothing; a replaced socket connects at once', async () => {
    await server.stale()
    const s = setup()
    s.source.start()
    await s.until(() => s.log.length > 0)
    expect(s.watchers.size).toBe(1)
    const said = s.log.length
    // herdr's log beside its socket changes the folder.
    s.fire()
    expect(s.watchers.size).toBe(1)
    expect(s.timers).toEqual([])

    server.agents = [agent('w1:p1')]
    await server.start()
    // herdr starts again a while later.
    s.advance(5000)
    s.fire()
    expect(s.watchers.size).toBe(0)
    expect(s.timers).toEqual([])
    await s.until(() => s.source.list().length === 1)
    expect(s.log.slice(said)).toEqual(['[herdr] socket · live', '[herdr] listed · 1 agents'])
    // The herdr that started again is retried afresh.
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
  })

  it('a subscription that drops within 60 s does not put the delay back to 1 s; one that lived 60 s does', async () => {
    const s = setup()
    s.source.start()
    await listRead(1)
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    s.advance(1000)
    await listRead(2)
    s.advance(59_999)
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 2')
    s.advance(2000)
    await listRead(3)
    s.advance(60_000)
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
  })

  it('a herdr that lists and drops each subscription is retried at 60 s, and given up on only once a retry lists nothing', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    s.source.start()
    await listRead(1)
    // Each retry lists, and its subscription drops before the 60 s that would put the wait back to 1 s.
    let lists = 1
    for (const seconds of [1, 2, 4, 8, 16, 32, 60]) {
      server.drop()
      await s.until(() => s.log.at(-1) === `[herdr] retry · ${seconds}`)
      s.advance(seconds * 1000)
      await listRead(++lists)
    }
    const said = s.log.length
    server.drop()
    await s.until(() => s.log.length > said)
    expect(s.log.slice(said)).toEqual(['[herdr] closed · ended', '[herdr] retry · 60'])
    expect(s.source.list()).toHaveLength(1)
    expect(s.watchers.size).toBe(0)

    await server.stale()
    s.advance(60_000)
    await s.until(() => s.watchers.size === 1)
    expect(s.timers).toEqual([])
    expect(s.source.list()).toEqual([])
  })

  it('a herdr that starts again while the last retry fails is tried within the second', async () => {
    await server.stale()
    const real = herdrClient()
    let moved = false
    // What the source reads of herdr's socket: once moved, the socket of a herdr that started again.
    const s = setup({ client: { ...real, socketStamp: () => moved ? 'restarted' : real.socketStamp() } })
    s.source.start()
    // The source has tried the stale socket; herdr starts again before the refusal comes back.
    moved = true
    await s.until(() => s.timers.length === 1)
    expect(s.watchers.size).toBe(0)
    expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
    server.agents = [agent('w1:p1')]
    await server.start()
    s.advance(1000)
    await s.until(() => s.source.list().length === 1)
  })

  // herdr's own codes and the client's words are apart: a herdr that answers `no_socket` has a socket, and is retried with
  // the waits that grow and give up, as for any refusal, never reconnected on each change beside its socket.
  it('a list herdr refuses with a code that is one of the client\'s own words is rejected, and retried', async () => {
    server.answer('agent.list', refusal('no_socket'))
    const s = setup()
    s.source.start()
    await s.until(() => s.timers.length > 0)
    expect(s.log).toEqual(['[herdr] socket · live', '[herdr] list · rejected', '[herdr] retry · 1'])
    expect(s.watchers.size).toBe(0)
    await server.ended(1)
  })

  it('a list that fails, and a new subscription that does not start, are a drop', async () => {
    server.answer('agent.list', refusal('invalid_request'))
    const s = setup()
    s.source.start()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    // herdr's own code is not said.
    expect(s.log).toEqual(['[herdr] socket · live', '[herdr] list · rejected', '[herdr] retry · 1'])
    await server.ended(1)
    expect(s.source.list()).toEqual([])

    server.answer('agent.list')
    server.agents = [agent('w1:p1')]
    s.advance(1000)
    await s.until(() => s.source.list().length === 1)
    const { connection: live } = await server.got('events.subscribe', 2)
    // That list asks for a subscription naming w1:p1, which herdr never starts.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.answer('events.subscribe', 'hold')
    s.advance(1000)
    const { connection: held } = await server.got('events.subscribe', 3)
    vi.advanceTimersByTime(10_000)
    await s.until(() => s.log.at(-1) === '[herdr] retry · 2')
    expect(s.log.slice(-2)).toEqual(['[herdr] closed · timeout', '[herdr] retry · 2'])
    // The old one was live: its agents stay for the retry.
    expect(s.source.list()).toHaveLength(1)
    await server.ended(held)
    await server.ended(live)
  })

  it('while live and idle it holds one connection and no timer', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    await live(s)
    expect(server.connections).toBe(4)
    for (const connection of [1, 2, 4]) await server.ended(connection)
    expect(s.timers).toEqual([])
    expect(s.watchers.size).toBe(0)
    // The third connection, the second subscription, still tells.
    await heard(s, 'w1:p1')
    expect(server.connections).toBe(4)
  })

  it('stop while the list is in flight: its answer lists nothing, and no connection, watch or timer is left', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    s.source.start()
    const { connection } = await server.got('agent.list', 1)
    s.source.stop()
    await server.ended(connection)
    await server.ended(1)
    expect(s.source.list()).toEqual([])
    expect(s.changes).toBe(0)
    expect(s.timers).toEqual([])
    expect(s.watchers.size).toBe(0)
    expect(s.log).toEqual(['[herdr] socket · live'])
  })

  it('stop empties the list and tells once; started again, its agents have fresh ids', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    await live(s)
    const changes = s.changes
    s.source.stop()
    expect(s.source.list()).toEqual([])
    expect(s.changes).toBe(changes + 1)
    s.source.stop()
    expect(s.changes).toBe(changes + 1)
    await server.ended(3)

    const subscribe = vi.spyOn(s.client, 'subscribe')
    s.source.start()
    // The last subscription opened under a second ago: the next waits out the rest of that second.
    expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
    expect(subscribe).not.toHaveBeenCalled()
    s.advance(1000)
    expect(subscribe).toHaveBeenCalledTimes(1)
    await listRead(3)
    expect(s.source.list().map(({ id }) => id)).toEqual(['u2'])
  })

  it('start twice is one subscription', async () => {
    const s = setup()
    const subscribe = vi.spyOn(s.client, 'subscribe')
    s.source.start()
    s.source.start()
    await listRead(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('on Windows start does nothing', () => {
    const s = setup({ platform: 'win32' })
    const subscribe = vi.spyOn(s.client, 'subscribe')
    const stamp = vi.spyOn(s.client, 'socketStamp')
    s.source.start()
    expect(subscribe).not.toHaveBeenCalled()
    expect(stamp).not.toHaveBeenCalled()
    expect(s.watchers.size).toBe(0)
    expect(s.timers).toEqual([])
  })

  it('voice', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    await live(s)
    const api = () => row(s, 'w1:p1')!
    const to = async (status: string, state: string) => {
      server.agents[0].agent_status = status
      server.event('pane.agent_status_changed', { agent: 'claude', agent_status: status, pane_id: 'w1:p1' })
      await s.until(() => api().state === state)
    }
    const sent = async () => {
      const calls = s.prompt.mock.calls.length
      expect(await s.source.send(api(), 'run the tests')).toEqual({ ok: true })
      expect(s.prompt.mock.calls.slice(calls)).toEqual([['w1:p1', 'claude', 'run the tests']])
    }
    const refused = async (reason: string, text = 'run the tests', of: HostAgent = api()) => {
      const calls = s.prompt.mock.calls.length
      expect(await s.source.send(of, text)).toEqual({ ok: false, reason })
      return s.prompt.mock.calls.length - calls
    }
    const BUSY = 'api is busy. Say it when it is done.'

    // Idle, done, and a turn that ended idle.
    await sent()
    await to('done', 'done')
    await sent()
    await to('working', 'working')
    expect(await refused(BUSY)).toBe(0)
    await to('idle', 'done')
    expect(api().unseenDone).toBe(false)
    await sent()
    expect(s.counts).toEqual(['herdr', 'herdr', 'busy', 'herdr'])

    await to('blocked', 'needs-you')
    expect(await refused('api is waiting for your answer in herdr.')).toBe(0)
    await to('unknown', 'idle')
    expect(await refused(BUSY)).toBe(0)
    expect(s.counts.slice(4)).toEqual(['waiting', 'busy'])

    // A second send while one runs, and a prompt the adapter answers busy.
    await to('done', 'done')
    s.counts.length = 0
    let answer!: (prompt: HerdrPrompt) => void
    vi.spyOn(s.client, 'prompt').mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const first = s.source.send(api(), 'run the tests')
    // The adapter holds the pane's turn: it answers busy, and the client is asked once.
    expect(await refused(BUSY, 'and then')).toBe(1)
    expect(s.client.prompt).toHaveBeenCalledTimes(1)
    answer({ outcome: 'sent' })
    expect(await first).toEqual({ ok: true })
    s.prompt.mockResolvedValueOnce({ outcome: 'busy' })
    expect(await refused(BUSY)).toBe(1)
    expect(s.counts).toEqual(['busy', 'herdr', 'busy'])

    s.counts.length = 0
    expect(await refused('Too long. Say it shorter.', 'x'.repeat(2001))).toBe(0)
    server.answer('agent.prompt', refusal('agent_not_ready'))
    expect(await refused('api did not answer.')).toBe(1)
    const gone = api()
    server.event('pane_closed', { pane_id: 'w1:p1', type: 'pane_closed', workspace_id: 'w1' })
    await s.until(() => s.source.list().length === 0)
    expect(await refused('api did not answer.', 'run the tests', gone)).toBe(0)
    expect(s.counts).toEqual(['too-long', 'no-answer', 'no-answer'])
  })

  it('a tap focuses the agent\'s pane through deps.focus; one no longer listed is false', async () => {
    server.agents = [agent('w1:p1')]
    const s = setup()
    s.source.start()
    await listRead(1)
    const api = s.source.list()[0]
    expect(await s.source.focus(api)).toBe(true)
    expect(s.focus.mock.calls).toEqual([['w1:p1']])
    s.focus.mockResolvedValueOnce(false)
    expect(await s.source.focus(api)).toBe(false)
    expect(await s.source.focus({ ...api, id: 'gone' })).toBe(false)
    expect(s.focus).toHaveBeenCalledTimes(2)
  })

  it('no log line holds a pane id, a name, a folder or the words', async () => {
    server.agents = Array.from({ length: 65 }, (_, i) => agent(`w${i + 1}:p1`, 'idle', { name: 'secret-name', cwd: '/work/secret-folder' }))
    const s = setup()
    await live(s)
    expect(await s.source.send(s.source.list()[0], 'secret words')).toEqual({ ok: true })
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr] retry · 1')
    expect(s.log).toContain('[herdr] over · 1 left out')
    for (const line of s.log) {
      expect(line).toMatch(LOG_LINE)
      expect(line).not.toMatch(/w1|secret|words/)
    }
  })
})
