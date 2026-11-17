import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOpencode, type FakeAnswer, type FakeOpencode, type FakeSession } from '../../testing/fakeOpencode.js'
import { createOpencodeClient, MAX_BODY_BYTES, type OpencodeClient, type OpencodePrompt } from './opencodeClient.js'
import { LIST_LIMIT, MAX_SESSIONS, OpencodeSource, RECENT_MS, type OpencodeSourceDeps } from './opencodeSource.js'
import type { HostAgent, HostAgentState } from './types.js'

/** The wall clock the test starts at; the sessions' times are set against it. */
const WALL = 1_700_000_000_000
const HOUR = 3600_000
/** The test's message ids, in opencode's form, which the client holds them to. */
const messageIdOf = (n: number) => `msg_${n.toString(16).padStart(12, '0')}${'A'.repeat(14)}`
const LIST = 'GET /api/session'
const ACTIVE = 'GET /api/session/active'
const POST = 'POST /api/session/ses_a1/prompt'
const message = (id: string) => `GET /api/session/${id}/message`
const NOT_FOUND: FakeAnswer = { status: 404, json: { _tag: 'SessionNotFoundError', sessionID: 'ses_a1', message: 'Session not found' } }
/** At rest, viewed since its last turn ended. */
const API: FakeSession = {
  id: 'ses_a1', title: 'Fix the login test', directory: '/work/api', updated: WALL - 60_000, idle: WALL - 60_000,
  viewed: WALL - 30_000, answer: 'All 12 tests pass.',
}
const BUSY = 'Fix the login test is busy. Say it when it is done.'
const SILENT = 'Fix the login test did not answer.'
const LOG_LINE = /^\[opencode\] (listed · \d+ sessions|over · \d+ left out|(list|closed) · [a-z0-9_]+|retry · \d+|service · (not_local|not_ours|old_version|unauthorized))$/

const routes = (server: FakeOpencode) => server.requests.map(({ method, path }) => `${method} ${path}`)
const count = (server: FakeOpencode, route: string) => routes(server).filter((each) => each === route).length
/** Every promise the source's work queued has run. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** The real client, whose answers to the paths `hold` matches are read, then kept back until `release`. `calls` holds each
 *  path asked, as the source asks it. */
function gated(real: OpencodeClient) {
  let match: ((path: string) => boolean) | undefined
  let reached = () => {}
  const kept: Array<() => void> = []
  const calls: string[] = []
  const client: OpencodeClient = {
    ...real,
    request: async (method, path, body) => {
      calls.push(path)
      const answer = await real.request(method, path, body)
      if (match?.(path)) await new Promise<void>((resolve) => { kept.push(resolve); reached() })
      return answer
    },
  }
  return {
    client,
    calls,
    /** From now on; resolves once an answer is kept back. */
    hold: (paths: (path: string) => boolean) => new Promise<void>((resolve) => {
      match = paths
      reached = resolve
    }),
    release: () => {
      match = undefined
      for (const go of kept.splice(0)) go()
    },
  }
}

describe("the opencode source (docs/plans/2026-11-17-dial-opencode-design.md)", () => {
  let server: FakeOpencode
  const made: OpencodeSource[] = []

  beforeEach(async () => { server = await fakeOpencode() })
  afterEach(async () => {
    for (const source of made.splice(0)) source.stop()
    await server.stop()
  })

  const opencode = () => createOpencodeClient({ servicePath: server.servicePath, uid: process.getuid?.() ?? -1, platform: process.platform })

  /** A source on the real client and the fake server, with a timer queue, a watch and two clocks the test runs by hand. */
  function setup(over: Partial<OpencodeSourceDeps> = {}) {
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
    let messages = 0
    let changes = 0
    const deps: OpencodeSourceDeps = {
      client: opencode(),
      watch: (changed) => {
        watchers.add(changed)
        settle()
        return () => { watchers.delete(changed) }
      },
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
      messageId: () => messageIdOf(++messages),
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
    const source = new OpencodeSource(deps)
    made.push(source)
    source.onChange(() => {
      changes++
      settle()
    })
    const due = () => timers.filter(({ at }) => at <= mono).sort((a, b) => a.at - b.at)[0]
    return {
      source, timers, watchers, log, counts,
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
      /** A change where service.json lives. */
      fire: () => { for (const changed of [...watchers]) changed() },
    }
  }
  type Setup = ReturnType<typeof setup>

  const row = (s: Setup, id: string): HostAgent | undefined => s.source.list().find(({ sessionId }) => sessionId === id)
  const said = (s: Setup, line: string) => s.log.filter((each) => each === line).length

  /** Starts the source and waits for its first list. */
  async function live(s: Setup, sessions = 1): Promise<void> {
    s.source.start()
    await s.until(() => s.log.includes(`[opencode] listed · ${sessions} sessions`))
  }

  let fences = 0
  /** Events on the stream come in order: once a rename sent after them has named the row, each one before it was heard. */
  async function heard(s: Setup, id = 'ses_a1'): Promise<void> {
    const title = `Fence ${++fences}`
    server.event('session.renamed', { sessionID: id, title })
    await s.until(() => row(s, id)?.name === title)
  }

  describe('finding the service', () => {
    it('started with a service registered, its sessions are listed with their fields', async () => {
      server.session(API)
      const s = setup()
      expect(s.source.id).toBe('opencode')
      await live(s)
      expect(s.source.list()).toEqual([{
        id: 'u1', engine: 'opencode', sessionId: 'ses_a1', cwd: '/work/api', name: 'Fix the login test', host: 'opencode',
        app: 'opencode', state: 'idle', unseenDone: false, lastActivityAt: API.updated, lastAnswer: 'All 12 tests pass.',
      }])
      expect(s.changes).toBe(1)
      expect(s.log).toEqual(['[opencode] listed · 1 sessions'])
    })

    it('the list is asked once server.connected has come, with parentID=null, archived=false, order=desc and limit=50, then the active sessions', async () => {
      server.session(API)
      // A stream that ends before server.connected asks for no list.
      server.answer('GET /api/event', { raw: '' })
      const s = setup()
      s.source.start()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      server.answer('GET /api/event')
      s.advance(1000)
      await s.until(() => s.source.list().length === 1)
      expect(routes(server)).toEqual([
        'GET /api/info', 'GET /api/event', 'GET /api/info', 'GET /api/event', LIST, ACTIVE, message('ses_a1'),
      ])
      expect(LIST_LIMIT).toBe(50)
      expect(Object.fromEntries((await server.got(LIST)).query)).toEqual({ parentID: 'null', archived: 'false', order: 'desc', limit: '50' })
      expect(Object.fromEntries((await server.got(message('ses_a1'))).query)).toEqual({ type: 'assistant', order: 'desc', limit: '1' })
      expect(s.log).toEqual(['[opencode] closed · ended', '[opencode] retry · 1', '[opencode] listed · 1 sessions'])
    })

    it('with no service file it holds the watch and no timer, and lists when the file appears', async () => {
      server.session(API)
      rmSync(server.servicePath)
      const s = setup()
      s.source.start()
      await turn()
      expect(s.watchers.size).toBe(1)
      expect(s.timers).toEqual([])
      expect(s.log).toEqual([])
      expect(server.requests).toEqual([])
      server.register()
      s.fire()
      await s.until(() => s.source.list().length === 1)
      expect(s.watchers.size).toBe(1)
      expect(s.timers).toEqual([])
    })

    it('a file being written is no service and says nothing; the whole one is found at the next change', async () => {
      server.session(API)
      const whole = readFileSync(server.servicePath, 'utf8')
      writeFileSync(server.servicePath, whole.slice(0, Math.floor(whole.length / 2)), { mode: 0o600 })
      const s = setup()
      s.source.start()
      await turn()
      expect(s.log).toEqual([])
      expect(s.timers).toEqual([])
      expect(server.requests).toEqual([])
      writeFileSync(server.servicePath, whole, { mode: 0o600 })
      s.fire()
      await s.until(() => s.source.list().length === 1)
      expect(s.log).toEqual(['[opencode] listed · 1 sessions'])
    })

    it('a change beside the same service.json connects nothing', async () => {
      server.session(API)
      const client = opencode()
      const find = vi.spyOn(client, 'find')
      const s = setup({ client })
      await live(s)
      const requests = server.requests.length
      s.fire()
      s.fire()
      expect(find).toHaveBeenCalledTimes(1)
      await turn()
      expect(server.requests).toHaveLength(requests)
      expect(server.streams).toBe(1)
      expect(s.timers).toEqual([])
      expect(s.source.list().map(({ id }) => id)).toEqual(['u1'])
    })

    it('not_local, not_ours, old_version and unauthorized are each said once, retried never, and looked at again when the file changes', async () => {
      server.session(API)
      const cases: Array<[string, () => void, () => void]> = [
        ['not_local', () => server.register({ url: 'http://192.168.1.5:4096' }), () => server.register()],
        ['not_ours', () => server.register({ pid: 1 }), () => server.register()],
        ['old_version', () => server.answer('GET /api/info', { status: 404 }), () => {
          server.answer('GET /api/info')
          server.register({ id: 'svc_next' })
        }],
        ['unauthorized', () => server.register({ password: 'wrong' }), () => server.register({ id: 'svc_next' })],
      ]
      for (const [fault, wrong, right] of cases) {
        wrong()
        const client = opencode()
        const find = vi.spyOn(client, 'find')
        const s = setup({ client })
        const before = server.requests.length
        s.source.start()
        await s.until(() => s.log.length === 1)
        expect(s.log).toEqual([`[opencode] service · ${fault}`])
        expect(s.timers).toEqual([])
        expect(s.source.list()).toEqual([])
        // Nothing more is sent after the refusal: /api/info alone, or nothing for a url off loopback.
        expect(routes(server).slice(before)).toEqual(fault === 'not_local' ? [] : ['GET /api/info'])
        const found = fault === 'not_local' ? 0 : 1
        expect(find).toHaveBeenCalledTimes(found)
        s.fire()
        expect(find).toHaveBeenCalledTimes(found)
        await turn()
        expect(s.log).toHaveLength(1)
        expect(server.requests).toHaveLength(before + found)
        right()
        s.fire()
        await s.until(() => s.source.list().length === 1)
        expect(s.log).toEqual([`[opencode] service · ${fault}`, '[opencode] listed · 1 sessions'])
        s.source.stop()
      }
    })

    it('a new service.json empties the list and starts again at once, its wait back to 1 s', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      expect(s.source.list().map(({ id }) => id)).toEqual(['u1'])
      await server.restart()
      // Restarting ended no stream of the source's: the drop had.
      const changes = s.changes
      s.fire()
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(changes + 1)
      expect(s.timers).toEqual([])
      await server.stream(2)
      // The list waits out the second since the last one started.
      await s.until(() => s.timers.length === 1)
      s.advance(1000)
      await s.until(() => s.source.list().length === 1)
      expect(s.source.list().map(({ id }) => id)).toEqual(['u2'])
      server.drop()
      await s.until(() => said(s, '[opencode] retry · 1') === 2)
      expect(s.log).toEqual([
        '[opencode] listed · 1 sessions', '[opencode] closed · ended', '[opencode] retry · 1',
        '[opencode] listed · 1 sessions', '[opencode] closed · ended', '[opencode] retry · 1',
      ])
    })

    it('a dropped stream keeps its rows until the first retry; that retry failing empties the list', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      expect(s.source.list()).toHaveLength(1)
      const changes = s.changes
      await server.crash()
      s.advance(1000)
      await s.until(() => s.log.at(-1) === '[opencode] retry · 2')
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(changes + 1)
      expect(s.log).toEqual([
        '[opencode] listed · 1 sessions', '[opencode] closed · ended', '[opencode] retry · 1', '[opencode] closed · refused',
        '[opencode] retry · 2',
      ])
    })

    it('nothing listening retries after 1, 2, 4, 8, 16, 32 and 60 s, then holds only the watch', async () => {
      server.session(API)
      await server.crash()
      const client = opencode()
      const find = vi.spyOn(client, 'find')
      const s = setup({ client })
      s.source.start()
      for (const seconds of [1, 2, 4, 8, 16, 32, 60]) {
        await s.until(() => s.log.at(-1) === `[opencode] retry · ${seconds}`)
        expect(s.timers.map(({ ms }) => ms)).toEqual([seconds * 1000])
        s.advance(seconds * 1000)
      }
      await s.until(() => said(s, '[opencode] closed · refused') === 8)
      expect(s.timers).toEqual([])
      expect(s.watchers.size).toBe(1)
      expect(s.log.filter((line) => line.includes('retry'))).toEqual([1, 2, 4, 8, 16, 32, 60].map((n) => `[opencode] retry · ${n}`))
      // Beside the same file, nothing is tried.
      expect(find).toHaveBeenCalledTimes(8)
      s.fire()
      expect(find).toHaveBeenCalledTimes(8)
      // The next opencode writes a new file, which is listed at once.
      await server.restart()
      s.fire()
      await s.until(() => s.source.list().length === 1)
    })

    it('a service that lists and drops keeps the 60 s wait; a stream that drops within 60 s does not put the wait back to 1 s, and one that lived 60 s does', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      let updated = API.updated!
      const waits = [1, 2, 4, 8, 16, 32, 60, 60]
      for (const [at, seconds] of waits.entries()) {
        server.drop()
        await s.until(() => s.log.filter((line) => line.includes('retry')).length === at + 1)
        expect(s.log.at(-1)).toBe(`[opencode] retry · ${seconds}`)
        // Each list after a reconnect shows, by the time it reads.
        server.session({ ...API, updated: ++updated })
        s.advance(seconds * 1000)
        await s.until(() => s.source.list()[0]?.lastActivityAt === updated)
      }
      s.advance(60_000)
      server.drop()
      await s.until(() => s.log.filter((line) => line.includes('retry')).length === waits.length + 1)
      expect(s.log.at(-1)).toBe('[opencode] retry · 1')
    })

    it('a list that fails says list · <fault> and is a drop', async () => {
      server.session(API)
      server.answer(LIST, { status: 500 })
      const s = setup()
      s.source.start()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      await vi.waitFor(() => expect(server.streams).toBe(0))
      server.answer(LIST, { status: 200, json: { cursor: {} } })
      s.advance(1000)
      await s.until(() => s.log.at(-1) === '[opencode] retry · 2')
      await vi.waitFor(() => expect(server.streams).toBe(0))
      server.answer(LIST)
      server.answer(ACTIVE, { status: 200, json: { data: [] } })
      s.advance(2000)
      await s.until(() => s.log.at(-1) === '[opencode] retry · 4')
      server.answer(ACTIVE)
      s.advance(4000)
      await s.until(() => s.source.list().length === 1)
      expect(s.log).toEqual([
        '[opencode] list · http_500', '[opencode] retry · 1', '[opencode] list · bad_json', '[opencode] retry · 2',
        '[opencode] list · bad_json', '[opencode] retry · 4', '[opencode] listed · 1 sessions',
      ])
    })

    it('ids are kept across a reconnect to the same service, and are others once the list emptied', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      server.session({ ...API, updated: API.updated! + 1 })
      s.advance(1000)
      await s.until(() => s.source.list()[0]?.lastActivityAt === API.updated! + 1)
      expect(s.source.list().map(({ id }) => id)).toEqual(['u1'])
      server.answer('GET /api/info', { status: 500 })
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 2')
      s.advance(2000)
      await s.until(() => s.log.at(-1) === '[opencode] retry · 4')
      expect(s.source.list()).toEqual([])
      server.answer('GET /api/info')
      s.advance(4000)
      await s.until(() => s.source.list().length === 1)
      expect(s.source.list().map(({ id }) => id)).toEqual(['u2'])
    })

    it('stop while find, the list or a recap read is in flight: its answer lists nothing, and no stream, watch or timer is left', async () => {
      server.session(API)
      for (const step of ['find', '/api/session?', '/message?']) {
        const real = opencode()
        let reached!: () => void
        const reaching = new Promise<void>((resolve) => { reached = resolve })
        let release!: () => void
        const released = new Promise<void>((resolve) => { release = resolve })
        const hold = async <T>(answer: T): Promise<T> => {
          reached()
          await released
          return answer
        }
        const events = vi.fn(real.events)
        const s = setup({
          client: {
            ...real,
            events,
            find: async () => step === 'find' ? hold(await real.find()) : real.find(),
            request: async (method, path, body) => {
              const answer = await real.request(method, path, body)
              return path.includes(step) ? hold(answer) : answer
            },
          },
        })
        s.source.start()
        await reaching
        s.source.stop()
        release()
        await turn()
        expect(s.source.list()).toEqual([])
        expect(s.changes).toBe(0)
        expect(s.timers).toEqual([])
        expect(s.watchers.size).toBe(0)
        expect(s.log).toEqual([])
        expect(events).toHaveBeenCalledTimes(step === 'find' ? 0 : 1)
        await vi.waitFor(() => expect(server.streams).toBe(0))
      }
    })

    it('stop empties the list and tells once; started again, its sessions have fresh ids and are said once more', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      const changes = s.changes
      s.source.stop()
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(changes + 1)
      s.source.stop()
      expect(s.changes).toBe(changes + 1)
      expect(s.watchers.size).toBe(0)
      expect(s.timers).toEqual([])
      await vi.waitFor(() => expect(server.streams).toBe(0))
      s.source.start()
      // The last list started under a second ago: the next waits out the rest of that second.
      await s.until(() => s.timers.length === 1)
      s.advance(1000)
      await s.until(() => s.source.list().length === 1)
      expect(s.source.list().map(({ id }) => id)).toEqual(['u2'])
      expect(s.log).toEqual(['[opencode] listed · 1 sessions', '[opencode] listed · 1 sessions'])
    })

    it('start twice is one stream', async () => {
      server.session(API)
      const s = setup()
      s.source.start()
      s.source.start()
      await s.until(() => s.source.list().length === 1)
      expect(count(server, 'GET /api/info')).toBe(1)
      expect(count(server, 'GET /api/event')).toBe(1)
      expect(s.watchers.size).toBe(1)
    })
  })

  describe('the list', () => {
    it('kept: running, or updated within 24 hours; the 16 newest; the rest in one over line', async () => {
      for (let i = 1; i <= 20; i++) server.session({ id: `ses_n${i}`, updated: WALL - i * 60_000 })
      const first = setup()
      await live(first, 16)
      expect(MAX_SESSIONS).toBe(16)
      expect(first.source.list().map(({ sessionId }) => sessionId)).toEqual(Array.from({ length: 16 }, (_, i) => `ses_n${i + 1}`))
      expect(first.log).toEqual(['[opencode] listed · 16 sessions', '[opencode] over · 4 left out'])
      first.source.stop()

      for (let i = 3; i <= 20; i++) server.session({ id: `ses_n${i}`, updated: WALL - i * 60_000, archived: WALL })
      server.session({ id: 'ses_old', updated: WALL - 25 * HOUR })
      server.session({ id: 'ses_run', updated: WALL - 72 * HOUR })
      server.start('ses_run')
      const second = setup()
      await live(second, 3)
      expect(RECENT_MS).toBe(24 * HOUR)
      expect(second.source.list().map(({ sessionId, state }) => [sessionId, state])).toEqual([
        ['ses_n1', 'idle'], ['ses_n2', 'idle'], ['ses_run', 'working'],
      ])
      expect(second.log).toEqual(['[opencode] listed · 3 sessions'])
    })

    it('an entry with an id not in its form, a parentID, or a time that is no finite number is left out, the rest listed', async () => {
      const info = (id: unknown, more: Record<string, unknown> = {}, time: Record<string, unknown> = {}) =>
        ({ id, projectID: 'prj_1', time: { created: WALL - 5000, updated: WALL - 1000, ...time }, ...more })
      server.answer(LIST, {
        status: 200,
        json: {
          cursor: {},
          data: [
            info('ses_a1', { title: 'Fix', location: { directory: '/work/api' } }),
            info('ses_a1', { title: 'Again' }),
            info('ses/../x'), info('abc'), info(7), info(`ses_${'x'.repeat(100)}`),
            info('ses_p1', { parentID: 'ses_a1' }),
            info('ses_t1', {}, { updated: '1700000000000' }), info('ses_t2', {}, { idle: null }), info('ses_t3', {}, { viewed: 'x' }),
            { id: 'ses_t4', title: 'No time' },
            info('ses_n1', { title: 7 }), info('ses_n2', { location: { directory: 7 } }),
            null, 'ses_x',
            info('ses_b1', { title: 'Web', location: { directory: '/work/web' } }, { updated: WALL - 2000 }),
          ],
        },
      })
      const s = setup()
      await live(s, 2)
      expect(s.source.list().map(({ sessionId, name, cwd }) => [sessionId, name, cwd])).toEqual([
        ['ses_a1', 'Fix', '/work/api'], ['ses_b1', 'Web', '/work/web'],
      ])
    })

    it('a name is the title, else the folder\'s name, else opencode; cut to 64 by code point, its control characters removed; the folder is cut to 4096', async () => {
      // Under the client's 1 MiB bound on an answer, which holds the whole list.
      server.session({ id: 'ses_t', title: '\u001b[31m😀'.repeat(60_000), updated: WALL - 1000 })
      server.session({ id: 'ses_f', title: '', directory: '/work/web', updated: WALL - 2000 })
      server.session({ id: 'ses_o', directory: '/', updated: WALL - 3000 })
      server.session({ id: 'ses_l', title: 'Long', directory: `/${'d'.repeat(5000)}`, updated: WALL - 4000 })
      const s = setup()
      await live(s, 4)
      expect(s.source.list().map(({ name }) => name)).toEqual([
        [...'[31m😀'.repeat(13)].slice(0, 64).join(''), 'web', 'opencode', 'Long',
      ])
      expect(row(s, 'ses_l')?.cwd).toBe(`/${'d'.repeat(4095)}`)
    })

    it('each listed state', async () => {
      server.session({ id: 'ses_run', updated: WALL - 1000 })
      server.session({ id: 'ses_ask', updated: WALL - 2000 })
      server.session({ id: 'ses_done', updated: WALL - 3000, idle: WALL - 3000, viewed: WALL - 4000 })
      server.session({ id: 'ses_never', updated: WALL - 4000, idle: WALL - 4000 })
      server.session({ id: 'ses_seen', updated: WALL - 5000, idle: WALL - 6000, viewed: WALL - 5000 })
      server.session({ id: 'ses_fresh', updated: WALL - 6000 })
      server.start('ses_run')
      server.start('ses_ask')
      server.ask('ses_ask')
      // At rest, its permission is not read.
      server.ask('ses_seen')
      const s = setup()
      await live(s, 6)
      expect(s.source.list().map(({ sessionId, state, unseenDone }) => [sessionId, state, unseenDone])).toEqual([
        ['ses_run', 'working', false], ['ses_ask', 'needs-you', false], ['ses_done', 'done', true],
        ['ses_never', 'done', true], ['ses_seen', 'idle', false], ['ses_fresh', 'idle', false],
      ])
      expect(routes(server).filter((route) => route.endsWith('/permission')).sort()).toEqual([
        'GET /api/session/ses_ask/permission', 'GET /api/session/ses_run/permission',
      ])
      expect(routes(server).filter((route) => route.endsWith('/message')).sort()).toEqual(
        ['ses_done', 'ses_fresh', 'ses_never', 'ses_seen'].map(message),
      )
    })

    it('session.created and session.unarchived ask for a list, at most one a second, and those in between join it', async () => {
      server.session(API)
      const gate = gated(opencode())
      const s = setup({ client: gate.client })
      await live(s)
      server.session({ id: 'ses_b1', updated: WALL - 1000 })
      server.session({ id: 'ses_b2', updated: WALL - 2000 })
      server.event('session.created', { sessionID: 'ses_b1' })
      await s.until(() => s.timers.length === 1)
      expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
      server.event('session.unarchived', { sessionID: 'ses_b2' })
      server.event('session.created', { sessionID: 'ses_b1' })
      await heard(s)
      expect(s.timers).toHaveLength(1)
      expect(count(server, LIST)).toBe(1)
      s.advance(1000)
      await s.until(() => s.source.list().length === 3)
      expect(count(server, LIST)).toBe(2)

      // A second later a run starts at once; asks while it is in flight are one more run, a second after it started.
      s.advance(1000)
      const held = gate.hold((path) => path === '/api/session/active')
      server.event('session.created', { sessionID: 'ses_b3' })
      await held
      server.event('session.created', { sessionID: 'ses_b4' })
      server.event('session.unarchived', { sessionID: 'ses_b5' })
      await heard(s)
      expect(s.timers).toEqual([])
      server.session({ id: 'ses_b3', updated: WALL - 500 })
      gate.release()
      await s.until(() => s.timers.length === 1)
      expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
      expect(row(s, 'ses_b3')).toBeUndefined()
      s.advance(1000)
      await s.until(() => row(s, 'ses_b3') !== undefined)
      expect(count(server, LIST)).toBe(4)
      expect(s.timers).toEqual([])
    })

    it('session.deleted and session.archived drop the row at once, with no list', async () => {
      server.session(API)
      server.session({ id: 'ses_b1', title: 'Web', updated: WALL - 1000 })
      const s = setup()
      await live(s, 2)
      const changes = s.changes
      server.event('session.deleted', { sessionID: 'ses_a1' })
      await s.until(() => row(s, 'ses_a1') === undefined)
      server.event('session.archived', { sessionID: 'ses_b1' })
      await s.until(() => s.source.list().length === 0)
      expect(s.changes).toBe(changes + 2)
      expect(count(server, LIST)).toBe(1)
      expect(s.timers).toEqual([])
    })

    it('a session past 24 hours leaves at the next list, and no timer waits for it', async () => {
      server.session({ ...API, updated: WALL - 1000 })
      server.session({ id: 'ses_b1', updated: WALL })
      const s = setup()
      await live(s, 2)
      expect(s.timers).toEqual([])
      s.advance(RECENT_MS)
      expect(s.source.list()).toHaveLength(2)
      server.event('session.created', { sessionID: 'ses_c1' })
      await s.until(() => s.source.list().length === 1)
      // Exactly 24 hours old is kept.
      expect(s.source.list().map(({ sessionId }) => sessionId)).toEqual(['ses_b1'])
      expect(s.timers).toEqual([])
    })

    it('session.renamed sets the name, with no list', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      const changes = s.changes
      server.event('session.renamed', { sessionID: 'ses_a1', title: 'Login\u001b[2J flow' })
      await s.until(() => row(s, 'ses_a1')?.name === 'Login[2J flow')
      server.event('session.renamed', { sessionID: 'ses_a1', title: '' })
      await s.until(() => row(s, 'ses_a1')?.name === 'api')
      server.event('session.renamed', { sessionID: 'ses_a1', title: 7 })
      await heard(s)
      expect(s.changes).toBe(changes + 3)
      expect(count(server, LIST)).toBe(1)
      expect(s.timers).toEqual([])
    })

    it('a turn starting in a session not listed asks for one list, and no second one while that id stays unlisted', async () => {
      server.session(API)
      server.session({ id: 'ses_old', title: 'Old', updated: WALL - 30 * HOUR })
      server.session({ id: 'ses_child', parentID: 'ses_a1', updated: WALL - 1000 })
      const s = setup()
      await live(s)
      // A session resumed after 24 hours: its turn's start asks for a list, which finds it running.
      server.start('ses_old')
      await s.until(() => s.timers.length === 1)
      s.advance(1000)
      await s.until(() => row(s, 'ses_old')?.state === 'working')
      expect(count(server, LIST)).toBe(2)
      // A sub-agent's child session is never listed: its start asks once.
      server.start('ses_child')
      await s.until(() => s.timers.length === 1)
      server.session({ ...API, updated: API.updated! + 1 })
      s.advance(1000)
      await s.until(() => row(s, 'ses_a1')?.lastActivityAt === API.updated! + 1)
      server.start('ses_child')
      server.event('session.status', { sessionID: 'ses_child', status: { type: 'busy' } })
      await heard(s)
      expect(s.timers).toEqual([])
      expect(count(server, LIST)).toBe(3)
    })
  })

  describe('events', () => {
    it('each event is its dial state, told once', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      const state = () => row(s, 'ses_a1')!
      let changes = s.changes
      const to = async (tell: () => void, expected: HostAgentState, unseen = false) => {
        tell()
        await s.until(() => state().state === expected)
        expect(state().unseenDone).toBe(unseen)
        expect(s.changes).toBe(++changes)
      }
      const still = async (tell: () => void) => {
        const was = state()
        tell()
        await heard(s)
        expect(state()).toMatchObject({ state: was.state, unseenDone: was.unseenDone })
        // The fence's own change.
        expect(s.changes).toBe(++changes)
      }
      const status = (type: string) => () => server.event('session.status', { sessionID: 'ses_a1', status: { type } })
      const idle = () => server.event('session.idle', { sessionID: 'ses_a1' })
      let permission = ''

      await to(status('busy'), 'working')
      await still(status('retry'))
      await still(() => server.start('ses_a1'))
      await to(() => { permission = server.ask('ses_a1') }, 'needs-you')
      await to(() => server.reply('ses_a1', permission), 'working')
      await to(() => server.end('ses_a1', 'succeeded'), 'done', true)
      // succeeded then session.idle is one change.
      await still(idle)
      await to(() => server.start('ses_a1'), 'working')
      await to(() => server.end('ses_a1', 'interrupted'), 'done', true)
      await to(status('retry'), 'working')
      await to(() => server.end('ses_a1', 'failed'), 'error')
      // At rest or in error, opencode's idle changes nothing.
      await still(idle)
      await still(status('idle'))
      await to(() => server.start('ses_a1'), 'working')
      await to(idle, 'done', true)
      await still(idle)
      await to(() => server.start('ses_a1'), 'working')
      await to(status('idle'), 'done', true)
    })

    it('a turn that ends while its permission is asked leaves needs-you', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      server.start('ses_a1')
      server.ask('ses_a1')
      await s.until(() => row(s, 'ses_a1')?.state === 'needs-you')
      server.end('ses_a1', 'interrupted')
      await s.until(() => row(s, 'ses_a1')?.state === 'done')
      // opencode drops a turn's permissions as it ends; the fake keeps them until answered.
      server.answer('GET /api/session/ses_a1/permission', { status: 200, json: { data: [] } })
      expect(await s.source.send(row(s, 'ses_a1')!, 'run the tests')).toEqual({ ok: true })
      expect(s.counts).toEqual(['opencode'])
    })

    it('an event for a session not listed, with an id not in its form, or with no sessionID changes nothing and reads nothing', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      const requests = server.requests.length
      const changes = s.changes
      server.end('ses_zz', 'succeeded')
      server.event('permission.asked', { id: 'per_1', sessionID: 'ses_zz' })
      server.event('session.execution.failed', { error: { type: 'unknown', message: 'x' } })
      server.event('session.execution.succeeded', { sessionID: 'ses_a1/../x' })
      server.event('session.execution.started', { sessionID: 'ses a1' })
      server.event('session.renamed', { sessionID: 7, title: 'x' })
      server.event('session.created', {})
      server.event('session.deleted', { sessionID: 'ses_a1?x' })
      await heard(s)
      expect(s.changes).toBe(changes + 1)
      expect(server.requests).toHaveLength(requests)
      expect(s.timers).toEqual([])
      expect(row(s, 'ses_a1')?.state).toBe('idle')
    })

    it('a permission asked by a child session changes no row: its root stays working', async () => {
      server.session(API)
      server.session({ id: 'ses_child', parentID: 'ses_a1', updated: WALL - 1000 })
      server.start('ses_a1')
      const s = setup()
      await live(s)
      expect(row(s, 'ses_a1')?.state).toBe('working')
      const changes = s.changes
      server.ask('ses_child')
      await heard(s)
      expect(row(s, 'ses_a1')?.state).toBe('working')
      expect(s.changes).toBe(changes + 1)
      expect(routes(server).filter((route) => route.includes('ses_child'))).toEqual([])
    })

    it('what the stream said while the list was in flight wins over the list', async () => {
      server.session({ id: 'ses_a', title: 'A', updated: WALL - 1000 })
      server.session({ id: 'ses_b', title: 'B', updated: WALL - 2000 })
      server.session({ id: 'ses_c', title: 'C', updated: WALL - 3000 })
      server.start('ses_b')
      const gate = gated(opencode())
      const s = setup({ client: gate.client })
      await live(s, 3)
      server.session({ id: 'ses_d', title: 'D', updated: WALL - 500 })
      // The list's read of the running sessions is answered before the events, and kept back until they were heard.
      const held = gate.hold((path) => path === '/api/session/active')
      server.event('session.created', { sessionID: 'ses_d' })
      await s.until(() => s.timers.length === 1)
      s.advance(1000)
      await held
      // A start for a session the list says is at rest, an end for one it says is running, a session deleted, and a
      // permission in one the list is the first to name.
      server.start('ses_a')
      server.end('ses_b', 'succeeded')
      server.event('session.deleted', { sessionID: 'ses_c' })
      server.ask('ses_d')
      await heard(s, 'ses_a')
      expect(s.source.list().map(({ sessionId, state }) => [sessionId, state])).toEqual([['ses_a', 'working'], ['ses_b', 'done']])
      gate.release()
      await s.until(() => row(s, 'ses_d') !== undefined)
      expect(s.source.list().map(({ sessionId, state }) => [sessionId, state])).toEqual([
        ['ses_d', 'needs-you'], ['ses_a', 'working'], ['ses_b', 'done'],
      ])
      // What the stream said is not said twice: the end heard was read once.
      expect(gate.calls.filter((path) => path.startsWith('/api/session/ses_b/message'))).toHaveLength(1)
    })

    it('done is unseen until the dial turns to it; markSeen tells once and asks opencode nothing', async () => {
      server.session(API)
      const gate = gated(opencode())
      const s = setup({ client: gate.client })
      await live(s)
      const held = gate.hold((path) => path.includes('/message'))
      server.start('ses_a1')
      server.end('ses_a1', 'succeeded')
      await s.until(() => row(s, 'ses_a1')?.state === 'done')
      await held
      gate.release()
      await turn()
      expect(row(s, 'ses_a1')?.unseenDone).toBe(true)
      const requests = server.requests.length
      const changes = s.changes
      const { id } = row(s, 'ses_a1')!
      s.source.markSeen(id)
      expect(row(s, 'ses_a1')).toMatchObject({ state: 'done', unseenDone: false })
      expect(s.changes).toBe(changes + 1)
      s.source.markSeen(id)
      s.source.markSeen('nobody')
      expect(s.changes).toBe(changes + 1)
      await turn()
      expect(server.requests).toHaveLength(requests)
      // opencode still says the turn is not viewed: a reconnect's list leaves it seen.
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      server.session({ ...API, updated: API.updated! + 1 })
      s.advance(1000)
      await s.until(() => row(s, 'ses_a1')?.lastActivityAt === API.updated! + 1)
      expect(row(s, 'ses_a1')).toMatchObject({ state: 'done', unseenDone: false })
    })
  })

  describe('the recap', () => {
    it('a session at rest is first listed with its last answer; a running one is listed with none and no read', async () => {
      server.session(API)
      server.session({ id: 'ses_run', title: 'Run', updated: WALL - 1000, answer: 'Earlier.' })
      server.start('ses_run')
      const gate = gated(opencode())
      const held = gate.hold((path) => path.includes('/message'))
      const s = setup({ client: gate.client })
      s.source.start()
      await held
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(0)
      gate.release()
      await s.until(() => s.source.list().length === 2)
      expect(s.changes).toBe(1)
      expect(s.source.list().map(({ sessionId, lastAnswer }) => [sessionId, lastAnswer])).toEqual([
        ['ses_run', undefined], ['ses_a1', 'All 12 tests pass.'],
      ])
      expect(routes(server).filter((route) => route.endsWith('/message'))).toEqual([message('ses_a1')])
    })

    it('the answer is the message\'s text parts, joined by a blank line and cut to 300 by code point; a message with no text part, an empty list, a 500 and an answer over 1 MiB set none', async () => {
      const reply = (data: unknown[]): FakeAnswer => ({ status: 200, json: { data, cursor: {} } })
      const assistant = (...content: unknown[]) => ({ id: 'msg_x', type: 'assistant', time: { created: WALL }, content })
      const text = (words: string) => ({ type: 'text', text: words })
      const cases: Array<[string, FakeAnswer, string | undefined]> = [
        ['ses_m1', reply([assistant({ type: 'reasoning', text: 'Thinking.' }, text('First.'), { type: 'tool', tool: 'bash' }, text('Second.'))]), 'First.\n\nSecond.'],
        ['ses_m2', reply([assistant(text('😀'.repeat(400)))]), `${'😀'.repeat(299)}…`],
        ['ses_m3', reply([assistant({ type: 'reasoning', text: 'Thinking.' })]), undefined],
        ['ses_m4', reply([]), undefined],
        ['ses_m5', { status: 500 }, undefined],
        ['ses_m6', { raw: JSON.stringify({ data: [assistant(text('x'.repeat(MAX_BODY_BYTES)))] }) }, undefined],
        ['ses_m7', reply([{ type: 'user', content: [text('Mine.')] }, assistant(text('Theirs.'))]), 'Theirs.'],
        ['ses_m8', reply([assistant(text('  \n '))]), undefined],
      ]
      cases.forEach(([id, answer], at) => {
        server.session({ id, updated: WALL - (at + 1) * 1000 })
        server.answer(message(id), answer)
      })
      const s = setup()
      await live(s, cases.length)
      expect(s.source.list().map(({ sessionId, lastAnswer }) => [sessionId, lastAnswer])).toEqual(cases.map(([id, , answer]) => [id, answer]))
    })

    it('each turn\'s end reads it once; a read that lands after a newer turn started is dropped; a turn that ends while a read is under way is read once more', async () => {
      server.session(API)
      const gate = gated(opencode())
      const s = setup({ client: gate.client })
      await live(s)
      const answers: Array<string | undefined> = []
      s.source.onChange(() => answers.push(row(s, 'ses_a1')?.lastAnswer))
      const reads = () => count(server, message('ses_a1'))
      expect(reads()).toBe(1)
      server.start('ses_a1')
      server.end('ses_a1', 'succeeded', 'B.')
      await s.until(() => row(s, 'ses_a1')?.lastAnswer === 'B.')
      expect(reads()).toBe(2)

      // Read, then a newer turn starts before the answer lands: it is dropped.
      let held = gate.hold((path) => path.includes('/message'))
      server.start('ses_a1')
      server.end('ses_a1', 'succeeded', 'C.')
      await held
      server.start('ses_a1')
      await s.until(() => row(s, 'ses_a1')?.state === 'working')
      gate.release()
      await turn()
      expect(row(s, 'ses_a1')?.lastAnswer).toBe('B.')

      // That turn ends while the read of the one before is under way: read once more, and only that answer lands.
      held = gate.hold((path) => path.includes('/message'))
      server.end('ses_a1', 'succeeded', 'D.')
      await held
      server.start('ses_a1')
      server.end('ses_a1', 'succeeded', 'E.')
      await heard(s)
      // One read at a time: the end of E is not read until D's read has landed.
      expect(gate.calls.filter((path) => path.includes('/message'))).toHaveLength(4)
      gate.release()
      await s.until(() => row(s, 'ses_a1')?.lastAnswer === 'E.')
      expect(reads()).toBe(5)
      expect(answers).not.toContain('C.')
      expect(answers).not.toContain('D.')
    })

    it('a turn heard while a list is in flight keeps the answer read at its end, read after the list lands', async () => {
      server.session(API)
      const reads = gated(opencode())
      const gate = gated(reads.client)
      const s = setup({ client: gate.client })
      await live(s)
      server.session({ id: 'ses_b1', updated: WALL - 1000 })
      const held = gate.hold((path) => path === '/api/session/active')
      server.event('session.created', { sessionID: 'ses_b1' })
      await s.until(() => s.timers.length === 1)
      s.advance(1000)
      await held
      // Its end's read lands after the list: ses_b1's first read is not held.
      const reading = reads.hold((path) => path.startsWith('/api/session/ses_a1/message'))
      server.start('ses_a1')
      server.end('ses_a1', 'succeeded', 'B.')
      await reading
      gate.release()
      await s.until(() => s.log.includes('[opencode] listed · 2 sessions'))
      reads.release()
      await turn()
      expect(row(s, 'ses_a1')).toMatchObject({ state: 'done', lastAnswer: 'B.' })
      expect(count(server, message('ses_a1'))).toBe(2)
    })

    it('a turn interrupted before any answer keeps the last one, unchanged', async () => {
      server.session(API)
      const gate = gated(opencode())
      const s = setup({ client: gate.client })
      await live(s)
      const before = row(s, 'ses_a1')!.lastAnswer
      server.start('ses_a1')
      await s.until(() => row(s, 'ses_a1')?.state === 'working')
      const held = gate.hold((path) => path.includes('/message'))
      server.end('ses_a1', 'interrupted')
      await s.until(() => row(s, 'ses_a1')?.state === 'done')
      const changes = s.changes
      await held
      gate.release()
      await turn()
      expect(row(s, 'ses_a1')?.lastAnswer).toBe(before)
      expect(before).toBe('All 12 tests pass.')
      expect(s.changes).toBe(changes)
    })

    it('a reconnect reads no answer for a session still at rest, and reads one for a turn that ended unheard', async () => {
      server.session(API)
      server.session({ id: 'ses_run', title: 'Run', updated: WALL - 1000 })
      server.start('ses_run')
      const s = setup()
      await live(s, 2)
      expect(count(server, message('ses_a1'))).toBe(1)
      expect(count(server, message('ses_run'))).toBe(0)
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      // No stream hears it.
      server.end('ses_run', 'succeeded', 'Shipped.')
      s.advance(1000)
      await s.until(() => row(s, 'ses_run')?.lastAnswer === 'Shipped.')
      expect(row(s, 'ses_run')).toMatchObject({ state: 'done', unseenDone: true })
      expect(count(server, message('ses_a1'))).toBe(1)
      expect(count(server, message('ses_run'))).toBe(1)
    })

    it('a session at rest whose whole turn ran while the stream was down is done after the reconnect, with that turn\'s answer', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      // No stream hears it: opencode's time.idle moves past the one listed, and past the last view.
      server.session({ ...API, updated: WALL - 10_000, idle: WALL - 10_000, answer: 'Shipped.' })
      s.advance(1000)
      await s.until(() => row(s, 'ses_a1')?.lastActivityAt === WALL - 10_000)
      expect(row(s, 'ses_a1')).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: 'Shipped.' })
      expect(count(server, message('ses_a1'))).toBe(2)
    })

    it('an end heard before the last list hides no later turn that ran unheard', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      server.session({ ...API, idle: WALL - 20_000, answer: 'B.' })
      server.event('session.execution.started', { sessionID: 'ses_a1' })
      server.event('session.execution.succeeded', { sessionID: 'ses_a1' })
      await s.until(() => row(s, 'ses_a1')?.lastAnswer === 'B.')
      // A list with the stream up, which shows that end.
      server.session({ id: 'ses_b1', updated: WALL - 1000 })
      server.event('session.created', { sessionID: 'ses_b1' })
      await s.until(() => s.timers.length === 1)
      s.advance(1000)
      await s.until(() => s.log.includes('[opencode] listed · 2 sessions'))
      s.source.markSeen(row(s, 'ses_a1')!.id)
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      server.session({ ...API, updated: WALL - 10_000, idle: WALL - 10_000, answer: 'C.' })
      s.advance(1000)
      await s.until(() => row(s, 'ses_a1')?.lastActivityAt === WALL - 10_000)
      expect(row(s, 'ses_a1')).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: 'C.' })
    })

    it('a session working at the drop whose turn ended unheard is done after the reconnect, though an event of it came while the list was in flight', async () => {
      server.session(API)
      server.session({ id: 'ses_run', title: 'Run', updated: WALL - 1000 })
      server.start('ses_run')
      const gate = gated(opencode())
      const s = setup({ client: gate.client })
      await live(s, 2)
      server.drop()
      await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
      server.end('ses_run', 'succeeded', 'Shipped.')
      server.session({ ...API, updated: API.updated! + 1 })
      const held = gate.hold((path) => path === '/api/session/active')
      s.advance(1000)
      await held
      // A rename, heard while the list is in flight.
      await heard(s, 'ses_run')
      gate.release()
      await s.until(() => row(s, 'ses_a1')?.lastActivityAt === API.updated! + 1)
      expect(row(s, 'ses_run')).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: 'Shipped.' })
      expect(row(s, 'ses_run')?.name).toMatch(/^Fence \d+$/)
      expect(count(server, message('ses_run'))).toBe(1)
    })
  })

  describe('voice', () => {
    it('voice', async () => {
      server.session(API)
      const real = opencode()
      const prompt = vi.fn(real.prompt)
      const s = setup({ client: { ...real, prompt } })
      await live(s)
      const api = () => row(s, 'ses_a1')!
      const to = async (tell: () => void, state: HostAgentState) => {
        tell()
        await s.until(() => api().state === state)
      }
      const sent = async (n: number) => {
        expect(await s.source.send(api(), 'run the tests')).toEqual({ ok: true })
        expect((await server.got(POST, n)).body).toEqual({ text: 'run the tests', id: messageIdOf(n), delivery: 'queue' })
      }
      const refused = async (reason: string, text = 'run the tests', of: HostAgent = api()) => {
        const calls = prompt.mock.calls.length
        expect(await s.source.send(of, text)).toEqual({ ok: false, reason })
        return prompt.mock.calls.length - calls
      }
      let permission = ''

      // At rest, done and in error, the words are sent.
      await sent(1)
      await to(() => server.start('ses_a1'), 'working')
      expect(await refused(BUSY)).toBe(0)
      await to(() => { permission = server.ask('ses_a1') }, 'needs-you')
      expect(await refused('Fix the login test is waiting for your answer in opencode.')).toBe(0)
      await to(() => server.reply('ses_a1', permission), 'working')
      await to(() => server.end('ses_a1', 'succeeded'), 'done')
      await sent(2)
      await to(() => server.start('ses_a1'), 'working')
      await to(() => server.end('ses_a1', 'failed'), 'error')
      await sent(3)
      expect(s.counts).toEqual(['opencode', 'busy', 'waiting', 'opencode', 'opencode'])

      // A second send while one is under way.
      s.counts.length = 0
      let answer!: (outcome: OpencodePrompt) => void
      prompt.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
      const first = s.source.send(api(), 'run the tests')
      expect(await refused(BUSY, 'and then')).toBe(0)
      answer('sent')
      expect(await first).toEqual({ ok: true })
      expect(s.counts).toEqual(['busy', 'opencode'])

      s.counts.length = 0
      expect(await refused('Too long. Say it shorter.', 'x'.repeat(2001))).toBe(0)
      server.answer(POST, NOT_FOUND)
      expect(await refused(SILENT)).toBe(1)
      server.answer(POST, { status: 500 })
      expect(await refused(SILENT)).toBe(1)
      server.answer(POST)
      const gone = api()
      server.event('session.deleted', { sessionID: 'ses_a1' })
      await s.until(() => s.source.list().length === 0)
      expect(await refused(SILENT, 'run the tests', gone)).toBe(0)
      expect(s.counts).toEqual(['too-long', 'no-answer', 'no-answer', 'no-answer'])
    })

    it('a session that started a turn since the last event is busy by the client\'s own read', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      server.answer(ACTIVE, { status: 200, json: { data: { ses_a1: { type: 'running' } } } })
      expect(await s.source.send(row(s, 'ses_a1')!, 'run the tests')).toEqual({ ok: false, reason: BUSY })
      expect(s.counts).toEqual(['busy'])
      expect(count(server, POST)).toBe(0)
    })

    it('each dial command has an id of its own', async () => {
      server.session(API)
      const s = setup()
      await live(s)
      expect(await s.source.send(row(s, 'ses_a1')!, 'run the tests')).toEqual({ ok: true })
      expect(await s.source.send(row(s, 'ses_a1')!, 'and the linter')).toEqual({ ok: true })
      expect(server.requests.filter((request) => `${request.method} ${request.path}` === POST).map(({ body }) => body)).toEqual([
        { text: 'run the tests', id: messageIdOf(1), delivery: 'queue' },
        { text: 'and the linter', id: messageIdOf(2), delivery: 'queue' },
      ])
    })
  })

  it('its capabilities are sv', () => {
    const s = setup()
    expect(s.source.capabilities()).toEqual({ status: true, voice: true, focus: false, answer: false })
    expect(['focus', 'showPane', 'hasPane'].filter((verb) => verb in s.source)).toEqual([])
  })

  it('no log line holds a session id, a title, a folder, the url, the password or the words', async () => {
    for (let i = 1; i <= 20; i++) {
      server.session({ id: `ses_s${i}`, title: `secret title ${i}`, directory: `/work/secret-folder-${i}`, updated: WALL - i * 1000 })
    }
    const s = setup()
    await live(s, 16)
    expect(await s.source.send(s.source.list()[0], 'secret words')).toEqual({ ok: true })
    server.answer(LIST, { status: 500 })
    server.drop()
    await s.until(() => s.log.at(-1) === '[opencode] retry · 1')
    s.advance(1000)
    await s.until(() => s.log.at(-1) === '[opencode] retry · 2')
    server.register({ password: 'wrong', id: 'svc_other' })
    s.fire()
    await s.until(() => s.log.at(-1) === '[opencode] service · unauthorized')
    expect(s.log).toContain('[opencode] over · 4 left out')
    expect(s.log).toContain('[opencode] list · http_500')
    for (const line of s.log) {
      expect(line).toMatch(LOG_LINE)
      expect(line).not.toMatch(/ses_|secret|words|e2e-word|wrong|127\.0\.0\.1|svc_|msg_/)
    }
  })
})
