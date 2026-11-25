import { describe, expect, it, vi } from 'vitest'
import { lstartGeneration } from '../../lib/lstart.js'
import type { Pane } from './adapter.js'
import type { ProcessName } from './scannedApp.js'
import type { RunPs } from './tabs.js'
import { TYPE_ANSWER_MS, type TabsLine, type TabsWrite, type WroteAnswer } from './tabsLines.js'
import {
  READERS_TIMEOUT_MS, readTabProcess, readTtyReaders, tabsTyping, type RunLsof, type TabProcess, type TabsTypeDeps,
} from './tabsType.js'
import { settleMs } from './twoStep.js'
import type { TypeResult } from './types.js'

const START = 'Tue Nov 25 10:00:00 2026'
const TTY = '/dev/ttys003'
const AGENT = 4101
const PANE: Pane = { adapter: 'tabs', id: `iterm:${TTY}`, proof: { pid: AGENT, start: 'ps:1' } }
const GHOSTTY: Pane = { adapter: 'tabs', id: 'ghostty:/dev/ttys004', proof: { pid: 4301, start: 'ps:3' } }
/** The agent in front of its tty, as ps reads it. */
const FRONT: TabProcess = { tty: TTY, pgid: AGENT, tpgid: AGENT, start: 'ps:1' }
/** The agent under its shell and login, and a child of its own: an editor, a pager or a `!` command. */
const TABLE: ProcessName[] = [
  { pid: 4000, ppid: 1, executable: 'login' },
  { pid: 4100, ppid: 4000, executable: '-zsh' },
  { pid: AGENT, ppid: 4100, executable: 'codex' },
  { pid: 4200, ppid: AGENT, executable: 'vim' },
  { pid: 4300, ppid: 1, executable: 'ghostty-shell' },
  { pid: 4301, ppid: 4300, executable: 'claude' },
]

/** Lets every promise already settled run its callbacks. */
const drain = () => new Promise<void>((done) => { setImmediate(done) })

/** An `after` that records each wait and runs the ones not cancelled when told. */
function fakeAfter() {
  const asked: number[] = []
  const waiting: Array<{ run: () => void; on: boolean }> = []
  return {
    asked,
    after: (ms: number, run: () => void) => {
      asked.push(ms)
      const timer = { run, on: true }
      waiting.push(timer)
      return () => { timer.on = false }
    },
    flush: () => {
      for (const timer of waiting.splice(0)) if (timer.on) timer.run()
    },
  }
}

/**
 * The devices' side of a watch's tabs stream: each send is logged and answered from [answers] in turn, then `ok`.
 * `unanswered` leaves it unsettled, as a late `wrote` may still come, until `settle` or the stream's end.
 */
function fakeLine(log: string[], answers: WroteAnswer[] = []) {
  const sent: TabsWrite[] = []
  const late: Array<() => void> = []
  const wakes: Array<(ready: boolean) => void> = []
  const readyMs: number[] = []
  const stream = new AbortController()
  let writable = true
  const settle = (): void => { for (const done of late.splice(0)) done() }
  const wake = (ready: boolean, drained = ready): void => {
    writable = drained
    for (const woken of wakes.splice(0)) woken(ready)
  }
  const line: TabsLine = {
    writable: () => writable,
    ready: (ms) => {
      readyMs.push(ms)
      return new Promise((woken) => wakes.push(woken))
    },
    send: (typing) => {
      sent.push(typing)
      log.push('write' in typing ? 'write' : 'enter')
      const answer = answers.shift() ?? 'ok'
      const settled = answer === 'unanswered' ? new Promise<void>((done) => late.push(done)) : Promise.resolve()
      return { answer: Promise.resolve(answer), settled }
    },
    ended: stream.signal,
  }
  return {
    line, sent, readyMs, settle, wake,
    fill: () => { writable = false },
    end: () => {
      stream.abort()
      settle()
      wake(false)
    },
  }
}

/** An agent alone at its prompt in the foreground of its iTerm2 tab, its stream open: every probe passes. */
function world(over: Partial<TabsTypeDeps> = {}, answers?: WroteAnswer[]) {
  const log: string[] = []
  const stream = fakeLine(log, answers)
  const clock = fakeAfter()
  let current: TabsLine | undefined = stream.line
  const deps: TabsTypeDeps = {
    line: () => current,
    shared: (tty, pid) => {
      log.push(`shared ${tty} ${pid}`)
      return false
    },
    process: async (pid) => {
      log.push(`process ${pid}`)
      return pid === AGENT ? FRONT : { tty: '/dev/ttys004', pgid: 4301, tpgid: 4301, start: 'ps:3' }
    },
    readers: async (tty) => {
      log.push(`readers ${tty}`)
      return tty === TTY ? [AGENT, 4100] : [4301]
    },
    processes: async () => {
      log.push('processes')
      return TABLE
    },
    after: clock.after,
    ...over,
  }
  const atPrompt = (): boolean => {
    log.push('atPrompt')
    return true
  }
  const typing = tabsTyping(deps)
  /** A send carried to its end: each settle fired once the send waits on it. */
  const send = async (pane = PANE, text = 'hi', prompt = atPrompt): Promise<TypeResult> => {
    const typed = typing.type(pane, text, 'codex', prompt)
    for (let i = 0; i < 4; i++) {
      await drain()
      clock.flush()
    }
    return typed
  }
  return { log, stream, clock, typing, atPrompt, send, replace: (line: TabsLine | undefined) => { current = line } }
}

/** A probe that answers [first] when first asked and [then] after. */
function secondly<T>(first: T, then: T): () => Promise<T> {
  let asked = 0
  return async () => (++asked === 1 ? first : then)
}

const PROBES = ['process 4101', `readers ${TTY}`, 'processes', `shared ${TTY} 4101`, 'atPrompt']

describe('readTabProcess', () => {
  it('asks ps once for the tty, the groups and the start, with 1 s and 256 bytes', async () => {
    const run = vi.fn<RunPs>(async () => `ttys003  4101  4101 ${START}\n`)
    expect(await readTabProcess(4101, run)).toStrictEqual({
      tty: '/dev/ttys003', pgid: 4101, tpgid: 4101, start: lstartGeneration(START),
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(['-o', 'tty=,pgid=,tpgid=,lstart=', '-p', '4101'], { timeout: 1_000, maxBuffer: 256 })
  })

  it('reads a start that does not parse as none', async () => {
    expect(await readTabProcess(4101, async () => 'ttys003  4101  4100 garbage\n'))
      .toStrictEqual({ tty: '/dev/ttys003', pgid: 4101, tpgid: 4100 })
  })

  it('reads no tty, no row, two rows, a row it cannot read and a failed run as nothing', async () => {
    for (const out of [
      `??  4101  0 ${START}\n`, '', `ttys003  4101  4101 ${START}\nttys004  4102  4102 ${START}\n`,
      `ttys003  x  4101 ${START}\n`, `ttys003  4101 ${START}\n`, null,
    ]) {
      expect(await readTabProcess(4101, async () => out), String(out)).toBeUndefined()
    }
  })
})

describe('readTtyReaders', () => {
  it('asks lsof for the processes whose stdin is the tty, with 2 s and 4 KiB', async () => {
    const run = vi.fn<RunLsof>(async () => ({ code: 0, stdout: '4101\n4100\n' }))
    expect(await readTtyReaders(TTY, run)).toEqual([4101, 4100])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(['-a', '-d', '0', '-t', TTY], { timeout: READERS_TIMEOUT_MS, maxBuffer: 4096 })
    expect(READERS_TIMEOUT_MS).toBe(2_000)
  })

  it('takes exit 1 as a read: lsof says so when it found nothing, or could not read some of it', async () => {
    expect(await readTtyReaders(TTY, async () => ({ code: 1, stdout: '' }))).toEqual([])
    expect(await readTtyReaders(TTY, async () => ({ code: 1, stdout: '4101\n' }))).toEqual([4101])
  })

  it('has no readers for a timeout, a spawn error, another exit or a line that is no pid', async () => {
    for (const answer of [
      { code: null, stdout: '' }, null, { code: 2, stdout: '4101\n' }, { code: 0, stdout: '4101\nlsof: WARNING\n' },
    ]) {
      expect(await readTtyReaders(TTY, async () => answer), JSON.stringify(answer)).toBeUndefined()
    }
  })

  it('never runs for a tty the check refuses', async () => {
    const run = vi.fn<RunLsof>(async () => ({ code: 0, stdout: '4101\n' }))
    for (const tty of ['/dev/pts/1', '/dev/ttys12345', 'ttys003', '/dev/ttys003 -p 1']) {
      expect(await readTtyReaders(tty, run), tty).toBeUndefined()
    }
    expect(run).not.toHaveBeenCalled()
  })
})

describe('tabsTyping', () => {
  it('can type only with a line open, into a pane with a proof, in iTerm2 or Ghostty', () => {
    const w = world()
    expect(w.typing.canType(PANE)).toBe(true)
    expect(w.typing.canType(GHOSTTY)).toBe(true)
    expect(w.typing.canType({ adapter: 'tabs', id: `iterm:${TTY}` })).toBe(false)
    expect(w.typing.canType({ ...PANE, id: `terminal-app:${TTY}` })).toBe(false)
    w.replace(undefined)
    expect(w.typing.canType(PANE)).toBe(false)
  })

  it('writes the words, hears them written, settles, checks everything again, then presses Enter', async () => {
    const w = world()
    expect(await w.send(PANE, 'hello there')).toBe(true)
    expect(w.stream.sent).toEqual([
      { write: { app: 'iterm', tty: TTY, text: 'hello there' } },
      { enter: { app: 'iterm', tty: TTY } },
    ])
    expect(w.clock.asked).toEqual([settleMs('hello there')])
    const write = w.log.indexOf('write')
    const enter = w.log.indexOf('enter')
    expect(new Set(w.log.slice(0, write))).toEqual(new Set(PROBES))
    expect(new Set(w.log.slice(write + 1, enter))).toEqual(new Set(PROBES))
  })

  it('writes to a Ghostty tab by its own tty', async () => {
    const w = world()
    expect(await w.send(GHOSTTY)).toBe(true)
    expect(w.stream.sent).toEqual([
      { write: { app: 'ghostty', tty: '/dev/ttys004', text: 'hi' } },
      { enter: { app: 'ghostty', tty: '/dev/ttys004' } },
    ])
  })

  it('types a control character as a space and a lone surrogate as the replacement character', async () => {
    const w = world()
    expect(await w.send(PANE, 'a\nb\u001b\ud800')).toBe(true)
    expect(w.stream.sent[0]).toEqual({ write: { app: 'iterm', tty: TTY, text: 'a b �' } })
  })

  it('answers false for a text with no words, and asks nothing', async () => {
    const w = world()
    expect(await w.send(PANE, '')).toBe(false)
    expect(w.log).toEqual([])
  })

  describe('a check that fails before the words writes nothing, and says why', () => {
    const cases: Array<[string, Partial<TabsTypeDeps>, Pane, TypeResult]> = [
      ['no line', { line: () => undefined }, PANE, { notSent: 'no-stream' }],
      ['a pane with no proof', {}, { adapter: 'tabs', id: `iterm:${TTY}` }, { notSent: 'nested' }],
      ['Terminal.app', {}, { ...PANE, id: `terminal-app:${TTY}` }, { notSent: 'terminal-app' }],
      ['another agent on the tty', { shared: () => true }, PANE, { notSent: 'shared' }],
      ['ps unreadable', { process: async () => undefined }, PANE, { notSent: 'process' }],
      ['another tty', { process: async () => ({ ...FRONT, tty: '/dev/ttys009' }) }, PANE, { notSent: 'process' }],
      ['another start', { process: async () => ({ ...FRONT, start: 'ps:2' }) }, PANE, { notSent: 'process' }],
      ['no start', { process: async () => ({ tty: TTY, pgid: AGENT, tpgid: AGENT }) }, PANE, { notSent: 'process' }],
      ['no foreground group', { process: async () => ({ ...FRONT, tpgid: 0 }) }, PANE, { notSent: 'process' }],
      ['the agent in the background', { process: async () => ({ ...FRONT, tpgid: 4300 }) }, PANE, { notSent: 'background' }],
      ['its child reading the tty', { readers: async () => [AGENT, 4100, 4200] }, PANE, { notSent: 'foreground-child' }],
      ['the agent not reading it', { readers: async () => [4100] }, PANE, { notSent: 'foreground-child' }],
      ['no reader', { readers: async () => [] }, PANE, { notSent: 'foreground-child' }],
      ['lsof unreadable', { readers: async () => undefined }, PANE, { notSent: 'foreground-child' }],
      ['the table unreadable', { processes: async () => { throw new Error('ps') } }, PANE, { notSent: 'foreground-child' }],
      ['the agent not in the table', { processes: async () => TABLE.filter(({ pid }) => pid !== AGENT) }, PANE,
        { notSent: 'foreground-child' }],
    ]
    it.each(cases)('%s', async (_name, over, pane, why) => {
      const w = world(over)
      expect(await w.send(pane)).toEqual(why)
      expect(w.stream.sent).toEqual([])
    })

    it('the agent left its prompt during the probes', async () => {
      const w = world()
      expect(await w.send(PANE, 'hi', () => false)).toEqual({ notSent: 'busy' })
      // No prompt check at all is no prompt known.
      expect(await w.typing.type(PANE, 'hi', 'codex')).toEqual({ notSent: 'busy' })
      expect(w.stream.sent).toEqual([])
    })

    it('a newer watch took the stream during the probes', async () => {
      const newer = fakeLine([])
      let replace = (): void => {}
      const w = world({ process: async () => { replace(); return FRONT } })
      replace = () => w.replace(newer.line)
      expect(await w.send()).toEqual({ notSent: 'no-stream' })
      expect(w.stream.sent).toEqual([])
      expect(newer.sent).toEqual([])
    })

    it('a probe that throws as it is asked, or rejects, is a check that failed', async () => {
      const fails = (): never => { throw new Error('read') }
      expect(await world({ process: fails }).send()).toEqual({ notSent: 'process' })
      expect(await world({ process: async () => fails() }).send()).toEqual({ notSent: 'process' })
      expect(await world({ readers: fails }).send()).toEqual({ notSent: 'foreground-child' })
      expect(await world({ readers: async () => fails() }).send()).toEqual({ notSent: 'foreground-child' })
      expect(await world({ processes: fails }).send()).toEqual({ notSent: 'foreground-child' })
    })
  })

  describe('the words or the Enter not written', () => {
    const cases: Array<[string, WroteAnswer[], TypeResult, number]> = [
      ['the words refused', ['refused'], { notSent: 'no-session' }, 1],
      ['the words unanswered', ['unanswered'], { notSent: 'no-answer' }, 1],
      ['the stream ended under the words', ['ended'], { notSent: 'no-stream' }, 1],
      ['the Enter refused', ['ok', 'refused'], { notSent: 'no-session' }, 2],
      ['the Enter unanswered', ['ok', 'unanswered'], { notSent: 'no-answer' }, 2],
      ['the stream ended under the Enter', ['ok', 'ended'], { notSent: 'no-stream' }, 2],
    ]
    it.each(cases)('%s', async (_name, answers, why, lines) => {
      const w = world({}, answers)
      expect(await w.send()).toEqual(why)
      expect(w.stream.sent).toHaveLength(lines)
      // No settle after words that were not written: no Enter waits.
      expect(w.clock.asked).toEqual(lines === 1 ? [] : [settleMs('hi')])
    })
  })

  describe('a check that fails again after the settle presses no Enter, and says why', () => {
    const cases: Array<[string, Partial<TabsTypeDeps>, (() => boolean) | undefined, TypeResult]> = [
      ['another start', { process: secondly<TabProcess | undefined>(FRONT, { ...FRONT, start: 'ps:2' }) }, undefined,
        { notSent: 'process' }],
      ['the agent in the background', { process: secondly<TabProcess | undefined>(FRONT, { ...FRONT, tpgid: 4300 }) },
        undefined, { notSent: 'background' }],
      ['its child reading the tty',
        { readers: secondly<readonly number[] | undefined>([AGENT], [AGENT, 4200]) }, undefined,
        { notSent: 'foreground-child' }],
      ['another agent on the tty', { shared: (() => { let asked = 0; return () => ++asked > 1 })() }, undefined,
        { notSent: 'shared' }],
      ['the agent left its prompt', {}, (() => { let asked = 0; return () => ++asked === 1 })(), { notSent: 'busy' }],
    ]
    it.each(cases)('%s', async (_name, over, atPrompt, why) => {
      const w = world(over)
      expect(await w.send(PANE, 'hi', atPrompt ?? w.atPrompt)).toEqual(why)
      expect(w.stream.sent).toEqual([{ write: { app: 'iterm', tty: TTY, text: 'hi' } }])
    })

    it('a newer watch took the stream during the settle', async () => {
      const w = world()
      const newer = fakeLine([])
      const typed = w.typing.type(PANE, 'hi', 'codex', w.atPrompt)
      await drain()
      expect(w.stream.sent).toHaveLength(1)
      w.replace(newer.line)
      w.stream.end()
      w.clock.flush()
      expect(await typed).toEqual({ notSent: 'no-stream' })
      expect(w.stream.sent).toHaveLength(1)
      expect(newer.sent).toEqual([])
    })
  })

  it('keeps the tty locked while a late answer may still come, and frees it once it settled', async () => {
    const w = world({}, ['unanswered'])
    expect(await w.send(PANE, 'one')).toEqual({ notSent: 'no-answer' })
    expect(await w.send(PANE, 'two')).toBe(false)
    expect(w.stream.sent).toHaveLength(1)
    // Another tab's tty is not held by it.
    expect(await w.send(GHOSTTY, 'elsewhere')).toBe(true)
    w.stream.settle()
    await drain()
    expect(await w.send(PANE, 'three')).toBe(true)
    expect(w.stream.sent.filter((line) => 'write' in line)).toEqual([
      { write: { app: 'iterm', tty: TTY, text: 'one' } },
      { write: { app: 'ghostty', tty: '/dev/ttys004', text: 'elsewhere' } },
      { write: { app: 'iterm', tty: TTY, text: 'three' } },
    ])
  })

  describe('a line still draining', () => {
    it('waits until it drains, checks everything again, then writes', async () => {
      const w = world()
      w.stream.fill()
      const typed = w.typing.type(PANE, 'hi', 'codex', w.atPrompt)
      await drain()
      expect(w.stream.sent).toEqual([])
      expect(w.stream.readyMs).toEqual([TYPE_ANSWER_MS])
      w.stream.wake(true)
      await drain()
      const write = w.log.indexOf('write')
      expect(write).toBeGreaterThan(0)
      expect(w.log.slice(0, write).filter((asked) => asked === 'process 4101')).toHaveLength(2)
      expect(w.log.slice(0, write).filter((asked) => asked === 'atPrompt')).toHaveLength(2)
      w.clock.flush()
      expect(await typed).toBe(true)
    })

    it('a check that fails after the wait writes nothing', async () => {
      const w = world({ process: secondly<TabProcess | undefined>(FRONT, { ...FRONT, start: 'ps:2' }) })
      w.stream.fill()
      const typed = w.typing.type(PANE, 'hi', 'codex', w.atPrompt)
      await drain()
      w.stream.wake(true)
      expect(await typed).toEqual({ notSent: 'process' })
      expect(w.stream.sent).toEqual([])
    })

    it('a wait that ends unwritten writes nothing: no answer, or the stream gone', async () => {
      const unwritten = world()
      unwritten.stream.fill()
      const typed = unwritten.typing.type(PANE, 'hi', 'codex', unwritten.atPrompt)
      await drain()
      unwritten.stream.wake(false)
      expect(await typed).toEqual({ notSent: 'no-answer' })
      expect(unwritten.stream.sent).toEqual([])

      const ended = world()
      ended.stream.fill()
      const gone = ended.typing.type(PANE, 'hi', 'codex', ended.atPrompt)
      await drain()
      ended.stream.end()
      expect(await gone).toEqual({ notSent: 'no-stream' })
      expect(ended.stream.sent).toEqual([])
    })

    it('a drain another write filled again waits again, all within TYPE_ANSWER_MS', async () => {
      const w = world()
      w.stream.fill()
      const typed = w.typing.type(PANE, 'hi', 'codex', w.atPrompt)
      await drain()
      w.stream.wake(true, false)
      await drain()
      expect(w.stream.readyMs).toHaveLength(2)
      expect(w.stream.sent).toEqual([])
      expect(w.clock.asked).toEqual([TYPE_ANSWER_MS])
      w.clock.flush()
      expect(await typed).toEqual({ notSent: 'no-answer' })
      expect(w.stream.sent).toEqual([])
    })
  })

  describe('never rejects', () => {
    it('a send that throws is false, and frees the tty', async () => {
      const w = world()
      w.replace({ ...w.stream.line, send: () => { throw new Error('send') } })
      expect(await w.send()).toBe(false)
      w.replace(w.stream.line)
      expect(await w.send()).toBe(true)
    })

    it('an answer that rejects is no answer, and holds the tty until the line settles', async () => {
      const w = world()
      let settle = (): void => {}
      const settled = new Promise<void>((done) => { settle = done })
      w.replace({ ...w.stream.line, send: () => ({ answer: Promise.reject(new Error('answer')), settled }) })
      expect(await w.send()).toEqual({ notSent: 'no-answer' })
      w.replace(w.stream.line)
      expect(await w.send()).toBe(false)
      settle()
      await drain()
      expect(await w.send()).toBe(true)
    })

    it('a source check that throws is false', async () => {
      expect(await world({ shared: () => { throw new Error('shared') } }).send()).toBe(false)
      expect(await world().send(PANE, 'hi', () => { throw new Error('prompt') })).toBe(false)
    })
  })
})
