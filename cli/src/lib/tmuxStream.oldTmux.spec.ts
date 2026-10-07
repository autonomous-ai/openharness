/**
 * The terminal on the tmux a distribution ships. Debian 10 ships 2.8, Ubuntu 20.04 3.0a, Debian 11 3.1c:
 * before 3.2 the control client's `-f ignore-size` was a usage error and no terminal opened at all;
 * before 3.1 `capture-pane -N` failed every snapshot; before 3.0 `send-keys -H` failed every keystroke;
 * before 2.9 there was no `resize-window`. Each is asked of the tmux by name (`tmuxVersion.ts`), and
 * the same stream is proven against real tmux 2.8 and 3.0a in tmuxStream.real.spec.ts.
 */
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmuxControlGate } from './tmuxControlGate.js'
import { TmuxControlStream } from './tmuxStream.js'
import { assumeTmuxVersion, resetTmuxVersionCache, type TmuxVersion } from './tmuxVersion.js'

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}))

afterEach(() => {
  vi.resetAllMocks()
  resetTmuxVersionCache()
})

/** A control client that answers every command, `display-message` with [meta], and records what it was sent. */
function controlClient(version: TmuxVersion, meta = '$1|@1|1|80|24|80|24|0|0|0|1|0|0|0|0|0', answersAttach = true) {
  assumeTmuxVersion(version)
  const sent: string[] = []
  const child = new EventEmitter() as {
    -readonly [K in keyof ChildProcessWithoutNullStreams]: ChildProcessWithoutNullStreams[K]
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  let command = 1
  child.kill = () => { child.exitCode = 0; child.emit('close', 0); return true }
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString().replace(/\n$/, '')
      sent.push(line)
      const number = command++
      setImmediate(() => {
        callback()
        if (line.startsWith('detach-client')) { child.kill(); return }
        const body = line.startsWith('display-message') ? `${meta}\n` : ''
        child.stdout.emit('data', Buffer.from(`%begin 1 ${number} 0\n${body}%end 1 ${number} 0\n`))
      })
    },
  })
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args.at(-1) as (error: null, stdout: Buffer) => void)(null, Buffer.from(`${meta}\n`))
    return child
  }) as typeof execFile)
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => {
      child.emit('spawn')
      if (answersAttach) setImmediate(() => child.stdout.emit('data', Buffer.from('%begin 1 0 0\n%end 1 0 0\n')))
    })
    return child
  })
  return { sent }
}

async function open(size = { cols: 80, rows: 24 }, readOnly = false) {
  const opened = await TmuxControlStream.open('%1', size, { onData: () => {}, onClose: () => {} }, readOnly)
  expect(opened.state).toBe('succeeded')
  if (opened.state !== 'succeeded') throw new Error('stream did not open')
  return opened.value
}

describe('the terminal on an older tmux', () => {
  it.each([
    [{ major: 3, minor: 2 }, ['-C', 'attach-session', '-f', 'ignore-size', '-t', '%1']],
    // Before client flags the control client never sets a size of its own, and counts for none.
    [{ major: 3, minor: 1 }, ['-C', 'attach-session', '-t', '%1']],
    [{ major: 2, minor: 8 }, ['-C', 'attach-session', '-t', '%1']],
  ])('attaches its control client as tmux %o takes it', async (version, argv) => {
    controlClient(version)
    const stream = await open()
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(argv)
    await stream.close()
  })

  it('types through send-keys -H from 3.0, and as literal text and keys before it', async () => {
    const modern = controlClient({ major: 3, minor: 0 })
    let stream = await open()
    expect((await stream.writeRaw(Buffer.from("ls;\n"))).state).toBe('succeeded')
    expect(modern.sent.slice(-1)).toEqual(['send-keys -t %1 -H 6c 73 3b 0a'])
    await stream.close()

    vi.resetAllMocks()
    const old = controlClient({ major: 2, minor: 8 })
    stream = await open()
    expect((await stream.writeRaw(Buffer.from("echo 'hi';\n-x"))).state).toBe('succeeded')
    expect(old.sent.slice(-3)).toEqual([
      `send-keys -t %1 -l -- 'echo '"'"'hi'"'"'\\;'`,
      'send-keys -t %1 C-j',
      `send-keys -t %1 -l -- '-x'`,
    ])
    await stream.close()
  })

  it('sizes its window with resize-window from 2.9, and as a control client before it, never under 2x2', async () => {
    const modern = controlClient({ major: 2, minor: 9 })
    let stream = await open({ cols: 100, rows: 30 })
    expect(modern.sent).toContain('resize-window -t @1 -x 100 -y 30')
    await stream.close()

    vi.resetAllMocks()
    const old = controlClient({ major: 2, minor: 8 })
    stream = await open({ cols: 100, rows: 30 })
    expect((await stream.resize({ cols: 1, rows: 1 })).state).toBe('succeeded')
    expect(old.sent.filter((line) => /resize|refresh/.test(line))).toEqual(['refresh-client -C 100,30', 'refresh-client -C 2,2'])
    await stream.close()
  })

  it('keeps a row\'s trailing blanks from 3.1, and captures without asking for them before it', async () => {
    for (const [version, flag] of [[{ major: 3, minor: 1 }, ' -N'], [{ major: 3, minor: 0 }, '']] as const) {
      vi.resetAllMocks()
      const client = controlClient(version)
      const stream = await open()
      stream.beginSnapshot()
      expect((await stream.snapshot()).state).toBe('succeeded')
      stream.endSnapshot()
      expect(client.sent.filter((line) => line.startsWith('capture-pane'))).toEqual([
        `capture-pane -p -e${flag} -t %1 -S -500 -E -1`,
        `capture-pane -p -e${flag} -t %1`,
      ])
      await stream.close()
    }
  })
})

describe('a terminal on a tmux that crashes when one attaches as another goes (tmuxControlGate.ts)', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const empty = { room: null, inside: 0, waiting: 0 }
  afterEach(() => { vi.useRealTimers() })

  it('attaches in the attach room until tmux answers, and goes in the other, asking tmux once more before it leaves', async () => {
    const client = controlClient({ major: 3, minor: 4 })
    const atSpawn: unknown[] = []
    const attach = vi.mocked(spawn).getMockImplementation()!
    vi.mocked(spawn).mockImplementation(((...args: Parameters<typeof spawn>) => {
      atSpawn.push(tmuxControlGate.state)
      return attach(...args)
    }) as typeof spawn)
    const stream = await open()
    await stream.attached
    expect(atSpawn).toEqual([{ room: 'attach', inside: 1, waiting: 0 }])
    expect(tmuxControlGate.state).toEqual(empty)

    // Another terminal attaching: this one's `detach-client` waits for it.
    const attaching = await tmuxControlGate.enter('attach')
    vi.mocked(execFile).mockClear()
    const closing = stream.close()
    await tick()
    expect(client.sent).not.toContain('detach-client')
    attaching()
    await closing
    expect(client.sent.at(-1)).toBe('detach-client')
    // tmux tells the others it went only once it reads the socket close: one more answer comes after that.
    expect(vi.mocked(execFile).mock.calls.map((call) => call[1])).toEqual([['display-message', '-p', '#{pid}']])
    expect(tmuxControlGate.state).toEqual(empty)
  })

  it('on tmux 3.7 neither waits nor asks again', async () => {
    const client = controlClient({ major: 3, minor: 7 })
    const stream = await open()
    const attaching = await tmuxControlGate.enter('attach')
    vi.mocked(execFile).mockClear()
    try {
      await stream.close()
      expect(client.sent.at(-1)).toBe('detach-client')
      expect(vi.mocked(execFile)).not.toHaveBeenCalled()
    } finally {
      attaching()
    }
  })

  it('leaves the attach room when its client cannot start', async () => {
    controlClient({ major: 3, minor: 4 })
    vi.mocked(spawn).mockImplementation((() => {
      const child = new EventEmitter()
      setImmediate(() => child.emit('error', new Error('spawn tmux ENOENT')))
      return child
    }) as unknown as typeof spawn)
    const opened = await TmuxControlStream.open('%1', { cols: 80, rows: 24 }, { onData: () => {}, onClose: () => {} })
    expect(opened).toEqual({ state: 'failed', reason: 'tmux control client could not start' })
    expect(tmuxControlGate.state).toEqual(empty)
  })

  it('keeps the others waiting no longer than its first command may take, when tmux never answers its attach', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    controlClient({ major: 3, minor: 4 }, undefined, false)
    const watching = await open(undefined, true)
    expect(tmuxControlGate.state).toEqual({ room: 'attach', inside: 1, waiting: 0 })
    vi.advanceTimersByTime(3_000)
    expect(tmuxControlGate.state).toEqual(empty)
    await watching.close()
    expect(tmuxControlGate.state).toEqual(empty)
  })
})
