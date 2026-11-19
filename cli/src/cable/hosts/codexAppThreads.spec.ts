// The ChatGPT app's threads, read from a fixture Codex home in a temp folder: no test reads anyone's own ~/.codex.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetCodexThreadNames } from '../../lib/sessionTitle.js'
import { codexAppFixture, NEVER_READ, type CodexAppFixture, type FixtureThread } from '../../testing/codexAppFixture.js'
import { CodexAppThreads, MAX_STATE_BYTES, type CodexAppRead, type CodexAppSeams } from './codexAppThreads.js'

let root: string
beforeEach(() => {
  resetCodexThreadNames()
  root = mkdtempSync(join(tmpdir(), 'codex-app-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const fixture = (name = '.codex'): CodexAppFixture => codexAppFixture(join(root, name))
const storeOf = (fx: CodexAppFixture) => join(fx.home, 'state_5.sqlite')
const stateOf = (fx: CodexAppFixture) => join(fx.home, '.codex-global-state.json')
const indexOf = (fx: CodexAppFixture) => join(fx.home, 'session_index.jsonl')
/** A lowercase UUID, as Codex names its threads; a higher n sorts later. */
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const local = (projectId: string) => ({ projectKind: 'local', projectId })
const thread = (n: number, recencyAtMs: number, over: Partial<FixtureThread> = {}): FixtureThread =>
  ({ id: uuid(n), cwd: `/work/t${n}`, recencyAtMs, ...over })

async function ok(reader: CodexAppThreads): Promise<Extract<CodexAppRead, { ok: true }>> {
  const result = await reader.read()
  if (!result.ok) throw new Error('the read failed')
  return result
}
/** One plain read of the descriptor, as the reader's own default does. */
function readAll(fd: number, max: number): Buffer {
  const buffer = Buffer.alloc(max)
  return buffer.subarray(0, readSync(fd, buffer, 0, max, 0))
}
/** A reader whose reads of the JSON file are counted. */
function counted(fx: CodexAppFixture, seams: CodexAppSeams = {}) {
  const calls = { state: 0 }
  const reader = new CodexAppThreads(fx.home, { ...seams, readState: (fd, max) => { calls.state++; return readAll(fd, max) } })
  return { reader, calls }
}

describe('the query', () => {
  it('the query keeps cli and vscode threads that are not archived', async () => {
    const fx = fixture()
    fx.threads([
      thread(1, 600, { source: 'vscode' }),
      thread(2, 500, { source: 'cli' }),
      thread(3, 400, { source: 'exec' }),
      thread(4, 300, { source: '{"subagent":{"thread_spawn":{}}}' }),
      thread(5, 200, { source: '{"subagent":{"other":"guardian"}}' }),
      thread(6, 700, { source: 'vscode', archived: 1 }),
    ])
    expect((await ok(new CodexAppThreads(fx.home))).order).toEqual([uuid(1), uuid(2)])
  })

  it('at most 200 rows are read', async () => {
    const fx = fixture()
    fx.threads(Array.from({ length: 205 }, (_, i) => thread(i + 1, i + 1)))
    const result = await ok(new CodexAppThreads(fx.home))
    expect(result.rows).toBe(200)
    expect(result.order).toHaveLength(200)
    for (let n = 1; n <= 5; n++) expect(result.order).not.toContain(uuid(n))
  })

  it('a row with a bad id or folder is skipped and counted', async () => {
    const fx = fixture()
    const bad = [
      { id: 'NOT-A-UUID', cwd: '/work/a', recencyAtMs: 10 },
      { id: 'AAAAAAAA-0000-4000-8000-000000000002', cwd: '/work/b', recencyAtMs: 20 },
      thread(3, 30, { cwd: '' }),
      thread(4, 40, { cwd: `/${'a'.repeat(4096)}` }),
    ]
    fx.threads([thread(1, 50), ...bad])
    const result = await ok(new CodexAppThreads(fx.home))
    expect(result.skipped).toBe(4)
    expect(result.rows).toBe(5)
    expect(result.order).toEqual([uuid(1)])
  })

  it('a missing store, a missing table or a missing column is a failed read', async () => {
    const none = fixture('none')
    mkdirSync(none.home, { recursive: true })
    expect(await new CodexAppThreads(none.home).read()).toEqual({ ok: false })

    const renamed = fixture('renamed')
    renamed.threads([thread(1, 10)])
    const writer = renamed.writer()
    writer.exec('ALTER TABLE threads RENAME TO t2')
    writer.close()
    expect(await new CodexAppThreads(renamed.home).read()).toEqual({ ok: false })

    const old = fixture('old')
    const maker = old.writer()
    maker.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER)`)
    maker.exec(`INSERT INTO threads (id, source, cwd) VALUES ('${uuid(1)}', 'vscode', '/work/a')`)
    maker.close()
    expect(await new CodexAppThreads(old.home).read()).toEqual({ ok: false })
  })

  it('no SQLite binding is a failed read', async () => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    expect(await new CodexAppThreads(fx.home, { sqlite: () => null }).read()).toEqual({ ok: false })
  })

  it('a thread\'s time is recency_at_ms, else updated_at_ms, else 0', async () => {
    const fx = fixture()
    fx.threads([
      thread(1, 400),
      thread(2, 0, { updatedAtMs: 500 }),
      thread(3, 0, { updatedAtMs: null }),
    ])
    const result = await ok(new CodexAppThreads(fx.home))
    expect(result.order).toEqual([uuid(2), uuid(1), uuid(3)])
    expect(result.listed.map((t) => t.at)).toEqual([500, 400, 0])
  })
})

describe('the sidebar order', () => {
  it('the sidebar order: projects in project-order, each newest first, then Recent newest first', async () => {
    const fx = fixture()
    fx.threads([
      thread(1, 900), thread(2, 100), // P1
      thread(3, 500), thread(4, 200), // P2
      thread(5, 800), // assigned to a project not in the order
      thread(6, 700), // a remote project
      thread(7, 300), thread(8, 300), // Recent, tied
      thread(9, 950), // Recent, no assignment
    ])
    fx.state({
      projectOrder: ['P2', 'P1'],
      assignments: {
        [uuid(1)]: local('P1'), [uuid(2)]: local('P1'), [uuid(3)]: local('P2'), [uuid(4)]: local('P2'),
        [uuid(5)]: local('P9'), [uuid(6)]: { projectKind: 'remote', projectId: 'P1' },
      },
    })
    expect((await ok(new CodexAppThreads(fx.home))).order)
      .toEqual([uuid(3), uuid(4), uuid(1), uuid(2), uuid(9), uuid(5), uuid(6), uuid(8), uuid(7)])
  })

  it('the newest 16 are listed in the sidebar order, and every kept thread is in the order', async () => {
    const fx = fixture()
    const project = Array.from({ length: 10 }, (_, i) => thread(i + 1, i + 1))
    const recent = Array.from({ length: 10 }, (_, i) => thread(i + 11, i + 101))
    fx.threads([...project, ...recent])
    fx.state({ projectOrder: ['P'], assignments: Object.fromEntries(project.map((t) => [t.id, local('P')])) })
    const result = await ok(new CodexAppThreads(fx.home))
    expect(result.order).toHaveLength(20)
    expect(result.listed.map((t) => t.id)).toEqual([
      ...[10, 9, 8, 7, 6, 5].map(uuid),
      ...[20, 19, 18, 17, 16, 15, 14, 13, 12, 11].map(uuid),
    ])
    expect(result.listed.map((t) => t.inProject)).toEqual([...Array(6).fill(true), ...Array(10).fill(false)])
  })

  it('at most 64 project ids are kept', async () => {
    const fx = fixture()
    fx.threads([thread(1, 20), thread(2, 10)])
    const order = Array.from({ length: 70 }, (_, i) => `P${i}`)
    fx.state({ projectOrder: order, assignments: { [uuid(1)]: local(order[64]!), [uuid(2)]: local(order[63]!) } })
    const result = await ok(new CodexAppThreads(fx.home))
    expect(result.listed.map((t) => [t.id, t.inProject])).toEqual([[uuid(2), true], [uuid(1), false]])
  })
})

describe('the JSON file', () => {
  const GOOD = { projectOrder: ['P'], assignments: { [uuid(1)]: local('P') } }

  it.each<[string, (fx: CodexAppFixture) => void]>([
    ['too large', (fx) => fx.state({ ...GOOD, padTo: MAX_STATE_BYTES + 1 })],
    ['not JSON', (fx) => fx.state('{"project-order":')],
    ['of the wrong shape', (fx) => fx.state({ projectOrder: 'P', assignments: GOOD.assignments })],
    ['a link', (fx) => {
      fx.state(GOOD)
      renameSync(stateOf(fx), join(fx.home, 'real.json'))
      symlinkSync(join(fx.home, 'real.json'), stateOf(fx))
    }],
    ['a FIFO', (fx) => execFileSync('mkfifo', [stateOf(fx)])],
  ])('a JSON file that held still and is %s counts as no projects', async (_, make) => {
    const fx = fixture()
    fx.threads([thread(1, 20), thread(2, 10)])
    make(fx)
    const { reader, calls } = counted(fx)
    const first = await ok(reader)
    expect(first.listed.map((t) => t.inProject)).toEqual([false, false])
    const parsed = calls.state
    expect(await ok(reader)).toEqual(first)
    expect(calls.state).toBe(parsed)
  })

  it.each<[string, boolean, (fx: CodexAppFixture) => void]>([
    ['appended to', false, (fx) => appendFileSync(stateOf(fx), ' '.repeat(10))],
    ['replaced by a new file', false, (fx) => fx.state(GOOD)],
    ['appended to after a good parse', true, (fx) => appendFileSync(stateOf(fx), ' '.repeat(10))],
  ])('a JSON file %s during its read is a failed read; once it holds still it is parsed', async (_, parsedFirst, change) => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    fx.state(GOOD)
    let calls = 0
    const changeAt = parsedFirst ? 2 : 1
    const reader = new CodexAppThreads(fx.home, {
      readState: (fd, max) => {
        if (++calls === changeAt) change(fx)
        return readAll(fd, max)
      },
    })
    if (parsedFirst) {
      expect((await ok(reader)).listed[0]!.inProject).toBe(true)
      fx.state({ ...GOOD, padTo: 200 })
    }
    expect(await reader.read()).toEqual({ ok: false })
    expect((await ok(reader)).listed[0]!.inProject).toBe(true)
  })

  it('a JSON file that cannot be opened is a failed read, not one with no projects; once it opens it is parsed', async () => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    fx.state(GOOD)
    chmodSync(stateOf(fx), 0o000)
    const reader = new CodexAppThreads(fx.home)
    expect(await reader.read()).toEqual({ ok: false })
    chmodSync(stateOf(fx), 0o644)
    expect((await ok(reader)).listed[0]!.inProject).toBe(true)
  })

  it('the JSON file is parsed again only when its size or mtime changed, or a thread it was not parsed for comes', async () => {
    const fx = fixture()
    fx.threads([thread(1, 10), thread(2, 20)])
    const assignments = { [uuid(1)]: local('P1'), [uuid(2)]: local('P2'), [uuid(3)]: local('P1') }
    const when = 1_700_000_000
    fx.state({ projectOrder: ['P1', 'P2'], assignments })
    utimesSync(stateOf(fx), when, when)
    const reader = new CodexAppThreads(fx.home)
    expect((await ok(reader)).order).toEqual([uuid(1), uuid(2)])

    fx.state({ projectOrder: ['P2', 'P1'], assignments })
    utimesSync(stateOf(fx), when, when)
    expect((await ok(reader)).order).toEqual([uuid(1), uuid(2)])

    utimesSync(stateOf(fx), when + 10, when + 10)
    expect((await ok(reader)).order).toEqual([uuid(2), uuid(1)])

    fx.threads([thread(3, 30)])
    const result = await ok(reader)
    expect(result.order).toEqual([uuid(2), uuid(3), uuid(1)])
    expect(result.listed.find((t) => t.id === uuid(3))!.inProject).toBe(true)
  })
})

describe('the store\'s connection', () => {
  it('no connection outlives a read: a writer can checkpoint and remove the WAL after it', async () => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    const writer = fx.writer()
    writer.exec(`UPDATE threads SET recency_at_ms = 20 WHERE id = '${uuid(1)}'`)
    expect(existsSync(storeOf(fx) + '-wal')).toBe(true)
    expect((await ok(new CodexAppThreads(fx.home))).order).toEqual([uuid(1)])
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    writer.close()
    expect(existsSync(storeOf(fx) + '-wal')).toBe(false)
    expect(existsSync(storeOf(fx) + '-shm')).toBe(false)
  })

  it('no connection outlives a failed read: a writer can checkpoint and remove the WAL after it', async () => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    const writer = fx.writer()
    writer.exec('ALTER TABLE threads RENAME TO t2')
    expect(existsSync(storeOf(fx) + '-wal')).toBe(true)
    expect(await new CodexAppThreads(fx.home).read()).toEqual({ ok: false })
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    writer.close()
    expect(existsSync(storeOf(fx) + '-wal')).toBe(false)
    expect(existsSync(storeOf(fx) + '-shm')).toBe(false)
  })

  it('an idle store is read immutable and leaves no -wal or -shm', async () => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    expect((await ok(new CodexAppThreads(fx.home))).order).toEqual([uuid(1)])
    expect(existsSync(storeOf(fx) + '-wal')).toBe(false)
    expect(existsSync(storeOf(fx) + '-shm')).toBe(false)
  })

  it('a store the app holds locked is a failed read, within a second', async () => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    const writer = fx.writer()
    writer.exec('PRAGMA locking_mode = EXCLUSIVE')
    writer.exec(`UPDATE threads SET recency_at_ms = 20 WHERE id = '${uuid(1)}'`)
    const reader = new CodexAppThreads(fx.home)
    const started = performance.now()
    expect(await reader.read()).toEqual({ ok: false })
    expect(performance.now() - started).toBeLessThan(1_000)
    writer.close()
    expect((await ok(reader)).order).toEqual([uuid(1)])
  })

  it('a store that is a FIFO is a failed read and never waits', async () => {
    const fx = fixture()
    mkdirSync(fx.home, { recursive: true })
    execFileSync('mkfifo', [storeOf(fx)])
    expect(await new CodexAppThreads(fx.home).read()).toEqual({ ok: false })
  })
})

describe('names', () => {
  it('D4: Codex\'s own name, else the folder\'s, never the store\'s title', async () => {
    const fx = fixture()
    fx.threads([
      thread(1, 50),
      thread(2, 40),
      thread(3, 30, { cwd: '/work/alpha' }),
      thread(4, 20, { cwd: '/' }),
      thread(5, 10, { cwd: '/work/beta/' }),
    ])
    fx.name(uuid(1), 'Fix the build')
    fx.name(uuid(2), 'n'.repeat(100))
    const result = await ok(new CodexAppThreads(fx.home))
    expect(result.listed.map((t) => t.name)).toEqual(['Fix the build', 'n'.repeat(64), 'alpha', 'codex', 'beta'])
    expect(JSON.stringify(result)).not.toContain(NEVER_READ)
  })

  it('a name Codex gives after a read, and a thread new to the list, are named at the next read', async () => {
    const fx = fixture()
    fx.threads([thread(1, 20), thread(2, 10)])
    fx.name(uuid(1), 'Alpha')
    fx.name(uuid(3), 'Charlie')
    const reader = new CodexAppThreads(fx.home)
    expect((await ok(reader)).listed.map((t) => t.name)).toEqual(['Alpha', 't2'])
    fx.name(uuid(2), 'Bravo')
    expect((await ok(reader)).listed.map((t) => t.name)).toEqual(['Alpha', 'Bravo'])
    // The index held still since: the new thread's name is still read.
    fx.threads([thread(3, 30)])
    expect((await ok(reader)).listed.map((t) => t.name)).toEqual(['Charlie', 'Alpha', 'Bravo'])
  })

  it('forget() keeps no name: the next read reads Codex\'s index afresh', async () => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    fx.name(uuid(1), 'Alpha')
    const when = 1_700_000_000
    utimesSync(indexOf(fx), when, when)
    const reader = new CodexAppThreads(fx.home)
    expect((await ok(reader)).listed[0]!.name).toBe('Alpha')
    // Another name in the same file, of the same size and mtime: only a reader that kept no name reads it.
    writeFileSync(indexOf(fx), readFileSync(indexOf(fx), 'utf8').replace('Alpha', 'Bravo'))
    utimesSync(indexOf(fx), when, when)
    reader.forget()
    expect((await ok(reader)).listed[0]!.name).toBe('Bravo')
  })

  // A FIFO opened to be read waits for a writer for good, and the event loop with it, so vitest's timeout would never
  // fire: the read runs in a child the test can kill.
  it.each<[string, (fx: CodexAppFixture) => void]>([
    ['a FIFO', (fx) => execFileSync('mkfifo', [indexOf(fx)])],
    ['a link to a FIFO', (fx) => {
      execFileSync('mkfifo', [join(root, 'fifo')])
      symlinkSync(join(root, 'fifo'), indexOf(fx))
    }],
  ])('a session index that is %s gives folder names and never waits', (_, make) => {
    const fx = fixture()
    fx.threads([thread(1, 10)])
    make(fx)
    const reader = new URL('./codexAppThreads.ts', import.meta.url).href
    const script = `const { CodexAppThreads } = await import(${JSON.stringify(reader)})
      console.log(JSON.stringify(await new CodexAppThreads(process.argv[1]).read()))`
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, fx.home],
      { encoding: 'utf8', timeout: 10_000 })
    expect(child.signal).toBeNull()
    expect((JSON.parse(child.stdout) as Extract<CodexAppRead, { ok: true }>).listed.map((t) => t.name)).toEqual(['t1'])
  })
})

describe('there()', () => {
  it('there() is whether the home is a folder', () => {
    const home = join(root, '.codex')
    const reader = new CodexAppThreads(home)
    expect(reader.there()).toBe(false)
    writeFileSync(home, '')
    expect(reader.there()).toBe(false)
    rmSync(home)
    mkdirSync(home)
    expect(reader.there()).toBe(true)
  })
})
