import { chmodSync } from 'fs'
import { appendFile, mkdtemp, open, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Watcher, type HistoryEvent, type LineEvent, type RewrittenEvent } from './watcher.js'

const cleanup: string[] = []

/** Waits for what a timer delivers — a released hold's read, an expired hold — however slow the machine. */
const until = async (what: string, test: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Watcher.pollAll', () => {
  it('drains every registered transcript to EOF without waiting for chokidar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-watcher-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"n":1}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath })
    await appendFile(transcriptPath, '{"n":2}\n{"n":3}\n')

    await watcher.pollAll()

    expect(lines).toEqual(['{"n":2}', '{"n":3}'])
    await watcher.stop()
  })

  it('replays only the changed Cursor suffix when a trailing turn sentinel is replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-cursor-watcher-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    const user = '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}'
    const assistant = '{"role":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
    const ended = '{"type":"turn_ended","status":"completed"}'
    await writeFile(transcriptPath, `${user}\n${ended}\n`)
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    await watcher.addSession({ sessionId: 's1', engine: 'cursor', transcriptPath })

    await writeFile(transcriptPath, `${user}\n${assistant}\n`)
    await watcher.pollSession('s1')
    await appendFile(transcriptPath, `${ended}\n`)
    await watcher.pollSession('s1')

    expect(lines).toEqual([assistant, ended])
    await watcher.stop()
  })

  it('can emit an existing Cursor transcript from the start for first-turn discovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-cursor-first-turn-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"n":1}\n{"n":2}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))

    await watcher.addSession(
      { sessionId: 's1', engine: 'cursor', transcriptPath },
      { fromStart: true },
    )
    await watcher.pollSession('s1')

    expect(lines).toEqual(['{"n":1}', '{"n":2}'])
    await watcher.stop()
  })

  it('emits a file-backed transcript from the start when nothing was folded', async () => {
    // The generic byte-tail branch, which every JSONL engine uses. `fromStart` was only ever covered for
    // cursor, and the gap was live: pi's agent is discovered the moment the engine starts but its session
    // file only materialises once the first answer is written, so the re-attach that finally brought the
    // path tailed from the file's END and the whole first turn — prompt, tools and answer — was read as
    // history that never reached web or device.
    const dir = await mkdtemp(join(tmpdir(), 'machine-first-turn-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"a":1}\n{"a":2}\n{"a":3}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    const history: string[][] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    watcher.on('history', (batch: HistoryEvent) => history.push(batch.lines.map((l) => l.text)))

    await watcher.addSession({ sessionId: 'p1', engine: 'pi', transcriptPath }, { fromStart: true })
    await watcher.pollSession('p1')

    // Everything that was on disk when the tail was placed arrives as ONE history batch, so the
    // consumer can tell a prompt already answered from the one turn that may still be running; what
    // is appended afterwards is live, line by line.
    expect(history).toEqual([['{"a":1}', '{"a":2}', '{"a":3}']])
    expect(lines).toEqual([])
    await appendFile(transcriptPath, '{"a":4}\n')
    await watcher.pollSession('p1')
    expect(lines).toEqual(['{"a":4}'])
    expect(history).toHaveLength(1)
    await watcher.stop()
  })

  it('reads a file that shrank under it as history, not as a conversation happening now', async () => {
    // The untrusted-producer version of the repair case below: a transcript rewritten in place by
    // something that never called setTail. The old behaviour re-emitted the whole file as live — on
    // prod that was one agent credited with 42 turns in a single second.
    const dir = await mkdtemp(join(tmpdir(), 'machine-shrink-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"t":1}\n{"t":2}\n{"t":3}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    const history: string[][] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    watcher.on('history', (batch: HistoryEvent) => history.push(batch.lines.map((l) => l.text)))

    await watcher.addSession({ sessionId: 'x1', engine: 'pi', transcriptPath })
    await watcher.pollSession('x1')
    expect(lines).toEqual([])

    await writeFile(transcriptPath, '{"t":1}\n{"t":2}\n') // shorter than the tail's cursor
    await watcher.pollSession('x1')
    expect(history).toEqual([['{"t":1}', '{"t":2}']])
    expect(lines).toEqual([])

    await appendFile(transcriptPath, '{"t":4}\n')
    await watcher.pollSession('x1')
    expect(lines).toEqual(['{"t":4}'])
    expect(history).toHaveLength(1)
    await watcher.stop()
  })

  it('splits one chunk into its historical prefix and its live rest', async () => {
    // A `fromStart` tail placed on a file that grows before the first read: the bytes below the
    // cursor's placement are history, the bytes appended since are not, and they arrive in the
    // same read. The split is by byte position, so a multi-byte line cannot shift it.
    const dir = await mkdtemp(join(tmpdir(), 'machine-split-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"h":"xin chào"}\n{"h":2}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    const history: string[][] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    watcher.on('history', (batch: HistoryEvent) => history.push(batch.lines.map((l) => l.text)))

    await watcher.addSession({ sessionId: 's1', engine: 'pi', transcriptPath }, { fromStart: true })
    await appendFile(transcriptPath, '{"live":3}\n')
    await watcher.pollSession('s1')

    expect(history).toEqual([['{"h":"xin chào"}', '{"h":2}']])
    expect(lines).toEqual(['{"live":3}'])
    await watcher.stop()
  })

  it('still starts at the end by default, so a resumed session does not replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-resume-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"old":1}\n{"old":2}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))

    await watcher.addSession({ sessionId: 'p2', engine: 'pi', transcriptPath })
    await watcher.pollSession('p2')
    expect(lines).toEqual([])

    await writeFile(transcriptPath, '{"old":1}\n{"old":2}\n{"new":3}\n')
    await watcher.pollSession('p2')
    expect(lines).toEqual(['{"new":3}'])
    await watcher.stop()
  })

  it('does not replay a rollout repaired (shrunk) in place once the tail is re-synced', async () => {
    // The Codex resume reasoning-id repair rewrites the rollout to a SHORTER file before the engine
    // relaunches. Without moving the tail, the next read sees size < offset, treats the shrink as a
    // truncation, resets to 0, and re-emits the whole conversation into the live normalizer. setTail
    // pins the offset to the repaired length so only the resumed turn is read.
    const dir = await mkdtemp(join(tmpdir(), 'machine-repair-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"meta":1}\n{"reasoning":"msg_bad_id"}\n{"answer":1}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))

    await watcher.addSession({ sessionId: 'c1', engine: 'codex', transcriptPath })
    await watcher.pollSession('c1')
    expect(lines).toEqual([])

    const repaired = '{"meta":1}\n{"reasoning":""}\n{"answer":1}\n' // shorter: the stale id was stripped
    await writeFile(transcriptPath, repaired)
    watcher.setTail('c1', Buffer.byteLength(repaired))
    await watcher.pollSession('c1')
    expect(lines).toEqual([]) // the repaired history is NOT re-emitted

    await appendFile(transcriptPath, '{"resumed":2}\n')
    await watcher.pollSession('c1')
    expect(lines).toEqual(['{"resumed":2}']) // only the resumed engine's new turn
    await watcher.stop()
  })

  it('setTail is a harmless no-op for a session that is not registered', async () => {
    // The post-reboot restore path repairs the rollout before it re-attaches the tail, so there is
    // nothing to move — this must not throw.
    const watcher = new Watcher()
    expect(() => watcher.setTail('never-registered', 123)).not.toThrow()
    await watcher.stop()
  })
})

describe('Watcher.addSession fromOffset', () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-watcher-offset-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    const watcher = new Watcher()
    const lines: string[] = []
    const history: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    watcher.on('history', (event: HistoryEvent) => history.push(...event.lines.map((line) => line.text)))
    return { transcriptPath, watcher, lines, history }
  }

  it('tails from where the attach stopped reading, so a record written meanwhile is streamed live', async () => {
    const { transcriptPath, watcher, lines, history } = await setup()
    await writeFile(transcriptPath, '{"n":1}\n{"n":2}\n')
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath }, { fromOffset: 8 })
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":2}'])
    expect(history).toEqual([])
    await watcher.stop()
  })

  it('starts at the new end when the file shrank since the attach read it', async () => {
    const { transcriptPath, watcher, lines } = await setup()
    await writeFile(transcriptPath, '{"n":1}\n')
    await watcher.addSession({ sessionId: 's1', engine: 'claude', transcriptPath }, { fromOffset: 500 })
    await appendFile(transcriptPath, '{"n":2}\n')
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":2}'])
    await watcher.stop()
  })

  it('lets fromStart win, reading the existing content as history', async () => {
    const { transcriptPath, watcher, lines, history } = await setup()
    await writeFile(transcriptPath, '{"n":1}\n{"n":2}\n')
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath }, { fromStart: true, fromOffset: 8 })
    await watcher.pollSession('s1')
    expect(history).toEqual(['{"n":1}', '{"n":2}'])
    expect(lines).toEqual([])
    await watcher.stop()
  })
})

describe('Watcher.hold and release', () => {
  const tailed = async (content: string | Buffer) => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-watcher-hold-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, content)
    const watcher = new Watcher()
    const lines: string[] = []
    const history: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    watcher.on('history', (event: HistoryEvent) => history.push(...event.lines.map((line) => line.text)))
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath })
    return { transcriptPath, watcher, lines, history }
  }

  it('stops delivery where the next line starts, a carried partial line included, and resumes from a given byte', async () => {
    const { transcriptPath, watcher, lines } = await tailed('{"n":1}\n')
    await appendFile(transcriptPath, '{"n":2}\n{"n":')
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":2}'])
    const hold = (await watcher.hold('s1', transcriptPath))!
    expect(hold.offset).toBe(16)
    await appendFile(transcriptPath, '3}\n{"n":4}\n')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(lines).toEqual(['{"n":2}'])
    hold.release(24)
    hold.release(0)
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":2}', '{"n":4}'])
    await watcher.stop()
  })

  it('counts a partial line in bytes, a character split between two reads included, and decodes it whole', async () => {
    const { transcriptPath, watcher, lines } = await tailed('{"n":1}\n')
    const accented = Buffer.from('{"a":"é漢"}\n')
    await appendFile(transcriptPath, accented.subarray(0, 9))
    await watcher.pollSession('s1')
    expect(lines).toEqual([])
    const hold = (await watcher.hold('s1', transcriptPath))!
    expect(hold.offset).toBe(8)
    hold.release()
    await appendFile(transcriptPath, accented.subarray(9))
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"a":"é漢"}'])
    await watcher.stop()
  })

  it('keeps its own position when released without one, and delivers what arrived while held', async () => {
    const { transcriptPath, watcher, lines } = await tailed('')
    const hold = (await watcher.hold('s1', transcriptPath))!
    await appendFile(transcriptPath, '{"n":1}\n')
    hold.release()
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":1}'])
    await watcher.stop()
  })

  it('stays held until every hold is released, and a drain waits for that', async () => {
    const { transcriptPath, watcher, lines } = await tailed('')
    const first = (await watcher.hold('s1', transcriptPath))!
    const second = (await watcher.hold('s1', transcriptPath))!
    await appendFile(transcriptPath, '{"n":1}\n')
    let drained = false
    const drain = watcher.pollSession('s1').then(() => { drained = true })
    first.release()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(drained).toBe(false)
    expect(lines).toEqual([])
    second.release()
    await drain
    expect(lines).toEqual(['{"n":1}'])
    await watcher.stop()
  })

  it('lets go of a hold an attach never releases, says so, and lets a late release change nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { transcriptPath, watcher, lines } = await tailed('')
      const hold = (await watcher.hold('s1', transcriptPath, 40))!
      expect(hold.expired).toBe(false)
      await appendFile(transcriptPath, '{"n":1}\n')
      await until('the hold to let go and its read to deliver', () => lines.length > 0)
      expect(warn).toHaveBeenCalledOnce()
      expect(hold.expired).toBe(true)
      expect(lines).toEqual(['{"n":1}'])
      // The attach finishing late: where its read stopped is behind what was delivered since.
      hold.release(0)
      await appendFile(transcriptPath, '{"n":2}\n')
      await watcher.pollSession('s1')
      expect(lines).toEqual(['{"n":1}', '{"n":2}'])
      await watcher.stop()
    } finally { warn.mockRestore() }
  })

  it('keeps the position a repair moved the tail to while it was held', async () => {
    const { transcriptPath, watcher, lines, history } = await tailed(`{"n":1,"r":"${'x'.repeat(200)}"}\n{"n":2}\n`)
    const hold = (await watcher.hold('s1', transcriptPath))!
    // The Codex resume repair shrinks the rollout in place and pins the tail to its new end.
    const repaired = '{"n":1}\n{"n":2}\n'
    await writeFile(transcriptPath, repaired)
    watcher.setTail('s1', Buffer.byteLength(repaired))
    await appendFile(transcriptPath, '{"n":3}\n')
    hold.release(hold.offset)
    await watcher.pollSession('s1')
    expect({ lines, history }).toEqual({ lines: ['{"n":3}'], history: [] })
    await watcher.stop()
  })

  it('drains through a hold that lands during its read, once the hold lets go', async () => {
    const { transcriptPath, watcher, lines } = await tailed('')
    await appendFile(transcriptPath, '{"n":1}\n')
    const reading = watcher.pollAll()
    let drained = false
    // A drain asked for while that read runs (the Stop hook's), then a reset attach takes the tail.
    const drain = watcher.pollSession('s1').then(() => { drained = true })
    const held = watcher.hold('s1', transcriptPath)
    await appendFile(transcriptPath, '{"n":2}\n')
    await reading
    const hold = (await held)!
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(drained).toBe(false)
    hold.release()
    await drain
    expect(lines).toEqual(['{"n":1}', '{"n":2}'])
    await watcher.stop()
  })

  it('ends a drain waiting on a hold when the session is removed, or the watcher stops', async () => {
    for (const end of ['remove', 'stop'] as const) {
      const { transcriptPath, watcher } = await tailed('')
      const hold = (await watcher.hold('s1', transcriptPath))!
      const drain = watcher.pollSession('s1')
      if (end === 'remove') await watcher.removeSession('s1')
      else await watcher.stop()
      await drain
      hold.release()
      await watcher.stop()
    }
  })

  it('says which file it tails for a session', async () => {
    const { transcriptPath, watcher } = await tailed('')
    expect(watcher.tails('s1', transcriptPath)).toBe(true)
    expect(watcher.tails('s1', `${transcriptPath}.other`)).toBe(false)
    expect(watcher.tails('nobody', transcriptPath)).toBe(false)
    await watcher.removeSession('s1')
    expect(watcher.tails('s1', transcriptPath)).toBe(false)
    await watcher.stop()
  })

  it('stops a read in progress that more data would keep going, at the hold', async () => {
    const { transcriptPath, watcher, lines } = await tailed('')
    await appendFile(transcriptPath, '{"n":1}\n')
    const reading = watcher.pollAll()
    const held = watcher.hold('s1', transcriptPath)
    // Asks for another read while the first is running: without the hold the read would loop on.
    const another = watcher.pollAll()
    await appendFile(transcriptPath, '{"n":2}\n')
    await reading
    const hold = (await held)!
    await another
    expect(lines).toEqual(['{"n":1}'])
    hold.release()
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":1}', '{"n":2}'])
    await watcher.stop()
  })

  it('reads again when more is asked for during a read', async () => {
    const { transcriptPath, watcher, lines } = await tailed('')
    await appendFile(transcriptPath, '{"n":1}\n')
    const reading = watcher.pollSession('s1')
    const another = watcher.pollAll()
    await appendFile(transcriptPath, '{"n":2}\n')
    await reading
    await another
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":1}', '{"n":2}'])
    await watcher.stop()
  })

  it('skips blank lines and line endings in a live read', async () => {
    const { transcriptPath, watcher, lines } = await tailed('')
    await appendFile(transcriptPath, '\n  \r\n{"n":1}\r\n\n{"n":2}\n')
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":1}', '{"n":2}'])
    await watcher.stop()
  })

  it('waits out a read in progress, and that read stops at the hold', async () => {
    const { transcriptPath, watcher, lines } = await tailed('')
    await appendFile(transcriptPath, '{"n":1}\n')
    const reading = watcher.pollAll()
    const held = watcher.hold('s1', transcriptPath)
    await appendFile(transcriptPath, '{"n":2}\n')
    await reading
    const hold = (await held)!
    expect(hold.offset).toBe(8)
    expect(lines).toEqual(['{"n":1}'])
    hold.release()
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":1}', '{"n":2}'])
    await watcher.stop()
  })

  it('cancels a read that was only scheduled, and reads it after release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-watcher-hold-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"n":1}\n{"n":2}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath }, { fromOffset: 8 })
    const hold = (await watcher.hold('s1', transcriptPath))!
    expect(hold.offset).toBe(8)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(lines).toEqual([])
    hold.release()
    await until('the read the release schedules', () => lines.length > 0)
    expect(lines).toEqual(['{"n":2}'])
    await watcher.stop()
  })

  it('holds nothing for a session it does not tail, or for another file than the one it tails', async () => {
    const { transcriptPath, watcher } = await tailed('')
    expect(await watcher.hold('nobody', transcriptPath)).toBeNull()
    expect(await watcher.hold('s1', `${transcriptPath}.other`)).toBeNull()
    await watcher.stop()
  })

  it('releases quietly after the session was removed', async () => {
    const { transcriptPath, watcher } = await tailed('')
    const hold = (await watcher.hold('s1', transcriptPath))!
    await watcher.removeSession('s1')
    expect(() => hold.release(5)).not.toThrow()
    await watcher.stop()
  })
})

describe('Watcher, at its edges', () => {
  const fresh = async (content = '') => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-watcher-edges-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, content)
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    return { dir, transcriptPath, watcher, lines }
  }
  // Private state, read only to see what the file system's events did.
  const internals = (watcher: Watcher) => watcher as unknown as {
    watcher: { emit(event: string, ...args: unknown[]): boolean } | null
    files: Map<string, { pending: boolean }>
    readNew(filePath: string): Promise<void>
  }

  it('follows what chokidar reports from start to stop, and logs the changes the turn engines ride on', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { dir, transcriptPath, watcher, lines } = await fresh()
      await watcher.addSession({ sessionId: 's1', engine: 'commandcode', transcriptPath })
      watcher.start()
      watcher.start()
      const second = join(dir, 'second.jsonl')
      await writeFile(second, '')
      await watcher.addSession({ sessionId: 's2', engine: 'codex', transcriptPath: second })
      await appendFile(transcriptPath, '{"n":1}\n')
      await until('the change to be read', () => lines.includes('{"n":1}'))
      expect(log.mock.calls.some(([line]) => String(line).startsWith('[watcher] change commandcode s1'))).toBe(true)
      await appendFile(second, '{"n":2}\n')
      await until('the second file to be read', () => lines.includes('{"n":2}'))
      expect(log.mock.calls.some(([line]) => String(line).startsWith('[watcher] change codex'))).toBe(false)
      await rm(transcriptPath)
      await until('the unlink to be noticed', () => internals(watcher).files.get(transcriptPath)?.pending === true)
      // Events for a file no longer tailed are dropped, however often they come.
      internals(watcher).watcher!.emit('change', join(dir, 'gone.jsonl'), undefined)
      internals(watcher).watcher!.emit('change', join(dir, 'gone.jsonl'), undefined)
      internals(watcher).watcher!.emit('unlink', join(dir, 'gone.jsonl'))
      internals(watcher).watcher!.emit('error', new Error('EMFILE'))
      expect(error).toHaveBeenCalledWith('[watcher] error:', expect.any(Error))
      await watcher.stop()
      await watcher.stop()
      // Started before anything is tailed: there is nothing to watch yet.
      const idle = new Watcher()
      idle.start()
      await idle.stop()
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })

  it('moves a session to its new file, and starts a missing one from nothing', async () => {
    const { dir, transcriptPath, watcher, lines } = await fresh('{"n":1}\n')
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath })
    const moved = join(dir, 'moved.jsonl')
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath: moved })
    expect(watcher.tails('s1', transcriptPath)).toBe(false)
    expect(watcher.tails('s1', moved)).toBe(true)
    await writeFile(moved, '{"n":2}\n')
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":2}'])
    await watcher.stop()
  })

  it('hands a file to the session added last, and lets a session that lost it go quietly', async () => {
    const { transcriptPath, watcher, lines } = await fresh()
    const seen: string[] = []
    watcher.on('line', (event: LineEvent) => seen.push(event.sessionId))
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath })
    await watcher.addSession({ sessionId: 's2', engine: 'codex', transcriptPath })
    await appendFile(transcriptPath, '{"n":1}\n')
    await watcher.pollSession('s2')
    expect(seen).toEqual(['s2'])
    await watcher.removeSession('s2')
    // s1 still names the file, which is no longer tailed.
    watcher.setTail('s1', 0)
    await watcher.pollSession('s1')
    expect(await watcher.hold('s1', transcriptPath)).toBeNull()
    expect(lines).toEqual(['{"n":1}'])
    await watcher.removeSession('nobody')
    await watcher.pollSession('nobody')
    await watcher.stop()
  })

  it('drops a read that was only scheduled when the tail is moved or the session removed', async () => {
    for (const end of ['setTail', 'remove'] as const) {
      const { transcriptPath, watcher, lines } = await fresh('{"n":1}\n{"n":2}\n')
      await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath }, { fromOffset: 0 })
      if (end === 'setTail') watcher.setTail('s1', 16)
      else await watcher.removeSession('s1')
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(lines).toEqual([])
      await watcher.stop()
    }
  })

  it('skips a read of a file it does not tail, one that is gone, and one it may not open', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { transcriptPath, watcher, lines } = await fresh('{"n":1}\n')
      await internals(watcher).readNew('/nowhere.jsonl')
      await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath })
      await appendFile(transcriptPath, '{"n":2}\n')
      chmodSync(transcriptPath, 0o000)
      await watcher.pollSession('s1')
      expect(error).toHaveBeenCalledOnce()
      expect(String(error.mock.calls[0][0])).toContain('[watcher] read failed (session.jsonl)')
      chmodSync(transcriptPath, 0o600)
      await rm(transcriptPath)
      await watcher.pollSession('s1')
      expect(lines).toEqual([])
      await watcher.stop()
    } finally { error.mockRestore() }
  })

  it('reads Cursor transcripts whole: none to begin with, a last line not yet ended, and one that vanishes', async () => {
    const { transcriptPath, watcher, lines } = await fresh()
    await rm(transcriptPath)
    await watcher.addSession({ sessionId: 's1', engine: 'cursor', transcriptPath })
    await writeFile(transcriptPath, '{"c":1}\n\n{"c":2}\r\n{"c":3')
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"c":1}', '{"c":2}'])
    await appendFile(transcriptPath, '}\n')
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"c":1}', '{"c":2}', '{"c":3}'])
    await rm(transcriptPath)
    await watcher.pollSession('s1')
    expect(lines).toHaveLength(3)
    await watcher.stop()
  })
})

describe('Watcher, reading a backlog', () => {
  const backlog = async (options: ConstructorParameters<typeof Watcher>[0], content = '') => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-watcher-backlog-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, content)
    const watcher = new Watcher(options)
    const lines: string[] = []
    const history: string[] = []
    const rewritten: RewrittenEvent[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    watcher.on('history', (event: HistoryEvent) => history.push(...event.lines.map((line) => line.text)))
    watcher.on('rewritten', (event: RewrittenEvent) => rewritten.push(event))
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath })
    return { transcriptPath, watcher, lines, history, rewritten }
  }
  const records = [
    '{"n":1}', '{"n":2,"text":"漢字 📘 across a chunk"}', `{"n":3,"long":"${'x'.repeat(200)}"}`, '{"n":4}', '', '   ', '{"n":5}',
  ]

  it('reads what fell behind a chunk at a time: lines and characters split between chunks, a line longer than many', async () => {
    for (const chunk of [1, 3, 16, 64, 1 << 20]) {
      const { transcriptPath, watcher, lines } = await backlog({ readChunkBytes: chunk })
      await appendFile(transcriptPath, records.join('\r\n') + '\r\n{"n":6, still')
      await watcher.pollSession('s1')
      expect(lines, `chunks of ${chunk}`).toEqual(records.filter((record) => record.trim()))
      await appendFile(transcriptPath, ' being written}\n')
      await watcher.pollSession('s1')
      expect(lines.at(-1)).toBe('{"n":6, still being written}')
      await watcher.stop()
    }
  })

  it('stops a long read at a hold that lands in it, and hands over every line exactly once', async () => {
    const all = Array.from({ length: 400 }, (_, i) => `{"n":${i},"pad":"${'y'.repeat(i % 37)}"}`)
    const { transcriptPath, watcher, lines } = await backlog({ readChunkBytes: 32 })
    await appendFile(transcriptPath, all.join('\n') + '\n')
    const reading = watcher.pollAll()
    const hold = (await watcher.hold('s1', transcriptPath))!
    await reading
    const size = Buffer.byteLength(all.join('\n') + '\n')
    expect(hold.offset).toBeLessThan(size)
    // Delivery stopped exactly at a line: what came out is everything before that byte.
    expect(Buffer.byteLength(lines.map((line) => line + '\n').join(''))).toBe(hold.offset)
    hold.release(hold.offset)
    await watcher.pollSession('s1')
    expect(lines).toEqual(all)
    await watcher.stop()
  })

  it('attaches a file that shrank to more history than one batch should hold, instead of replaying it', async () => {
    const { transcriptPath, watcher, lines, history, rewritten } = await backlog({ historyMaxBytes: 40 }, records.join('\n') + '\n')
    await writeFile(transcriptPath, records.slice(0, 4).join('\n') + '\n')
    await watcher.pollSession('s1')
    expect(rewritten).toEqual([{ sessionId: 's1', engine: 'codex', transcriptPath }])
    expect({ lines, history }).toEqual({ lines: [], history: [] })
    // The tail goes on from the new end.
    await appendFile(transcriptPath, '{"n":7}\n')
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":7}'])
    // A shrink small enough is still read as history.
    await writeFile(transcriptPath, '{"n":8}\n')
    await watcher.pollSession('s1')
    expect(history).toEqual(['{"n":8}'])
    await watcher.stop()
  })

  it('stops where a file cut short under the read ends', async () => {
    const shorted = async (path: string) => {
      const handle = await open(path, 'r')
      let reads = 0
      return Object.assign(Object.create(handle), {
        read: (...args: Parameters<typeof handle.read>) => (++reads > 1 ? Promise.resolve({ bytesRead: 0, buffer: args[0] }) : handle.read(...args)),
        close: () => handle.close(),
      })
    }
    const { transcriptPath, watcher, lines } = await backlog({ readChunkBytes: 8, openFile: shorted })
    await appendFile(transcriptPath, '{"n":1}\n{"n":2}\n')
    await watcher.pollSession('s1')
    expect(lines).toEqual(['{"n":1}'])
    await watcher.stop()
  })
})

