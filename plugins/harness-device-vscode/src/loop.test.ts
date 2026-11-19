// The loop, against inputs and a window of this file's own: a launcher's answers, a connect whose chunks the test sends,
// posts it answers, and a clock it moves. Never the developer's own harness, daemon or VS Code.
import { afterEach, describe, expect, it } from 'vitest'
import { MISSING, type LoopInputs, type Ran, type Target } from './inputs'
import { startLoop, type Loop, type LoopState } from './loop'
import { fakeWindow } from './testing/fakeWindow'
import type { WindowFacade } from './window'

const ID = 'a1b2c3d4-0000-4000-8000-123456789abc'
const SOCKET = '/run/h/devices.sock'
const OPEN = `{"type":"vscode","window":"${ID}"}`
const READY = JSON.stringify({ daemon: true, devicesSocket: SOCKET, devicesReady: true })
const UNPLUGGED = JSON.stringify({ daemon: true, devicesSocket: SOCKET, devicesReady: false })
const LINK = { args: ['device', 'vscode', 'link'], path: '/usr/bin:/bin', timeoutMs: 5_000, maxBytes: 4_096 }
// On Windows, a profile whose name has a space, Vietnamese letters, ', & and %.
const WINDOWS = { platform: 'win32', home: "C:\\Users\\Nguyễn Văn A' & 100%", path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' }
const PIPE = '\\\\.\\pipe\\harness-0123456789abcdef0123456789abcdef'
const TOKEN = '0123456789abcdef'.repeat(4)
const RECORD = "C:\\Users\\Nguyễn Văn A' & 100%\\.harness\\devices.json"
const WINDOWS_READY = { daemon: true, devicesPipe: PIPE, devicesToken: TOKEN, devicesReady: true, devicesRecord: RECORD }
const WINDOWS_UNPLUGGED = JSON.stringify({ daemon: true, devicesReady: false, devicesRecord: RECORD })

let loops: Loop[] = []

afterEach(async () => {
  await Promise.all(loops.map((loop) => loop.stop()))
  loops = []
})

type Timer = { at: number; run: () => void }
type Watch = { folder: string; changed: (name: string | null) => void; failed: () => void; closed: boolean }
interface Stream {
  target: Target
  body: string
  /** Aborted once the loop has let the stream go. */
  signal: AbortSignal
  /** The head, with this status. */
  answer(status: number): void
  send(...chunks: (string | Uint8Array)[]): void
  /** The devices' end of the stream. */
  end(): void
}
interface Post { target: Target; body: string; signal: AbortSignal; at: number; answer(status: number | null): void }

const bytes = (text: string) => new TextEncoder().encode(text)
// Every input here answers in a promise, so once the queue of them is drained the loop has done all it can.
const flush = () => new Promise<void>((done) => setImmediate(done))

/** A loop on inputs of the test's own. `answers` are link's, one a run; with none left, a run lasts until aborted. */
function world(answers: (Ran | Promise<Ran>)[], win = fakeWindow(), over: Partial<LoopInputs> = {}) {
  let time = 0
  const timers = new Set<Timer>()
  const runs: { file: string; args: readonly string[]; path: string; timeoutMs: number; maxBytes: number; signal: AbortSignal; at: number }[] = []
  const watches: Watch[] = []
  const streams: Stream[] = []
  const posts: Post[] = []
  /** How the next posts are answered, in turn: a status, null, or held until the test answers it. 204 once none is left. */
  const replies: (number | null | 'held')[] = []
  const states: LoopState[] = []
  const logs: string[] = []
  const checks = new Set<() => void>()
  // Each call the loop makes may be the one a test waits for.
  const called = () => {
    for (const check of checks) check()
  }
  const inputs: LoopInputs = {
    platform: 'darwin',
    home: '/h',
    path: '/usr/bin:/bin',
    windowId: ID,
    run(file, args, bounds) {
      runs.push({ file, args, ...bounds, at: time })
      called()
      if (answers.length > 0) return Promise.resolve(answers.shift()!)
      return new Promise((settle) => bounds.signal.addEventListener('abort', () => settle(null)))
    },
    connect(target, body, signal) {
      return new Promise((settle) => {
        const queue: Uint8Array[] = []
        let ended = false
        let wake = () => {}
        const end = () => {
          ended = true
          wake()
        }
        async function* chunks(): AsyncGenerator<Uint8Array> {
          for (;;) {
            const chunk = queue.shift()
            if (chunk) yield chunk
            else if (ended) return
            else await new Promise<void>((done) => (wake = done))
          }
        }
        // Before the head an abort is null; after it, it ends the chunks, as Node's connect does.
        signal.addEventListener('abort', () => {
          settle(null)
          queue.length = 0
          end()
          called()
        })
        streams.push({
          target,
          body,
          signal,
          answer: (status) => settle({ status, chunks: chunks() }),
          send(...sent) {
            queue.push(...sent.map((chunk) => (typeof chunk === 'string' ? bytes(chunk) : chunk)))
            wake()
          },
          end,
        })
        called()
      })
    },
    post(target, body, signal) {
      return new Promise((settle) => {
        const reply = replies.length > 0 ? replies.shift()! : 204
        posts.push({ target, body, signal, at: time, answer: settle })
        signal.addEventListener('abort', () => settle(null))
        if (reply !== 'held') settle(reply)
        called()
      })
    },
    watch(folder, changed, failed) {
      const watch = { folder, changed, failed, closed: false }
      watches.push(watch)
      called()
      return () => {
        watch.closed = true
      }
    },
    now: () => time,
    after(ms, run) {
      const timer = { at: time + ms, run }
      timers.add(timer)
      called()
      return () => {
        timers.delete(timer)
      }
    },
    ...over,
  }
  let listening = 0
  const window: WindowFacade = {
    remote: win.window.remote,
    state: () => win.window.state(),
    onChange(changed) {
      listening += 1
      const dispose = win.window.onChange(changed)
      return () => {
        listening -= 1
        dispose()
      }
    },
    show(pid) {
      const shown = win.window.show(pid)
      called()
      return shown
    },
    raise() {
      win.window.raise()
      called()
    },
    scrollLine(up) {
      const scrolled = win.window.scrollLine(up)
      called()
      return scrolled
    },
    pageKey(pid, up) {
      const sent = win.window.pageKey(pid, up)
      called()
      return sent
    },
  }
  const loop = startLoop(inputs, window, {
    changed(state) {
      states.push(state)
      called()
    },
    log(line) {
      logs.push(line)
      called()
    },
  })
  if (loop) loops.push(loop)
  return {
    loop,
    runs,
    watches,
    streams,
    posts,
    replies,
    states,
    logs,
    timers,
    /** The window's change listeners the loop holds. */
    listening: () => listening,
    due: () => [...timers].map((timer) => timer.at).sort((a, b) => a - b),
    /** Resolves once `holds` does: it is asked again at each call the loop makes. */
    until(holds: () => boolean): Promise<void> {
      return new Promise((done) => {
        const check = () => {
          if (!holds()) return
          checks.delete(check)
          done()
        }
        checks.add(check)
        check()
      })
    },
    /** The clock to `at`, each timer due by then fired at its own time, and what each one started let run. */
    async to(at: number): Promise<void> {
      for (;;) {
        await flush()
        const due = [...timers].filter((timer) => timer.at <= at).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.delete(due)
        time = due.at
        due.run()
      }
      time = at
    },
  }
}

/** A loop whose link says ready, its stream's head come at 0, and the state it then sent taken. */
async function connected(win = fakeWindow(), more: (Ran | Promise<Ran>)[] = []) {
  const w = world([READY, ...more], win)
  await w.until(() => w.streams.length === 1)
  const stream = w.streams[0]
  stream.answer(200)
  await w.until(() => w.posts.length === 1)
  await flush()
  return { w, stream }
}

const sent = (post: Post) => JSON.parse(post.body)

describe('startLoop', () => {
  it('in a remote window nothing starts, on any platform: no run, no connect, null', async () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const w = world([], fakeWindow({ remote: true }), { platform })
      await flush()
      expect(w.loop).toBeNull()
      expect([w.runs, w.streams, w.posts, w.watches, w.timers.size, w.states, w.logs]).toEqual([[], [], [], [], 0, [], []])
    }
  })

  it("the home's launcher is tried before PATH's, with device vscode link, 5 s and 4 KiB", async () => {
    const w = world([MISSING, MISSING])
    await w.until(() => w.states.length > 0)
    expect(w.runs.map(({ file, args, path, timeoutMs, maxBytes }) => ({ file, args, path, timeoutMs, maxBytes }))).toEqual([
      { file: '/h/.local/bin/harness', ...LINK },
      { file: 'harness', ...LINK },
    ])
    // The first answer that is not missing is the launcher's.
    const second = world([MISSING, UNPLUGGED])
    await second.until(() => second.states.length > 0)
    expect(second.states).toEqual(['unplugged'])
    // With no home, PATH's alone.
    const homeless = world([MISSING], fakeWindow(), { home: '' })
    await homeless.until(() => homeless.states.length > 0)
    expect(homeless.runs.map((run) => run.file)).toEqual(['harness'])
  })

  // A relative folder, or an empty one, is the extension host's working folder, which can be the folder VS Code opened:
  // in Restricted Mode an untrusted one, whose own `harness` must never run.
  it("only PATH's absolute folders, and only a home that is absolute, are looked in", async () => {
    const w = world([MISSING, MISSING], fakeWindow(), { path: 'node_modules/.bin::/usr/bin:.:/bin:', home: 'h' })
    await w.until(() => w.states.length > 0)
    expect(w.runs.map(({ file, args, path, timeoutMs, maxBytes }) => ({ file, args, path, timeoutMs, maxBytes }))).toEqual([
      { file: 'harness', ...LINK },
    ])
  })

  it.each([
    ['no launcher', 'noHarness', [MISSING, MISSING]],
    ['a run that failed', 'notRunning', [null]],
    ['daemon false', 'notRunning', ['{"daemon":false,"devicesSocket":"/run/h/devices.sock","devicesReady":true}']],
    ["an older CLI's usage text", 'notRunning', ['Usage: harness device <claude|codex|orca> …\n']],
  ] as const)('%s is %s, and nothing is connected', async (_case, state, answers) => {
    const w = world([...answers])
    await w.until(() => w.states.length > 0)
    expect([w.states, w.streams, w.watches]).toEqual([[state], [], []])
  })

  it("any output that is not link's answer is notRunning, and nothing is connected", async () => {
    const printed = [
      '',
      'warning\n{"daemon":true}',
      '[]',
      'null',
      '{"daemon":"yes","devicesReady":true}',
      '{"daemon":true}',
      '{"daemon":true,"devicesSocket":"/run/h/devices.sock","devicesReady":"yes"}',
      '{"daemon":true,"devicesSocket":"devices.sock","devicesReady":true}',
      '{"daemon":true,"devicesSocket":7,"devicesReady":true}',
      '{"daemon":true,"devicesReady":true}',
      '{"daemon":true,"devicesSocket":"/run/h/devices\\u0000.sock","devicesReady":true}',
    ]
    for (const out of printed) {
      const w = world([out])
      await w.until(() => w.states.length > 0)
      expect([out, w.states, w.streams, w.watches]).toEqual([out, ['notRunning'], [], []])
    }
  })

  it("unplugged watches the socket's folder, passes at most once a second, and looks again after 5 min", async () => {
    const w = world([UNPLUGGED, UNPLUGGED, UNPLUGGED, UNPLUGGED])
    await w.until(() => w.states.length === 1 && w.timers.size > 0)
    expect([w.states, w.watches.map((watch) => watch.folder)]).toEqual([['unplugged'], ['/run/h']])
    // A watch can start a moment after it returns (macOS), so link is asked once more, a second after.
    expect(w.due()).toEqual([1_000])
    await w.to(1_000)
    // Then, the watch on, only in 5 min.
    expect([w.runs.length, w.due()]).toEqual([2, [301_000]])
    // The socket's entry asks, a second after the last pass; another entry asks nothing; one with no name asks too.
    await w.to(1_500)
    w.watches[0].changed('devices.sock')
    w.watches[0].changed('registry.json')
    w.watches[0].changed(null)
    expect(w.due()).toEqual([2_000])
    await w.to(2_000)
    expect([w.runs.length, w.due()]).toEqual([3, [302_000]])
    await w.to(302_000)
    expect(w.runs.map((run) => run.at)).toEqual([0, 1_000, 2_000, 302_000])
    expect(w.watches).toHaveLength(1)
  })

  it('a watch that cannot start is tried again by the next pass, on the backoff', async () => {
    const folders: string[] = []
    const w = world([UNPLUGGED, UNPLUGGED, UNPLUGGED], fakeWindow(), {
      watch(folder, _changed, failed) {
        folders.push(folder)
        failed()
        return () => {}
      },
    })
    await w.until(() => w.runs.length === 1 && w.timers.size > 0)
    await w.to(3_000)
    expect([w.runs.map((run) => run.at), folders]).toEqual([[0, 1_000, 3_000], ['/run/h', '/run/h', '/run/h']])
    expect(w.logs).toEqual(['state: unplugged'])
  })

  it('the watch closes when the state leaves unplugged', async () => {
    const w = world([UNPLUGGED, null])
    await w.until(() => w.timers.size > 0)
    expect(w.watches[0].closed).toBe(false)
    await w.to(1_000)
    expect([w.states, w.watches.length, w.watches[0].closed]).toEqual([['unplugged', 'notRunning'], 1, true])
  })

  it('a folder change during a link run that then connects is let go: the pass after the stream waits 1 s', async () => {
    let answer!: (ran: Ran) => void
    const w = world([UNPLUGGED, new Promise<Ran>((settle) => (answer = settle))])
    await w.until(() => w.timers.size > 0)
    await w.to(1_000)
    await w.until(() => w.runs.length === 2)
    w.watches[0].changed('devices.sock')
    answer(READY)
    await w.until(() => w.streams.length === 1)
    w.streams[0].answer(200)
    await w.until(() => w.states.at(-1) === 'connected')
    await w.to(61_000)
    w.streams[0].end()
    await w.until(() => w.streams[0].signal.aborted)
    await flush()
    expect([w.runs.length, w.due()[0]]).toEqual([2, 62_000])
  })

  it('opens the stream with its window id and is connected at the head', async () => {
    const w = world([READY])
    await w.until(() => w.streams.length === 1)
    expect([w.streams[0].target, w.streams[0].body, w.states]).toEqual([{ socket: SOCKET }, OPEN, []])
    w.streams[0].answer(200)
    await w.until(() => w.states.length === 1)
    expect(w.states).toEqual(['connected'])
  })

  it('a head that has not come in 2 s is notRunning', async () => {
    const w = world([READY])
    await w.until(() => w.streams.length === 1)
    expect(w.due()).toEqual([2_000])
    await w.to(1_999)
    expect(w.states).toEqual([])
    await w.to(2_000)
    expect([w.states, w.streams[0].signal.aborted]).toEqual([['notRunning'], true])
  })

  it.each([409, 404, 500])('a %i is notRunning, and the next pass waits 1 s, then 2 s … 30 s', async (status) => {
    const w = world(Array.from({ length: 8 }, () => READY))
    for (let pass = 1; pass <= 8; pass++) {
      if (pass > 1) await w.to(w.due()[0])
      await w.until(() => w.streams.length === pass)
      w.streams[pass - 1].answer(status)
      await w.until(() => w.streams[pass - 1].signal.aborted && w.timers.size > 0)
    }
    expect(w.states).toEqual(['notRunning'])
    expect(w.runs.map((run) => run.at)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000])
  })

  it('a stream open over 30 s starts the wait at 1 s again; one open 30 s does not', async () => {
    for (const [open, wait] of [[30_001, 1_000], [30_000, 4_000]] as const) {
      // Two passes first, so the wait has grown to 4 s.
      const w = world([null, null, READY])
      await w.until(() => w.timers.size > 0)
      await w.to(3_000)
      await w.until(() => w.streams.length === 1)
      w.streams[0].answer(200)
      await w.until(() => w.states.length === 2)
      await w.to(3_000 + open)
      w.streams[0].end()
      await w.until(() => w.streams[0].signal.aborted)
      await flush()
      expect([open, w.due()[0]]).toEqual([open, 3_000 + open + wait])
    }
  })

  it('the state is sent once the head has come, then on each change, the latest only, at most four a second', async () => {
    const win = fakeWindow({ terminals: [101], active: 101, focused: true })
    const w = world([READY], win)
    await w.until(() => w.streams.length === 1)
    // Before the head, nothing is sent.
    win.set({ focused: false })
    await w.to(100)
    expect(w.posts).toEqual([])
    w.streams[0].answer(200)
    await w.until(() => w.posts.length === 1)
    expect([w.posts[0].at, sent(w.posts[0])]).toEqual([
      100,
      { type: 'vscode-state', window: ID, terminals: [101], active: 101, focused: false },
    ])
    // A burst inside the 250 ms is one post, of the latest state, at the slot.
    await w.to(150)
    win.set({ terminals: [101, 202] })
    win.set({ active: 202 })
    win.set({ focused: true })
    await flush()
    expect(w.posts).toHaveLength(1)
    await w.to(350)
    expect([w.posts.length, w.posts[1].at, sent(w.posts[1])]).toEqual([
      2,
      350,
      { type: 'vscode-state', window: ID, terminals: [101, 202], active: 202, focused: true },
    ])
    // A change every 50 ms for a second: four posts in it, the last one the latest state.
    for (let at = 400; at <= 1_350; at += 50) {
      await w.to(at)
      win.set({ terminals: [101, 202, at] })
    }
    await w.to(2_000)
    expect(w.posts.map((post) => post.at)).toEqual([100, 350, 600, 850, 1_100, 1_350, 1_600])
    expect(sent(w.posts[6]).terminals).toEqual([101, 202, 1_350])
    // A change long after the last slot goes at once.
    await w.to(5_000)
    win.set({ focused: false })
    await w.until(() => w.posts.length === 8)
    expect(w.posts[7].at).toBe(5_000)
  })

  it('a state equal to the last one taken is not sent', async () => {
    const win = fakeWindow({ terminals: [101], focused: true })
    const { w } = await connected(win)
    // A change and its undo inside the slot: at the slot, the state is the one taken.
    await w.to(100)
    win.set({ terminals: [101, 202] })
    win.set({ terminals: [101] })
    await w.to(1_000)
    // A change that says what was taken.
    win.set({ focused: true })
    await w.to(2_000)
    expect(w.posts).toHaveLength(1)
  })

  it("each state is a post of its own to the devices' socket, never on the stream", async () => {
    const win = fakeWindow({ terminals: [101] })
    const { w } = await connected(win)
    await w.to(1_000)
    win.set({ focused: true })
    await w.until(() => w.posts.length === 2)
    expect(w.posts.map((post) => [post.target, sent(post).focused])).toEqual([[{ socket: SOCKET }, false], [{ socket: SOCKET }, true]])
    expect(w.streams.map((stream) => stream.body)).toEqual([OPEN])
  })

  it('a post that fails is sent again at the next slot; three in a row end the stream', async () => {
    const win = fakeWindow({ terminals: [101] })
    const w = world([READY, READY], win)
    // Two that fail and one taken: the count starts again. Then three that fail.
    w.replies.push(500, null, 204, 409, 400, 503)
    await w.until(() => w.streams.length === 1)
    w.streams[0].answer(200)
    await w.to(500)
    expect(w.posts.map((post) => post.at)).toEqual([0, 250, 500])
    await w.to(1_000)
    expect(w.posts).toHaveLength(3)
    win.set({ focused: true })
    await w.to(1_500)
    expect(w.posts.map((post) => post.at)).toEqual([0, 250, 500, 1_000, 1_250, 1_500])
    expect(w.streams[0].signal.aborted).toBe(true)
    expect(w.due()[0]).toBe(2_500)
  })

  it('after the stream ends, the next one sends the state again', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win, [READY])
    expect(w.listening()).toBe(1)
    stream.end()
    await w.until(() => stream.signal.aborted)
    // Between streams, no change is listened to.
    expect(w.listening()).toBe(0)
    await w.to(1_000)
    await w.until(() => w.streams.length === 2)
    w.streams[1].answer(200)
    await w.until(() => w.posts.length === 2)
    expect([w.posts[1].at, w.posts[1].body, w.listening()]).toEqual([1_000, w.posts[0].body, 1])
  })

  it("a show line shows that shell's terminal; one for no terminal is counted", async () => {
    const win = fakeWindow({ terminals: [101, 202] })
    const { w, stream } = await connected(win)
    stream.send('{"show":202}\n{"show":303}\n')
    await w.until(() => win.shows.length === 2)
    expect(win.shows).toEqual([202, 303])
    await w.to(60_000)
    expect(w.logs).toEqual(['state: connected', 'in the last minute: 1 shows, 1 not found, 0 lines skipped, 1 states sent, 0 not sent, 0 page keys, 0 scroll lines, 0 dropped'])
  })

  it('a show that asks for the window raises it after the terminal is shown; one that does not, does not', async () => {
    const win = fakeWindow({ terminals: [101, 202] })
    const { w, stream } = await connected(win)
    stream.send('{"show":202,"raise":true}\n{"show":101}\n{"show":101,"raise":"yes"}\n{"show":303,"raise":true}\n')
    await w.until(() => win.shows.length === 4)
    expect(win.shows).toEqual([202, 101, 101, 303])
    // The first only: "yes" is not true, and a show that found no terminal raises nothing.
    expect(win.raised).toEqual([1])
    await w.to(60_000)
    expect(w.logs.at(-1)).toBe('in the last minute: 3 shows, 1 not found, 0 lines skipped, 1 states sent, 0 not sent, 0 page keys, 0 scroll lines, 0 dropped')
  })

  it('a line it does not know is skipped and counted', async () => {
    const win = fakeWindow({ terminals: [101] })
    const { w, stream } = await connected(win)
    const unknown = ['{"hide":101}', 'not json', '[]', 'null', '{"show":"101"}', '{"show":101.5}', '{"replaced":false}', '{}']
    stream.send(`${unknown.join('\n')}\n{"show":101,"tab":"api"}\n`)
    await w.until(() => win.shows.length === 1)
    expect(win.shows).toEqual([101])
    await w.to(60_000)
    expect(w.logs.at(-1)).toBe('in the last minute: 1 shows, 0 not found, 8 lines skipped, 1 states sent, 0 not sent, 0 page keys, 0 scroll lines, 0 dropped')
    expect(stream.signal.aborted).toBe(false)
  })

  it('n below zero scrolls up that many lines, above zero down', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-3,"pid":101}\n')
    await w.until(() => win.scrolls.length === 3)
    stream.send('{"scroll":2,"pid":101}\n')
    await w.until(() => win.scrolls.length === 5)
    await flush()
    expect(win.scrolls).toEqual([true, true, true, false, false])
  })

  it('more than 100 in a line runs 100', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":250,"pid":101}\n')
    await w.until(() => win.scrolls.length === 100)
    await flush()
    stream.send('{"scroll":-1000000000,"pid":101}\n')
    await w.until(() => win.scrolls.length === 200)
    await flush()
    expect([win.scrolls.length, win.scrolls.slice(0, 100).every((up) => !up), win.scrolls.slice(100).every((up) => up)]).toEqual([200, true, true])
  })

  it('a line for a terminal that is not the active one runs nothing and is counted', async () => {
    const win = fakeWindow({ terminals: [101, 202], active: 101 })
    const { w, stream } = await connected(win)
    // Another terminal of the window, then a pid no terminal has.
    stream.send('{"scroll":-3,"pid":202}\n{"scroll":2,"pid":303}\n')
    await flush()
    // No active terminal: the window sends that state too.
    win.set({ active: null })
    stream.send('{"scroll":-1,"pid":101}\n')
    await w.to(60_000)
    expect(win.scrolls).toEqual([])
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 2 states sent, 0 not sent, 0 page keys, 0 scroll lines, 3 dropped')
  })

  it('a run ends once its terminal is no longer the active one', async () => {
    const win = fakeWindow({ terminals: [101, 202], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('held')
    stream.send('{"scroll":-5,"pid":101}\n')
    await w.until(() => win.scrolls.length === 1)
    // The person clicks another terminal, or a show makes it active, while a line is in VS Code's hands.
    win.set({ active: 202 })
    win.release()
    await flush()
    expect(win.scrolls).toEqual([true])
    // A line for the terminal now active runs.
    stream.send('{"scroll":2,"pid":202}\n')
    await w.until(() => win.scrolls.length === 3)
    await flush()
    expect(win.scrolls).toEqual([true, false, false])
  })

  it('lines that come during a run are one next run for the same terminal, 100 at most', async () => {
    const win = fakeWindow({ terminals: [101, 202], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('held')
    stream.send('{"scroll":-1,"pid":101}\n')
    await w.until(() => win.scrolls.length === 1)
    stream.send('{"scroll":-60,"pid":101}\n{"scroll":-70,"pid":101}\n')
    await flush()
    // One run at a time.
    expect(win.scrolls).toHaveLength(1)
    win.release()
    await w.until(() => win.scrolls.length === 101)
    await flush()
    expect([win.scrolls.length, win.scrolls.every((up) => up)]).toEqual([101, true])
    // A line for another pid replaces what waits: the 5 for the active terminal never runs, and both are dropped.
    win.scrollReplies.push('held')
    stream.send('{"scroll":-1,"pid":101}\n')
    await w.until(() => win.scrolls.length === 102)
    stream.send('{"scroll":5,"pid":101}\n{"scroll":-2,"pid":202}\n')
    await flush()
    win.release()
    await w.to(60_000)
    expect(win.scrolls).toHaveLength(102)
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 0 page keys, 102 scroll lines, 2 dropped')
  })

  it.each(['{"scroll":0,"pid":7}', '{"scroll":-0,"pid":7}', '{"scroll":1.5,"pid":7}', '{"scroll":2}', '{"scroll":"2","pid":7}', '{"scroll":2,"pid":7.5}'])(
    '%s is skipped and counted',
    async (line) => {
      const win = fakeWindow({ terminals: [7], active: 7 })
      const { w, stream } = await connected(win)
      stream.send(`${line}\n`)
      await w.to(60_000)
      expect(win.scrolls).toEqual([])
      expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 1 lines skipped, 1 states sent, 0 not sent, 0 page keys, 0 scroll lines, 0 dropped')
    }
  )

  it('a scroll that rejects ends its run and is counted', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('rejected')
    stream.send('{"scroll":-3,"pid":101}\n')
    await w.until(() => win.scrolls.length === 1)
    await flush()
    expect(win.scrolls).toHaveLength(1)
    // The next line runs as any other.
    stream.send('{"scroll":1,"pid":101}\n')
    await w.until(() => win.scrolls.length === 2)
    await w.to(60_000)
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 0 page keys, 1 scroll lines, 1 dropped')
  })

  it("the minute's line counts each scrollLine that resolved as a scroll line, and each line that ran nothing as dropped", async () => {
    const win = fakeWindow({ terminals: [101, 202], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-3,"pid":101}\n')
    await w.until(() => win.scrolls.length === 3)
    stream.send('{"scroll":-3,"pid":202}\n')
    await w.to(60_000)
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 0 page keys, 3 scroll lines, 1 dropped')
  })

  it('stop ends a scroll run: no scroll follows, and what waited never runs', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('held')
    stream.send('{"scroll":-3,"pid":101}\n')
    await w.until(() => win.scrolls.length === 1)
    stream.send('{"scroll":-2,"pid":101}\n')
    await flush()
    await w.loop!.stop()
    win.release()
    await w.to(600_000)
    expect([win.scrolls.length, w.logs]).toEqual([1, ['state: connected']])
  })

  it('a page line of 21 sends 2 keys and keeps 5; the next page line for that shell adds to them', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-21,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 21)
    expect(win.pageKeys).toEqual([{ pid: 101, up: true }, { pid: 101, up: true }])
    stream.send('{"scroll":-3,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 24)
    await flush()
    expect([win.pageKeys.length, win.scrolls.every((up) => up)]).toEqual([3, true])
  })

  it('two page lines of 5 for one shell send one key', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-5,"pid":101,"page":true}\n{"scroll":-5,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 10)
    await flush()
    expect(win.pageKeys).toEqual([{ pid: 101, up: true }])
  })

  it('toward newer lines the key is PageDown', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":8,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 8)
    await flush()
    expect([win.pageKeys, win.scrolls.every((up) => !up)]).toEqual([[{ pid: 101, up: false }], true])
  })

  it("a line's keys go before its lines", async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('held')
    stream.send('{"scroll":-16,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 1)
    expect(win.pageKeys).toHaveLength(2)
    win.release()
  })

  it("a page line that comes during a run sends its keys at once: they wait behind none of the run's lines", async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('held')
    stream.send('{"scroll":-16,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 1)
    stream.send('{"scroll":-100,"pid":101,"page":true}\n')
    await flush()
    expect([win.pageKeys.length, win.scrolls.length]).toEqual([7, 1])
    win.release()
    await w.until(() => win.scrolls.length === 116)
    await flush()
    expect(win.pageKeys).toHaveLength(7)
  })

  it('no key follows a line with no page for that shell, though a page line came before it during the run', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('held')
    stream.send('{"scroll":-1,"pid":101}\n')
    await w.until(() => win.scrolls.length === 1)
    // The devices learned mid-stroke that the agent is asking: the rest of the stroke comes as lines with no page.
    stream.send('{"scroll":-40,"pid":101,"page":true}\n{"scroll":-5,"pid":101}\n')
    await flush()
    const pressed = win.pageKeys.length
    win.release()
    await w.until(() => win.scrolls.length === 46)
    await flush()
    expect(win.pageKeys).toHaveLength(pressed)
  })

  it.each([
    ['1 s with no page line', null],
    ['a page line for another shell', '{"scroll":-5,"pid":202,"page":true}'],
    ['a line with no page', '{"scroll":-1,"pid":101}'],
  ])('the remainder is forgotten after %s: the next page lines count from 0', async (_case, line) => {
    const win = fakeWindow({ terminals: [101, 202], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-5,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 5)
    if (line) stream.send(`${line}\n`)
    else await w.to(1_000)
    await flush()
    const before = win.scrolls.length
    stream.send('{"scroll":-5,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === before + 5)
    expect(win.pageKeys).toEqual([])
    // These 5 and the next 3 are the first page.
    stream.send('{"scroll":-3,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === before + 8)
    expect(win.pageKeys).toEqual([{ pid: 101, up: true }])
  })

  it('999 ms after the last page line keeps the remainder', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-3,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 3)
    await w.to(600)
    stream.send('{"scroll":-3,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 6)
    // 1.6 s after the first page line, 999 ms after the last.
    await w.to(1_599)
    stream.send('{"scroll":-2,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 8)
    expect(win.pageKeys).toEqual([{ pid: 101, up: true }])
  })

  it('a terminal that is not the active one gets no key', async () => {
    const win = fakeWindow({ terminals: [101, 202], active: 202 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-45,"pid":101,"page":true}\n')
    await w.to(60_000)
    expect([win.pageKeys, win.scrolls]).toEqual([[], []])
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 0 page keys, 0 scroll lines, 1 dropped')
  })

  it("a key no terminal takes is not counted and ends that line's keys; its lines still run", async () => {
    // Active, yet no terminal has that shell when its key is pressed.
    const win = fakeWindow({ terminals: [], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-45,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 45)
    await w.to(60_000)
    expect(win.pageKeys).toEqual([{ pid: 101, up: true }])
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 0 page keys, 45 scroll lines, 0 dropped')
  })

  it('a page line whose keys ran is not dropped, though VS Code refuses its first scroll', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('rejected')
    stream.send('{"scroll":-16,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 1)
    await w.to(60_000)
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 2 page keys, 0 scroll lines, 0 dropped')
  })

  it.each(['1', '"true"', 'false', 'null'])('a page of %s is no page: its lines run and no key is sent', async (page) => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send(`{"scroll":-45,"pid":101,"page":${page}}\n`)
    await w.until(() => win.scrolls.length === 45)
    await w.to(60_000)
    expect(win.pageKeys).toEqual([])
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 0 page keys, 45 scroll lines, 0 dropped')
  })

  it('at most 5 keys from one line, and what it leaves for the next is under one key', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-250,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 100)
    await flush()
    expect(win.pageKeys).toHaveLength(5)
    // The 4 left of the line's 100 and these 4 are one page.
    stream.send('{"scroll":-4,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 104)
    await flush()
    expect(win.pageKeys).toHaveLength(6)
    // Two page lines of 100 during a held line: 5 keys each at once, and their lines wait as one run of 100.
    win.scrollReplies.push('held')
    stream.send('{"scroll":-1,"pid":101}\n')
    await w.until(() => win.scrolls.length === 105)
    stream.send('{"scroll":-100,"pid":101,"page":true}\n{"scroll":-100,"pid":101,"page":true}\n')
    await flush()
    win.release()
    await w.until(() => win.scrolls.length === 205)
    await w.to(60_000)
    expect([win.pageKeys.length, win.scrolls.length]).toEqual([16, 205])
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 16 page keys, 205 scroll lines, 0 dropped')
  })

  it("the minute's line counts the page keys sent", async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    stream.send('{"scroll":-16,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 16)
    await w.to(60_000)
    expect(w.logs.at(-1)).toBe('in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 2 page keys, 16 scroll lines, 0 dropped')
  })

  it('stop ends a run: a page line that came during it sent its keys at once, and none of its lines run', async () => {
    const win = fakeWindow({ terminals: [101], active: 101 })
    const { w, stream } = await connected(win)
    win.scrollReplies.push('held')
    stream.send('{"scroll":-16,"pid":101,"page":true}\n')
    await w.until(() => win.scrolls.length === 1)
    stream.send('{"scroll":-16,"pid":101,"page":true}\n')
    await flush()
    await w.loop!.stop()
    win.release()
    await w.to(600_000)
    expect([win.pageKeys.length, win.scrolls.length, w.logs]).toEqual([4, 1, ['state: connected']])
  })

  it('a line split across two chunks is one line, and two lines in one chunk are two', async () => {
    const win = fakeWindow({ terminals: [101, 202] })
    const { w, stream } = await connected(win)
    const line = bytes('{"show":101,"note":"café"}\n')
    // Between the two bytes of é.
    const cut = line.indexOf(0xa9)
    stream.send(line.subarray(0, cut), line.subarray(cut))
    await w.until(() => win.shows.length === 1)
    stream.send('{"show":202}\n{"show":101}\n')
    await w.until(() => win.shows.length === 3)
    expect(win.shows).toEqual([101, 202, 101])
  })

  it.each([
    ['over 1 KiB', `${'x'.repeat(1_024)}\n`],
    ['1 KiB with no newline', 'x'.repeat(1_024)],
  ])('a line %s ends the stream, and is counted; one of 1 KiB with its newline is taken', async (_case, tooLong) => {
    const win = fakeWindow({ terminals: [101] })
    const { w, stream } = await connected(win)
    const padded = `{"show":101${' '.repeat(1_023 - '{"show":101}'.length)}}`
    stream.send(`${padded}\n`)
    await w.until(() => win.shows.length === 1)
    stream.send(tooLong)
    await w.until(() => stream.signal.aborted)
    await flush()
    expect(w.due()[0]).toBe(1_000)
    await w.to(60_000)
    expect(w.logs.at(-1)).toBe('in the last minute: 1 shows, 0 not found, 1 lines skipped, 1 states sent, 0 not sent, 0 page keys, 0 scroll lines, 0 dropped')
  })

  it('replaced stops the loop: no pass follows, and nothing is logged', async () => {
    const win = fakeWindow({ terminals: [101] })
    const { w, stream } = await connected(win)
    stream.send('{"show":101}\n{"replaced":true}\n')
    await w.until(() => stream.signal.aborted)
    await flush()
    expect([w.timers.size, w.listening()]).toEqual([0, 0])
    win.set({ focused: true })
    await w.to(600_000)
    expect([w.runs.length, w.streams.length, w.posts.length, win.shows, w.logs]).toEqual([1, 1, 1, [101], ['state: connected']])
  })

  it('the channel gets each state once and a minute\'s counts, and never a pid or the window id', async () => {
    const win = fakeWindow({ terminals: [101, 202], active: 202, focused: true })
    const w = world([null, null, READY], win)
    // The state at the head is taken; the next one is not at first, then is.
    w.replies.push(204, 500)
    await w.to(3_000)
    await w.until(() => w.streams.length === 1)
    w.streams[0].answer(200)
    await w.until(() => w.posts.length === 1)
    win.set({ active: 101 })
    w.streams[0].send('{"show":202}\n{"show":303}\nnope\n')
    await w.to(62_999)
    expect(w.logs).toEqual(['state: notRunning', 'state: connected'])
    await w.to(63_000)
    expect(w.logs).toEqual([
      'state: notRunning',
      'state: connected',
      'in the last minute: 1 shows, 1 not found, 1 lines skipped, 2 states sent, 1 not sent, 0 page keys, 0 scroll lines, 0 dropped',
    ])
    // A minute with nothing in it logs nothing; the next event starts the next minute.
    await w.to(200_000)
    expect(w.logs).toHaveLength(3)
    w.streams[0].send('{"show":101}\n')
    await w.until(() => win.shows.length === 3)
    await w.to(259_999)
    expect(w.logs).toHaveLength(3)
    await w.to(260_000)
    expect(w.logs[3]).toBe('in the last minute: 1 shows, 0 not found, 0 lines skipped, 0 states sent, 0 not sent, 0 page keys, 0 scroll lines, 0 dropped')
    expect(w.states).toEqual(['notRunning', 'connected'])
    expect(w.logs.filter((line) => /101|202|303/.test(line) || line.includes(ID))).toEqual([])
  })

  it('stop ends a link still running, and nothing is told after', async () => {
    const w = world([])
    await w.until(() => w.runs.length === 1)
    await w.loop!.stop()
    expect([w.runs.length, w.runs[0].signal.aborted, w.states, w.logs, w.timers.size]).toEqual([1, true, [], [], 0])
  })

  it('stop ends a connect that waits for its head, and leaves no timer', async () => {
    const w = world([READY])
    await w.until(() => w.streams.length === 1)
    await w.loop!.stop()
    expect([w.streams[0].signal.aborted, w.states, w.timers.size]).toEqual([true, [], 0])
  })

  it('stop closes the watch: a change after it asks nothing', async () => {
    const w = world([UNPLUGGED])
    await w.until(() => w.timers.size > 0)
    await w.loop!.stop()
    w.watches[0].changed('devices.sock')
    expect([w.watches[0].closed, w.runs.length, w.timers.size]).toEqual([true, 1, 0])
  })

  it('stop ends the stream and a post in flight, and nothing is sent, told or logged after', async () => {
    const win = fakeWindow({ terminals: [101] })
    const { w, stream } = await connected(win)
    w.replies.push('held')
    await w.to(1_000)
    win.set({ focused: true })
    stream.send('nope\n')
    await w.until(() => w.posts.length === 2)
    await flush()
    await w.loop!.stop()
    expect([stream.signal.aborted, w.posts[1].signal.aborted, w.timers.size, w.listening()]).toEqual([true, true, 0, 0])
    win.set({ focused: false })
    stream.send('{"show":101}\n')
    await w.to(600_000)
    expect([w.posts.length, win.shows, w.states, w.logs]).toEqual([2, [], ['connected'], ['state: connected']])
  })
})

describe('startLoop on Windows', () => {
  it("runs the profile's harness.exe first, then harness in PATH's absolute folders, each name one argument", async () => {
    const w = world([MISSING, MISSING], fakeWindow(), { ...WINDOWS, path: 'C:\\Windows\\System32;.;node_modules\\.bin;;C:\\Program Files\\nodejs' })
    await w.until(() => w.states.length > 0)
    expect(w.runs.map(({ file, args, path }) => ({ file, args, path }))).toEqual([
      { file: "C:\\Users\\Nguyễn Văn A' & 100%\\.harness\\bin\\harness.exe", args: LINK.args, path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' },
      { file: 'harness', args: LINK.args, path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' },
    ])
    expect(w.states).toEqual(['noHarness'])
  })

  it('a ready line opens the stream on the pipe with its token, posts the state there, and a show line shows the terminal', async () => {
    const win = fakeWindow({ terminals: [101, 202] })
    const w = world([JSON.stringify(WINDOWS_READY)], win, WINDOWS)
    await w.until(() => w.streams.length === 1)
    w.streams[0].answer(200)
    await w.until(() => w.posts.length === 1)
    w.streams[0].send('{"show":202}\n')
    await w.until(() => win.shows.length === 1)
    const target = { pipe: '\\\\.\\pipe\\harness-0123456789abcdef0123456789abcdef', token: '0123456789abcdef'.repeat(4) }
    expect([w.streams[0].target, w.streams[0].body, w.posts[0].target, w.states, win.shows]).toEqual([target, OPEN, target, ['connected'], [202]])
  })

  it('a line with a pipe on another computer, a bad token or a relative record is notRunning, and nothing is connected', async () => {
    const lines = [
      { ...WINDOWS_READY, devicesPipe: '\\\\srv\\pipe\\harness-0123456789abcdef0123456789abcdef' },
      { ...WINDOWS_READY, devicesToken: TOKEN.slice(1) },
      { ...WINDOWS_READY, devicesToken: `A${TOKEN.slice(1)}` },
      { ...WINDOWS_READY, devicesToken: undefined },
      { ...WINDOWS_READY, devicesRecord: '.harness\\devices.json' },
      { daemon: true, devicesReady: false, devicesRecord: '.harness\\devices.json' },
    ]
    for (const line of lines) {
      const out = JSON.stringify(line)
      const w = world([out], fakeWindow(), WINDOWS)
      await w.until(() => w.states.length > 0)
      expect([out, w.states, w.streams, w.watches]).toEqual([out, ['notRunning'], [], []])
    }
  })

  it("unplugged watches the record's folder, and only a devices.json entry there asks link again", async () => {
    const w = world([WINDOWS_UNPLUGGED, WINDOWS_UNPLUGGED, WINDOWS_UNPLUGGED], fakeWindow(), WINDOWS)
    await w.until(() => w.states.length === 1 && w.timers.size > 0)
    expect([w.states, w.watches.map((watch) => watch.folder)]).toEqual([['unplugged'], ["C:\\Users\\Nguyễn Văn A' & 100%\\.harness"]])
    await w.to(1_000)
    expect(w.due()).toEqual([301_000])
    await w.to(1_500)
    w.watches[0].changed('devices-token')
    expect(w.due()).toEqual([301_000])
    w.watches[0].changed('devices.json')
    expect(w.due()).toEqual([2_000])
    await w.to(2_000)
    expect([w.runs.length, w.watches.length]).toEqual([3, 1])
  })

  it('no line it logs holds the token', async () => {
    const win = fakeWindow({ terminals: [101] })
    const w = world([JSON.stringify(WINDOWS_READY)], win, WINDOWS)
    await w.until(() => w.streams.length === 1)
    w.streams[0].answer(200)
    w.streams[0].send('{"show":101}\n')
    await w.to(60_000)
    expect([w.logs.length, w.logs.filter((line) => line.includes(TOKEN))]).toEqual([2, []])
  })
})
