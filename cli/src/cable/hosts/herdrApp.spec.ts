import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Place } from './adapter.js'
import type { HcPrompt, HcStatus } from './hcClient.js'
import { createHerdrAppAdapter, type HerdrAppDeps } from './herdrApp.js'
import { detectApp, detectHost } from './hostDetect.js'
import { herdrAppStatus } from '../../testing/herdrAppStatus.js'

const FAKE_PATH_HERDR_APP = '/fake/bin/herdr-app'
/** Herdr.app's own binary, written out: the adapter's own constant would agree with itself. */
const APP_BINARY = '/Applications/Herdr.app/Contents/MacOS/Herdr'
/** Addresses a hook or a forged hint could send that are no terminal of this machine's. */
const FORGED = ['vps/t7', 'T7', 't', ' t7', 't7\n', '--help', 't7; rm -rf /', `t${'1'.repeat(17)}`]
/** The tab of Herdr's window that holds each terminal, as its `herdr.tab` label in hc says (hcSource.ts tabOf). */
const TABS = new Map([['t7', 'tbaaaa'], ['t8', 'tbbbbb']])

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording runner that runs nothing, so no spec opens Herdr or moves its window: each call answers the next of
 *  [codes], then exit 0, with [stdout] (what `herdr-app status` printed). Beside it a recording client that opens no
 *  socket (its `prompt` answers `sent` unless the test sets another answer, its `keys` true), Herdr in front, every
 *  terminal shown and reporting Codex idle, t7 and t8 in the tabs of TABS, and the default hc session followed unless
 *  the test says otherwise, and the log's lines kept. */
function recorder(over: Partial<HerdrAppDeps> = {}, codes: Array<number | null> = [], stdout = '') {
  const calls: Call[] = []
  const log: string[] = []
  const prompt = vi.fn(async (_address: string, _kind: string, _text: string): Promise<HcPrompt> => ({ outcome: 'sent' }))
  const keys = vi.fn(async (_address: string, _keys: readonly string[], _deadlineMs: number) => true)
  const deps: HerdrAppDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout }
    },
    onPath: (name) => (name === 'herdr-app' ? FAKE_PATH_HERDR_APP : null),
    exists: () => false,
    platform: 'darwin',
    client: { prompt, keys },
    inFront: () => true,
    shows: () => true,
    tabOf: (address) => TABS.get(address),
    kindOf: () => 'codex',
    statusOf: () => 'idle',
    reports: () => true,
    hookIds: true,
    log: (line) => log.push(line),
    ...over,
  }
  return { calls, log, prompt, keys, adapter: createHerdrAppAdapter(deps) }
}

/** Lets every step already able to run take place. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** The recorder, each command held until the test answers it, so a run can be caught under way. */
function holding() {
  const calls: Call[] = []
  const waiting: Array<(code: number | null, stdout: string) => void> = []
  const rest = recorder({
    run: (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return new Promise((resolve) => waiting.push((code, stdout) => resolve({ code, stdout })))
    },
  })
  /** Answers the oldest command still held, with what it printed, and lets what follows it run. */
  const answer = async (code: number | null, stdout = '') => {
    waiting.shift()!(code, stdout)
    await turn()
  }
  return { ...rest, calls, answer }
}

/** An answer the test gives when it chooses. */
function held<T>() {
  let give!: (value: T) => void
  const answer = new Promise<T>((resolve) => { give = resolve })
  return { answer, give }
}

const place = (hints: Record<string, string>): Place => ({ host: 'herdr', app: 'herdr', hints })
/** The place the observed source gives a hook's hints. */
const detected = (hints: Record<string, string>): Place => ({ host: detectHost(hints), app: detectApp(hints), hints })
const pane = (id: string) => ({ adapter: 'herdr-app', id })
const openCall: Call = { file: '/usr/bin/open', args: ['-b', 'dev.herdr.app'], timeoutMs: 10_000 }
const focusCall = (address: string, file = FAKE_PATH_HERDR_APP): Call =>
  ({ file, args: ['do', 'agent.focus', '--terminal', address], timeoutMs: 10_000 })
const FAILED_LINE = '[herdr-app] focus · failed'
const scrollCall = (address: string, lines: number, file = FAKE_PATH_HERDR_APP): Call =>
  ({ file, args: ['do', 'terminal.scroll', '--terminal', address, '--lines', String(lines)], timeoutMs: 2_000 })
const SCROLL_FAILED = '[herdr-app] scroll · failed'
/** The line a terminal's scroll queue says once it has been quiet for 1 s. */
const drained = (lines: number, runs: number, failed: number) =>
  `[herdr-app] scroll · ${lines} lines · ${runs} runs · ${failed} failed`
const scrollFailures = (log: string[]) => log.filter((line) => line === SCROLL_FAILED).length
const statusCall: Call = { file: FAKE_PATH_HERDR_APP, args: ['status'], timeoutMs: 2_000 }
const STATUS_FAILED = '[herdr-app] status · failed'
/** The fixture with its keys changed, as a Herdr that printed other values would. */
const statusWith = (change: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(herdrAppStatus()), ...change })

describe('the Herdr adapter', () => {
  it('its id is herdr-app, and a tap is its own', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('herdr-app')
    expect(adapter.tap).toBe('instead')
    expect(adapter.type).toEqual(expect.any(Function))
    expect(adapter.show).toEqual(expect.any(Function))
    expect(adapter.canShow).toEqual(expect.any(Function))
  })

  // Herdr's window, and hc's socket as the client speaks it, are tried on macOS only.
  it('off macOS it has no pane, no type, no focus and no show', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { calls, log, adapter } = recorder({ platform })
      expect(adapter.paneOf(place({ HC_TERMINAL_ID: 't7' })), platform).toBeUndefined()
      expect(adapter.canFocus(pane('t7')), platform).toBe(false)
      expect(adapter.canShow(pane('t7')), platform).toBe(false)
      expect(adapter.type, platform).toBeUndefined()
      expect(adapter.canType, platform).toBeUndefined()
      expect(await adapter.focus(pane('t7')), platform).toBe(false)
      expect(await adapter.show(pane('t7'), 'agent-1'), platform).toBe('failed')
      expect(calls, platform).toEqual([])
      expect(log, platform).toEqual([])
    }
  })

  it('paneOf takes hc\'s address, and refuses any other', () => {
    const { adapter } = recorder()
    for (const id of ['t7', 't1b', `t${'1'.repeat(16)}`]) {
      expect(adapter.paneOf(place({ HC_TERMINAL_ID: id })), id).toEqual(pane(id))
    }
    // hc gives its programs TERM_PROGRAM=ghostty: the address is Herdr's whatever app the other hints name.
    for (const bundle of ['com.mitchellh.ghostty', 'dev.herdr.app', 'com.stablyai.orca']) {
      const hints = { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: bundle }
      expect(adapter.paneOf(place(hints)), bundle).toEqual(pane('t7'))
    }
    expect(adapter.paneOf(place({}))).toBeUndefined()
    expect(adapter.paneOf(place({ HERDR_PANE_ID: 'w1:p1', TERM_PROGRAM: 'ghostty' }))).toBeUndefined()
    for (const id of FORGED) {
      expect(adapter.paneOf(place({ HC_TERMINAL_ID: id })), id).toBeUndefined()
    }
  })

  // Every program an hc terminal starts inherits its HC_TERMINAL_ID (`code .`, tmux, zellij, herdr): there it names the
  // terminal the other app was started from, and a tap would switch Herdr, and words go, to another agent.
  it('paneOf refuses an hc address another app or a nearer host inherited, and any host but herdr', () => {
    const { adapter } = recorder()
    const inherited: Array<Record<string, string>> = [
      { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' },
      { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'tmux', TMUX_PANE: '%3' },
      { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'ghostty', TMUX_PANE: '%3' },
      { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'ghostty', HERDR_PANE_ID: 'w1:p1' },
      { HC_TERMINAL_ID: 't3', REX_BLOCK: 'x' },
      { HC_TERMINAL_ID: 't3', ZELLIJ: '0' },
      { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'iTerm.app' },
    ]
    for (const hints of inherited) expect(adapter.paneOf(detected(hints)), JSON.stringify(hints)).toBeUndefined()
    expect(adapter.paneOf(detected({ HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'ghostty' }))).toEqual(pane('t3'))
    const ghostty: Place = { host: 'ghostty', app: 'ghostty', hints: { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'ghostty' } }
    expect(adapter.paneOf(ghostty)).toBeUndefined()
  })

  // The hook sends the address of a terminal of the default hc session alone (notify.mjs): a session of its own counts
  // from t1 again, so to devices following another session the address is another of their terminals.
  it('paneOf takes a hook\'s address only when the devices follow the default hc session', async () => {
    const hints = { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' }
    expect(recorder({ hookIds: true }).adapter.paneOf(place(hints))).toEqual(pane('t7'))
    for (const hookIds of [false, undefined]) {
      const { calls, adapter } = recorder({ hookIds })
      expect(adapter.paneOf(place(hints)), String(hookIds)).toBeUndefined()
      // The hc source's own rows still come by their address.
      expect(await adapter.focus(pane('t7')), String(hookIds)).toBe(true)
      expect(calls, String(hookIds)).toEqual([openCall, focusCall('t7')])
    }
  })

  // Every hc terminal has HC_TERMINAL_ID, hidden `hc run` workers too: a hooked copy in one has the pane for words only.
  it('canFocus is true only for a terminal Herdr\'s window shows; canShow also needs Herdr in front', () => {
    let front = true
    const shown = new Set(['t7'])
    const { adapter } = recorder({ inFront: () => front, shows: (address) => shown.has(address) })
    expect(adapter.canFocus(pane('t7'))).toBe(true)
    expect(adapter.canShow(pane('t7'))).toBe(true)
    expect(adapter.canFocus(pane('t8'))).toBe(false)
    expect(adapter.canShow(pane('t8'))).toBe(false)
    front = false
    expect(adapter.canFocus(pane('t7'))).toBe(true)
    expect(adapter.canShow(pane('t7'))).toBe(false)
    // Asked at each look: the window may have closed the terminal since.
    shown.delete('t7')
    expect(adapter.canFocus(pane('t7'))).toBe(false)
  })

  it('focus opens Herdr, then switches its window to the terminal', async () => {
    const { calls, log, adapter } = recorder()
    expect(await adapter.focus(pane('t7'))).toBe(true)
    expect(calls).toEqual([openCall, focusCall('t7')])
    expect(log).toEqual([])
  })

  // The end-to-end harness points HARNESS_OPEN_BIN at a fake that opens nothing (e2e/harness/daemon.ts), as open.ts takes it.
  it.each([
    ['/tmp/e2e/fake-open', '/tmp/e2e/fake-open'],
    ['', '/usr/bin/open'],
    ['fake-open', '/usr/bin/open'],
    [undefined, '/usr/bin/open'],
  ])('HARNESS_OPEN_BIN %j: an absolute path is the open a tap runs; empty, relative and none run /usr/bin/open', async (bin, file) => {
    const { calls, adapter } = recorder({ bin })
    expect(await adapter.focus(pane('t7'))).toBe(true)
    expect(calls).toEqual([{ ...openCall, file }, focusCall('t7')])
  })

  it('herdr-app is found on PATH, else at Herdr.app\'s own binary', async () => {
    expect(recorder().adapter.binary()).toBe(FAKE_PATH_HERDR_APP)
    expect(recorder({ exists: (path) => path === APP_BINARY }).adapter.binary()).toBe(FAKE_PATH_HERDR_APP)
    const app = recorder({ onPath: () => null, exists: (path) => path === APP_BINARY })
    expect(app.adapter.binary()).toBe(APP_BINARY)
    expect(await app.adapter.focus(pane('t7'))).toBe(true)
    expect(app.calls).toEqual([openCall, focusCall('t7', APP_BINARY)])
    expect(recorder({ onPath: () => null }).adapter.binary()).toBeNull()
  })

  it('an open that fails is false, and agent.focus does not run', async () => {
    for (const code of [1, null]) {
      const { calls, log, adapter } = recorder({}, [code])
      expect(await adapter.focus(pane('t7')), String(code)).toBe(false)
      expect(calls, String(code)).toEqual([openCall])
      expect(log, String(code)).toEqual([])
    }
  })

  // Herdr is in front once `open` came back: a window still opening may not take the switch (Review Focus 1).
  it('agent.focus that fails after Herdr came forward is true, with one line and no address in it', async () => {
    for (const code of [1, null]) {
      const { calls, log, adapter } = recorder({}, [0, code])
      expect(await adapter.focus(pane('t7')), String(code)).toBe(true)
      expect(calls, String(code)).toEqual([openCall, focusCall('t7')])
      expect(log, String(code)).toEqual([FAILED_LINE])
    }
    const none = recorder({ onPath: () => null })
    expect(await none.adapter.focus(pane('t7'))).toBe(true)
    expect(none.calls).toEqual([openCall])
    expect(none.log).toEqual([FAILED_LINE])
  })

  it('show runs agent.focus alone: ok, or failed with the line', async () => {
    const { calls, log, adapter } = recorder({}, [0, 1, null])
    expect(await adapter.show(pane('t7'), 'agent-1')).toBe('ok')
    expect(log).toEqual([])
    expect(await adapter.show(pane('t7'), 'agent-1')).toBe('failed')
    expect(await adapter.show(pane('t7'), 'agent-1')).toBe('failed')
    expect(calls).toEqual([focusCall('t7'), focusCall('t7'), focusCall('t7')])
    expect(log).toEqual([FAILED_LINE, FAILED_LINE])
    const none = recorder({ onPath: () => null })
    expect(await none.adapter.show(pane('t7'), 'agent-1')).toBe('failed')
    expect(none.calls).toEqual([])
    expect(none.log).toEqual([FAILED_LINE])
  })

  it('an address not in its form runs nothing', async () => {
    const { calls, log, adapter } = recorder()
    for (const id of FORGED) {
      expect(await adapter.focus(pane(id)), id).toBe(false)
      expect(await adapter.show(pane(id), 'agent-1'), id).toBe('failed')
    }
    expect(calls).toEqual([])
    expect(log).toEqual([])
  })

  describe('one run per terminal', () => {
    it('a second focus and a show for that terminal are the same two calls; another terminal runs beside it', async () => {
      const { calls, adapter, answer } = holding()
      const tap = adapter.focus(pane('t7'))
      const again = adapter.focus(pane('t7'))
      const rest = adapter.show(pane('t7'), 'agent-1')
      const other = adapter.focus(pane('t8'))
      await turn()
      expect(calls).toEqual([openCall, openCall])
      await answer(0)
      expect(calls).toEqual([openCall, openCall, focusCall('t7')])
      await answer(0)
      expect(calls).toEqual([openCall, openCall, focusCall('t7'), focusCall('t8')])
      await answer(0)
      expect(await tap).toBe(true)
      expect(await again).toBe(true)
      expect(await rest).toBe('ok')
      await answer(0)
      expect(await other).toBe(true)
      expect(calls).toHaveLength(4)
    })

    // A rest runs only with Herdr in front (canShow): a tap that comes meanwhile finds Herdr forward.
    it('a tap while a show runs is that show, and Herdr is forward', async () => {
      const { calls, log, adapter, answer } = holding()
      const rest = adapter.show(pane('t7'), 'agent-1')
      const tap = adapter.focus(pane('t7'))
      await answer(1)
      expect(await rest).toBe('failed')
      expect(await tap).toBe(true)
      expect(calls).toEqual([focusCall('t7')])
      expect(log).toEqual([FAILED_LINE])
    })

    it('the terminal is free again after a run that failed', async () => {
      const { calls, adapter } = recorder({}, [1])
      expect(await adapter.focus(pane('t7'))).toBe(false)
      expect(await adapter.focus(pane('t7'))).toBe(true)
      expect(await adapter.show(pane('t7'), 'agent-1')).toBe('ok')
      expect(calls).toEqual([openCall, openCall, focusCall('t7'), focusCall('t7')])
    })
  })

  // A hooked copy has the pane for any address its hook said; hc reports an agent's status at some of them alone.
  it('type sends the words with the agent\'s engine, and is true only when sent; canType follows what hc reports', async () => {
    const reported = new Set(['t7'])
    const { adapter, prompt } = recorder({ reports: (address) => reported.has(address) })
    expect(await adapter.type!(pane('t7'), 'next', 'claude')).toBe(true)
    expect(prompt.mock.calls).toEqual([['t7', 'claude', 'next']])
    prompt.mockResolvedValueOnce({ outcome: 'busy' })
    expect(await adapter.type!(pane('t7'), 'next', 'claude')).toBe(false)
    prompt.mockResolvedValueOnce({ outcome: 'failed', fault: 'rejected', kind: 'not_found' })
    expect(await adapter.type!(pane('t7'), 'next', 'claude')).toBe(false)
    expect(adapter.canType!(pane('t7'))).toBe(true)
    expect(adapter.canType!(pane('t8'))).toBe(false)
    reported.delete('t7')
    expect(adapter.canType!(pane('t7'))).toBe(false)
  })

  // Review Focus 5: two transcripts typed at once would mix in the agent's prompt.
  it('a second prompt to one terminal while one is under way is busy, and the client is asked once', async () => {
    const { adapter, prompt } = recorder()
    const first = held<HcPrompt>()
    prompt.mockReturnValueOnce(first.answer)
    const words = adapter.prompt('t7', 'claude', 'one')
    expect(await adapter.prompt('t7', 'claude', 'two')).toEqual({ outcome: 'busy' })
    expect(await adapter.prompt('t8', 'claude', 'three')).toEqual({ outcome: 'sent' })
    first.give({ outcome: 'sent' })
    expect(await words).toEqual({ outcome: 'sent' })
    expect(prompt.mock.calls).toEqual([['t7', 'claude', 'one'], ['t8', 'claude', 'three']])
  })

  it('a terminal takes words again after sent, busy and failed, each answered as the client answered', async () => {
    const { adapter, prompt } = recorder()
    const answers: HcPrompt[] = [{ outcome: 'sent' }, { outcome: 'busy' }, { outcome: 'failed', fault: 'timeout' }]
    for (const answer of answers) {
      prompt.mockResolvedValueOnce(answer)
      expect(await adapter.prompt('t7', 'codex', 'run the tests')).toEqual(answer)
    }
    expect(await adapter.prompt('t7', 'codex', 'run the tests')).toEqual({ outcome: 'sent' })
    expect(prompt).toHaveBeenCalledTimes(4)
  })

  // hc types by address, whatever the window shows.
  it('words and a tap do not wait for each other', async () => {
    const typing = recorder()
    const words = held<HcPrompt>()
    typing.prompt.mockReturnValueOnce(words.answer)
    const sending = typing.adapter.prompt('t7', 'claude', 'one')
    expect(await typing.adapter.focus(pane('t7'))).toBe(true)
    expect(typing.calls).toEqual([openCall, focusCall('t7')])
    words.give({ outcome: 'sent' })
    expect(await sending).toEqual({ outcome: 'sent' })

    const tapping = holding()
    const tap = tapping.adapter.focus(pane('t7'))
    expect(await tapping.adapter.prompt('t7', 'claude', 'two')).toEqual({ outcome: 'sent' })
    expect(tapping.prompt.mock.calls).toEqual([['t7', 'claude', 'two']])
    await tapping.answer(0)
    await tapping.answer(0)
    expect(await tap).toBe(true)
  })

  it('paneKey is herdr-app:<address>', () => {
    expect(recorder().adapter.paneKey(pane('t7'))).toBe('herdr-app:t7')
  })

  describe('scroll', () => {
    // The tally waits for a terminal's quiet second: the test moves the clock, never waits it out.
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
    afterEach(() => { vi.useRealTimers() })

    it('canScroll needs macOS, hc\'s form of address, Herdr in front, a terminal its window shows, and herdr-app found', () => {
      expect(recorder().adapter.canScroll(pane('t7'))).toBe(true)
      expect(recorder({ platform: 'linux' }).adapter.canScroll(pane('t7'))).toBe(false)
      for (const id of FORGED) expect(recorder().adapter.canScroll(pane(id)), id).toBe(false)
      expect(recorder({ inFront: () => false }).adapter.canScroll(pane('t7'))).toBe(false)
      expect(recorder({ shows: () => false }).adapter.canScroll(pane('t7'))).toBe(false)
      expect(recorder({ onPath: () => null }).adapter.canScroll(pane('t7'))).toBe(false)
      // Asked at every stroke's down: the PATH lookup runs only for a pane that passed the rest.
      const onPath = vi.fn(() => FAKE_PATH_HERDR_APP)
      expect(recorder({ onPath, shows: () => false }).adapter.canScroll(pane('t7'))).toBe(false)
      expect(onPath).not.toHaveBeenCalled()
    })

    it('scroll runs herdr-app do terminal.scroll with the terminal and the lines, each one argument, within 2 s', async () => {
      const { calls, adapter } = recorder()
      adapter.scroll(pane('t7'), -3)
      await turn()
      expect(calls).toEqual([scrollCall('t7', -3)])
      // Past the gap since that run started.
      vi.advanceTimersByTime(50)
      adapter.scroll(pane('t7'), 2)
      await turn()
      expect(calls).toEqual([scrollCall('t7', -3), scrollCall('t7', 2)])
      const app = recorder({ onPath: () => null, exists: (path) => path === APP_BINARY })
      app.adapter.scroll(pane('t7'), -3)
      await turn()
      expect(app.calls).toEqual([scrollCall('t7', -3, APP_BINARY)])
    })

    it('one run at a time: lines that come meanwhile are summed, and the next run carries them', async () => {
      const { calls, adapter, answer } = holding()
      adapter.scroll(pane('t7'), -3)
      adapter.scroll(pane('t7'), -2)
      adapter.scroll(pane('t7'), -4)
      await turn()
      expect(calls).toEqual([scrollCall('t7', -3)])
      // Past the gap, the run under way still holds the next.
      vi.advanceTimersByTime(50)
      await turn()
      expect(calls).toEqual([scrollCall('t7', -3)])
      await answer(0)
      expect(calls).toEqual([scrollCall('t7', -3), scrollCall('t7', -6)])
      await answer(0)
      expect(calls).toHaveLength(2)
    })

    it.each([-1, 1])('the pending count is clamped to 100 either way (%i)', async (sign) => {
      const { calls, adapter, answer } = holding()
      adapter.scroll(pane('t7'), sign)
      adapter.scroll(pane('t7'), 60 * sign)
      adapter.scroll(pane('t7'), 60 * sign)
      vi.advanceTimersByTime(50)
      await answer(0)
      expect(calls).toEqual([scrollCall('t7', sign), scrollCall('t7', 100 * sign)])
    })

    // Review Focus 1: most strokes wobble, and the lines that came meanwhile may sum to 0.
    it('lines that cancel while a run is under way run nothing more, and the queue drains', async () => {
      const { calls, log, adapter, answer } = holding()
      adapter.scroll(pane('t7'), -3)
      adapter.scroll(pane('t7'), -2)
      adapter.scroll(pane('t7'), 2)
      await answer(0)
      expect(calls).toEqual([scrollCall('t7', -3)])
      vi.advanceTimersByTime(1_000)
      expect(log).toEqual([drained(3, 1, 0)])
      adapter.scroll(pane('t7'), -1)
      expect(calls).toEqual([scrollCall('t7', -3), scrollCall('t7', -1)])
    })

    it('another terminal\'s lines run beside it', () => {
      const { calls, adapter } = holding()
      adapter.scroll(pane('t7'), -1)
      adapter.scroll(pane('t8'), -1)
      expect(calls).toEqual([scrollCall('t7', -1), scrollCall('t8', -1)])
    })

    // Diego's first check (2026-11-18) logged 109 runs for 161 lines in about 3 s: about 40 processes a second, each
    // carrying a line or two.
    it('lines every 10 ms start a run at most every 50 ms, each carrying the lines of its gap; a stroke\'s first starts at once', async () => {
      const { calls, adapter } = recorder()
      const runs: number[] = []
      for (let line = 0; line < 10; line++) {
        adapter.scroll(pane('t7'), -1)
        runs.push(calls.length)
        await vi.advanceTimersByTimeAsync(10)
      }
      // Runs at 0, 50 and 100 ms: the first line's at once, then each gap's lines summed.
      expect(runs).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2])
      expect(calls).toEqual([scrollCall('t7', -1), scrollCall('t7', -4), scrollCall('t7', -5)])
      // The next stroke's first run starts at once too.
      await vi.advanceTimersByTimeAsync(1_000)
      adapter.scroll(pane('t7'), 2)
      expect(calls).toEqual([scrollCall('t7', -1), scrollCall('t7', -4), scrollCall('t7', -5), scrollCall('t7', 2)])
    })

    it('another terminal does not wait for a terminal\'s gap', async () => {
      const { calls, adapter } = recorder()
      adapter.scroll(pane('t7'), -1)
      await turn()
      adapter.scroll(pane('t7'), -1)
      adapter.scroll(pane('t8'), -1)
      expect(calls).toEqual([scrollCall('t7', -1), scrollCall('t8', -1)])
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toEqual([scrollCall('t7', -1), scrollCall('t8', -1), scrollCall('t7', -1)])
    })

    // The devices stopping (devices.ts stop): a stroke Herdr took runs nothing more, whatever its queue holds then.
    it('once stopped, no run starts: neither the lines held for a gap, nor those behind a run under way, nor a new scroll\'s', async () => {
      const gap = recorder()
      gap.adapter.scroll(pane('t7'), -1)
      await turn()
      gap.adapter.scroll(pane('t7'), -2)
      gap.adapter.stop()
      await vi.advanceTimersByTimeAsync(5_000)
      gap.adapter.scroll(pane('t8'), -1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(gap.calls).toEqual([scrollCall('t7', -1)])

      const under = holding()
      under.adapter.scroll(pane('t7'), -1)
      under.adapter.scroll(pane('t7'), -2)
      await vi.advanceTimersByTimeAsync(50)
      under.adapter.stop()
      await under.answer(0)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(under.calls).toEqual([scrollCall('t7', -1)])
    })

    // A scroll that joined the focus run would lose its lines.
    it('a scroll during a focus of the same terminal runs on its own', async () => {
      const { calls, adapter, answer } = holding()
      const tap = adapter.focus(pane('t7'))
      expect(calls).toEqual([openCall])
      adapter.scroll(pane('t7'), -3)
      expect(calls).toEqual([openCall, scrollCall('t7', -3)])
      await answer(0)
      await answer(0)
      await answer(0)
      expect(await tap).toBe(true)
      expect(calls).toEqual([openCall, scrollCall('t7', -3), focusCall('t7')])
    })

    it.each([1, null])('a run that fails drops its lines and those pending, and says so once until a run succeeds (exit %s)', async (code) => {
      const { calls, log, adapter, answer } = holding()
      adapter.scroll(pane('t7'), -3)
      adapter.scroll(pane('t7'), -2)
      await answer(code)
      expect(calls).toEqual([scrollCall('t7', -3)])
      expect(scrollFailures(log)).toBe(1)
      // Each line past the gap since the run before started.
      vi.advanceTimersByTime(50)
      adapter.scroll(pane('t7'), -1)
      await answer(code)
      expect(calls).toEqual([scrollCall('t7', -3), scrollCall('t7', -1)])
      expect(scrollFailures(log)).toBe(1)
      vi.advanceTimersByTime(50)
      adapter.scroll(pane('t7'), -1)
      await answer(0)
      vi.advanceTimersByTime(50)
      adapter.scroll(pane('t7'), -1)
      await answer(code)
      expect(calls).toEqual([scrollCall('t7', -3), scrollCall('t7', -1), scrollCall('t7', -1), scrollCall('t7', -1)])
      expect(scrollFailures(log)).toBe(2)
    })

    it('with herdr-app gone nothing runs, and the lines are dropped', async () => {
      const { calls, log, adapter } = recorder({ onPath: () => null })
      adapter.scroll(pane('t7'), -3)
      await turn()
      adapter.scroll(pane('t7'), -1)
      adapter.scroll(pane('t8'), 2)
      await turn()
      expect(calls).toEqual([])
      expect(scrollFailures(log)).toBe(1)
    })

    // Review Focus 5: nobody awaits a scroll, so a rejection left unhandled would end the devices process.
    it('a run that rejects is a failed run', async () => {
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const calls: Call[] = []
        const { log, adapter } = recorder({
          run: async (file, args, timeoutMs) => {
            calls.push({ file, args, timeoutMs })
            if (calls.length === 1) throw new Error('spawn failed')
            return { code: 0, stdout: '' }
          },
        })
        adapter.scroll(pane('t7'), -3)
        await turn()
        vi.advanceTimersByTime(1_000)
        expect(log).toEqual([SCROLL_FAILED, drained(0, 1, 3)])
        adapter.scroll(pane('t7'), -2)
        await turn()
        expect(calls).toEqual([scrollCall('t7', -3), scrollCall('t7', -2)])
        await turn()
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })

    it('the drain line counts what the queue did, and names no terminal', async () => {
      const one = recorder()
      one.adapter.scroll(pane('t7'), -3)
      await turn()
      vi.advanceTimersByTime(1_000)
      expect(one.log).toEqual([drained(3, 1, 0)])

      const carried = holding()
      carried.adapter.scroll(pane('t7'), -3)
      carried.adapter.scroll(pane('t7'), -6)
      vi.advanceTimersByTime(50)
      await carried.answer(0)
      await carried.answer(0)
      vi.advanceTimersByTime(1_000)
      expect(carried.log).toEqual([drained(9, 2, 0)])

      const failing = holding()
      failing.adapter.scroll(pane('t7'), -3)
      failing.adapter.scroll(pane('t7'), -2)
      await failing.answer(1)
      vi.advanceTimersByTime(1_000)
      expect(failing.log).toEqual([SCROLL_FAILED, drained(0, 1, 5)])

      const none = recorder({ onPath: () => null })
      none.adapter.scroll(pane('t7'), -3)
      await turn()
      vi.advanceTimersByTime(1_000)
      expect(none.log).toEqual([SCROLL_FAILED, drained(0, 0, 3)])

      for (const line of [...one.log, ...carried.log, ...failing.log, ...none.log]) expect(line).not.toContain('t7')
    })

    // Final review: a run is faster than the dial's line, so a queue drains after almost every line it runs, and a line
    // said at each drain would be up to 20 a second while scrolling.
    it('the drain line waits for the terminal\'s quiet second: a stroke that drains after every line says one', async () => {
      const { calls, log, adapter } = recorder()
      // A line each 50 ms, the gap between two runs: each runs on its own.
      for (let move = 0; move < 30; move++) {
        adapter.scroll(pane('t7'), -1)
        await turn()
        vi.advanceTimersByTime(50)
      }
      expect(calls).toHaveLength(30)
      vi.advanceTimersByTime(1_000 - 50 - 1)
      expect(log).toEqual([])
      vi.advanceTimersByTime(1)
      expect(log).toEqual([drained(30, 30, 0)])
      // The next stroke counts from 0.
      adapter.scroll(pane('t7'), 2)
      await turn()
      vi.advanceTimersByTime(1_000)
      expect(log).toEqual([drained(30, 30, 0), drained(2, 1, 0)])
    })

    it('a run under way is no quiet, and each terminal has its own second', async () => {
      const { log, adapter, answer } = holding()
      adapter.scroll(pane('t7'), -3)
      vi.advanceTimersByTime(5_000)
      expect(log).toEqual([])
      await answer(0)
      adapter.scroll(pane('t8'), 2)
      vi.advanceTimersByTime(999)
      expect(log).toEqual([])
      vi.advanceTimersByTime(1)
      expect(log).toEqual([drained(3, 1, 0)])
      await answer(0)
      vi.advanceTimersByTime(1_000)
      expect(log).toEqual([drained(3, 1, 0), drained(2, 1, 0)])
    })

    it('a bad id or 0 lines runs nothing', async () => {
      const { calls, log, adapter } = recorder()
      for (const id of FORGED) adapter.scroll(pane(id), -3)
      adapter.scroll(pane('t7'), 0)
      await turn()
      expect(calls).toEqual([])
      expect(log).toEqual([])
    })

    // Review Focus 4: a garbled frame's travel (dy: 1e308) makes the lines -Infinity.
    it.each([NaN, Infinity, -Infinity, 1.5])('lines that are no whole number run nothing (%s)', async (lines) => {
      const { calls, log, adapter } = recorder()
      adapter.scroll(pane('t7'), lines)
      await turn()
      expect(calls).toEqual([])
      expect(log).toEqual([])
    })

    it('off macOS nothing scrolls', async () => {
      for (const platform of ['linux', 'win32'] as const) {
        const { calls, log, adapter } = recorder({ platform })
        expect(adapter.canScroll(pane('t7')), platform).toBe(false)
        adapter.scroll(pane('t7'), -3)
        await turn()
        expect(calls, platform).toEqual([])
        expect(log, platform).toEqual([])
      }
    })

    // Claude Code draws on the alternate screen, where Herdr's view has no history: its own page keys move it
    // (docs/plans/2026-11-17-dial-herdr-scroll-design.md §3).
    describe('a Claude Code terminal', () => {
      /** The recorder with Claude Code in t7 and Codex in t8, and the rest of [over]: each key call is recorded in
       *  `pressed`, and answers true, or when `held` waits until the test answers it. */
      const claudeCode = (held = false, over: Partial<HerdrAppDeps> = {}) => {
        const pressed: Array<[string, string[], number]> = []
        const waiting: Array<(pressed: boolean) => void> = []
        const rest = recorder({
          kindOf: (address) => (address === 't7' ? 'claude' : 'codex'),
          client: {
            prompt: async () => ({ outcome: 'sent' }),
            keys: async (address, keys, deadlineMs) => {
              pressed.push([address, [...keys], deadlineMs])
              return held ? new Promise<boolean>((resolve) => waiting.push(resolve)) : true
            },
          },
          ...over,
        })
        /** Answers the oldest key call still held, and lets what follows it run. */
        const answer = async (ok: boolean) => {
          waiting.shift()!(ok)
          await turn()
        }
        return { ...rest, pressed, answer }
      }
      /** A call of [count] keys, with 5 s: hc holds keys until 3 s after the person's own last key in Herdr's window,
       *  and presses them then even once their call was given up (measured 2026-11-18). */
      const press = (key: 'pageup' | 'pagedown', count: number): [string, string[], number] =>
        ['t7', Array<string>(count).fill(key), 5_000]

      it('canScroll is false while it asks, or while hc tells no status it knows; working, idle, done and error take the stroke, as another app\'s does whatever its status', () => {
        const can = (kind: string, status?: HcStatus) =>
          recorder({ kindOf: () => kind, statusOf: () => status }).adapter.canScroll(pane('t7'))
        expect(can('claude', 'blocked')).toBe(false)
        // A state hc adds later, or none heard since the subscription dropped (hcSource.ts statusOf), may be a question.
        expect(can('claude', undefined)).toBe(false)
        // hc presses at once while the program writes (measured 2026-11-18): a stroke over a working Claude Code is
        // not late.
        for (const status of ['working', 'idle', 'done', 'error'] as const) expect(can('claude', status), status).toBe(true)
        for (const status of ['blocked', 'working', undefined] as const) expect(can('codex', status), status).toBe(true)
      })

      // canScroll is asked at the stroke's down only: a question that comes up mid-stroke must stop its keys too.
      it('a Claude Code that begins to ask mid-stroke takes no key from then on: the lines that wait are dropped and counted failed', async () => {
        let state: HcStatus | undefined = 'working'
        const { pressed, log, adapter, answer } = claudeCode(true, { statusOf: () => state })
        adapter.scroll(pane('t7'), -20)
        adapter.scroll(pane('t7'), -40)
        expect(pressed).toEqual([press('pageup', 1)])
        // It asks while the first call is under way: the 40 lines that wait press nothing.
        state = 'blocked'
        await answer(true)
        await vi.advanceTimersByTimeAsync(50)
        expect(pressed).toEqual([press('pageup', 1)])
        // The rest of the stroke, and lines once hc tells no status it knows, press nothing either.
        adapter.scroll(pane('t7'), 60)
        await vi.advanceTimersByTimeAsync(50)
        state = undefined
        adapter.scroll(pane('t7'), 20)
        await vi.advanceTimersByTimeAsync(50)
        expect(pressed).toEqual([press('pageup', 1)])
        await vi.advanceTimersByTimeAsync(1_000)
        // Not a failure of hc's: no failed line, only the tally's count.
        expect(log).toEqual([drained(20, 1, 120)])

        // Answered, it takes the keys of a new stroke.
        state = 'working'
        adapter.scroll(pane('t7'), 20)
        await turn()
        expect(pressed).toEqual([press('pageup', 1), press('pagedown', 1)])
      })

      it('the check is made again right before each call: a page that waited for the gap is not pressed once it asks', async () => {
        let state: HcStatus = 'idle'
        const { pressed, log, adapter } = claudeCode(false, { statusOf: () => state })
        adapter.scroll(pane('t7'), 20)
        await turn()
        expect(pressed).toEqual([press('pagedown', 1)])
        // Held for the gap, then it asks before the gap ends.
        adapter.scroll(pane('t7'), 20)
        await turn()
        state = 'blocked'
        await vi.advanceTimersByTimeAsync(50)
        expect(pressed).toEqual([press('pagedown', 1)])
        await vi.advanceTimersByTimeAsync(1_000)
        expect(log).toEqual([drained(20, 1, 20)])
      })

      it('its lines press pageup or pagedown through hc, one a 20 lines, within 5 s, past hc\'s hold, and run no herdr-app; Codex\'s run terminal.scroll', async () => {
        const { calls, pressed, adapter } = claudeCode()
        adapter.scroll(pane('t7'), -20)
        await turn()
        expect(pressed).toEqual([press('pageup', 1)])
        // The gap holds the next call, as it holds a run.
        adapter.scroll(pane('t7'), 40)
        await turn()
        expect(pressed).toEqual([press('pageup', 1)])
        await vi.advanceTimersByTimeAsync(50)
        expect(pressed).toEqual([press('pageup', 1), press('pagedown', 2)])
        expect(calls).toEqual([])
        adapter.scroll(pane('t8'), -3)
        await turn()
        expect(calls).toEqual([scrollCall('t8', -3)])
        expect(pressed).toHaveLength(2)
      })

      it('lines short of a page wait for that terminal\'s next lines; its quiet second drops them, and its tally counts the lines its keys stood for', async () => {
        const { pressed, log, adapter } = claudeCode()
        adapter.scroll(pane('t7'), -15)
        await turn()
        expect(pressed).toEqual([])
        // 25 lines: a page, 5 kept.
        adapter.scroll(pane('t7'), -10)
        await turn()
        expect(pressed).toEqual([press('pageup', 1)])
        await vi.advanceTimersByTimeAsync(50)
        adapter.scroll(pane('t7'), -15)
        await turn()
        expect(pressed).toEqual([press('pageup', 1), press('pageup', 1)])
        adapter.scroll(pane('t7'), -15)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(log).toEqual([drained(40, 2, 0)])
        // The 15 went with the quiet second: 5 more are no page.
        adapter.scroll(pane('t7'), -5)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(pressed).toHaveLength(2)
        expect(log).toEqual([drained(40, 2, 0), drained(0, 0, 0)])
      })

      it('one call at a time: the lines that come meanwhile are summed, and the next call carries their pages', async () => {
        const { pressed, adapter, answer } = claudeCode(true)
        adapter.scroll(pane('t7'), -20)
        adapter.scroll(pane('t7'), -20)
        adapter.scroll(pane('t7'), 60)
        await vi.advanceTimersByTimeAsync(50)
        expect(pressed).toEqual([press('pageup', 1)])
        await answer(true)
        expect(pressed).toEqual([press('pageup', 1), press('pagedown', 2)])
        await answer(true)
        expect(pressed).toHaveLength(2)
      })

      it('at most 5 keys go in one call, and the lines that wait are clamped to 100', async () => {
        const { pressed, adapter } = claudeCode()
        adapter.scroll(pane('t7'), 300)
        await turn()
        expect(pressed).toEqual([press('pagedown', 5)])
        await vi.advanceTimersByTimeAsync(5_000)
        expect(pressed).toEqual([press('pagedown', 5), press('pagedown', 5)])

        const under = claudeCode(true)
        under.adapter.scroll(pane('t7'), -20)
        under.adapter.scroll(pane('t7'), -60)
        under.adapter.scroll(pane('t7'), -60)
        await vi.advanceTimersByTimeAsync(50)
        await under.answer(true)
        await under.answer(true)
        expect(under.pressed).toEqual([press('pageup', 1), press('pageup', 5)])
      })

      it('a refused or timed-out call drops its lines and those waiting, and says so once until a call succeeds', async () => {
        const { pressed, log, adapter, answer } = claudeCode(true)
        adapter.scroll(pane('t7'), -20)
        adapter.scroll(pane('t7'), -30)
        await answer(false)
        expect(pressed).toEqual([press('pageup', 1)])
        expect(log).toEqual([SCROLL_FAILED])
        await vi.advanceTimersByTimeAsync(50)
        adapter.scroll(pane('t7'), -20)
        await answer(false)
        expect(log).toEqual([SCROLL_FAILED])
        await vi.advanceTimersByTimeAsync(50)
        adapter.scroll(pane('t7'), -20)
        await answer(true)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(pressed).toEqual([press('pageup', 1), press('pageup', 1), press('pageup', 1)])
        expect(log).toEqual([SCROLL_FAILED, drained(20, 3, 70)])
      })

      // Review Focus 5: nobody awaits a scroll, so a rejection left unhandled would end the devices process.
      it('a call that rejects is a failed call', async () => {
        const unhandled = vi.fn()
        process.on('unhandledRejection', unhandled)
        try {
          const { log, adapter } = recorder({
            kindOf: () => 'claude',
            client: { prompt: async () => ({ outcome: 'sent' }), keys: async () => { throw new Error('socket broken') } },
          })
          adapter.scroll(pane('t7'), -20)
          await vi.advanceTimersByTimeAsync(1_000)
          expect(log).toEqual([SCROLL_FAILED, drained(0, 1, 20)])
          expect(unhandled).not.toHaveBeenCalled()
        } finally {
          process.off('unhandledRejection', unhandled)
        }
      })

      it('once stopped, no key is pressed', async () => {
        const { pressed, adapter } = claudeCode()
        adapter.scroll(pane('t7'), -20)
        await turn()
        adapter.scroll(pane('t7'), -20)
        adapter.stop()
        await vi.advanceTimersByTimeAsync(5_000)
        adapter.scroll(pane('t7'), -40)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(pressed).toEqual([press('pageup', 1)])
      })
    })
  })

  describe('onScreen', () => {
    it('onScreen runs herdr-app status within 2 s, and is true when its tab is the one that holds the pane\'s terminal', async () => {
      const { calls, log, adapter } = recorder({}, [], herdrAppStatus('tbaaaa'))
      expect(await adapter.onScreen(pane('t7'))).toBe(true)
      expect(calls).toEqual([statusCall])
      expect(log).toEqual([])
    })

    // Diego's first check (2026-11-18): with another tab shown, status's agent still named the agent of the tab before,
    // and a stroke ran 175 scrolls on a terminal nobody saw.
    it('a status whose agent is the pane\'s terminal but whose tab is another is false', async () => {
      const { calls, log, adapter } = recorder({}, [], herdrAppStatus('tbbbbb', 't7'))
      expect(await adapter.onScreen(pane('t7'))).toBe(false)
      expect(calls).toEqual([statusCall])
      expect(log).toEqual([])
    })

    // A layout with no tab block has no tab; a terminal hc labels with no tab is in none the window shows.
    it.each([
      ['another tab', {}, herdrAppStatus('tbbbbb')],
      ['a null tab', {}, herdrAppStatus(null)],
      ['no tab', {}, herdrAppStatus()],
      ['a tab that is no string', {}, statusWith({ tab: 7 })],
      ['an empty tab, as the terminal\'s label', { tabOf: () => '' }, herdrAppStatus('')],
      ['a terminal with no herdr.tab label', { tabOf: () => undefined }, herdrAppStatus('tbaaaa')],
      ['a terminal with no herdr.tab label, and no tab', { tabOf: () => undefined }, herdrAppStatus()],
    ] as Array<[string, Partial<HerdrAppDeps>, string]>)('%s is false, with one run and no line', async (_, over, stdout) => {
      const { calls, log, adapter } = recorder(over, [], stdout)
      expect(await adapter.onScreen(pane('t7'))).toBe(false)
      expect(calls).toEqual([statusCall])
      expect(log).toEqual([])
    })

    // A Herdr that changes what status prints must be seen.
    it.each([
      ['a stdout that is no JSON', {}, [], 'not json', 1],
      ['an array', {}, [], '[]', 1],
      ['null', {}, [], 'null', 1],
      ['a string', {}, [], '"tbaaaa"', 1],
      ['exit 1', {}, [1], herdrAppStatus('tbaaaa'), 1],
      ['no exit code', {}, [null], herdrAppStatus('tbaaaa'), 1],
      ['no binary', { onPath: () => null }, [], herdrAppStatus('tbaaaa'), 0],
    ] as Array<[string, Partial<HerdrAppDeps>, Array<number | null>, string, number]>)('%s is false, with the failed line', async (_, over, codes, stdout, runs) => {
      const { calls, log, adapter } = recorder(over, codes, stdout)
      expect(await adapter.onScreen(pane('t7'))).toBe(false)
      expect(calls).toEqual(Array(runs).fill(statusCall))
      expect(log).toEqual([STATUS_FAILED])
    })

    it('status · failed is said once until a read succeeds', async () => {
      const { log, adapter } = recorder({}, [1, 1, 0, 1], herdrAppStatus('tbaaaa'))
      expect(await adapter.onScreen(pane('t7'))).toBe(false)
      expect(await adapter.onScreen(pane('t7'))).toBe(false)
      expect(log).toEqual([STATUS_FAILED])
      expect(await adapter.onScreen(pane('t7'))).toBe(true)
      expect(await adapter.onScreen(pane('t7'))).toBe(false)
      expect(log).toEqual([STATUS_FAILED, STATUS_FAILED])
    })

    // The rest names the person's spaces and layouts, and its agent is not what is on screen.
    it('nothing but tab is read', async () => {
      const others = { space: 7, layout: null, overlays: 'x', agent: 't7' }
      expect(await recorder({}, [], statusWith({ ...others, tab: 'tbaaaa' })).adapter.onScreen(pane('t7'))).toBe(true)
      const { log, adapter } = recorder({}, [], statusWith({ ...others, tab: 'tbbbbb' }))
      expect(await adapter.onScreen(pane('t7'))).toBe(false)
      expect(log).toEqual([])
    })

    // Review Focus 2: a dial may send down after down faster than status answers.
    it('asks while a read is under way are that one read, each answered for its own pane', async () => {
      const { calls, adapter, answer } = holding()
      const seven = adapter.onScreen(pane('t7'))
      const eight = adapter.onScreen(pane('t8'))
      await turn()
      expect(calls).toEqual([statusCall])
      await answer(0, herdrAppStatus('tbaaaa'))
      expect(await seven).toBe(true)
      expect(await eight).toBe(false)
      const again = adapter.onScreen(pane('t8'))
      await turn()
      expect(calls).toEqual([statusCall, statusCall])
      await answer(0, herdrAppStatus('tbbbbb'))
      expect(await again).toBe(true)
    })

    // Review Focus 5.
    it('a read that rejects is false', async () => {
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const { log, adapter } = recorder({ run: async () => { throw new Error('spawn failed') } })
        expect(await adapter.onScreen(pane('t7'))).toBe(false)
        expect(log).toEqual([STATUS_FAILED])
        await turn()
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })

    it('a bad id asks nothing; off macOS nothing is asked', async () => {
      const { calls, log, adapter } = recorder({}, [], herdrAppStatus('tbaaaa'))
      for (const id of FORGED) expect(await adapter.onScreen(pane(id)), id).toBe(false)
      expect(calls).toEqual([])
      expect(log).toEqual([])
      for (const platform of ['linux', 'win32'] as const) {
        const other = recorder({ platform }, [], herdrAppStatus('tbaaaa'))
        expect(await other.adapter.onScreen(pane('t7')), platform).toBe(false)
        expect(other.calls, platform).toEqual([])
        expect(other.log, platform).toEqual([])
      }
    })
  })
})
