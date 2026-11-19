import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHc, type FakeHc, type FakeHcTerminal } from '../../testing/fakeHc.js'
import { createHcClient, type HcPrompt } from './hcClient.js'
import { HcSource, type HcSourceDeps } from './hcSource.js'
import type { HostAgent, PaneSwitch } from './types.js'

/** The wall clock the test starts at. */
const WALL = 1_700_000_000_000
/** The stamp (`<inode>:<ctime in ns>`) of a socket made at that wall clock time. A real socket of the fake's is made
 *  after WALL, so it is never young. */
const stampAt = (ms: number) => `7:${BigInt(ms) * 1_000_000n}`
const RETRIES = [1, 2, 4, 8, 16, 32, 60]
const LOG_LINE = /^\[herdr-app\] (socket · (none|stale|live)|listed · \d+ agents|over · \d+ left out|list · [a-z_]+|closed · [a-z_]+|retry · \d+)$/

/** A terminal Herdr's window shows, with the fake's defaults: live, labeled `herdr.space`, Claude Code idle. */
const agent = (address: string, more: Partial<FakeHcTerminal> = {}): FakeHcTerminal => ({ address, cwd: '/work/api', ...more })
const status = (state: string, app = 'claude-code') => ({ status: { state, app } })
const method = (request: unknown) => (request as { method: string }).method
/** Lets what a socket has already said be read. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

describe.skipIf(process.platform === 'win32')('the hc source (docs/plans/2026-11-16-herdr-app-design.md)', () => {
  let server: FakeHc

  beforeEach(async () => { server = await fakeHc() })
  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  const hcClient = () =>
    createHcClient({ socketPath: server.path, home: dirname(server.path), uid: process.getuid!(), platform: 'darwin' })

  /** A source on the real client and the fake server, its words through that client's prompt, with a timer queue, a
   *  watch and two clocks the test runs by hand. */
  function setup(over: Partial<HcSourceDeps> = {}) {
    const client = hcClient()
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
    const prompt = vi.fn((address: string, kind: string, text: string): Promise<HcPrompt> => client.prompt(address, kind, text))
    const focus = vi.fn(async (_address: string, _agentId: string) => true)
    const canShow = vi.fn((_address: string) => true)
    const show = vi.fn(async (_address: string, _agentId: string): Promise<PaneSwitch> => 'ok')
    const deps: HcSourceDeps = {
      client,
      watch: (changed) => {
        watchers.add(changed)
        settle()
        return () => { watchers.delete(changed) }
      },
      prompt,
      focus,
      canShow,
      show,
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
    const source = new HcSource(deps)
    source.onChange(() => {
      changes++
      settle()
    })
    const due = () => timers.filter(({ at }) => at <= mono).sort((a, b) => a.at - b.at)[0]
    return {
      source, client, prompt, focus, canShow, show, timers, watchers, log, counts,
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
      /** A change where hc's socket lives. */
      fire: () => { for (const changed of [...watchers]) changed() },
    }
  }
  type Setup = ReturnType<typeof setup>

  const row = (s: Setup, address: string): HostAgent | undefined =>
    s.source.list().find((a) => a.paneKeys?.[0] === `herdr-app:${address}`)
  const listed = (s: Setup) => s.source.list().map(({ paneKeys }) => paneKeys![0])

  /** A source whose socket's stamp holds still: a core that died and left its socket, which the fake's own `stale()`
   *  would give another stamp. */
  const holding = (stamp: string) => setup({ client: { ...hcClient(), socketStamp: () => stamp } })

  /** Starts the source and waits for its first snapshot to be listed. */
  async function live(s: Setup): Promise<void> {
    s.source.start()
    await s.until(() => s.log.some((line) => line.startsWith('[herdr-app] listed · ')))
  }

  it('started with a core running, the terminals Herdr\'s window shows are listed with their fields', async () => {
    server.terminals = [
      agent('t7'),
      agent('t8', { labels: {} }),
      agent('t9', { status: null }),
      agent('t10', status('idle', 'Weird App')),
      agent('vps/t3'),
      agent('t11', { state: 'finished' }),
    ]
    const s = setup()
    expect(s.source.id).toBe('herdr-app')
    s.source.start()
    await s.until(() => s.changes === 1)
    expect(s.source.list()).toStrictEqual([{
      id: 'u1', engine: 'claude', cwd: '/work/api', name: 'api', host: 'herdr', app: 'herdr', state: 'idle',
      unseenDone: false, lastActivityAt: WALL, paneKeys: ['herdr-app:t7'],
    }])
    expect(s.log).toEqual(['[herdr-app] socket · live', '[herdr-app] listed · 1 agents'])
    expect(s.source.capabilities()).toEqual({ status: true, voice: true, focus: true, answer: false })
  })

  it('each of hc\'s states is its dial state', async () => {
    const words = ['idle', 'working', 'blocked', 'done', 'error', 'paused']
    server.terminals = [...words.map((word, at) => agent(`t${at + 1}`, status(word))), agent('t7')]
    const s = setup()
    await live(s)
    expect(s.source.list().map(({ paneKeys, state, unseenDone }) => [paneKeys![0], state, unseenDone])).toEqual([
      ['herdr-app:t1', 'idle', false], ['herdr-app:t2', 'working', false], ['herdr-app:t3', 'needs-you', false],
      ['herdr-app:t4', 'done', true], ['herdr-app:t5', 'error', false], ['herdr-app:t7', 'idle', false],
    ])
    const t7 = () => row(s, 't7')
    for (const [word, state, unseen] of [
      ['working', 'working', false], ['blocked', 'needs-you', false], ['done', 'done', true], ['error', 'error', false],
    ] as const) {
      server.change('t7', status(word))
      await s.until(() => t7()?.state === state)
      expect(t7()?.unseenDone, word).toBe(unseen)
    }
    server.change('t7', status('paused'))
    await s.until(() => t7() === undefined)
  })

  it('a turn that ends idle is done with nothing unseen; hc\'s done is done and unseen', async () => {
    server.terminals = [agent('t7')]
    const s = setup()
    await live(s)
    const t7 = () => row(s, 't7')!
    const to = async (word: string, state: string) => {
      server.change('t7', status(word))
      await s.until(() => t7().state === state)
    }
    for (const from of ['working', 'blocked']) {
      await to(from, from === 'working' ? 'working' : 'needs-you')
      const changes = s.changes
      await to('idle', 'done')
      expect(t7().unseenDone, from).toBe(false)
      expect(s.changes, from).toBe(changes + 1)
    }
    s.advance(5_000)
    await to('working', 'working')
    expect(t7().lastActivityAt).toBe(WALL + 5_000)
    await to('done', 'done')
    expect(t7().unseenDone).toBe(true)
    await to('idle', 'idle')
    await to('error', 'error')
    await to('idle', 'idle')
    // A change of what it shows but its state keeps the time of its last activity.
    s.advance(5_000)
    server.change('t7', { cwd: '/work/web' })
    await s.until(() => t7().name === 'web')
    expect(t7().lastActivityAt).toBe(WALL + 5_000)
  })

  it('a terminal that gains herdr.space, or its first status, is listed at once; one that loses its label, finishes or is removed goes at once', async () => {
    server.terminals = [agent('t7', { labels: {} }), agent('t8', { status: null }), agent('t9')]
    const s = setup()
    await live(s)
    expect(listed(s)).toEqual(['herdr-app:t9'])
    server.change('t7', { labels: { 'herdr.space': 's1' } })
    await s.until(() => listed(s).length === 2)
    server.change('t8', status('idle'))
    await s.until(() => listed(s).length === 3)
    // A terminal hc creates with the window's label, listed once its program's first status follows.
    server.change('t12', { cwd: '/work/new' })
    await s.until(() => listed(s).length === 4)
    expect(listed(s)).toEqual(['herdr-app:t9', 'herdr-app:t7', 'herdr-app:t8', 'herdr-app:t12'])

    server.change('t7', { labels: {} })
    await s.until(() => listed(s).length === 3)
    server.change('t8', { state: 'finished' })
    await s.until(() => listed(s).length === 2)
    server.remove('t9')
    await s.until(() => listed(s).length === 1)
    expect(listed(s)).toEqual(['herdr-app:t12'])
  })

  it('a status that clears drops the row; another app at that address is another row with another id', async () => {
    server.terminals = [agent('t7', status('working'))]
    const s = setup()
    await live(s)
    expect(row(s, 't7')).toMatchObject({ id: 'u1', engine: 'claude', state: 'working' })
    // The agent exits and its shell is back: hc clears the status.
    server.change('t7', { status: null })
    await s.until(() => s.source.list().length === 0)
    server.change('t7', status('working', 'codex'))
    await s.until(() => s.source.list().length === 1)
    expect(row(s, 't7')).toMatchObject({ id: 'u2', engine: 'codex', state: 'working' })
    // Another app's first word at that address ends no turn of the one before.
    server.change('t7', status('idle'))
    await s.until(() => row(s, 't7')?.engine === 'claude')
    expect(row(s, 't7')).toMatchObject({ id: 'u3', state: 'idle', unseenDone: false })
  })

  it('claude-code is claude and codex is codex; another app keeps its word when it fits', async () => {
    server.terminals = [
      agent('t1'), agent('t2', status('idle', 'codex')), agent('t3', status('idle', 'pi')), agent('t4', status('idle', 'Weird App')),
    ]
    const s = setup()
    await live(s)
    expect(s.source.list().map(({ engine }) => engine)).toEqual(['claude', 'codex', 'pi'])
  })

  it('a name is hc\'s, else the folder\'s, else the kind; cut to 64, control characters removed; a cwd is cut to 4096', async () => {
    const long = `/work/${'d'.repeat(5000)}`
    server.terminals = [
      agent('t1', { name: `a\u0007p\u001bi${'x'.repeat(70)}` }),
      agent('t2', { cwd: '/work/web' }),
      agent('t3', { cwd: '' }),
      agent('t4', { cwd: long }),
    ]
    const s = setup()
    await live(s)
    const [named, folder, none, cut] = s.source.list()
    expect(named.name).toBe(`api${'x'.repeat(61)}`)
    expect(folder.name).toBe('web')
    expect(none.name).toBe('claude')
    expect(none.cwd).toBeUndefined()
    expect(cut.cwd).toBe(long.slice(0, 4096))
    expect(cut.name).toBe('d'.repeat(64))
  })

  it('65 listable terminals: 64 listed and one over line; when one leaves the 65th is listed, and the line is not said again', async () => {
    server.terminals = Array.from({ length: 65 }, (_, at) => agent(`t${at + 1}`))
    const s = setup()
    await live(s)
    expect(s.source.list()).toHaveLength(64)
    expect(row(s, 't65')).toBeUndefined()
    server.remove('t1')
    await s.until(() => row(s, 't65') !== undefined)
    expect(s.source.list()).toHaveLength(64)
    expect(s.log).toEqual(['[herdr-app] socket · live', '[herdr-app] listed · 64 agents', '[herdr-app] over · 1 left out'])
  })

  it('terminals the client leaves out past its 1,024 are in the over line', async () => {
    // 1,024 terminals the window does not show, then an agent the client has no room for.
    server.terminals = [...Array.from({ length: 1024 }, (_, at) => agent(`t${at + 1}`, { labels: {} })), agent('t1025')]
    const s = setup()
    await live(s)
    expect(s.source.list()).toEqual([])
    expect(s.log).toEqual(['[herdr-app] socket · live', '[herdr-app] listed · 0 agents', '[herdr-app] over · 1 left out'])
    // One more created past the bound; then a kept one shown, whose line comes after it.
    server.change('t2000', {})
    server.change('t1', { labels: { 'herdr.space': 's1' } })
    await s.until(() => s.source.list().length === 1)
    expect(s.log.slice(3)).toEqual(['[herdr-app] over · 2 left out', '[herdr-app] listed · 1 agents'])
  })

  it('missed: the fresh snapshot replaces the list, and a row that stays keeps its id', async () => {
    server.terminals = [agent('t7'), agent('t8')]
    const s = setup()
    await live(s)
    expect(s.source.list().map(({ id }) => id)).toEqual(['u1', 'u2'])
    server.terminals = [agent('t9'), agent('t7', status('working'))]
    server.missed()
    await s.until(() => row(s, 't8') === undefined)
    expect(s.source.list().map(({ id, paneKeys, state }) => [id, paneKeys![0], state])).toEqual([
      ['u1', 'herdr-app:t7', 'working'], ['u3', 'herdr-app:t9', 'idle'],
    ])
  })

  it('the id is kept across a reconnect to the same socket while the address stays listed', async () => {
    server.terminals = [agent('t7')]
    const s = setup()
    await live(s)
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr-app] retry · 1')
    expect(row(s, 't7')?.id).toBe('u1')
    // It went working while nothing was subscribed: the next snapshot says so.
    server.terminals[0].status = { state: 'working', app: 'claude-code' }
    s.advance(1000)
    await s.until(() => row(s, 't7')?.state === 'working')
    expect(row(s, 't7')?.id).toBe('u1')
  })

  it('a turn that ended while nothing was subscribed, back on the word it started from, is a turn end all the same', async () => {
    server.terminals = [agent('t7'), agent('t8', status('done')), agent('t9')]
    const s = setup()
    await live(s)
    s.source.markSeen(row(s, 't8')!.id)
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr-app] retry · 1')
    // Each went working and back while the source was away: only hc's turn says so.
    server.terminals[0].more = { turn: 1 }
    server.terminals[1].more = { turn: 1 }
    s.advance(1000)
    await server.got('events.subscribe', 2)
    // Lines come in order: t9's change is read after the snapshot.
    server.change('t9', status('working'))
    await s.until(() => row(s, 't9')?.state === 'working')
    expect(row(s, 't7')).toMatchObject({ state: 'done', unseenDone: false, lastActivityAt: WALL + 1000 })
    expect(row(s, 't8')).toMatchObject({ state: 'done', unseenDone: true, lastActivityAt: WALL + 1000 })
    // The same turn told again is no new end.
    s.source.markSeen(row(s, 't8')!.id)
    server.missed()
    server.change('t9', status('idle'))
    await s.until(() => row(s, 't9')?.state === 'done')
    expect(row(s, 't8')?.unseenDone).toBe(false)
  })

  it('done is unseen until the dial turns to it', async () => {
    server.terminals = [agent('t7', status('working'))]
    const s = setup()
    await live(s)
    server.change('t7', status('done'))
    await s.until(() => row(s, 't7')?.state === 'done')
    const api = row(s, 't7')!
    expect(api.unseenDone).toBe(true)
    const changes = s.changes
    s.source.markSeen(api.id)
    expect(row(s, 't7')!.unseenDone).toBe(false)
    expect(s.changes).toBe(changes + 1)
    s.source.markSeen(api.id)
    expect(s.changes).toBe(changes + 1)
    // hc's done again, and a snapshot that says done again, leave it seen. Lines come in order: the folder told after
    // them is read after them.
    server.change('t7', status('done'))
    server.missed()
    server.change('t7', { cwd: '/work/web' })
    await s.until(() => row(s, 't7')!.name === 'web')
    expect(row(s, 't7')!.unseenDone).toBe(false)
    // It asks hc nothing.
    expect(server.requests.map(({ request }) => method(request))).toEqual(['hello', 'events.subscribe'])
  })

  it('with no socket it says none, watches, and lists when the core starts', async () => {
    await server.stop()
    const s = setup()
    s.source.start()
    expect(s.log).toEqual(['[herdr-app] socket · none'])
    expect(s.watchers.size).toBe(1)
    expect(s.timers).toEqual([])
    s.fire()
    expect(s.watchers.size).toBe(1)
    expect(server.connections).toBe(0)

    server.terminals = [agent('t7')]
    await server.start()
    s.fire()
    expect(s.watchers.size).toBe(0)
    await s.until(() => s.source.list().length === 1)
    expect(s.log).toEqual(['[herdr-app] socket · none', '[herdr-app] socket · live', '[herdr-app] listed · 1 agents'])
  })

  it('a stale socket is said once, and nothing retries', async () => {
    await server.stale()
    const s = holding(stampAt(WALL - 60_000))
    s.source.start()
    await s.until(() => s.log.length > 0)
    const still = () => {
      expect(s.log).toEqual(['[herdr-app] socket · stale'])
      expect(s.timers).toEqual([])
      expect(s.watchers.size).toBe(1)
      expect(server.connections).toBe(0)
    }
    still()
    s.fire()
    s.advance(120_000)
    still()
  })

  it('a young socket that refuses is tried once after 1 s; a core listening by then is listed', async () => {
    server.terminals = [agent('t7')]
    await server.stale()
    const s = holding(stampAt(WALL - 500))
    s.source.start()
    await s.until(() => s.timers.length === 1)
    expect(s.log).toEqual(['[herdr-app] retry · 1'])
    expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
    await server.start()
    s.advance(1000)
    await s.until(() => s.source.list().length === 1)
    expect(s.log).toEqual(['[herdr-app] retry · 1', '[herdr-app] socket · live', '[herdr-app] listed · 1 agents'])
  })

  it('a young socket still refused after its one retry is stale, and nothing retries', async () => {
    await server.stale()
    const s = holding(stampAt(WALL - 500))
    s.source.start()
    await s.until(() => s.timers.length === 1)
    s.advance(1000)
    await s.until(() => s.watchers.size === 1)
    expect(s.log).toEqual(['[herdr-app] retry · 1', '[herdr-app] socket · stale'])
    expect(s.timers).toEqual([])
  })

  it('a dropped subscription keeps its agents until the first retry; that retry failing empties the list', async () => {
    server.terminals = [agent('t7')]
    const s = holding(stampAt(WALL - 60_000))
    await live(s)
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr-app] retry · 1')
    expect(s.log.slice(-2)).toEqual(['[herdr-app] closed · ended', '[herdr-app] retry · 1'])
    expect(s.source.list()).toHaveLength(1)

    await server.stale()
    const changes = s.changes
    s.advance(1000)
    await s.until(() => s.log.at(-1) === '[herdr-app] retry · 2')
    expect(s.log.slice(-2)).toEqual(['[herdr-app] closed · refused', '[herdr-app] retry · 2'])
    expect(s.source.list()).toEqual([])
    expect(s.changes).toBe(changes + 1)
  })

  it('45 s of silence is closed · timeout, and retried', async () => {
    server.terminals = [agent('t7')]
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = setup()
    await live(s)
    const said = s.log.length
    vi.advanceTimersByTime(44_999)
    expect(s.log).toHaveLength(said)
    vi.advanceTimersByTime(1)
    expect(s.log.slice(said)).toEqual(['[herdr-app] closed · timeout', '[herdr-app] retry · 1'])
    expect(s.source.list()).toHaveLength(1)
    await server.ended(1)

    s.advance(1000)
    await server.got('events.subscribe', 2)
    server.change('t7', status('working'))
    await s.until(() => row(s, 't7')?.state === 'working')
    expect(row(s, 't7')?.id).toBe('u1')
  })

  it('a core of another generation is list · bad_answer, retried, never listed, and never called stale', async () => {
    server.terminals = [agent('t7')]
    server.answer('hello', { result: { generation: 2 } })
    const s = setup()
    s.source.start()
    for (const seconds of RETRIES) {
      await s.until(() => s.log.at(-1) === `[herdr-app] retry · ${seconds}`)
      s.advance(seconds * 1000)
    }
    await s.until(() => s.watchers.size === 1)
    expect(s.timers).toEqual([])
    expect(s.source.list()).toEqual([])
    expect(s.changes).toBe(0)
    expect(s.log).toEqual([
      ...RETRIES.flatMap((seconds) => ['[herdr-app] list · bad_answer', `[herdr-app] retry · ${seconds}`]),
      '[herdr-app] list · bad_answer',
    ])
  })

  it('a subscription that ends after its snapshot with a bad line is closed, not list', async () => {
    server.terminals = [agent('t7')]
    const s = setup()
    await live(s)
    // A missed line with no snapshot in it.
    server.send('{"jsonrpc":"2.0","method":"missed","params":{"seq":99}}\n')
    await s.until(() => s.log.at(-1) === '[herdr-app] retry · 1')
    expect(s.log.slice(-2)).toEqual(['[herdr-app] closed · bad_answer', '[herdr-app] retry · 1'])
  })

  it('while live it holds one connection, and no timer of its own', async () => {
    server.terminals = [agent('t7')]
    const s = setup()
    await live(s)
    expect(server.connections).toBe(1)
    expect(s.timers).toEqual([])
    expect(s.watchers.size).toBe(0)
    server.change('t7', status('working'))
    await s.until(() => row(s, 't7')?.state === 'working')
    expect(server.connections).toBe(1)
  })

  it('stop while the snapshot is in flight: it lists nothing, and no connection, watch or timer is left', async () => {
    server.terminals = [agent('t7')]
    const s = setup()
    s.source.start()
    await server.got('events.subscribe', 1)
    s.source.stop()
    await server.ended(1)
    await turn()
    expect(s.source.list()).toEqual([])
    expect(s.changes).toBe(0)
    expect(s.timers).toEqual([])
    expect(s.watchers.size).toBe(0)
    expect(s.log).toEqual([])
  })

  it('stop empties the list and tells once; started again, its agents have fresh ids', async () => {
    server.terminals = [agent('t7')]
    const s = setup()
    await live(s)
    const changes = s.changes
    s.source.stop()
    expect(s.source.list()).toEqual([])
    expect(s.changes).toBe(changes + 1)
    s.source.stop()
    expect(s.changes).toBe(changes + 1)
    await server.ended(1)

    s.source.start()
    await s.until(() => s.source.list().length === 1)
    expect(s.source.list().map(({ id }) => id)).toEqual(['u2'])
  })

  it('start twice is one subscription', async () => {
    const s = setup()
    const subscribe = vi.spyOn(s.client, 'subscribe')
    s.source.start()
    s.source.start()
    await s.until(() => s.log.includes('[herdr-app] listed · 0 agents'))
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('voice', async () => {
    server.terminals = [agent('t7')]
    const s = setup()
    await live(s)
    const api = () => row(s, 't7')!
    const to = async (word: string, state: string) => {
      server.change('t7', status(word))
      await s.until(() => row(s, 't7')?.state === state)
    }
    const sent = async () => {
      const calls = s.prompt.mock.calls.length
      expect(await s.source.send(api(), 'run the tests')).toEqual({ ok: true })
      expect(s.prompt.mock.calls.slice(calls)).toEqual([['t7', 'claude', 'run the tests']])
    }
    const refused = async (reason: string, text = 'run the tests', of: HostAgent = api()) => {
      const calls = s.prompt.mock.calls.length
      expect(await s.source.send(of, text)).toEqual({ ok: false, reason })
      return s.prompt.mock.calls.length - calls
    }
    const BUSY = 'api is busy. Say it when it is done.'
    const SILENT = 'api did not answer.'

    // Idle, done, and a turn that ended idle.
    await sent()
    await to('done', 'done')
    await sent()
    await to('working', 'working')
    expect(await refused(BUSY)).toBe(0)
    await to('idle', 'done')
    expect(api().unseenDone).toBe(false)
    await sent()
    expect(s.counts).toEqual(['herdr-app', 'herdr-app', 'busy', 'herdr-app'])
    expect(server.requests.filter(({ request }) => method(request) === 'terminal.send')).toHaveLength(3)

    await to('blocked', 'needs-you')
    expect(await refused('api is waiting for your answer in herdr.')).toBe(0)
    // An errored agent is at no prompt (spec Q7).
    await to('error', 'error')
    expect(await refused(SILENT)).toBe(0)
    expect(s.counts.slice(4)).toEqual(['waiting', 'no-answer'])

    await to('idle', 'idle')
    s.counts.length = 0
    s.prompt.mockResolvedValueOnce({ outcome: 'busy' })
    expect(await refused(BUSY)).toBe(1)
    expect(await refused('Too long. Say it shorter.', 'x'.repeat(2001))).toBe(0)
    server.answer('terminal.get', { error: 'not_found' })
    expect(await refused(SILENT)).toBe(1)
    const gone = api()
    server.remove('t7')
    await s.until(() => s.source.list().length === 0)
    expect(await refused(SILENT, 'run the tests', gone)).toBe(0)
    expect(s.counts).toEqual(['busy', 'too-long', 'no-answer', 'no-answer'])
  })

  it('a tap is deps.focus with the address and the agent; a rest is deps.canShow and deps.show; one no longer listed is false, no pane and failed', async () => {
    server.terminals = [agent('t7')]
    const s = setup()
    await live(s)
    const api = row(s, 't7')!
    expect(await s.source.focus(api)).toBe(true)
    expect(s.focus.mock.calls).toEqual([['t7', 'u1']])
    s.focus.mockResolvedValueOnce(false)
    expect(await s.source.focus(api)).toBe(false)

    expect(s.source.hasPane(api)).toBe(true)
    expect(s.canShow.mock.calls).toEqual([['t7']])
    s.canShow.mockReturnValueOnce(false)
    expect(s.source.hasPane(api)).toBe(false)
    expect(await s.source.showPane(api)).toBe('ok')
    expect(s.show.mock.calls).toEqual([['t7', 'u1']])
    s.show.mockResolvedValueOnce('busy')
    expect(await s.source.showPane(api)).toBe('busy')

    server.remove('t7')
    await s.until(() => s.source.list().length === 0)
    expect(await s.source.focus(api)).toBe(false)
    expect(s.source.hasPane(api)).toBe(false)
    expect(await s.source.showPane(api)).toBe('failed')
    expect(s.focus).toHaveBeenCalledTimes(2)
    expect(s.canShow).toHaveBeenCalledTimes(2)
    expect(s.show).toHaveBeenCalledTimes(2)
  })

  it('shows: each live terminal Herdr\'s window shows, with a status or none, listed or past the 64; reports: each live one hc reports an agent status for, shown or not', async () => {
    server.terminals = [
      agent('t7'),
      agent('t8', { status: null }),
      // A hidden worker, whose hook's copy takes words.
      agent('t9', { labels: {} }),
      agent('t10', status('idle', 'Weird App')),
      agent('t11', status('paused')),
      agent('t12', { state: 'finished' }),
      // With t7, 65 listable: t76 is past the 64.
      ...Array.from({ length: 64 }, (_, at) => agent(`t${at + 13}`)),
    ]
    const s = setup()
    await live(s)
    expect(row(s, 't76')).toBeUndefined()
    const shown = () => ['t7', 't8', 't9', 't10', 't11', 't12', 't76', 't99'].filter((address) => s.source.shows(address))
    const reported = () => ['t7', 't8', 't9', 't10', 't11', 't12', 't76', 't99'].filter((address) => s.source.reports(address))
    expect(shown()).toEqual(['t7', 't8', 't10', 't11', 't76'])
    expect(reported()).toEqual(['t7', 't9', 't76'])

    server.change('t8', status('working'))
    server.remove('t9')
    // Lines come in order: t7's is read after the others.
    server.change('t7', { labels: {} })
    await s.until(() => row(s, 't7') === undefined)
    expect(shown()).toEqual(['t8', 't10', 't11', 't76'])
    expect(reported()).toEqual(['t7', 't8', 't76'])

    s.source.stop()
    expect(shown()).toEqual([])
    expect(reported()).toEqual([])
  })

  /** hc's foreground of a terminal: the program running in it now, with that pid. */
  const foreground = (pid: number): Partial<FakeHcTerminal> =>
    ({ more: { foreground: { argv: ['/usr/local/bin/node'], cwd: '/work/api', name: 'node', pid } } })

  it('terminalOf answers the one live terminal whose foreground is that pid, shown or not, reporting or not', async () => {
    // The fake's foreground pids: 4242, then 4243.
    server.terminals = [agent('t1'), agent('t2', { labels: {}, status: null })]
    const s = setup()
    await live(s)
    expect(s.source.terminalOf(4242)).toBe('t1')
    expect(s.source.terminalOf(4243)).toBe('t2')
    expect(s.source.terminalOf(1)).toBeUndefined()
  })

  it('two terminals whose foreground is the same pid answer none', async () => {
    server.terminals = [agent('t1', foreground(4242)), agent('t2', { labels: {}, ...foreground(4242) })]
    const s = setup()
    await live(s)
    expect(s.source.terminalOf(4242)).toBeUndefined()
    server.change('t2', foreground(5000))
    await s.until(() => s.source.terminalOf(4242) === 't1')
    expect(s.source.terminalOf(5000)).toBe('t2')
  })

  it('a terminal that finished or was removed answers none; a missed snapshot replaces every answer', async () => {
    // The fake's foreground pids: 4242, 4243, 4244.
    server.terminals = [agent('t1'), agent('t2'), agent('t3')]
    const s = setup()
    await live(s)
    expect([4242, 4243, 4244].map((pid) => s.source.terminalOf(pid))).toEqual(['t1', 't2', 't3'])
    server.change('t1', { state: 'finished' })
    await s.until(() => row(s, 't1') === undefined)
    expect(s.source.terminalOf(4242)).toBeUndefined()
    server.remove('t2')
    await s.until(() => row(s, 't2') === undefined)
    expect(s.source.terminalOf(4243)).toBeUndefined()

    // t3 is gone from hc's list with no line of its own, and another terminal runs its pid now.
    server.terminals = [agent('t5', foreground(4244))]
    server.missed()
    await s.until(() => row(s, 't5') !== undefined)
    expect(s.source.terminalOf(4244)).toBe('t5')
  })

  it('a foreground that moves tells one change though no listed row changed; nothing else is logged', async () => {
    server.terminals = [agent('t1')]
    const s = setup()
    await live(s)
    const changes = s.changes
    const list = s.source.list()
    const log = [...s.log]
    server.change('t1', foreground(5000))
    await s.until(() => s.source.terminalOf(5000) === 't1')
    await turn()
    expect(s.changes).toBe(changes + 1)
    expect(s.source.list()).toEqual(list)
    expect(s.log).toEqual(log)
  })

  it('stopped, it answers none and tells the change, though it listed no row', async () => {
    server.terminals = [agent('t1', { labels: {} })]
    const s = setup()
    await live(s)
    expect(s.source.list()).toEqual([])
    expect(s.source.terminalOf(4242)).toBe('t1')
    const changes = s.changes
    s.source.stop()
    expect(s.changes).toBe(changes + 1)
    expect(s.source.terminalOf(4242)).toBeUndefined()
  })

  it('tabOf: the herdr.tab label of each terminal shows covers, listed or past the 64, as it changes; none for any other', async () => {
    const tab = (id: string) => ({ labels: { 'herdr.space': 'sp0123', 'herdr.tab': id } })
    server.terminals = [
      agent('t7', tab('tbaaaa')),
      agent('t8', { ...tab('tbbbbb'), status: null }),
      // A hidden worker: the window does not show it.
      agent('t9', { labels: { 'herdr.tab': 'tbcccc' } }),
      // Shown, with no tab of its own.
      agent('t10'),
      agent('t11', { ...tab('tbdddd'), state: 'finished' }),
      // With t7 and t10, 66 listable: t76 is past the 64.
      ...Array.from({ length: 64 }, (_, at) => agent(`t${at + 13}`, tab('tbeeee'))),
    ]
    const s = setup()
    await live(s)
    const addresses = ['t7', 't8', 't9', 't10', 't11', 't76', 't99']
    const tabs = () => addresses.map((address) => s.source.tabOf(address))
    expect(tabs()).toEqual(['tbaaaa', 'tbbbbb', undefined, undefined, undefined, 'tbeeee', undefined])

    // A terminal moved to another tab is matched there; one the window no longer shows has none.
    server.change('t7', tab('tbffff'))
    server.change('t8', { labels: { 'herdr.tab': 'tbbbbb' } })
    await vi.waitFor(() => expect(tabs()).toEqual(['tbffff', undefined, undefined, undefined, undefined, 'tbeeee', undefined]))

    s.source.stop()
    expect(tabs()).toEqual(addresses.map(() => undefined))
  })

  // The dial's scroll presses a Claude Code terminal's own page keys, and none while it asks (herdrApp.ts).
  it('kindOf and statusOf: the kind and hc\'s status of each terminal shows covers, listed or past the 64, as they change; none for any other', async () => {
    server.terminals = [
      agent('t7'),
      agent('t8', status('working', 'codex')),
      // Shown, its program reporting nothing.
      agent('t9', { status: null }),
      // A hidden worker: the window does not show it.
      agent('t10', { labels: {} }),
      agent('t11', { state: 'finished' }),
      // With t7 and t8, 66 listable: t76 is past the 64.
      ...Array.from({ length: 64 }, (_, at) => agent(`t${at + 13}`, status('blocked'))),
    ]
    const s = setup()
    await live(s)
    const addresses = ['t7', 't8', 't9', 't10', 't11', 't76', 't99']
    const kinds = () => addresses.map((address) => s.source.kindOf(address))
    const statuses = () => addresses.map((address) => s.source.statusOf(address))
    expect(kinds()).toEqual(['claude', 'codex', undefined, undefined, undefined, 'claude', undefined])
    expect(statuses()).toEqual(['idle', 'working', undefined, undefined, undefined, 'blocked', undefined])

    server.change('t7', status('blocked'))
    server.change('t8', { status: null })
    await vi.waitFor(() => expect(statuses()).toEqual(['blocked', undefined, undefined, undefined, undefined, 'blocked', undefined]))
    expect(kinds()).toEqual(['claude', undefined, undefined, undefined, undefined, 'claude', undefined])

    s.source.stop()
    expect(kinds()).toEqual(addresses.map(() => undefined))
    expect(statuses()).toEqual(addresses.map(() => undefined))
  })

  // A drop keeps the rows for the retry, but hc may have changed a status meanwhile: a Claude Code that began to ask
  // must not take the dial's keys on a status heard before the drop (herdrApp.ts).
  it('statusOf is none from a drop until the next snapshot, which tells it again; kindOf is kept', async () => {
    server.terminals = [agent('t7', status('working'))]
    const s = setup()
    await live(s)
    expect(s.source.statusOf('t7')).toBe('working')
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr-app] retry · 1')
    expect(s.source.shows('t7')).toBe(true)
    expect(s.source.kindOf('t7')).toBe('claude')
    expect(s.source.statusOf('t7')).toBeUndefined()

    // It asked while nothing was subscribed: the next snapshot says so.
    server.terminals[0].status = { state: 'blocked', app: 'claude-code' }
    s.advance(1000)
    await s.until(() => s.source.statusOf('t7') === 'blocked')
  })

  it('paneOf answers a listed agent\'s terminal, and none for another id or one that left', async () => {
    server.terminals = [agent('t7'), agent('t8')]
    const s = setup()
    await live(s)
    const left = row(s, 't7')!.id
    expect(s.source.paneOf(left)).toBe('t7')
    expect(s.source.paneOf(row(s, 't8')!.id)).toBe('t8')
    expect(s.source.paneOf('nope')).toBeUndefined()

    server.remove('t7')
    await s.until(() => s.source.list().length === 1)
    expect(s.source.paneOf(left)).toBeUndefined()
  })

  it('no log line holds an address, a name, a folder or the words', async () => {
    server.terminals = Array.from({ length: 65 }, (_, at) => agent(`t${at + 1}`, { name: 'secret-name', cwd: '/work/secret-folder' }))
    const s = setup()
    await live(s)
    expect(await s.source.send(s.source.list()[0], 'secret words')).toEqual({ ok: true })
    server.drop()
    await s.until(() => s.log.at(-1) === '[herdr-app] retry · 1')
    expect(s.log).toContain('[herdr-app] over · 1 left out')
    for (const line of s.log) {
      expect(line).toMatch(LOG_LINE)
      expect(line).not.toMatch(/\bt\d|secret|words/)
    }
  })
})
