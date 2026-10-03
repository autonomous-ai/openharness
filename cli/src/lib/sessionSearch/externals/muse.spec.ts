import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { museActivity, museOwnRun, museProvider, museTurnOpen, readMuseHead } from './muse.js'
import { scanMemo } from './support.js'
import { type ExternalProvider, type ProcessView, type RunningProcess, UNSETTLED } from './types.js'

// Shapes follow the repo's recorded Muse session (lib/__fixtures__/muse-session.jsonl): one envelope a
// record, `recorded_at` in microseconds, sub-agent streams mirrored into the parent. Values are made up.
const ID = '8a5b11e5-5eae-441c-ba9d-903608a9632e'
const ID2 = '9b6c22f6-0000-4000-8000-000000000002'
const CHILD = 'c0c0c0c0-0000-4000-8000-00000000c41d'
const T0 = Date.parse('2026-09-01T10:00:00.000Z')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muse-external-'))
  dirs.push(dir)
  return dir
}

let sequence = 0
const micros = (seconds: number) => (T0 + seconds * 1000) * 1000
/** One record, spaced as the recorded fixture is. */
const rec = (stream: string, seconds: number | null, payload: Record<string, unknown>) =>
  JSON.stringify({
    schema_version: 1, id: `r-${++sequence}`, stream: { kind: 'session', id: stream }, sequence,
    ...(seconds === null ? {} : { recorded_at: micros(seconds) }),
    record_type: 'event', durability: 'durable', causation_id: null, payload_type: 'runtime.session', payload_schema_version: 1, payload,
  }, null, 0).replace(/,"/g, ', "').replace(/":/g, '": ')
const metadata = (stream: string, cwd: unknown, seconds: number | null = 0) =>
  rec(stream, seconds, { kind: 'metadata', record: { workspace_root: cwd, provider_id: 'meta', build: { sha: 'x', semver: '0.1.0' } } })
const run = (stream: string, kind: string, seconds: number, event: Record<string, unknown> = {}) =>
  rec(stream, seconds, { kind: 'run', run_id: `run-${stream}`, event: { kind, ...event } })
const task = (stream: string, seconds: number) => rec(stream, seconds, { kind: 'task', run_id: 'x', task_id: 't', event: { kind: 'started', task_id: 't' } })
const jsonl = (...lines: string[]) => `${lines.join('\n')}\n`

function write(path: string, content: string, mtimeSeconds?: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mtimeSeconds !== undefined) utimesSync(path, new Date(T0 + mtimeSeconds * 1000), new Date(T0 + mtimeSeconds * 1000))
  return path
}

/** A log where Muse puts it: `sessions/YYYY/MM/DD/<id>/session.jsonl`. */
function log(home: string, id: string, lines: string[], day = ['2026', '09', '01'], mtimeSeconds?: number): string {
  return write(join(home, 'sessions', ...day, id, 'session.jsonl'), jsonl(...lines), mtimeSeconds)
}

function scanner(provider: ExternalProvider, excluded: string[] = []) {
  const memo = scanMemo({ excluded })
  return async () => {
    const found = await provider.scan(memo.context())
    memo.prune()
    return found
  }
}

const row = (pid: number, executable: string, args: string): RunningProcess => ({ pid, ppid: 1, executable, args })
const view = (rows: RunningProcess[]): ProcessView => ({
  list: async () => rows, openFiles: async () => new Map(), openFilesOf: async () => new Map(), alive: () => true,
})

describe('readMuseHead', () => {
  const head = async (content: string, folderId = ID) => readMuseHead(write(join(temp(), 'session.jsonl'), content), folderId)

  it("reads the session's folder from its own stream's metadata", async () => {
    expect(await head(jsonl(metadata(ID, '/Users/me/Work/app'), run(ID, 'started', 1)))).toEqual({ sessionId: ID, cwd: '/Users/me/Work/app' })
  })

  it('refuses a first record of another stream, not metadata, or without an absolute workspace', async () => {
    expect(await head(jsonl(metadata(ID2, '/w')))).toBeNull()
    expect(await head(jsonl(run(ID, 'started', 1)))).toBeNull()
    expect(await head(jsonl(metadata(ID, 'relative')))).toBeNull()
    expect(await head(jsonl(metadata(ID, null)))).toBeNull()
    expect(await head(jsonl('{torn'))).toBeNull()
  })

  it('says "not yet" while the first record is being written, and "never" past the bound', async () => {
    expect(await head(metadata(ID, '/w'))).toBe(UNSETTLED)
    expect(await head('x'.repeat(256 * 1024 + 1))).toBeNull()
    // A first record larger than the first read is read whole on a second.
    const long = rec(ID, 0, { kind: 'metadata', record: { workspace_root: '/w', notes: 'y'.repeat(40_000) } })
    expect(await head(jsonl(long, run(ID, 'started', 1)))).toEqual({ sessionId: ID, cwd: '/w' })
  })
})

describe('museOwnRun', () => {
  const ran = (...lines: string[]) => museOwnRun(write(join(temp(), 'session.jsonl'), jsonl(metadata(ID, '/w'), ...lines)), ID)

  it('is true once the session opens a run of its own, a scheduled one (no prompt) included', async () => {
    expect(await ran(run(ID, 'started', 1, { prompt: 'hi' }))).toBe(true)
    expect(await ran(task(ID, 1), run(ID, 'started', 2, { prompt: '' }), run(ID, 'terminal', 3), ...Array.from({ length: 50 }, (_, i) => task(ID, 4 + i)))).toBe(true)
  })

  it("is false for a memory reminder's session, a metadata-only one, and one where only a mirrored stream ran", async () => {
    expect(await ran(task(ID, 1), rec(ID, 2, { kind: 'memory', event: { kind: 'memory_reminder_child_session_linked' } }))).toBe(false)
    expect(await ran()).toBe(false)
    expect(await ran(run(CHILD, 'started', 1, { prompt: `mentions ${ID}` }), run(CHILD, 'terminal', 2), `{"torn": "${ID}`)).toBe(false)
    expect(await museOwnRun(join(temp(), 'gone.jsonl'), ID)).toBe(false)
  })
})

describe('museActivity', () => {
  it("is the time of the session's own newest record, in milliseconds", async () => {
    const dir = temp()
    expect(await museActivity(write(join(dir, 'a.jsonl'), jsonl(metadata(ID, '/w'), run(ID, 'started', 5), run(ID, 'terminal', 9), run(CHILD, 'terminal', 60))), ID)).toBe(T0 + 9_000)
    expect(await museActivity(write(join(dir, 'b.jsonl'), jsonl(metadata(ID, '/w', null), run(CHILD, 'started', 60))), ID)).toBeNull()
    expect(await museActivity(join(dir, 'gone.jsonl'), ID)).toBeNull()
  })

  it('reads only the end of a long log', async () => {
    const dir = temp()
    const big = run(ID, 'reasoning_committed', 3, { text: 'x'.repeat(70_000) })
    expect(await museActivity(write(join(dir, 'a.jsonl'), jsonl(metadata(ID, '/w'), big, run(ID, 'terminal', 4))), ID)).toBe(T0 + 4_000)
  })
})

describe('museTurnOpen', () => {
  const turn = (...lines: string[]) => museTurnOpen(write(join(temp(), ID, 'session.jsonl'), jsonl(metadata(ID, '/w'), ...lines)))

  it("is open while the session's own run has started and not ended, whatever its sub-agents do", async () => {
    expect(await turn(run(ID, 'started', 1), task(ID, 2), run(CHILD, 'started', 3), run(CHILD, 'terminal', 4))).toBe(true)
    expect(await turn(run(ID, 'started', 1), run(ID, 'terminal', 2), run(CHILD, 'started', 3), task(ID, 4))).toBe(false)
  })

  it('cannot say when no run of its own is near the end', async () => {
    expect(await turn()).toBeNull()
    expect(await turn(run(CHILD, 'started', 1))).toBeNull()
    expect(await museTurnOpen('')).toBeNull()
    expect(await museTurnOpen(join(temp(), ID, 'gone.jsonl'))).toBeNull()
  })

  it('looks further back when one long record fills the end of the log', async () => {
    expect(await turn(run(ID, 'started', 1), run(ID, 'tool_result_batch_committed', 2, { results: [{ text: 'x'.repeat(300_000) }] }))).toBe(true)
  })
})

describe('museProvider', () => {
  it('lists each log at exactly YYYY/MM/DD/<id>/ that someone talked to, under its workspace', async () => {
    const home = temp()
    const path = log(home, ID, [metadata(ID, '/Users/me/Work/app'), run(ID, 'started', 1, { prompt: 'hi' }), run(ID, 'terminal', 2)])
    expect(await scanner(museProvider({ home }))()).toEqual([
      { sessionId: ID, engine: 'muse', cwd: '/Users/me/Work/app', origin: 'terminal', title: '', mtime: T0 + 2_000, transcriptPath: path },
    ])
  })

  it("leaves out sub-agents, reminder sessions, metadata-only logs, another stream's log, excluded folders, and stray folders", async () => {
    const home = temp()
    const kept = log(home, ID, [metadata(ID, '/w'), run(ID, 'started', 1)])
    // A sub-agent one level deeper, and a reminder session beside the person's with the same folder.
    write(join(home, 'sessions', '2026', '09', '01', ID, 'subagent', CHILD, 'session.jsonl'), jsonl(metadata(CHILD, '/w'), run(CHILD, 'started', 1)))
    log(home, ID2, [metadata(ID2, '/w'), task(ID2, 1)])
    log(home, 'aaaaaaaa-0000-4000-8000-000000000003', [metadata('aaaaaaaa-0000-4000-8000-000000000003', '/w')])
    log(home, 'bbbbbbbb-0000-4000-8000-000000000004', [metadata(ID, '/w'), run(ID, 'started', 1)])
    log(home, 'cccccccc-0000-4000-8000-000000000005', [metadata('cccccccc-0000-4000-8000-000000000005', '/data/harness/summary-scratch'), run('cccccccc-0000-4000-8000-000000000005', 'started', 1)])
    log(home, 'not-a-session-id', [metadata('not-a-session-id', '/w'), run('not-a-session-id', 'started', 1)])
    log(home, 'dddddddd-0000-4000-8000-000000000006', [metadata('dddddddd-0000-4000-8000-000000000006', '/w'), run('dddddddd-0000-4000-8000-000000000006', 'started', 1)], ['index', '09', '01'])
    mkdirSync(join(home, 'sessions', '2026', '09', '02', 'eeeeeeee-0000-4000-8000-000000000007'), { recursive: true })
    write(join(home, 'sessions', '2026', '09', 'notes.txt'), 'x')
    const found = await scanner(museProvider({ home }), ['/data/harness'])()
    expect(found.map((s) => s.transcriptPath)).toEqual([kept])
  })

  it('dates a log whose own records carry no time by its file', async () => {
    const home = temp()
    log(home, ID, [metadata(ID, '/w', null), rec(ID, null, { kind: 'run', event: { kind: 'started' } })], undefined, 300)
    expect((await scanner(museProvider({ home }))())[0].mtime).toBe(T0 + 300_000)
  })

  it('lists a log whose metadata was still being written once it is whole, and one that opens its first run later', async () => {
    const home = temp()
    const path = write(join(home, 'sessions', '2026', '09', '01', ID, 'session.jsonl'), metadata(ID, '/w'))
    const scan = scanner(museProvider({ home }))
    expect(await scan()).toEqual([])
    appendFileSync(path, '\n')
    expect(await scan()).toEqual([])
    appendFileSync(path, jsonl(run(ID, 'started', 1)))
    expect((await scan()).map((s) => s.sessionId)).toEqual([ID])
  })

  it('reads a log again only when it changed, and for a run never once one is found', async () => {
    const home = temp()
    const path = log(home, ID, [metadata(ID, '/w'), run(ID, 'started', 1)], undefined, 100)
    const scan = scanner(museProvider({ home }))
    expect((await scan())[0].mtime).toBe(T0 + 1_000)
    // A run once written stays: the log is not read for one again, even when it no longer shows one.
    write(path, jsonl(metadata(ID, '/w'), task(ID, 5)), 200)
    expect((await scan())[0].mtime).toBe(T0 + 5_000)
    // The metadata record is read once.
    write(path, jsonl(metadata(ID, '/w/elsewhere'), run(ID, 'started', 6)), 300)
    expect((await scan())[0].cwd).toBe('/w')
    // Gone, then back: read from nothing again.
    rmSync(path)
    expect(await scan()).toEqual([])
    write(path, jsonl(metadata(ID, '/w'), task(ID, 7)), 400)
    expect(await scan()).toEqual([])
  })

  it('says which Muse has a session open from `muse resume <id>`, and whether its own run is going', async () => {
    const home = temp()
    const path = log(home, ID, [metadata(ID, '/w'), run(ID, 'started', 1)])
    const provider = museProvider({ home })
    await scanner(provider)()
    const claims = await provider.owners!(view([
      row(31, 'muse-bin-0.1.0-R708.1', `muse-bin-0.1.0-R708.1 resume ${ID}`),
      row(32, 'muse', `muse --session-id ${ID2}`),
      row(33, 'muse', 'muse resume --last'),
      row(34, 'muse-bin-0.1.0-R708.1', 'muse-bin-0.1.0-R708.1'),
      row(35, 'zsh', `zsh -c "echo resume ${ID}"`),
    ]))
    expect(claims).toEqual([
      { sessionId: ID, pid: 31, record: path, fromArgs: true },
      { sessionId: ID2, pid: 32, record: '', fromArgs: true },
    ])
    expect(await provider.busy!(claims[0])).toBe(true)
    expect(await provider.busy!(claims[1])).toBeNull()
  })
})
