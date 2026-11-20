import { describe, expect, it, vi } from 'vitest'
import { REFUSED, type ListenerStream, type StreamEnd } from '../../services/devicesListener.js'
import type { PageAgent } from './adapter.js'
import { PS_TIMEOUT_MS, type Exec } from './scannedApp.js'
import { setProcessTableSource, type ProcessRow } from '../../lib/processTable.js'
import {
  CHAIN_RETRY_MS, GROUPS_MAX_BYTES, readForeground, readProcessParents, VSCODE_GUARD_MS, VSCODE_OPEN_MAX_BYTES, VSCODE_OPEN_PER_SECOND,
  VSCODE_SCROLL_MAX, VSCODE_STATE_MAX_BYTES, VSCODE_STATE_PER_SECOND, VSCODE_TERMINALS, VSCODE_WINDOWS, vscodeStreams,
  type ProcessGroups, type VscodeTerminalsDeps,
} from './vscodeTerminals.js'

const W1 = 'window-1'
const W2 = 'window-2'
/** pid and parent: VS Code's helper 600, the shell 700 it started for a terminal, a node 800 in it, the agent 900. */
const TREE: ReadonlyArray<readonly [number, number]> = [[600, 1], [700, 600], [800, 700], [900, 800]]
/** A second terminal's shell 710 under the same helper, and its agent 910. */
const SECOND: ReadonlyArray<readonly [number, number]> = [[710, 600], [910, 710]]
/** A Claude Code agent the page guard is asked of: not asking, in its own folder. */
const AGENT: PageAgent = { asking: false, cwd: '/work/api' }

/** A stream as the listener hands one to open: it takes no line until the listener says it is ready, then one at a
 *  time, each in flight until the test drains it. */
function fakeStream() {
  const ended = new AbortController()
  const lines: unknown[] = []
  let run = (): void => {}
  let writable = false
  const stream: ListenerStream = {
    write: (line) => {
      if (!writable) return false
      writable = false
      lines.push(line)
      return true
    },
    onWritable: (listener) => { run = listener },
    ended: ended.signal,
  }
  return {
    stream,
    lines,
    drain: () => {
      writable = true
      run()
    },
    end: (reason: StreamEnd) => ended.abort(reason),
  }
}

/** The windows, with a `ps` that answers only when the test says, from a table the test sets; settings that draw every
 *  folder fullscreen unless the test says otherwise; a foreground read that answers only when the test says; a clock the
 *  test moves; each timer kept, and whether it was cancelled, to be run by hand; and every line logged. */
function harness(table: ReadonlyArray<readonly [number, number]> = TREE) {
  let at = 0
  const reads: Array<{ resolve(rows: Array<{ pid: number; ppid: number }>): void; reject(error: Error): void }> = []
  const groupReads: Array<{ resolve(groups: ProcessGroups | undefined): void; reject(error: Error): void }> = []
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = []
  const logged: string[] = []
  const processes = vi.fn<VscodeTerminalsDeps['processes']>(() => new Promise((resolve, reject) => { reads.push({ resolve, reject }) }))
  const changed = vi.fn<VscodeTerminalsDeps['changed']>()
  const fullscreen = vi.fn<VscodeTerminalsDeps['fullscreen']>(async () => true)
  const foreground = vi.fn<VscodeTerminalsDeps['foreground']>(() => new Promise((resolve, reject) => { groupReads.push({ resolve, reject }) }))
  const terminals = vscodeStreams({
    processes,
    changed,
    fullscreen,
    foreground,
    now: () => at,
    after: (ms, run) => {
      const timer = { ms, run, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    log: (line) => { logged.push(line) },
  })
  const { vscode, 'vscode-state': report } = terminals.handlers
  /** The read in flight's result, landed. */
  const landed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  return {
    terminals,
    processes,
    changed,
    fullscreen,
    foreground,
    timers,
    logged,
    landed,
    tick: (ms: number) => { at += ms },
    /** A window's stream opened, as the listener opens it: then ready for a line. */
    open: (window: string) => {
      const opened = fakeStream()
      expect(vscode.open({ type: 'vscode', window }, opened.stream)).toBeUndefined()
      opened.drain()
      return opened
    },
    state: (window: string, shells: unknown, over: Record<string, unknown> = {}) =>
      report.handle({ type: 'vscode-state', window, terminals: shells, active: null, focused: true, ...over }, new AbortController().signal),
    answer: async (rows = table) => {
      reads.shift()!.resolve(rows.map(([pid, ppid]) => ({ pid, ppid })))
      await landed()
    },
    fail: async () => {
      reads.shift()!.reject(new Error('process table not read'))
      await landed()
    },
    /** The oldest foreground read in flight, landed with that answer. */
    groups: async (groups: ProcessGroups | undefined) => {
      groupReads.shift()!.resolve(groups)
      await landed()
    },
    groupsFail: async () => {
      groupReads.shift()!.reject(new Error('ps not read'))
      await landed()
    },
    /** An ask's own deadline, the `nth` armed: the latest unless the test says. */
    deadline: (nth = -1) => timers.filter(({ ms }) => ms === VSCODE_GUARD_MS).at(nth)!,
    /** The guard's counts in the minute's line, its timer run by hand. */
    guardCounts: () => {
      timers.find(({ ms }) => ms === 60_000)!.run()
      return logged.at(-1)!.split(' dropped, ')[1]
    },
  }
}

/** The harness with the agents 900 and 910 in W1's terminals, of the shells 700 and 710: the page guard reads each
 *  one's foreground through its terminal's shell. */
async function placed() {
  const h = harness([...TREE, ...SECOND])
  h.open(W1)
  h.terminals.agents([900, 910])
  h.state(W1, [700, 710])
  await h.answer()
  return h
}

describe('VS Code\'s windows', () => {
  it('the vscode stream is keyed by its window, eight at once, 96 bytes, one a second', () => {
    const { vscode } = harness().terminals.handlers
    expect(vscode).toMatchObject({ maxBytes: VSCODE_OPEN_MAX_BYTES, perSecond: VSCODE_OPEN_PER_SECOND, keyed: { limit: VSCODE_WINDOWS } })
    expect([VSCODE_OPEN_MAX_BYTES, VSCODE_OPEN_PER_SECOND, VSCODE_WINDOWS]).toEqual([96, 1, 8])
    for (const window of [W1, 'A-b-C-1-2', 'a'.repeat(8), '5f3a9c2e-1b7d-4e8a-9c0f-2d6b8e4a7c13']) {
      expect(vscode.keyed!.key({ type: 'vscode', window })).toBe(window)
    }
    // Its longest message, at an id of 36, fits.
    expect(Buffer.byteLength(JSON.stringify({ type: 'vscode', window: 'a'.repeat(36) }))).toBe(65)
  })

  it('a window id of another form is refused', () => {
    const { vscode } = harness().terminals.handlers
    for (const window of ['a'.repeat(7), 'a'.repeat(37), 'window/1', 'window_1', 'window 1', 12345678, undefined, null, [W1]]) {
      expect(vscode.keyed!.key({ type: 'vscode', window }), String(window)).toBe(REFUSED)
    }
  })

  it('a state is 1 KiB at most, eight a second: 32 terminals of the largest pid fit', () => {
    const { 'vscode-state': report } = harness().terminals.handlers
    expect(report).toMatchObject({ maxBytes: VSCODE_STATE_MAX_BYTES, perSecond: VSCODE_STATE_PER_SECOND })
    expect([VSCODE_STATE_MAX_BYTES, VSCODE_STATE_PER_SECOND, VSCODE_TERMINALS]).toEqual([1024, 8, 32])
    const largest = {
      type: 'vscode-state', window: 'a'.repeat(36), terminals: Array.from({ length: 32 }, (_, i) => 2 ** 31 - 1 - i), active: 2 ** 31 - 1, focused: false,
    }
    expect(Buffer.byteLength(JSON.stringify(largest))).toBe(473)
  })

  it.each<[string, Record<string, unknown>]>([
    ['its window is not open', { window: 'window-9' }],
    ['its window is of another form', { window: 'win/1' }],
    ['its window is missing', { window: undefined }],
    ['terminals is not an array', { terminals: 700 }],
    ['it lists 33 terminals', { terminals: Array.from({ length: 33 }, (_, i) => 700 + i) }],
    ['it lists a pid twice', { terminals: [700, 700] }],
    ['it lists pid 1', { terminals: [1, 700] }],
    ['it lists pid 2^31', { terminals: [700, 2 ** 31] }],
    ['it lists a fraction', { terminals: [700.5] }],
    ['it lists a pid as a string', { terminals: ['700'] }],
    ['active is not among its terminals', { active: 710 }],
    ['active is missing', { active: undefined }],
    ['focused is not a boolean', { focused: 'yes' }],
  ])('a state is refused when %s, and counted in the minute\'s line', (_, over) => {
    const h = harness()
    h.open(W1)
    h.terminals.agents([900])
    expect(h.state(W1, [700], over)).toBe(REFUSED)
    // Nothing was taken: no window holds a state, so the agent asks no read.
    expect(h.processes).not.toHaveBeenCalled()
    expect(h.timers.map(({ ms }) => ms)).toEqual([60_000])
    h.timers[0]!.run()
    expect(h.logged.at(-1)).toBe('[devices] vscode · in the last minute: 0 shows, 0 taps, 1 refused states, 0 ps reads, 0 failed, 0 scroll lines, 0 dropped, 0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 0 ps, 0 slow')
    // The same state in its form is taken.
    expect(h.state(W1, [700])).toBeUndefined()
    expect(h.processes).toHaveBeenCalledTimes(1)
  })

  it('a state with a field it does not know is taken', async () => {
    const h = harness()
    h.open(W1)
    h.terminals.agents([900])
    expect(h.state(W1, [700], { active: 700, focused: false, title: 'build', more: { a: 1 } })).toBeUndefined()
    await h.answer()
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 700 })
  })

  it('a shell several levels up is the agent\'s terminal', async () => {
    const h = harness()
    h.open(W1)
    h.terminals.agents([900])
    // The nearest of its chain that a window lists: never VS Code's helper above the shell.
    h.state(W1, [600, 700])
    await h.answer()
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 700 })
  })

  it('an agent that is its terminal\'s own process is matched', async () => {
    const h = harness()
    h.open(W1)
    h.terminals.agents([900])
    h.state(W1, [900])
    await h.answer()
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 900 })
  })

  it('a pid in no window has no terminal', async () => {
    const h = harness()
    h.open(W1)
    h.terminals.agents([900])
    h.state(W1, [555])
    await h.answer()
    expect(h.terminals.terminalOf(900)).toBeUndefined()
    // Nor one never listed.
    expect(h.terminals.terminalOf(555)).toBeUndefined()
  })

  it('two windows listing one shell: the one that reported last holds it', async () => {
    const h = harness()
    const one = h.open(W1)
    h.open(W2)
    h.terminals.agents([900])
    h.state(W1, [700])
    await h.answer()
    h.state(W2, [700])
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W2, shell: 700 })
    h.state(W1, [710, 700])
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 700 })
    // The one that reported last going leaves the shell to the other.
    one.end('gone')
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W2, shell: 700 })
  })

  it('a reused window id: the newer stream\'s state stands, and the older stream ending after it drops nothing', async () => {
    const h = harness()
    const older = h.open(W1)
    h.terminals.agents([900])
    h.state(W1, [700])
    await h.answer()
    const newer = h.open(W1)
    // The newer stream starts with no state: its extension sends one as it opens.
    expect(h.terminals.terminalOf(900)).toBeUndefined()
    h.state(W1, [700])
    older.end('replaced')
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 700 })
    expect(h.terminals.show({ window: W1, shell: 700 }, false)).toBe(true)
    expect(newer.lines).toEqual([{ show: 700 }])
    expect(older.lines).toEqual([])
  })

  it('with no window open, an agent asks no read', () => {
    const h = harness()
    h.terminals.agents([900, 910])
    // A window open with no state yet asks none either.
    h.open(W1)
    h.terminals.agents([900, 910, 920])
    expect(h.processes).not.toHaveBeenCalled()
  })

  it('a window that opens after the agents were listed gives them their terminals with one read', async () => {
    const h = harness([...TREE, ...SECOND])
    h.terminals.agents([900, 910])
    h.open(W1)
    h.state(W1, [700, 710])
    expect(h.processes).toHaveBeenCalledTimes(1)
    await h.answer()
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 700 })
    expect(h.terminals.terminalOf(910)).toStrictEqual({ window: W1, shell: 710 })
    expect(h.processes).toHaveBeenCalledTimes(1)
    // The dials are told to look once, for both.
    expect(h.changed).toHaveBeenCalledTimes(1)
  })

  it('one read serves every agent with no chain; one that appears during it is read once more, after it; reads never overlap', async () => {
    const h = harness([...TREE, ...SECOND, [720, 600], [920, 720]])
    h.open(W1)
    h.state(W1, [700, 710, 720])
    h.terminals.agents([900, 910])
    expect(h.processes).toHaveBeenCalledTimes(1)
    h.terminals.agents([900, 910, 920])
    h.state(W1, [700, 710, 720])
    expect(h.processes).toHaveBeenCalledTimes(1)
    // The read began before 920 was listed, so its table says nothing of 920, even one that holds it.
    await h.answer()
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 700 })
    expect(h.terminals.terminalOf(910)).toStrictEqual({ window: W1, shell: 710 })
    expect(h.terminals.terminalOf(920)).toBeUndefined()
    expect(h.processes).toHaveBeenCalledTimes(2)
    await h.answer()
    expect(h.terminals.terminalOf(920)).toStrictEqual({ window: W1, shell: 720 })
    expect(h.processes).toHaveBeenCalledTimes(2)
  })

  it('a state while every agent has its chain asks no read', async () => {
    const h = harness()
    h.open(W1)
    h.terminals.agents([900])
    h.state(W1, [700])
    await h.answer()
    // A new shell with no agent in it, in this window and another.
    h.state(W1, [700, 750])
    h.open(W2)
    h.state(W2, [760])
    expect(h.processes).toHaveBeenCalledTimes(1)
  })

  it('a read that fails is asked again by the next state or agent, no sooner than 5 s an agent', async () => {
    const h = harness([...TREE, ...SECOND])
    h.open(W1)
    h.terminals.agents([900])
    h.state(W1, [700, 710])
    await h.fail()
    expect(h.terminals.terminalOf(900)).toBeUndefined()
    h.tick(CHAIN_RETRY_MS - 1)
    h.state(W1, [700, 710])
    h.terminals.agents([900])
    expect(h.processes).toHaveBeenCalledTimes(1)
    // A new agent asks a read of its own: the one that failed is not in it.
    h.terminals.agents([900, 910])
    expect(h.processes).toHaveBeenCalledTimes(2)
    await h.answer()
    expect(h.terminals.terminalOf(910)).toStrictEqual({ window: W1, shell: 710 })
    expect(h.terminals.terminalOf(900)).toBeUndefined()
    h.tick(1)
    h.state(W1, [700, 710])
    expect(h.processes).toHaveBeenCalledTimes(3)
    // A table that does not hold the agent fails it too, from the read's start, not its end.
    h.tick(1_000)
    await h.answer([[600, 1], [700, 600]])
    expect(h.terminals.terminalOf(900)).toBeUndefined()
    h.tick(CHAIN_RETRY_MS - 1_000 - 1)
    h.state(W1, [700, 710])
    expect(h.processes).toHaveBeenCalledTimes(3)
    h.tick(1)
    h.state(W1, [700, 710])
    expect(h.processes).toHaveBeenCalledTimes(4)
    await h.answer()
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 700 })
  })

  it('an agent that left drops its chain: its pid, reused, is read anew', async () => {
    const h = harness()
    h.open(W1)
    h.terminals.agents([900])
    h.state(W1, [700, 710])
    await h.answer()
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 700 })
    h.terminals.agents([])
    expect(h.terminals.terminalOf(900)).toBeUndefined()
    // The pid now names another process, in another terminal.
    h.terminals.agents([900])
    expect(h.processes).toHaveBeenCalledTimes(2)
    await h.answer([[600, 1], [710, 600], [900, 710]])
    expect(h.terminals.terminalOf(900)).toStrictEqual({ window: W1, shell: 710 })

    // One that left during its read keeps nothing of it.
    h.terminals.agents([900, 910])
    expect(h.processes).toHaveBeenCalledTimes(3)
    h.terminals.agents([900])
    await h.answer([...TREE, ...SECOND])
    expect(h.terminals.terminalOf(910)).toBeUndefined()
    h.terminals.agents([900, 910])
    expect(h.processes).toHaveBeenCalledTimes(4)
    // One whose read failed, gone and back within 5 s, is read anew too.
    await h.fail()
    h.terminals.agents([900])
    h.terminals.agents([900, 910])
    expect(h.processes).toHaveBeenCalledTimes(5)
    await h.answer([...TREE, ...SECOND])
    expect(h.terminals.terminalOf(910)).toStrictEqual({ window: W1, shell: 710 })
  })

  it('changed is told once when a state gives an agent its terminal, once when its window\'s stream ends, and not otherwise', async () => {
    const h = harness()
    const one = h.open(W1)
    // 4242 is in no table: it never has a chain.
    h.terminals.agents([900, 4242])
    h.state(W1, [555])
    await h.answer()
    h.open(W2)
    h.state(W2, [556])
    expect(h.changed).not.toHaveBeenCalled()
    h.state(W1, [555, 700])
    expect(h.changed).toHaveBeenCalledTimes(1)
    // The same answer again, another window's shell, a show, an agent with no terminal leaving: nothing changed.
    h.state(W1, [700, 555])
    h.state(W2, [556, 557])
    h.terminals.show({ window: W1, shell: 700 }, true)
    h.terminals.agents([900])
    expect(h.changed).toHaveBeenCalledTimes(1)
    one.end('gone')
    expect(h.changed).toHaveBeenCalledTimes(2)
    expect(h.terminals.terminalOf(900)).toBeUndefined()
    // An agent with a terminal leaving: the list that dropped it is the devices' own.
    h.open(W1)
    h.state(W1, [700])
    expect(h.changed).toHaveBeenCalledTimes(3)
    h.terminals.agents([])
    expect(h.changed).toHaveBeenCalledTimes(3)
  })

  it('a show is written at once on a writable stream; while a line drains the latest waits, and replaces an earlier one', () => {
    const h = harness()
    const one = h.open(W1)
    expect(h.terminals.show({ window: W1, shell: 700 }, true)).toBe(true)
    expect(one.lines).toEqual([{ show: 700, raise: true }])
    expect(h.terminals.show({ window: W1, shell: 710 }, false)).toBe(true)
    expect(h.terminals.show({ window: W1, shell: 720 }, false)).toBe(true)
    expect(one.lines).toEqual([{ show: 700, raise: true }])
    one.drain()
    expect(one.lines).toEqual([{ show: 700, raise: true }, { show: 720 }])
    one.drain()
    expect(one.lines).toEqual([{ show: 700, raise: true }, { show: 720 }])
  })

  it('a tap\'s show asks for the window, a rest\'s does not', () => {
    const h = harness()
    const one = h.open(W1)
    h.terminals.show({ window: W1, shell: 700 }, false)
    expect(one.lines).toEqual([{ show: 700 }])
    // While a line drains, the tap that waits keeps its ask, and so does a rest after it on the same shell.
    h.terminals.show({ window: W1, shell: 710 }, true)
    h.terminals.show({ window: W1, shell: 710 }, false)
    one.drain()
    expect(one.lines).toEqual([{ show: 700 }, { show: 710, raise: true }])
    // A rest on another shell replaces both.
    h.terminals.show({ window: W1, shell: 720 }, true)
    h.terminals.show({ window: W1, shell: 730 }, false)
    one.drain()
    expect(one.lines).toEqual([{ show: 700 }, { show: 710, raise: true }, { show: 730 }])
  })

  it('show answers false once the window\'s stream has ended', () => {
    const h = harness()
    const one = h.open(W1)
    expect(h.terminals.show({ window: W2, shell: 700 }, true)).toBe(false)
    one.end('stalled')
    expect(h.terminals.show({ window: W1, shell: 700 }, true)).toBe(false)
    expect(one.lines).toEqual([])
  })

  it('whole lines are written at once on a writable stream, with the shell\'s pid', () => {
    const h = harness()
    const one = h.open(W1)
    expect(h.terminals.scroll({ window: W1, shell: 700 }, -3)).toBe(true)
    expect(one.lines).toEqual([{ scroll: -3, pid: 700 }])
    one.drain()
    // No line is 0: none is written, and none waits.
    expect(h.terminals.scroll({ window: W1, shell: 700 }, 0)).toBe(true)
    one.drain()
    expect(one.lines).toEqual([{ scroll: -3, pid: 700 }])
  })

  it('lines that cannot be written yet are added to the next line, 100 at most, the rest after it', () => {
    expect(VSCODE_SCROLL_MAX).toBe(100)
    const h = harness()
    const one = h.open(W1)
    const terminal = { window: W1, shell: 700 }
    h.terminals.scroll(terminal, -3)
    h.terminals.scroll(terminal, -60)
    h.terminals.scroll(terminal, -75)
    h.terminals.scroll(terminal, 5)
    expect(one.lines).toEqual([{ scroll: -3, pid: 700 }])
    one.drain()
    expect(one.lines.at(-1)).toEqual({ scroll: -100, pid: 700 })
    // Lines that come while the rest waits are added to it.
    h.terminals.scroll(terminal, 200)
    one.drain()
    expect(one.lines.at(-1)).toEqual({ scroll: 100, pid: 700 })
    one.drain()
    expect(one.lines.at(-1)).toEqual({ scroll: 70, pid: 700 })
    one.drain()
    expect(one.lines).toHaveLength(4)
    // Lines that wait and add up to none write none.
    h.terminals.scroll(terminal, -1)
    h.terminals.scroll(terminal, -2)
    h.terminals.scroll(terminal, 2)
    one.drain()
    expect(one.lines).toHaveLength(5)
  })

  it('a show that waits is written before the scroll', () => {
    const h = harness()
    const one = h.open(W1)
    h.terminals.show({ window: W1, shell: 700 }, true)
    h.terminals.scroll({ window: W1, shell: 710 }, 2)
    h.terminals.show({ window: W1, shell: 710 }, false)
    one.drain()
    expect(one.lines).toEqual([{ show: 700, raise: true }, { show: 710 }])
    one.drain()
    expect(one.lines).toEqual([{ show: 700, raise: true }, { show: 710 }, { scroll: 2, pid: 710 }])
  })

  it('lines for another shell replace what waits, and that is counted dropped', () => {
    const h = harness()
    const one = h.open(W1)
    h.terminals.scroll({ window: W1, shell: 700 }, -1)
    h.terminals.scroll({ window: W1, shell: 700 }, -5)
    h.terminals.scroll({ window: W1, shell: 710 }, 2)
    one.drain()
    expect(one.lines).toEqual([{ scroll: -1, pid: 700 }, { scroll: 2, pid: 710 }])
    // A line already written is not what waits: the next shell's lines drop nothing.
    h.terminals.scroll({ window: W1, shell: 700 }, 1)
    one.drain()
    expect(h.timers.map(({ ms }) => ms)).toEqual([60_000])
    h.timers[0]!.run()
    expect(h.logged.at(-1)).toBe('[devices] vscode · in the last minute: 0 shows, 0 taps, 0 refused states, 0 ps reads, 0 failed, 3 scroll lines, 1 dropped, 0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 0 ps, 0 slow')
  })

  it('page lines are written with "page":true, and plain lines carry no page', () => {
    const h = harness()
    const one = h.open(W1)
    const terminal = { window: W1, shell: 700 }
    h.terminals.scroll(terminal, -45, true)
    one.drain()
    h.terminals.scroll(terminal, -3)
    expect(one.lines).toEqual([{ scroll: -45, pid: 700, page: true }, { scroll: -3, pid: 700 }])
  })

  it('page and plain lines that wait are never merged: each adds to its own kind, and the kind that waited first is written first', () => {
    const h = harness()
    const one = h.open(W1)
    const terminal = { window: W1, shell: 700 }
    // Written: the stream now has a line in flight, and what follows waits.
    h.terminals.scroll(terminal, -1, true)
    h.terminals.scroll(terminal, -30, true)
    h.terminals.scroll(terminal, -3)
    h.terminals.scroll(terminal, -10, true)
    h.terminals.scroll(terminal, -2)
    one.drain()
    one.drain()
    one.drain()
    expect(one.lines).toEqual([{ scroll: -1, pid: 700, page: true }, { scroll: -40, pid: 700, page: true }, { scroll: -5, pid: 700 }])
  })

  it('page lines that wait are held to 100', () => {
    const h = harness()
    const one = h.open(W1)
    const terminal = { window: W1, shell: 700 }
    h.terminals.scroll(terminal, -1, true)
    h.terminals.scroll(terminal, -90, true)
    h.terminals.scroll(terminal, -90, true)
    one.drain()
    one.drain()
    expect(one.lines).toEqual([{ scroll: -1, pid: 700, page: true }, { scroll: -100, pid: 700, page: true }])
  })

  it('lines for another shell replace both kinds that wait, each counted dropped', () => {
    const h = harness()
    const one = h.open(W1)
    h.terminals.scroll({ window: W1, shell: 700 }, -1)
    h.terminals.scroll({ window: W1, shell: 700 }, -5, true)
    h.terminals.scroll({ window: W1, shell: 700 }, -5)
    h.terminals.scroll({ window: W1, shell: 710 }, 2)
    one.drain()
    one.drain()
    expect(one.lines).toEqual([{ scroll: -1, pid: 700 }, { scroll: 2, pid: 710 }])
    h.timers[0]!.run()
    expect(h.logged.at(-1)).toContain(', 2 dropped')
  })

  it('scroll answers false once the window\'s stream has ended, and what waited is gone', () => {
    const h = harness()
    const one = h.open(W1)
    expect(h.terminals.scroll({ window: W2, shell: 700 }, -1)).toBe(false)
    h.terminals.scroll({ window: W1, shell: 700 }, -1)
    h.terminals.scroll({ window: W1, shell: 700 }, -4)
    one.end('stalled')
    expect(h.terminals.scroll({ window: W1, shell: 700 }, -1)).toBe(false)
    expect(one.lines).toEqual([{ scroll: -1, pid: 700 }])
    // The window's next stream starts with nothing waiting.
    const next = h.open(W1)
    expect(next.lines).toEqual([])
  })

  it('the log holds counts and fixed words: no pid, no window id and no read\'s error', async () => {
    const h = harness([...TREE, ...SECOND])
    const id = '5f3a9c2e-1b7d-4e8a-9c0f-2d6b8e4a7c13'
    const older = h.open(id)
    h.terminals.agents([900])
    h.state(id, [700])
    await h.answer()
    const terminal = h.terminals.terminalOf(900)!
    h.terminals.show(terminal, true)
    h.terminals.show(terminal, false)
    h.state(id, 'x')
    // One timer for the minute, from its first event.
    expect(h.timers.map(({ ms }) => ms)).toEqual([60_000])
    h.timers[0]!.run()
    const newer = h.open(id)
    older.end('replaced')
    h.state(id, [700, 710])
    // A read that fails is counted apart from the ones that read the table.
    h.terminals.agents([900, 910])
    await h.fail()
    h.terminals.show(terminal, false)
    expect(h.timers.map(({ ms }) => ms)).toEqual([60_000, 60_000])
    h.timers[1]!.run()
    newer.end('gone')
    expect(h.logged).toEqual([
      '[devices] vscode stream · open · windows 1',
      '[devices] vscode · in the last minute: 1 shows, 1 taps, 1 refused states, 1 ps reads, 0 failed, 0 scroll lines, 0 dropped, 0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 0 ps, 0 slow',
      '[devices] vscode stream · open · windows 1',
      '[devices] vscode stream · ended · replaced · windows 1',
      '[devices] vscode · in the last minute: 1 shows, 0 taps, 0 refused states, 1 ps reads, 1 failed, 0 scroll lines, 0 dropped, 0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 0 ps, 0 slow',
      '[devices] vscode stream · ended · gone · windows 0',
    ])
    for (const line of h.logged) expect(line).not.toMatch(/900|910|700|710|5f3a|process table/)
  })

  it('a fullscreen agent in its VS Code terminal\'s foreground group may take page keys: its folder read, then one ps, for its pid and its terminal\'s shell', async () => {
    const h = await placed()
    const answer = h.terminals.pageKeys(900, AGENT)
    expect(h.fullscreen.mock.calls).toEqual([['/work/api', undefined]])
    // The ps waits on the settings: a session they do not draw fullscreen costs none.
    expect(h.foreground).not.toHaveBeenCalled()
    await h.landed()
    expect(h.foreground.mock.calls).toEqual([[900, 700]])
    await h.groups({ pgid: 900, tpgid: 900 })
    expect(await answer).toBe(true)
    expect(h.guardCounts()).toBe('1 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 0 ps, 0 slow')
  })

  it('the agent\'s transcript path goes to the renderer read with its folder, as given', () => {
    const h = harness()
    void h.terminals.pageKeys(900, { ...AGENT, transcriptPath: '/o/home/projects/-work-api/s1.jsonl' })
    // Its shape is claudeRenderer.ts's to judge, not the guard's.
    expect(h.fullscreen.mock.calls).toEqual([['/work/api', '/o/home/projects/-work-api/s1.jsonl']])
  })

  it('an agent that asks is refused at once, with nothing read', () => {
    const h = harness()
    expect(h.terminals.pageKeys(900, { ...AGENT, asking: true })).toBe(false)
    expect([h.fullscreen.mock.calls, h.foreground.mock.calls]).toEqual([[], []])
    // No deadline is armed: only the minute's timer.
    expect(h.timers.map(({ ms }) => ms)).toEqual([60_000])
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 0 renderer, 1 asking, 0 background, 0 ps, 0 slow')
  })

  it.each([undefined, 'work/api'])('a folder of %s is refused renderer at once, with nothing read', (cwd) => {
    const h = harness()
    // The project's settings, which outrank the user's, cannot be found.
    expect(h.terminals.pageKeys(900, { asking: false, ...(cwd === undefined ? {} : { cwd }) })).toBe(false)
    expect([h.fullscreen.mock.calls, h.foreground.mock.calls]).toEqual([[], []])
    expect(h.timers.map(({ ms }) => ms)).toEqual([60_000])
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 1 renderer, 0 asking, 0 background, 0 ps, 0 slow')
  })

  it('settings that do not say fullscreen are refused renderer, and ps is not run', async () => {
    const h = harness()
    h.fullscreen.mockResolvedValue(false)
    expect(await h.terminals.pageKeys(900, AGENT)).toBe(false)
    expect(h.foreground).not.toHaveBeenCalled()
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 1 renderer, 0 asking, 0 background, 0 ps, 0 slow')
  })

  it('a renderer read that rejects is refused renderer, and nothing rejects', async () => {
    const h = harness()
    h.fullscreen.mockRejectedValue(new Error('settings not read'))
    expect(await h.terminals.pageKeys(900, AGENT)).toBe(false)
    expect(h.foreground).not.toHaveBeenCalled()
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 1 renderer, 0 asking, 0 background, 0 ps, 0 slow')
  })

  it('another group in front is refused', async () => {
    const h = await placed()
    const answer = h.terminals.pageKeys(900, AGENT)
    await h.landed()
    // The shell, or another of its jobs, holds the terminal: a key would be typed there.
    await h.groups({ pgid: 900, tpgid: 700 })
    expect(await answer).toBe(false)
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 0 renderer, 0 asking, 1 background, 0 ps, 0 slow')
  })

  it.each<[string, ProcessGroups | undefined]>([
    ['none', undefined],
    ['macOS, no terminal', { pgid: 900, tpgid: 0 }],
    ['Linux, no terminal', { pgid: 900, tpgid: -1 }],
    ['no terminal, in a group of the same number', { pgid: 0, tpgid: 0 }],
  ])('a read of %s is refused', async (_, groups) => {
    const h = await placed()
    const answer = h.terminals.pageKeys(900, AGENT)
    await h.landed()
    await h.groups(groups)
    expect(await answer).toBe(false)
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 1 ps, 0 slow')
  })

  it('an agent with no terminal now is refused ps, with no ps run', async () => {
    // Its window's stream ended between the stroke's look and its read: no shell holds the terminal's foreground.
    const h = harness()
    expect(await h.terminals.pageKeys(900, AGENT)).toBe(false)
    expect(h.foreground).not.toHaveBeenCalled()
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 1 ps, 0 slow')
  })

  it('a ps read that rejects is refused, and nothing rejects', async () => {
    const h = await placed()
    const answer = h.terminals.pageKeys(900, AGENT)
    await h.landed()
    await h.groupsFail()
    expect(await answer).toBe(false)
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 1 ps, 0 slow')
  })

  it.each<[string, 'fullscreen' | 'foreground', string]>([
    ['renderer', 'fullscreen', '1 renderer, 0 asking, 0 background, 0 ps'],
    ['ps', 'foreground', '0 renderer, 0 asking, 0 background, 1 ps'],
  ])('a %s read that throws as it is asked is refused at once, nothing rejects, and the next ask reads again', async (_, read, refused) => {
    const h = await placed()
    h[read].mockImplementationOnce(() => { throw new Error('not read') })
    const answer = h.terminals.pageKeys(900, AGENT)
    await h.landed()
    // Before its 500 ms: the throw is an answer.
    expect(h.deadline().cancelled).toBe(true)
    expect(await answer).toBe(false)
    expect(h.guardCounts()).toBe(`0 page strokes, guard refused: ${refused}, 0 slow`)
    void h.terminals.pageKeys(900, AGENT)
    await h.landed()
    expect(h[read]).toHaveBeenCalledTimes(2)
  })

  it('no answer in 500 ms is refused, and the answer that lands later counts nothing', async () => {
    expect(VSCODE_GUARD_MS).toBe(500)
    const h = await placed()
    const answer = h.terminals.pageKeys(900, AGENT)
    await h.landed()
    h.deadline().run()
    expect(await answer).toBe(false)
    await h.groups({ pgid: 900, tpgid: 900 })
    expect(h.guardCounts()).toBe('0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 0 ps, 1 slow')
  })

  it('an answer in time cancels its 500 ms', async () => {
    const h = await placed()
    const answer = h.terminals.pageKeys(900, AGENT)
    expect(h.deadline().cancelled).toBe(false)
    await h.landed()
    await h.groups({ pgid: 900, tpgid: 900 })
    expect(await answer).toBe(true)
    expect(h.deadline().cancelled).toBe(true)
  })

  it('an ask while that agent\'s guard is in flight joins it: one renderer read, one ps, and each ask is answered and counted', async () => {
    const h = await placed()
    const first = h.terminals.pageKeys(900, AGENT)
    await h.landed()
    const second = h.terminals.pageKeys(900, AGENT)
    expect([h.fullscreen.mock.calls.length, h.foreground.mock.calls.length]).toEqual([1, 1])
    // Each with a deadline of its own: the first's passing leaves the second waiting.
    h.deadline(0).run()
    expect(await first).toBe(false)
    await h.groups({ pgid: 900, tpgid: 900 })
    expect(await second).toBe(true)
    // Once it has answered, the next ask reads anew.
    const third = h.terminals.pageKeys(900, AGENT)
    expect(h.fullscreen).toHaveBeenCalledTimes(2)
    await h.landed()
    await h.groups({ pgid: 900, tpgid: 700 })
    expect(await third).toBe(false)
    expect(h.guardCounts()).toBe('1 page strokes, guard refused: 0 renderer, 0 asking, 1 background, 0 ps, 1 slow')
  })

  it('another agent\'s ask is a guard of its own', async () => {
    const h = await placed()
    const one = h.terminals.pageKeys(900, AGENT)
    const other = h.terminals.pageKeys(910, AGENT)
    await h.landed()
    expect(h.foreground.mock.calls).toEqual([[900, 700], [910, 710]])
    await h.groups({ pgid: 900, tpgid: 900 })
    await h.groups({ pgid: 910, tpgid: 700 })
    expect([await one, await other]).toEqual([true, false])
  })

  it('the minute\'s line counts page strokes and each refusal by its reason', async () => {
    const h = await placed()
    expect(h.terminals.pageKeys(900, { ...AGENT, asking: true })).toBe(false)
    expect(h.terminals.pageKeys(900, { asking: false })).toBe(false)
    for (const groups of [{ pgid: 900, tpgid: 900 }, { pgid: 900, tpgid: 700 }, undefined]) {
      const answer = h.terminals.pageKeys(900, AGENT)
      await h.landed()
      await h.groups(groups)
      await answer
    }
    const failed = h.terminals.pageKeys(900, AGENT)
    await h.landed()
    await h.groupsFail()
    await failed
    const slow = h.terminals.pageKeys(900, AGENT)
    h.deadline().run()
    await slow
    h.timers.find(({ ms }) => ms === 60_000)!.run()
    expect(h.logged).toEqual([
      '[devices] vscode stream · open · windows 1',
      // The one ps read is the table that placed the agents.
      '[devices] vscode · in the last minute: 0 shows, 0 taps, 0 refused states, 1 ps reads, 0 failed, 0 scroll lines, 0 dropped, 1 page strokes, guard refused: 1 renderer, 1 asking, 1 background, 2 ps, 1 slow',
    ])
  })
})

describe('the process table the match reads', () => {
  const row = (pid: number, parentPid: number): ProcessRow =>
    ({ pid, parentPid, executable: 'node', startMarker: 'w:1', args: 'node SECRET-TOKEN rotate the key' })

  it('reads each process\'s parent from the process table, Windows included', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    setProcessTableSource(async () => [row(600, 1), row(700, 600)])
    try {
      expect(await readProcessParents()).toEqual([{ pid: 600, ppid: 1 }, { pid: 700, ppid: 600 }])
    } finally {
      setProcessTableSource(null)
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('a table that was not read or listed nobody is an error that says nothing of what it held', async () => {
    for (const rows of [null, []]) {
      expect(await readProcessParents(async () => rows).catch((e: unknown) => e)).toEqual(new Error('process table not read'))
    }
  })

  it.skipIf(process.platform === 'win32')('this machine\'s holds this process under its parent', async () => {
    expect(await readProcessParents()).toContainEqual({ pid: process.pid, ppid: process.ppid })
  })
})

describe('the foreground group the page guard reads', () => {
  it('is the agent\'s group and its VS Code terminal\'s foreground group as the terminal\'s shell sees it, from one ps read within its bounds', async () => {
    expect(GROUPS_MAX_BYTES).toBe(128)
    const exec = vi.fn<Exec>(async () => '  700   700   900\n  900   900   900\n')
    expect(await readForeground(900, 700, exec)).toEqual({ pgid: 900, tpgid: 900 })
    expect(exec.mock.calls).toEqual([['ps', ['-o', 'pid=,pgid=,tpgid=', '-p', '900,700'], { timeout: PS_TIMEOUT_MS, maxBuffer: GROUPS_MAX_BYTES }]])
  })

  it('an agent in front of a pseudo-terminal of its own (screen, script, sudo\'s) is not in front of the VS Code terminal', async () => {
    // The agent leads the inner terminal, so its own tpgid is its group; the VS Code terminal's foreground is the
    // program that made that terminal, 800.
    expect(await readForeground(900, 700, async () => '  700   700   800\n  900   900   900\n')).toEqual({ pgid: 900, tpgid: 800 })
  })

  it('an agent that is its terminal\'s own process is asked once', async () => {
    const exec = vi.fn<Exec>(async () => '  900   900   900\n')
    expect(await readForeground(900, 900, exec)).toEqual({ pgid: 900, tpgid: 900 })
    expect(exec.mock.calls[0][1]).toEqual(['-o', 'pid=,pgid=,tpgid=', '-p', '900'])
  })

  it('reads the -1 Linux prints for a shell with no terminal', async () => {
    expect(await readForeground(900, 700, async () => '  700   700    -1\n  900   900    -1\n')).toEqual({ pgid: 900, tpgid: -1 })
  })

  it.each([
    null, '', 'SECRET-TOKEN rotate the key\n',
    // The agent gone, the shell gone, another process's row, a row of two numbers, a row twice.
    '  700   700   900\n', '  900   900   900\n', '  700   700   900\n  901   901   900\n', '  700   700\n  900   900\n',
    '  700   700   900\n  700   700   900\n', '  700   700   900\n  900   900   900\n  900   900   900\n',
  ])('a ps that failed, or printed anything but one row of three numbers for each, is none: %j', async (out) => {
    expect(await readForeground(900, 700, async () => out)).toBeUndefined()
  })

  it('has no foreground group to read on Windows, and runs no ps', async () => {
    const exec = vi.fn<Exec>(async () => '  700   700   900\n  900   900   900\n')
    expect(await readForeground(900, 700, exec, 'win32')).toBeUndefined()
    expect(exec).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('this machine\'s: this process has a group, and its parent a foreground group', async () => {
    expect(await readForeground(process.pid, process.ppid)).toEqual({ pgid: expect.any(Number), tpgid: expect.any(Number) })
  })
})
