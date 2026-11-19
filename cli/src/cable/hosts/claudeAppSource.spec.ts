import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observedAgentId } from './observed.js'
import { ClaudeAppSource, type ClaudeAppSourceDeps } from './claudeAppSource.js'
import type { ClaudeAppSession, StoreFolders, StoreRead } from './claudeAppStore.js'
import { capsLetters, type HostAgent, type PaneSwitch } from './types.js'

const ROOT = '/h/Library/Application Support/Claude/claude-code-sessions'
const ACCOUNT = join(ROOT, 'acc')
const ORG = join(ACCOUNT, 'org')
const ORG2 = join(ACCOUNT, 'org2')
const LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
const SESSION = '0b7c2f4e-8a1d-4c3b-9e5f-6a7b8c9d0e1f'
const ID = observedAgentId('claude', SESSION)
const T = 1_763_000_000_000
const FOLDERS: StoreFolders = { accounts: [ACCOUNT], orgs: [ORG] }
const LOG =
  /^\[claude-app\] (watch · (on|none)|listed · \d+ sessions|read · \d+ ms · \d+ parsed · \d+ skipped|over · \d+)$/

/** The session every test lists: Claude Code's id SESSION, the app's LOCAL, in /work/api. */
const session = (over: Partial<ClaudeAppSession> = {}): ClaudeAppSession => ({
  localId: LOCAL, sessionId: SESSION, cwd: '/work/api', title: 'Fix the build', lastActivityAt: T, ...over,
})
const pad = (n: number) => String(n).padStart(12, '0')
/** The n-th other session, with ids and a folder of its own. */
const nth = (n: number, over: Partial<ClaudeAppSession> = {}) => session({
  localId: `local_aaaaaaaa-0000-4000-8000-${pad(n)}`, sessionId: `cccccccc-0000-4000-8000-${pad(n)}`,
  cwd: `/work/p${n}`, title: `Task ${n}`, lastActivityAt: T - n * 1000, ...over,
})
const fileOf = (one: ClaudeAppSession) => `${one.localId}.json`
const read = (sessions: ClaudeAppSession[], over: Partial<StoreRead> = {}): StoreRead => ({
  sessions, parsed: sessions.length, skipped: 0, over: 0, more: false, ...over,
})
/** Lets what the source was answered be taken in. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

type Name = 'folders' | 'files' | 'touch' | 'read' | 'forget'
interface Call { name: Name; args: unknown[]; resolve(value: unknown): void; reject(error: Error): void }

/** Every line any source said, and each store call made while another was under way: checked after each test. */
const lines: string[] = []
let overlaps = 0

describe("the Claude app's source (docs/plans/2026-11-19-dial-claude-app-sessions-design.md)", () => {
  afterEach(() => {
    const said = lines.splice(0)
    for (const line of said) {
      expect(line).toMatch(LOG)
      for (const word of ['Fix the build', 'api', '/work', LOCAL, SESSION, ROOT]) expect(line).not.toContain(word)
    }
    expect(overlaps).toBe(0)
    overlaps = 0
  })

  /** A source on a store whose calls the test answers by hand, watches and a 250 ms timer the test fires, and a clock
   *  the test moves. */
  function setup(over: Partial<ClaudeAppSourceDeps> = {}) {
    const calls: Call[] = []
    const pending: Call[] = []
    function call<T>(name: Name, ...args: unknown[]): Promise<T> {
      if (pending.length > 0) overlaps++
      return new Promise<T>((resolve, reject) => {
        const one: Call = { name, args, resolve: resolve as (value: unknown) => void, reject }
        calls.push(one)
        pending.push(one)
      })
    }
    const watches: Array<{ folders: readonly string[]; changed: (file?: string) => void; stopped: boolean; at: number }> = []
    const timers: Array<{ ms: number; run: () => void; fired: boolean; cancelled: boolean }> = []
    const clock = { mono: 0 }
    const log: string[] = []
    let changes = 0
    const focus = vi.fn(async (_localId: string, _agentId: string) => true)
    const canShow = vi.fn((_localId: string) => true)
    const show = vi.fn(async (_localId: string, _agentId: string): Promise<PaneSwitch> => 'ok')
    /** What the store answers when the test does not say: the one session, in one org folder. */
    const answers: { folders: StoreFolders | undefined; read: StoreRead } = { folders: FOLDERS, read: read([session()]) }
    const deps: ClaudeAppSourceDeps = {
      store: {
        folders: () => call<StoreFolders | undefined>('folders'),
        files: () => call<void>('files'),
        touch: (org, name) => call<void>('touch', org, name),
        read: () => call<StoreRead>('read'),
        forget: () => { calls.push({ name: 'forget', args: [], resolve: () => {}, reject: () => {} }) },
      },
      root: ROOT,
      watch: (folders, changed) => {
        const one = { folders, changed, stopped: false, at: calls.length }
        watches.push(one)
        return () => { one.stopped = true }
      },
      after: (ms, run) => {
        const one = { ms, run, fired: false, cancelled: false }
        timers.push(one)
        return () => { one.cancelled = true }
      },
      focus,
      canShow,
      show,
      monotonic: () => clock.mono,
      log: (line) => {
        log.push(line)
        lines.push(line)
      },
      ...over,
    }
    const source = new ClaudeAppSource(deps)
    source.onChange(() => { changes++ })
    async function reply(value?: unknown): Promise<void> {
      pending.shift()!.resolve(value)
      await turn()
    }
    return {
      source, answers, watches, timers, clock, log, focus, canShow, show,
      get changes() { return changes },
      /** The store's calls, in order. */
      calls: () => calls.map(({ name }) => name),
      /** The arguments of each touch. */
      touched: () => calls.filter(({ name }) => name === 'touch').map(({ args }) => args),
      /** The watches not stopped, by their folders. */
      watching: () => watches.filter(({ stopped }) => !stopped).map(({ folders }) => folders),
      reply,
      /** Fails the call under way. */
      fail: async () => {
        pending.shift()!.reject(new Error('broken'))
        await turn()
      },
      /** Answers the pass under way as `answers` say, call after call, until it has ended. */
      land: async () => {
        while (pending.length > 0) {
          const { name } = pending[0]!
          await reply(name === 'folders' ? answers.folders : name === 'read' ? answers.read : undefined)
        }
      },
      /** The 250 ms passed: fires each timer not fired or cancelled yet. */
      gap: () => {
        for (const one of timers.filter(({ fired, cancelled }) => !fired && !cancelled)) {
          one.fired = true
          one.run()
        }
      },
      /** The timers neither fired nor cancelled. */
      timing: () => timers.filter(({ fired, cancelled }) => !fired && !cancelled).length,
      /** An event of the latest watch of that folder that is not stopped. */
      fire: (folder: string, file?: string) => {
        watches.filter(({ folders, stopped }) => folders[0] === folder && !stopped).at(-1)!.changed(file)
      },
    }
  }
  type Setup = ReturnType<typeof setup>

  /** Started, its first pass landed and its 250 ms passed. */
  async function started(over: Partial<ClaudeAppSourceDeps> = {}): Promise<Setup> {
    const s = setup(over)
    s.source.start()
    await s.land()
    s.gap()
    return s
  }

  /** The store's calls of the pass the event runs, landed, and its 250 ms passed. */
  async function after(s: Setup, event: () => void): Promise<Name[]> {
    const mark = s.calls().length
    event()
    await s.land()
    s.gap()
    return s.calls().slice(mark)
  }

  const names = (s: Setup) => s.source.list().map(({ name }) => name)

  describe('the row', () => {
    it('a session is one idle, resting agent on the Claude app\'s page, under the observed source\'s id', async () => {
      const s = await started()
      expect(s.source.list()).toEqual([{
        id: ID, engine: 'claude', sessionId: SESSION, paneKeys: [`claude-app:${LOCAL}`], name: 'Fix the build',
        cwd: '/work/api', host: 'claude', app: 'claude', state: 'idle', unseenDone: false, resting: true,
        lastActivityAt: T,
      }])
    })

    // Review Focus 4: a title the title rule refuses, or a folder with no name.
    it('a row always has a name', async () => {
      const s = setup()
      s.answers.read = read([
        nth(1, { title: undefined, cwd: '/work/api' }),
        nth(2, { title: '', cwd: '/work/api' }),
        nth(3, { title: '  ', cwd: '/work/api' }),
        nth(4, { title: 'a\u0007b', cwd: '/work/api' }),
        nth(5, { title: 'x'.repeat(80) }),
        nth(6, { title: undefined, cwd: '/' }),
      ])
      s.source.start()
      await s.land()
      expect(names(s)).toEqual(['api', 'api', 'api', 'api', 'x'.repeat(64), 'claude'])
    })

    it('it has status and a tap, no voice and no answer, and takes no words', async () => {
      const s = await started()
      expect(capsLetters(s.source.capabilities())).toBe('sf')
      expect('send' in s.source).toBe(false)
      expect('markSeen' in s.source).toBe(false)
    })

    it('a tap, a rest and its look go to the session\'s local id', async () => {
      const s = await started()
      const [agent] = s.source.list()
      expect(await s.source.focus(agent!)).toBe(true)
      expect(s.source.hasPane(agent!)).toBe(true)
      expect(await s.source.showPane(agent!)).toBe('ok')
      expect(s.focus.mock.calls).toEqual([[LOCAL, ID]])
      expect(s.canShow.mock.calls).toEqual([[LOCAL]])
      expect(s.show.mock.calls).toEqual([[LOCAL, ID]])
      const stranger: HostAgent = { ...agent!, id: observedAgentId('claude', nth(1).sessionId) }
      expect(await s.source.focus(stranger)).toBe(false)
      expect(s.source.hasPane(stranger)).toBe(false)
      expect(await s.source.showPane(stranger)).toBe('failed')
      expect(s.focus).toHaveBeenCalledTimes(1)
      expect(s.canShow).toHaveBeenCalledTimes(1)
      expect(s.show).toHaveBeenCalledTimes(1)
    })
  })

  describe('which event reads what', () => {
    it('the start lists the folders, then the files, then reads', async () => {
      const s = await started()
      expect(s.calls()).toEqual(['folders', 'files', 'read'])
    })

    it('an org\'s event naming a session\'s file touches that file alone', async () => {
      const s = await started()
      expect(await after(s, () => s.fire(ORG, fileOf(session())))).toEqual(['touch', 'read'])
      expect(s.touched()).toEqual([[ORG, fileOf(session())]])
    })

    it('an org\'s event naming anything else does nothing', async () => {
      const s = await started()
      const timers = s.timers.length
      for (const name of ['deleted_x', 'archived-sessions.idx', 'scheduled-tasks.json', 'waiting-input',
        'local_a.json.tmp', '.DS_Store']) s.fire(ORG, name)
      await turn()
      expect(s.calls()).toEqual(['folders', 'files', 'read'])
      expect(s.timers.length).toBe(timers)
    })

    it('an org\'s event with no name, and any event of an account\'s or the root\'s watch, lists the folders again', async () => {
      const s = await started()
      for (const [folder, file] of [[ORG, undefined], [ACCOUNT, 'org'], [ACCOUNT, undefined], [ROOT, 'acc'],
        [ROOT, undefined]] as const) {
        expect(await after(s, () => s.fire(folder, file))).toEqual(['folders', 'files', 'read'])
      }
    })
  })

  describe('the watches', () => {
    it('the root\'s watch is set before the folders are listed, on the root and the app\'s folder', () => {
      const s = setup()
      s.source.start()
      expect(s.watches.map(({ folders, at }) => [folders, at])).toEqual([[[ROOT, dirname(ROOT)], 0]])
      expect(s.calls()).toEqual(['folders'])
    })

    it('the account and org watches are set before the files are listed, one a folder', async () => {
      const s = setup()
      s.source.start()
      await s.reply(FOLDERS)
      expect(s.watches.slice(1).map(({ folders, at }) => [folders, at])).toEqual([[[ACCOUNT], 1], [[ORG], 1]])
      expect(s.calls()).toEqual(['folders', 'files'])
    })

    it('a folder that left loses its watch, a new one gets one, and none is set twice', async () => {
      const s = await started()
      s.answers.folders = { accounts: [ACCOUNT], orgs: [ORG2] }
      await after(s, () => s.fire(ACCOUNT, 'org2'))
      expect(s.watching()).toEqual([[ROOT, dirname(ROOT)], [ACCOUNT], [ORG2]])
      await after(s, () => s.fire(ACCOUNT, undefined))
      expect(s.watches.map(({ folders }) => folders)).toEqual([[ROOT, dirname(ROOT)], [ACCOUNT], [ORG], [ORG2]])
    })
  })

  describe('the root\'s wait', () => {
    it('with no root it says watch · none, lists nothing and reads nothing', async () => {
      const s = setup()
      s.answers.folders = undefined
      s.source.start()
      await s.land()
      expect(s.calls()).toEqual(['folders'])
      expect(s.log).toEqual(['[claude-app] watch · none'])
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(0)
      expect(s.watching()).toEqual([[ROOT, dirname(ROOT)]])
    })

    it('while it waits, an entry of the app\'s folder that is not the root does nothing', async () => {
      const s = setup()
      s.answers.folders = undefined
      s.source.start()
      await s.land()
      s.gap()
      s.fire(ROOT, 'Cookies')
      s.fire(ROOT, 'config.json')
      await turn()
      expect(s.calls()).toEqual(['folders'])
      expect(await after(s, () => s.fire(ROOT, 'claude-code-sessions'))).toEqual(['folders'])
      expect(await after(s, () => s.fire(ROOT, undefined))).toEqual(['folders'])
    })

    it('the root made: watch · on, and its sessions are listed', async () => {
      const s = setup()
      s.answers.folders = undefined
      s.source.start()
      await s.land()
      s.gap()
      s.answers.folders = FOLDERS
      expect(await after(s, () => s.fire(ROOT, 'claude-code-sessions'))).toEqual(['folders', 'files', 'read'])
      expect(s.log).toEqual([
        '[claude-app] watch · none', '[claude-app] watch · on', '[claude-app] read · 0 ms · 1 parsed · 0 skipped',
        '[claude-app] listed · 1 sessions',
      ])
      expect(s.source.list().map(({ id }) => id)).toEqual([ID])
      expect(s.changes).toBe(1)
    })

    it('the root removed: every row goes with one change, the account and org watches stop, and it says watch · none', async () => {
      const s = await started()
      expect(s.changes).toBe(1)
      s.answers.folders = undefined
      expect(await after(s, () => s.fire(ROOT, 'acc'))).toEqual(['folders'])
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(2)
      expect(s.watching()).toEqual([[ROOT, dirname(ROOT)]])
      expect(s.log.at(-1)).toBe('[claude-app] watch · none')
    })
  })

  describe('one pass at a time', () => {
    it('ten changes during a pass give one more pass, not ten', async () => {
      const s = await started()
      const mark = s.calls().length
      s.fire(ACCOUNT, 'org')
      for (let i = 0; i < 10; i++) s.fire(ORG, undefined)
      await s.land()
      s.gap()
      await s.land()
      s.gap()
      await turn()
      expect(s.calls().slice(mark)).toEqual(['folders', 'files', 'read', 'folders', 'files', 'read'])
    })

    it('the next pass starts no sooner than 250 ms after the last one\'s start', async () => {
      const s = setup()
      s.source.start()
      expect(s.timers.map(({ ms }) => ms)).toEqual([250])
      await s.land()
      s.fire(ORG, fileOf(session()))
      await turn()
      expect(s.calls()).toEqual(['folders', 'files', 'read'])
      s.gap()
      expect(s.calls()).toEqual(['folders', 'files', 'read', 'touch'])
      // A pass slower than the 250 ms: the next starts as it ends.
      s.gap()
      s.fire(ORG, fileOf(nth(1)))
      await turn()
      expect(s.calls()).toEqual(['folders', 'files', 'read', 'touch'])
      await s.land()
      expect(s.calls()).toEqual(['folders', 'files', 'read', 'touch', 'read', 'touch', 'read'])
      expect(s.timers.map(({ ms }) => ms)).toEqual([250, 250, 250])
    })

    it('the names touched during a pass are all touched in the next', async () => {
      const s = await started()
      s.fire(ORG, fileOf(nth(1)))
      s.fire(ORG, fileOf(nth(2)))
      s.fire(ORG, fileOf(nth(3)))
      s.fire(ORG, fileOf(nth(2)))
      await s.land()
      s.gap()
      await s.land()
      expect(s.touched()).toEqual([[ORG, fileOf(nth(1))], [ORG, fileOf(nth(2))], [ORG, fileOf(nth(3))]])
      expect(s.calls().slice(3)).toEqual(['touch', 'read', 'touch', 'touch', 'read'])
    })

    // Review Focus 2: the app rewrites hundreds of files at once.
    it('more than 256 names waiting become one listing', async () => {
      const s = await started()
      s.fire(ORG, fileOf(session()))
      for (let n = 1; n <= 256; n++) s.fire(ORG, fileOf(nth(n)))
      await s.land()
      s.gap()
      await s.land()
      s.gap()
      expect(s.touched()).toHaveLength(257)
      const mark = s.calls().length
      s.fire(ORG, fileOf(session()))
      for (let n = 1; n <= 300; n++) s.fire(ORG, fileOf(nth(n)))
      await s.land()
      s.gap()
      await s.land()
      expect(s.calls().slice(mark)).toEqual(['touch', 'read', 'folders', 'files', 'read'])
    })

    it('a read cut short asks for one more with no event', async () => {
      const s = setup()
      s.answers.read = read([session()], { more: true })
      s.source.start()
      await s.land()
      expect(s.calls()).toEqual(['folders', 'files', 'read'])
      s.answers.read = read([session()])
      s.gap()
      await s.land()
      expect(s.calls()).toEqual(['folders', 'files', 'read', 'read'])
      s.gap()
      await turn()
      expect(s.calls()).toEqual(['folders', 'files', 'read', 'read'])
    })
  })

  describe('told only when the list changes', () => {
    it('a new lastActivityAt alone tells nothing, and list() has it', async () => {
      const s = await started()
      expect(s.changes).toBe(1)
      s.answers.read = read([session({ lastActivityAt: T + 5000 })])
      await after(s, () => s.fire(ORG, fileOf(session())))
      expect(s.changes).toBe(1)
      expect(s.source.list()[0]!.lastActivityAt).toBe(T + 5000)
    })

    it('a new name, a new folder, a new order, a row come or gone each tell once', async () => {
      const s = await started()
      const steps = [
        [session({ title: 'Fix the tests' })],
        [session({ title: 'Fix the tests', cwd: '/work/web' })],
        [session({ title: 'Fix the tests', cwd: '/work/web' }), nth(1)],
        [nth(1), session({ title: 'Fix the tests', cwd: '/work/web' })],
        [nth(1)],
      ]
      for (const [at, sessions] of steps.entries()) {
        s.answers.read = read(sessions)
        await after(s, () => s.fire(ORG, undefined))
        expect(s.changes).toBe(at + 2)
      }
    })
  })

  describe('start and stop', () => {
    it('a second start sets no second watch', () => {
      const s = setup()
      s.source.start()
      s.source.start()
      expect(s.watches).toHaveLength(1)
      expect(s.calls()).toEqual(['folders'])
    })

    it('stop stops every watch and the timer, forgets the store and drops the rows with one change', async () => {
      const s = setup()
      s.source.start()
      await s.land()
      expect(s.changes).toBe(1)
      expect(s.timing()).toBe(1)
      s.source.stop()
      expect(s.watching()).toEqual([])
      expect(s.timing()).toBe(0)
      expect(s.calls().at(-1)).toBe('forget')
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(2)
      s.source.stop()
      expect(s.changes).toBe(2)
      expect(s.calls().filter((name) => name === 'forget')).toHaveLength(1)
    })

    // Review Focus 5: the dial unplugged while a read is under way, and plugged in again.
    it('a pass that lands after a stop lists nothing, and the next start reads afresh', async () => {
      const s = await started()
      s.fire(ORG, fileOf(nth(1)))
      await s.reply()
      expect(s.calls().at(-1)).toBe('read')
      s.source.stop()
      expect(s.changes).toBe(2)
      const said = s.log.length
      await s.reply(read([session(), nth(1)], { over: 2 }))
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(2)
      expect(s.log).toHaveLength(said)
      const mark = s.calls().length
      s.source.start()
      await s.land()
      expect(s.calls().slice(mark)).toEqual(['folders', 'files', 'read'])
      expect(s.source.list().map(({ id }) => id)).toEqual([ID])
      expect(s.changes).toBe(3)
      expect(s.log.filter((line) => line === '[claude-app] listed · 1 sessions')).toHaveLength(2)
      expect(s.log.filter((line) => line === '[claude-app] watch · on')).toHaveLength(1)
    })

    it('a start while a stopped pass is still under way waits for it: one pass at a time', async () => {
      const s = setup()
      s.source.start()
      s.source.stop()
      s.source.start()
      expect(s.calls()).toEqual(['folders', 'forget'])
      await s.reply(FOLDERS)
      expect(s.calls()).toEqual(['folders', 'forget', 'folders'])
      await s.land()
      expect(s.calls()).toEqual(['folders', 'forget', 'folders', 'files', 'read'])
      expect(s.source.list().map(({ id }) => id)).toEqual([ID])
    })
  })

  describe('failures', () => {
    it.each(['folders', 'files', 'touch', 'read'] as const)(
      'a store call that rejects keeps the rows and throws nothing, and the next change runs a pass: %s',
      async (failing) => {
        const s = await started()
        if (failing === 'touch') s.fire(ORG, fileOf(session()))
        else s.fire(ORG, undefined)
        await turn()
        while (s.calls().at(-1) !== failing) await s.reply(s.calls().at(-1) === 'folders' ? FOLDERS : undefined)
        await s.fail()
        expect(s.source.list().map(({ id }) => id)).toEqual([ID])
        expect(s.changes).toBe(1)
        s.gap()
        expect(await after(s, () => s.fire(ORG, undefined))).toEqual(['folders', 'files', 'read'])
      },
    )
  })

  describe('log lines', () => {
    it('listed is said when the count changes', async () => {
      const s = await started()
      s.answers.read = read([nth(1)])
      await after(s, () => s.fire(ORG, undefined))
      s.answers.read = read([nth(1), nth(2)])
      await after(s, () => s.fire(ORG, undefined))
      expect(s.log.filter((line) => line.includes('listed'))).toEqual([
        '[claude-app] listed · 1 sessions', '[claude-app] listed · 2 sessions',
      ])
    })

    it('read is said for the first read of a start, then only for a slower one', async () => {
      const s = setup()
      s.answers.read = read([session()], { parsed: 3, skipped: 1 })
      s.source.start()
      s.clock.mono = 12.4
      await s.land()
      s.gap()
      const reads = () => s.log.filter((line) => line.includes('read'))
      expect(reads()).toEqual(['[claude-app] read · 12 ms · 3 parsed · 1 skipped'])
      s.answers.read = read([session()], { parsed: 1 })
      s.fire(ORG, undefined)
      s.clock.mono += 5
      await s.land()
      s.gap()
      expect(reads()).toHaveLength(1)
      s.fire(ORG, undefined)
      s.clock.mono += 20
      await s.land()
      s.gap()
      expect(reads().at(-1)).toBe('[claude-app] read · 20 ms · 1 parsed · 0 skipped')
      s.source.stop()
      s.source.start()
      await s.land()
      expect(reads().at(-1)).toBe('[claude-app] read · 0 ms · 1 parsed · 0 skipped')
      expect(reads()).toHaveLength(3)
    })

    it('over is said when its number changes and is above zero', async () => {
      const s = await started()
      for (const over of [3, 3, 0, 5, 5]) {
        s.answers.read = read([session()], { over })
        await after(s, () => s.fire(ORG, undefined))
      }
      expect(s.log.filter((line) => line.includes('over'))).toEqual(['[claude-app] over · 3', '[claude-app] over · 5'])
    })

    it('every line is fixed words and counts', async () => {
      const s = setup()
      s.answers.folders = undefined
      s.source.start()
      await s.land()
      s.gap()
      s.answers.folders = FOLDERS
      s.answers.read = read([session(), nth(1, { cwd: '/work/api' })], { parsed: 2, skipped: 3, over: 4 })
      await after(s, () => s.fire(ROOT, 'claude-code-sessions'))
      expect(s.log).toEqual([
        '[claude-app] watch · none', '[claude-app] watch · on', '[claude-app] read · 0 ms · 2 parsed · 3 skipped',
        '[claude-app] listed · 2 sessions', '[claude-app] over · 4',
      ])
      for (const line of s.log) expect(line).toMatch(LOG)
    })
  })
})
