import { afterEach, describe, expect, it, vi } from 'vitest'
import { CMUX_AUTOMATION_OFF, type CmuxPrompt, type CmuxSession, type CmuxSessions } from './cmuxCli.js'
import { CmuxSource, type CmuxSourceDeps } from './cmuxSource.js'
import type { HostAgent, PaneSwitch } from './types.js'

/** The wall clock the test starts at. */
const WALL = 1_700_000_000_000
/** The n-th surface, as cmux prints a UUID: upper case. */
const S = (n: number) => `${n.toString(16).toUpperCase().padStart(8, '0')}-AAAA-4BBB-8CCC-DDDDDDDDDDDD`
const S1 = S(1)
const S2 = S(2)
const S3 = S(3)
const S4 = S(4)
const W = 'EEEEEEEE-1111-4222-8333-444444444444'
const key = (surface: string) => `cmux:${surface.toLowerCase()}`
const LOG_LINE =
  /^\[cmux\] (watch · (none|on)|listed · \d+ agents|over · \d+ left out|list · (failed|too-big)|read · ([a-z][a-z0-9-]{0,31}|all) · \d+)$/

/** One record of cmux's, as the client tells it: Claude Code idle at S1, in /work/api, by a live pid. */
const record = (more: Partial<CmuxSession> = {}): CmuxSession => ({
  word: 'claude', kind: 'claude', surface: S1, workspace: W, pid: 101, lifecycle: 'idle', updatedAt: 1,
  sessionId: 'session-1', cwd: '/work/api', ...more,
})
const codex = (more: Partial<CmuxSession> = {}) => record({ word: 'codex', kind: 'codex', sessionId: 'codex-1', ...more })
const ok = (sessions: CmuxSession[]): CmuxSessions => ({ ok: true, sessions })
/** Lets what the source was answered be taken in. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

describe('the cmux source (docs/plans/2026-11-17-dial-cmux-design.md)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  /** A source on a client whose runs the test answers by hand, a watch the test fires, a folder flag, a set of live
   *  pids and clocks the test moves. */
  function setup(over: Partial<CmuxSourceDeps> = {}) {
    const pending: Array<{ resolve(answer: CmuxSessions): void; reject(error: Error): void }> = []
    const sessions = vi.fn((_word?: string) =>
      new Promise<CmuxSessions>((resolve, reject) => { pending.push({ resolve, reject }) }))
    let changed: ((file?: string) => void) | undefined
    const state = { folder: true, mono: 0, wall: WALL }
    const live = new Set([101, 102, 103, 104])
    let ids = 0
    let changes = 0
    const log: string[] = []
    const counts: string[] = []
    const prompt = vi.fn(async (_pane: string, _kind: string, _text: string): Promise<CmuxPrompt> => 'sent')
    const focus = vi.fn(async (_pane: string, _agentId: string) => true)
    const canShow = vi.fn((_pane: string) => true)
    const show = vi.fn(async (_pane: string, _agentId: string): Promise<PaneSwitch> => 'ok')
    const deps: CmuxSourceDeps = {
      client: { sessions },
      watch: (tell) => {
        changed = tell
        return () => { if (changed === tell) changed = undefined }
      },
      folder: () => state.folder,
      alive: (pid) => live.has(pid),
      prompt,
      focus,
      canShow,
      show,
      now: () => state.wall,
      monotonic: () => state.mono,
      uuid: () => `u${++ids}`,
      log: (line) => { log.push(line) },
      count: (what) => { counts.push(what) },
      ...over,
    }
    const source = new CmuxSource(deps)
    source.onChange(() => { changes++ })
    return {
      source, sessions, state, live, log, counts, prompt, focus, canShow, show,
      get changes() { return changes },
      get watched() { return changed !== undefined },
      /** The agents each run asked for, in order: a word, or all. */
      asked: () => sessions.mock.calls.map(([word]) => word ?? 'all'),
      /** A change where cmux's stores live. */
      change: (file?: string) => changed!(file),
      /** Answers the n-th run (from 0), and lets the source take it in. */
      reply: async (n: number, answer: CmuxSessions) => {
        pending[n].resolve(answer)
        await turn()
      },
      reject: async (n: number) => {
        pending[n].reject(new Error('broken'))
        await turn()
      },
    }
  }
  type Setup = ReturnType<typeof setup>

  const listed = (s: Setup) => s.source.list().map(({ paneKeys }) => paneKeys![0])
  const at = (s: Setup, surface: string): HostAgent | undefined =>
    s.source.list().find(({ paneKeys }) => paneKeys![0] === key(surface))
  /** Starts the source and answers its first run with these records. */
  async function started(s: Setup, sessions: CmuxSession[]): Promise<void> {
    s.source.start()
    await s.reply(0, ok(sessions))
  }

  describe('listing', () => {
    it('at start it asks for every agent once, and lists each record whose pid is alive', async () => {
      const s = setup()
      s.source.start()
      expect(s.asked()).toEqual(['all'])
      await s.reply(0, ok([record()]))
      expect(s.source.list()).toEqual([{
        id: 'u1', engine: 'claude', name: 'api', host: 'cmux', app: 'cmux', sessionId: 'session-1', cwd: '/work/api',
        callerPid: 101, paneKeys: [key(S1)], state: 'idle', unseenDone: false, lastActivityAt: WALL,
      }])
      expect(s.log).toContain('[cmux] listed · 1 agents')
      expect(s.changes).toBe(1)
      expect(s.asked()).toEqual(['all'])
    })

    it('a record whose pid is gone is not listed', async () => {
      const s = setup()
      s.live.delete(102)
      await started(s, [record(), record({ surface: S2, pid: 102 })])
      expect(listed(s)).toEqual([key(S1)])
    })

    it('one row per surface: the newest updated_at_unix wins, whichever store it came from', async () => {
      const s = setup()
      await started(s, [record({ updatedAt: 5 }), codex({ pid: 102, updatedAt: 9, surface: S1.toLowerCase() })])
      expect(s.source.list().map(({ engine, paneKeys }) => [engine, paneKeys![0]])).toEqual([['codex', key(S1)]])
      s.change('claude-hook-sessions.json')
      await s.reply(1, ok([record({ updatedAt: 12 })]))
      expect(s.source.list().map(({ engine, paneKeys }) => [engine, paneKeys![0]])).toEqual([['claude', key(S1)]])
    })

    it('the name is the folder\'s, else the kind', async () => {
      const s = setup()
      await started(s, [
        record(),
        record({ surface: S2, pid: 102, cwd: undefined }),
        record({ surface: S3, pid: 103, cwd: '/' }),
        record({ surface: S4, pid: 104, cwd: `/work/\u0007${'x'.repeat(70)}` }),
      ])
      expect(s.source.list().map(({ name }) => name)).toEqual(['api', 'claude', 'claude', 'x'.repeat(64)])
    })
  })

  describe('states', () => {
    it('running is working, needsInput is needs-you, idle and unknown are idle', async () => {
      const s = setup()
      await started(s, [
        record({ lifecycle: 'running' }),
        record({ surface: S2, pid: 102, lifecycle: 'needsInput' }),
        record({ surface: S3, pid: 103, lifecycle: 'idle' }),
        record({ surface: S4, pid: 104, lifecycle: 'unknown' }),
      ])
      expect(s.source.list().map(({ state }) => state)).toEqual(['working', 'needs-you', 'idle', 'idle'])
    })

    it('a turn that leaves running or needsInput for idle is done with nothing unseen, and stays done while it stays idle', async () => {
      const s = setup()
      await started(s, [record({ lifecycle: 'running' })])
      const states: Array<[string, boolean]> = []
      const step = async (n: number, lifecycle: CmuxSession['lifecycle']) => {
        s.state.wall += 1000
        s.change('claude-hook-sessions.json')
        await s.reply(n, ok([record({ lifecycle, updatedAt: n + 1 })]))
        const [agent] = s.source.list()
        states.push([agent.state, agent.unseenDone])
      }
      await step(1, 'idle')
      expect(s.source.list()[0].lastActivityAt).toBe(WALL + 1000)
      await step(2, 'idle')
      expect(s.source.list()[0].lastActivityAt).toBe(WALL + 1000)
      await step(3, 'needsInput')
      await step(4, 'idle')
      expect(states).toEqual([['done', false], ['done', false], ['needs-you', false], ['done', false]])
    })

    it('unknown after running is idle, not done; an agent first listed idle is idle', async () => {
      const s = setup()
      await started(s, [record({ lifecycle: 'running' }), record({ surface: S2, pid: 102 })])
      expect(at(s, S2)?.state).toBe('idle')
      s.change('claude-hook-sessions.json')
      await s.reply(1, ok([record({ lifecycle: 'unknown' }), record({ surface: S2, pid: 102 })]))
      expect(at(s, S1)?.state).toBe('idle')
      s.change('claude-hook-sessions.json')
      await s.reply(2, ok([record({ lifecycle: 'idle' }), record({ surface: S2, pid: 102 })]))
      expect(at(s, S1)?.state).toBe('idle')
    })

    it('the same surface, kind and pid keep the row\'s id and place, through a new session id; another pid there is a new id, idle, with no done', async () => {
      const s = setup()
      await started(s, [record({ lifecycle: 'running' }), record({ surface: S2, pid: 102 })])
      s.change('claude-hook-sessions.json')
      await s.reply(1, ok([record({ lifecycle: 'running', sessionId: 'session-2' }), record({ surface: S2, pid: 102 })]))
      expect(s.source.list().map(({ id, sessionId }) => [id, sessionId])).toEqual([['u1', 'session-2'], ['u2', 'session-1']])
      s.change('claude-hook-sessions.json')
      await s.reply(2, ok([record({ pid: 103 }), record({ surface: S2, pid: 102 })]))
      expect(s.source.list().map(({ id, state, paneKeys }) => [id, state, paneKeys![0]]))
        .toEqual([['u2', 'idle', key(S2)], ['u3', 'idle', key(S1)]])
    })
  })

  describe('the watch', () => {
    it('a store\'s change asks for that agent alone, and its rows replace that agent\'s; the other agents\' rows stay', async () => {
      const s = setup()
      await started(s, [record(), codex({ surface: S2, pid: 102 })])
      s.change('codex-hook-sessions.json')
      expect(s.asked()).toEqual(['all', 'codex'])
      await s.reply(1, ok([codex({ surface: S3, pid: 103 })]))
      expect(listed(s)).toEqual([key(S1), key(S3)])
    })

    it('a change with no name asks for every agent', async () => {
      const s = setup()
      await started(s, [record()])
      s.change()
      expect(s.asked()).toEqual(['all', 'all'])
    })

    it('a name that is no store\'s runs nothing', async () => {
      const s = setup()
      await started(s, [record()])
      for (const name of ['claude-hook-sessions.json.tmp', '.DS_Store', 'CLAUDE-hook-sessions.json', '-hook-sessions.json']) {
        s.change(name)
      }
      expect(s.asked()).toEqual(['all'])
    })

    it('with no folder nothing runs and watch · none is said; when it appears every agent is asked once and watch · on is said; removed, every row goes with no run', async () => {
      const s = setup()
      s.state.folder = false
      s.source.start()
      expect(s.watched).toBe(true)
      expect(s.asked()).toEqual([])
      expect(s.log).toEqual(['[cmux] watch · none'])
      s.change('claude-hook-sessions.json')
      s.change()
      expect(s.asked()).toEqual([])
      s.state.folder = true
      s.change('.cmuxterm')
      expect(s.asked()).toEqual(['all'])
      expect(s.log).toEqual(['[cmux] watch · none', '[cmux] watch · on'])
      await s.reply(0, ok([record()]))
      expect(listed(s)).toEqual([key(S1)])
      const changes = s.changes
      s.state.folder = false
      s.change('.cmuxterm')
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(changes + 1)
      expect(s.asked()).toEqual(['all'])
      expect(s.log.filter((line) => line.startsWith('[cmux] watch'))).toEqual(['[cmux] watch · none', '[cmux] watch · on', '[cmux] watch · none'])
    })

    it('a dial plugged in again to the same folder says no watch line twice', async () => {
      const s = setup()
      await started(s, [record()])
      s.source.stop()
      expect(s.watched).toBe(false)
      s.source.start()
      expect(s.watched).toBe(true)
      expect(s.log.filter((line) => line.startsWith('[cmux] watch'))).toEqual(['[cmux] watch · on'])
      expect(s.asked()).toEqual(['all', 'all'])
    })
  })

  describe('runs', () => {
    it('ten changes during one run give one more run, not ten', async () => {
      const s = setup()
      await started(s, [record()])
      s.change('claude-hook-sessions.json')
      for (let n = 0; n < 10; n++) s.change('claude-hook-sessions.json')
      expect(s.asked()).toEqual(['all', 'claude'])
      await s.reply(1, ok([record()]))
      expect(s.asked()).toEqual(['all', 'claude', 'claude'])
      await s.reply(2, ok([record()]))
      expect(s.asked()).toEqual(['all', 'claude', 'claude'])
    })

    it('two agents\' runs go side by side', async () => {
      const s = setup()
      await started(s, [record()])
      s.change('claude-hook-sessions.json')
      s.change('codex-hook-sessions.json')
      expect(s.asked()).toEqual(['all', 'claude', 'codex'])
    })

    it('a run that ends after stop() changes nothing, and after a new start its answer is still dropped', async () => {
      const s = setup()
      s.source.start()
      s.source.stop()
      await s.reply(0, ok([record()]))
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(0)
      s.source.start()
      s.source.stop()
      s.source.start()
      await s.reply(1, ok([record()]))
      expect(s.source.list()).toEqual([])
      await s.reply(2, ok([record({ surface: S2, pid: 102 })]))
      expect(listed(s)).toEqual([key(S2)])
    })

    it('an all-agents run that ends after an agent\'s later run leaves that agent\'s rows', async () => {
      const s = setup()
      s.source.start()
      s.change('claude-hook-sessions.json')
      await s.reply(1, ok([record({ lifecycle: 'running' })]))
      expect(at(s, S1)?.state).toBe('working')
      await s.reply(0, ok([record({ lifecycle: 'idle', updatedAt: 9 }), codex({ surface: S2, pid: 102 })]))
      expect(at(s, S1)?.state).toBe('working')
      expect(listed(s)).toEqual([key(S1), key(S2)])
    })

    it('a 33rd run waits as one all-agents run', async () => {
      const s = setup()
      await started(s, [])
      for (let n = 0; n < 32; n++) s.change(`w${n}-hook-sessions.json`)
      expect(s.sessions).toHaveBeenCalledTimes(33)
      s.change('w32-hook-sessions.json')
      s.change('w33-hook-sessions.json')
      s.change()
      expect(s.sessions).toHaveBeenCalledTimes(33)
      await s.reply(1, ok([]))
      expect(s.asked().slice(33)).toEqual(['all'])
    })

    it('each result drops every row whose pid is gone, another agent\'s too', async () => {
      const s = setup()
      await started(s, [record(), codex({ surface: S2, pid: 102 })])
      s.live.delete(102)
      s.change('claude-hook-sessions.json')
      await s.reply(1, ok([record()]))
      expect(listed(s)).toEqual([key(S1)])
    })
  })

  describe('bounds and failures', () => {
    /** n Claude Code records at S(10) on, each by a live pid of its own. */
    const many = (s: Setup, n: number, from = 10) => Array.from({ length: n }, (_, at) => {
      s.live.add(1000 + from + at)
      return record({ surface: S(from + at), pid: 1000 + from + at })
    })

    it('64 are listed and the 65th is kept: it is listed when one leaves, with no new run', async () => {
      const s = setup()
      const claude = many(s, 64)
      await started(s, [...claude, codex({ surface: S2, pid: 102 })])
      expect(s.source.list()).toHaveLength(64)
      expect(listed(s)).not.toContain(key(S2))
      s.change('claude-hook-sessions.json')
      await s.reply(1, ok(claude.slice(1)))
      expect(s.source.list()).toHaveLength(64)
      expect(listed(s).at(-1)).toBe(key(S2))
      expect(s.asked()).toEqual(['all', 'claude'])
    })

    it('over is said when its number changes, with a run\'s records past the 1,024 it reads', async () => {
      const s = setup()
      const overs = () => s.log.filter((line) => line.startsWith('[cmux] over'))
      const rows = many(s, 65)
      s.source.start()
      await s.reply(0, ok(rows))
      expect(overs()).toEqual(['[cmux] over · 1 left out'])
      s.change()
      await s.reply(1, ok(rows))
      expect(overs()).toEqual(['[cmux] over · 1 left out'])
      // 1,030 records: 1,024 read, of which 64 are listed.
      s.change()
      await s.reply(2, ok(many(s, 1030)))
      expect(overs()).toEqual(['[cmux] over · 1 left out', '[cmux] over · 966 left out'])
    })

    it('a failed or too-big run keeps the rows, and says so once until that agent\'s next good run', async () => {
      const s = setup()
      await started(s, [record()])
      const lists = () => s.log.filter((line) => line.startsWith('[cmux] list ·'))
      s.change('claude-hook-sessions.json')
      await s.reply(1, { ok: false, fault: 'failed' })
      s.change('claude-hook-sessions.json')
      await s.reply(2, { ok: false, fault: 'timeout' })
      expect(listed(s)).toEqual([key(S1)])
      expect(lists()).toEqual(['[cmux] list · failed'])
      s.change('claude-hook-sessions.json')
      await s.reply(3, ok([record()]))
      s.change('claude-hook-sessions.json')
      await s.reply(4, { ok: false, fault: 'too-big' })
      expect(listed(s)).toEqual([key(S1)])
      expect(lists()).toEqual(['[cmux] list · failed', '[cmux] list · too-big'])
      s.change('codex-hook-sessions.json')
      await s.reject(5)
      expect(lists()).toEqual(['[cmux] list · failed', '[cmux] list · too-big', '[cmux] list · failed'])
      expect(listed(s)).toEqual([key(S1)])
    })

    it('onChange is told only when a listed row changed', async () => {
      const s = setup()
      await started(s, [record()])
      expect(s.changes).toBe(1)
      s.change('claude-hook-sessions.json')
      await s.reply(1, ok([record()]))
      s.change('claude-hook-sessions.json')
      await s.reply(2, ok([record({ updatedAt: 99 })]))
      expect(s.changes).toBe(1)
      s.change('claude-hook-sessions.json')
      await s.reply(3, ok([record({ lifecycle: 'running' })]))
      expect(s.changes).toBe(2)
    })
  })

  describe('words, a tap and a rest', () => {
    it('send refuses by its own state before any prompt', async () => {
      const s = setup()
      await started(s, [
        record(),
        record({ surface: S2, pid: 102, lifecycle: 'needsInput' }),
        record({ surface: S3, pid: 103, lifecycle: 'running' }),
      ])
      const [idle, waiting, working] = s.source.list()
      expect(await s.source.send(idle, 'x'.repeat(2001))).toEqual({ ok: false, reason: 'Too long. Say it shorter.' })
      expect(await s.source.send({ ...idle, id: 'gone', name: 'ghost' }, 'hi')).toEqual({ ok: false, reason: 'ghost did not answer.' })
      expect(await s.source.send(waiting, 'hi')).toEqual({ ok: false, reason: 'api is waiting for your answer in cmux.' })
      expect(await s.source.send(working, 'hi')).toEqual({ ok: false, reason: 'api is busy. Say it when it is done.' })
      expect(s.counts).toEqual(['too-long', 'no-answer', 'waiting', 'busy'])
      expect(s.prompt).not.toHaveBeenCalled()
    })

    it.each<[CmuxPrompt, { ok: boolean; reason?: string }, string]>([
      ['sent', { ok: true }, 'cmux'],
      ['busy', { ok: false, reason: 'api is busy. Say it when it is done.' }, 'busy'],
      ['waiting', { ok: false, reason: 'api is waiting for your answer in cmux.' }, 'waiting'],
      ['automation-off', { ok: false, reason: CMUX_AUTOMATION_OFF }, 'refused (cmux)'],
      ['no-answer', { ok: false, reason: 'api did not answer.' }, 'no-answer'],
    ])('a prompt that answers %s: %o, counted as %s', async (outcome, result, count) => {
      const s = setup()
      s.prompt.mockResolvedValueOnce(outcome)
      await started(s, [record()])
      expect(await s.source.send(s.source.list()[0], 'run the tests')).toEqual(result)
      expect(s.counts).toEqual([count])
    })

    it('the prompt is given <workspace>/<surface>, the row\'s kind and the text', async () => {
      const s = setup()
      await started(s, [record({ word: 'hermes-agent', kind: 'hermes' })])
      await s.source.send(s.source.list()[0], 'run the tests')
      expect(s.prompt.mock.calls).toEqual([[`${W}/${S1}`, 'hermes', 'run the tests']])
    })

    it('focus, hasPane and showPane hand the pane and the id on, and paneAt tells that pane; an unknown id is false, false, failed and none', async () => {
      const s = setup()
      await started(s, [record()])
      const [agent] = s.source.list()
      expect(await s.source.focus(agent)).toBe(true)
      expect(s.source.hasPane(agent)).toBe(true)
      expect(await s.source.showPane(agent)).toBe('ok')
      expect(s.source.paneAt(agent.id)).toBe(`${W}/${S1}`)
      expect(s.focus.mock.calls).toEqual([[`${W}/${S1}`, 'u1']])
      expect(s.canShow.mock.calls).toEqual([[`${W}/${S1}`]])
      expect(s.show.mock.calls).toEqual([[`${W}/${S1}`, 'u1']])
      const gone = { ...agent, id: 'gone' }
      expect(await s.source.focus(gone)).toBe(false)
      expect(s.source.hasPane(gone)).toBe(false)
      expect(await s.source.showPane(gone)).toBe('failed')
      expect(s.source.paneAt('gone')).toBeUndefined()
      expect(s.focus).toHaveBeenCalledTimes(1)
      expect(s.canShow).toHaveBeenCalledTimes(1)
      expect(s.show).toHaveBeenCalledTimes(1)
    })

    it('kindAt answers whatever the case of the id, for a row past the 64 too; none where cmux lists nothing', async () => {
      const s = setup()
      const rows = Array.from({ length: 64 }, (_, at) => {
        s.live.add(2000 + at)
        return record({ surface: S(10 + at), pid: 2000 + at })
      })
      await started(s, [...rows, codex({ surface: S2.toLowerCase(), pid: 102 })])
      expect(listed(s)).not.toContain(key(S2))
      expect(s.source.kindAt(S2)).toBe('codex')
      expect(s.source.kindAt(S2.toLowerCase())).toBe('codex')
      expect(s.source.kindAt(S(10).toLowerCase())).toBe('claude')
      expect(s.source.kindAt(S3)).toBeUndefined()
    })

    it('its capabilities are status, words and a tap, and it keeps nothing unseen', () => {
      const s = setup()
      expect(s.source.capabilities()).toEqual({ status: true, voice: true, focus: true, answer: false })
      expect('markSeen' in s.source).toBe(false)
    })
  })

  it('every line it logs is one of the five, with no id, folder or name', async () => {
    const s = setup()
    s.state.folder = false
    s.source.start()
    s.state.folder = true
    s.change('.cmuxterm')
    s.state.mono = 12
    const rows = Array.from({ length: 65 }, (_, at) => {
      s.live.add(3000 + at)
      return record({ surface: S(10 + at), pid: 3000 + at, cwd: `/work/api-${at}` })
    })
    await s.reply(0, ok(rows))
    s.change('claude-hook-sessions.json')
    await s.reply(1, { ok: false, fault: 'too-big' })
    s.change('codex-hook-sessions.json')
    await s.reply(2, { ok: false, fault: 'no-binary' })
    s.state.folder = false
    s.change()
    expect(s.log.length).toBeGreaterThanOrEqual(8)
    for (const line of s.log) {
      expect(line).toMatch(LOG_LINE)
      expect(line).not.toMatch(/api|work|session|aaaa|eeee/i)
    }
  })

  it('read is said for a word\'s first run, then only for a slower one', async () => {
    const s = setup()
    const reads = () => s.log.filter((line) => line.startsWith('[cmux] read'))
    s.source.start()
    s.state.mono = 40
    await s.reply(0, ok([record()]))
    const run = async (n: number, took: number) => {
      s.change('claude-hook-sessions.json')
      s.state.mono += took
      await s.reply(n, ok([record()]))
    }
    await run(1, 30)
    await run(2, 20)
    await run(3, 30)
    await run(4, 60)
    expect(reads()).toEqual(['[cmux] read · all · 40', '[cmux] read · claude · 30', '[cmux] read · claude · 60'])
    s.source.stop()
    s.source.start()
    s.state.mono += 5
    await s.reply(5, ok([record()]))
    expect(reads().at(-1)).toBe('[cmux] read · all · 5')
  })
})
