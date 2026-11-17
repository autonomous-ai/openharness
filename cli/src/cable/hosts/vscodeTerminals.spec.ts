import { describe, expect, it, vi } from 'vitest'
import { REFUSED, type ListenerStream, type StreamEnd } from '../../services/devicesListener.js'
import {
  CHAIN_RETRY_MS, VSCODE_OPEN_MAX_BYTES, VSCODE_OPEN_PER_SECOND, VSCODE_STATE_MAX_BYTES, VSCODE_STATE_PER_SECOND,
  VSCODE_TERMINALS, VSCODE_WINDOWS, vscodeStreams, type VscodeTerminalsDeps,
} from './vscodeTerminals.js'

const W1 = 'window-1'
const W2 = 'window-2'
/** pid and parent: VS Code's helper 600, the shell 700 it started for a terminal, a node 800 in it, the agent 900. */
const TREE: ReadonlyArray<readonly [number, number]> = [[600, 1], [700, 600], [800, 700], [900, 800]]
/** A second terminal's shell 710 under the same helper, and its agent 910. */
const SECOND: ReadonlyArray<readonly [number, number]> = [[710, 600], [910, 710]]

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

/** The windows, with a `ps` that answers only when the test says, from a table the test sets; a clock the test moves;
 *  each minute's timer kept to be run by hand; and every line logged. */
function harness(table: ReadonlyArray<readonly [number, number]> = TREE) {
  let at = 0
  const reads: Array<{ resolve(rows: Array<{ pid: number; ppid: number }>): void; reject(error: Error): void }> = []
  const timers: Array<{ ms: number; run: () => void }> = []
  const logged: string[] = []
  const processes = vi.fn<VscodeTerminalsDeps['processes']>(() => new Promise((resolve, reject) => { reads.push({ resolve, reject }) }))
  const changed = vi.fn<VscodeTerminalsDeps['changed']>()
  const terminals = vscodeStreams({
    processes,
    changed,
    now: () => at,
    after: (ms, run) => {
      timers.push({ ms, run })
      return () => {}
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
    timers,
    logged,
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
  }
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
    expect(h.logged.at(-1)).toBe('[devices] vscode · in the last minute: 0 shows, 0 taps, 1 refused states, 0 ps reads')
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
    expect(one.lines).toEqual([{ show: 700 }])
    expect(h.terminals.show({ window: W1, shell: 710 }, false)).toBe(true)
    expect(h.terminals.show({ window: W1, shell: 720 }, false)).toBe(true)
    expect(one.lines).toEqual([{ show: 700 }])
    one.drain()
    expect(one.lines).toEqual([{ show: 700 }, { show: 720 }])
    one.drain()
    expect(one.lines).toEqual([{ show: 700 }, { show: 720 }])
  })

  it('show answers false once the window\'s stream has ended', () => {
    const h = harness()
    const one = h.open(W1)
    expect(h.terminals.show({ window: W2, shell: 700 }, true)).toBe(false)
    one.end('stalled')
    expect(h.terminals.show({ window: W1, shell: 700 }, true)).toBe(false)
    expect(one.lines).toEqual([])
  })

  it('the log holds counts and fixed words: no pid and no window id', async () => {
    const h = harness()
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
    h.terminals.show(terminal, false)
    expect(h.timers.map(({ ms }) => ms)).toEqual([60_000, 60_000])
    h.timers[1]!.run()
    newer.end('gone')
    expect(h.logged).toEqual([
      '[devices] vscode stream · open · windows 1',
      '[devices] vscode · in the last minute: 1 shows, 1 taps, 1 refused states, 1 ps reads',
      '[devices] vscode stream · open · windows 1',
      '[devices] vscode stream · ended · replaced · windows 1',
      '[devices] vscode · in the last minute: 1 shows, 0 taps, 0 refused states, 0 ps reads',
      '[devices] vscode stream · ended · gone · windows 0',
    ])
    for (const line of h.logged) expect(line).not.toMatch(/900|700|5f3a/)
  })
})
