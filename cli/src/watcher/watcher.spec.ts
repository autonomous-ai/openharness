import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { Watcher, type HistoryEvent, type LineEvent } from './watcher.js'

const cleanup: string[] = []

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
