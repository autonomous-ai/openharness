import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { builtinSqlite } from '../../sqliteRead.js'
import { cursorBucket, cursorProvider, cursorSlug, cursorTurnOpen, readChat, type CursorDatabase } from './cursor.js'
import { scanMemo } from './support.js'
import type { ProcessView, RunningProcess, ScanContext } from './types.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A temporary folder, by its real path: Cursor hashes the physical folder. */
function temp(prefix = 'cursor-external-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

const ID = '6c3b2a1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d'
const ID2 = '7d4c3b2e-1f0a-4b9c-8d7e-6f5a4b3c2d1e'
const ID3 = '8e5d4c3f-2a1b-4c0d-9e8f-7a6b5c4d3e2f'
const CWD = '/work/app'

interface ChatFixture { meta?: unknown; store?: boolean; bucket?: string }

function chat(config: string, cwd: string, id: string, fixture: ChatFixture = {}): string {
  const dir = join(config, 'chats', fixture.bucket ?? cursorBucket(cwd), id)
  mkdirSync(dir, { recursive: true })
  if (fixture.store !== false) writeFileSync(join(dir, 'store.db'), '')
  const meta = fixture.meta === undefined
    ? { schemaVersion: 1, createdAtMs: 1_790_000_000_000, hasConversation: true, title: ' Fix the build ', updatedAtMs: 1_790_000_100_000, cwd }
    : fixture.meta
  if (meta !== null) writeFileSync(join(dir, 'meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta))
  return dir
}

const USER = JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>hi</user_query>' }] } })
const ASSISTANT = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })
const ENDED = JSON.stringify({ type: 'turn_ended', status: 'success' })

function transcript(data: string, project: string, id: string, lines: string[] = [USER, ASSISTANT, ENDED], flat = false): string {
  const dir = flat ? join(data, 'projects', project, 'agent-transcripts') : join(data, 'projects', project, 'agent-transcripts', id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

function counted(excluded: string[] = []) {
  const memo = scanMemo({ excluded })
  let reads = 0
  let paces = 0
  const context = (): ScanContext => {
    const inner = memo.context()
    return {
      ...inner,
      memo: (key, fingerprint, read) => inner.memo(key, fingerprint, () => { reads++; return read() }),
      pace: async () => { paces++; await inner.pace() },
    }
  }
  return { context, reads: () => reads, paces: () => paces }
}

/** A chat store whose `meta` row is [value], as Cursor's agent-kv writes it. */
function fakeDatabase(value: unknown, opened: Array<string | URL> = []): CursorDatabase {
  return class {
    constructor(path: string | URL) { opened.push(path) }
    prepare() { return { get: () => value === undefined ? undefined : { value } } }
    close() { /* nothing held */ }
  } as unknown as CursorDatabase
}

const hex = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('hex')

function roots() {
  const config = temp()
  const data = temp()
  return { config, data, provider: (database: CursorDatabase | null = null) => cursorProvider({ configDir: config, dataDir: data, database }) }
}

describe('cursor naming', () => {
  it('slugs a folder the way Cursor files its transcripts, and buckets it by md5', () => {
    expect(cursorSlug('/Users/me/code/my-app')).toBe('Users-me-code-my-app')
    expect(cursorSlug('/a/b-c')).toBe(cursorSlug('/a/b/c'))
    expect(cursorSlug('/Users/me/.config/my app/')).toBe('Users-me-config-my-app')
    expect(cursorBucket('/work/app/')).toBe(cursorBucket('/work/app'))
    expect(cursorBucket('/work/app')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('cursorProvider.scan', () => {
  it('offers a chat with its folder, title and transcript, from a config folder and a data folder apart', async () => {
    const { config, data, provider } = roots()
    chat(config, CWD, ID)
    const path = transcript(data, 'work-app', ID)
    expect(await provider().scan(counted().context())).toEqual([{
      sessionId: ID, engine: 'cursor', cwd: CWD, origin: 'terminal', title: 'Fix the build', mtime: 1_790_000_100_000, transcriptPath: path,
    }])
  })

  it('reads Cursor\'s default name as no title', async () => {
    const { config, provider } = roots()
    chat(config, CWD, ID, { meta: { createdAtMs: 1, hasConversation: true, title: 'New Agent', cwd: CWD } })
    expect((await provider().scan(counted().context()))[0]).toMatchObject({ title: '', transcriptPath: null })
  })

  it('leaves out sub-agents, empty chats, chats with no store, and chats it cannot read', async () => {
    const { config, provider } = roots()
    const ctx = counted().context()
    const sub = chat(config, CWD, ID, { meta: { createdAtMs: 1, hasConversation: true, isSubagent: true, cwd: CWD } })
    const empty = chat(config, CWD, ID2, { meta: { createdAtMs: 1, hasConversation: false, cwd: CWD } })
    const storeless = chat(config, CWD, ID3, { store: false })
    const bad = chat(config, '/work/other', ID, { meta: '{"createdAtMs":' })
    const undated = chat(config, '/work/other', ID2, { meta: { hasConversation: true, cwd: '/work/other' } })
    expect(await provider().scan(ctx)).toEqual([])
    expect(await readChat(ctx, sub, () => null)).toEqual({ kind: 'skip', reason: 'subagent' })
    expect(await readChat(ctx, empty, () => null)).toEqual({ kind: 'skip', reason: 'empty' })
    expect(await readChat(ctx, storeless, () => null)).toEqual({ kind: 'skip', reason: 'no-store' })
    expect(await readChat(ctx, bad, () => null)).toEqual({ kind: 'skip', reason: 'unreadable' })
    // Half-written: remembered by nothing, so read again.
    const again = counted()
    await readChat(again.context(), bad, () => null)
    await readChat(again.context(), bad, () => null)
    expect(again.reads()).toBe(2)
    writeFileSync(join(bad, 'meta.json'), JSON.stringify({ createdAtMs: 1, hasConversation: true, cwd: '/work/other' }))
    expect((await readChat(again.context(), bad, () => null)).kind).toBe('chat')
    expect(await readChat(ctx, undated, () => null)).toEqual({ kind: 'skip', reason: 'unreadable' })
  })

  it('gives every chat of a bucket the folder one of them names, and trusts a folder only when its md5 is the bucket', async () => {
    const { config, provider } = roots()
    chat(config, CWD, ID, { meta: { createdAtMs: 1, hasConversation: true, updatedAtMs: 5 } })
    chat(config, CWD, ID2, { meta: { createdAtMs: 1, hasConversation: true, updatedAtMs: 6, cwd: '/work/elsewhere' } })
    chat(config, CWD, ID3, { meta: { createdAtMs: 1, hasConversation: true, updatedAtMs: 7, cwd: `${CWD}/` } })
    const found = await provider().scan(counted().context())
    expect(found.map((s) => [s.sessionId, s.cwd])).toEqual([ID, ID2, ID3].map((id) => [id, CWD]))
    // A bucket whose only folder is wrong is not placed.
    const lone = roots()
    chat(lone.config, CWD, ID, { meta: { createdAtMs: 1, hasConversation: true, cwd: '/work/elsewhere' } })
    expect(await lone.provider().scan(counted().context())).toEqual([])
  })

  it('finds the folder of chats that never recorded it, from the project their transcript is filed under', async () => {
    const { config, data, provider } = roots()
    const base = temp('cursor-folder-')
    // `a-b` has the same slug as `a-b/_`, but not the md5 the bucket needs.
    const folder = join(base, 'a-b', '_')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(base, 'a-b', 'a file'), '')
    const meta = { createdAtMs: 1, hasConversation: true, updatedAtMs: 9 }
    chat(config, folder, ID, { meta })
    chat(config, folder, ID2, { meta })
    transcript(data, cursorSlug(folder), ID2)
    const scan = counted()
    const found = await provider().scan(scan.context())
    expect(found.map((s) => [s.sessionId, s.cwd])).toEqual([[ID, folder], [ID2, folder]])
    expect(found[1].transcriptPath).toBe(join(data, 'projects', cursorSlug(folder), 'agent-transcripts', ID2, `${ID2}.jsonl`))
    // The walk is remembered while the bucket's chats are the same ones.
    const reads = scan.reads()
    await provider().scan(scan.context())
    expect(scan.reads()).toBe(reads)
  })

  it('does not place chats whose folder is gone or cannot be reached', async () => {
    const { config, data, provider } = roots()
    const meta = { createdAtMs: 1, hasConversation: true }
    // Gone: two chats filed under one project, which is walked once.
    chat(config, '/nowhere/app-x', ID, { meta })
    chat(config, '/nowhere/app-x', ID2, { meta })
    transcript(data, cursorSlug('/nowhere/app-x'), ID)
    transcript(data, cursorSlug('/nowhere/app-x'), ID2)
    // No transcript at all.
    chat(config, '/nowhere/else', ID3, { meta })
    expect(await provider().scan(counted().context())).toEqual([])
  })

  it('stops walking after a bounded number of folders', async () => {
    const { config, data, provider } = roots()
    const base = temp('cursor-deep-')
    // Folders named `_` add nothing to a slug: every one of them looks like the way on.
    mkdirSync(join(base, ...Array.from({ length: 300 }, () => '_')), { recursive: true })
    const target = join(base, 'missing')
    chat(config, target, ID, { meta: { createdAtMs: 1, hasConversation: true } })
    transcript(data, cursorSlug(target), ID)
    expect(await provider().scan(counted().context())).toEqual([])
  })

  it('dates a chat by its store when `meta.json` does not say, the WAL included', async () => {
    const { config, provider } = roots()
    const dir = chat(config, CWD, ID, { meta: { createdAtMs: 1, hasConversation: true, cwd: CWD, updatedAtMs: 0 } })
    utimesSync(join(dir, 'store.db'), 1_700_000_000, 1_700_000_000)
    expect((await provider().scan(counted().context()))[0].mtime).toBe(1_700_000_000_000)
    writeFileSync(join(dir, 'store.db-wal'), 'wal')
    utimesSync(join(dir, 'store.db-wal'), 1_700_000_500, 1_700_000_500)
    expect((await provider().scan(counted().context()))[0].mtime).toBe(1_700_000_500_000)
  })

  it('finds a transcript filed under another project (a `--workspace` run), and the flat layout of older builds', async () => {
    const { config, data, provider } = roots()
    chat(config, CWD, ID)
    chat(config, CWD, ID2)
    chat(config, CWD, ID3)
    const moved = transcript(data, 'somewhere-else', ID)
    const flat = transcript(data, 'older', ID2, undefined, true)
    // A second flat copy elsewhere does not replace the first one found, and a text transcript is not one.
    transcript(data, 'zz-older', ID2, undefined, true)
    mkdirSync(join(data, 'projects', 'text', 'agent-transcripts', ID3), { recursive: true })
    writeFileSync(join(data, 'projects', 'text', 'agent-transcripts', ID3, `${ID3}.txt`), 'user: hi')
    writeFileSync(join(data, 'projects', 'text', 'agent-transcripts', `${ID3}.txt`), 'user: hi')
    mkdirSync(join(data, 'projects', 'mcp-only', 'mcps'), { recursive: true })
    mkdirSync(join(data, 'projects', 'text', 'agent-transcripts', 'not-a-uuid'), { recursive: true })
    writeFileSync(join(data, 'projects', '.agent-data-cleanup-2026-09-27'), '')
    const found = await provider().scan(counted().context())
    const byId = Object.fromEntries(found.map((s) => [s.sessionId, s.transcriptPath]))
    expect(byId[ID]).toBe(moved)
    expect([flat, join(data, 'projects', 'zz-older', 'agent-transcripts', `${ID2}.jsonl`)]).toContain(byId[ID2])
    expect(byId[ID3]).toBeNull()
  })

  it('skips what is not a chat folder, and folders Harness keeps its own sessions in', async () => {
    const { config, provider } = roots()
    chat(config, CWD, ID)
    mkdirSync(join(config, 'chats', 'not-a-bucket', ID), { recursive: true })
    writeFileSync(join(config, 'chats', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), '')
    mkdirSync(join(config, 'chats', cursorBucket(CWD), 'not-a-uuid'))
    writeFileSync(join(config, 'chats', cursorBucket(CWD), 'prompt_history.json'), '[]')
    mkdirSync(join(config, 'chats', cursorBucket('/work/empty')), { recursive: true })
    expect((await provider().scan(counted().context())).map((s) => s.sessionId)).toEqual([ID])
    expect(await provider().scan(counted(['/work']).context())).toEqual([])
    expect(await cursorProvider({ configDir: join(config, 'missing'), dataDir: config }).scan(counted().context())).toEqual([])
  })

  it('reads a chat again only when one of its files changed', async () => {
    const { config, provider } = roots()
    const dir = chat(config, CWD, ID)
    const scan = counted()
    const cursor = provider()
    await cursor.scan(scan.context())
    await cursor.scan(scan.context())
    expect([scan.reads(), scan.paces()]).toEqual([1, 2])
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ createdAtMs: 1, hasConversation: true, title: 'Renamed', cwd: CWD }))
    expect((await cursor.scan(scan.context()))[0].title).toBe('Renamed')
    expect(scan.reads()).toBe(2)
  })
})

describe('a chat with no meta.json, read from its store', () => {
  it('reads its title, whether it is empty or a sub-agent\'s, and checks the store is this chat\'s', async () => {
    const cases: Array<[unknown, string]> = [
      [hex({ agentId: ID, name: 'Refactor', latestRootBlobId: 'ab'.repeat(32) }), 'Refactor'],
      [hex({ name: 'New Agent', latestRootBlobId: 'ab' }), ''],
      [hex({ agentId: ID, latestRootBlobId: '' }), 'empty'],
      [hex({ agentId: ID, latestRootBlobId: 'ab', subagentInfo: { parentAgentId: ID2 } }), 'subagent'],
      [hex({ agentId: ID2, latestRootBlobId: 'ab' }), 'unreadable'],
      [hex(['not', 'an', 'object']), 'unreadable'],
      ['zz', 'unreadable'],
      ['abc', 'unreadable'],
      ['', 'unreadable'],
      [42, 'unreadable'],
      [undefined, 'unreadable'],
      ['ab'.repeat(64 * 1024 + 1), 'unreadable'],
    ]
    for (const [value, expected] of cases) {
      const { config } = roots()
      const dir = chat(config, CWD, ID, { meta: null })
      const read = await readChat(counted().context(), dir, () => fakeDatabase(value))
      expect(read.kind === 'chat' ? read.chat.meta.title : read.reason).toBe(expected)
    }
  })

  it('opens a store its Cursor closed immutable, so nothing is written beside it', async () => {
    const Database = builtinSqlite() as unknown as new (path: string, options: { readOnly: boolean }) => { exec(sql: string): void; close(): void }
    const { config, provider } = roots()
    const dir = chat(config, CWD, ID, { meta: null })
    rmSync(join(dir, 'store.db'))
    const writer = new Database(join(dir, 'store.db'), { readOnly: false })
    writer.exec(`PRAGMA journal_mode=WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('0', '${hex({ agentId: ID, name: 'Stored', latestRootBlobId: 'ab' })}')`)
    writer.close()
    expect(readdirSync(dir).sort()).toEqual(['store.db'])
    // The chat has no folder of its own; a sibling names the bucket's.
    chat(config, CWD, ID2)
    // No `database` given: the provider uses this Node's own SQLite.
    const found = await cursorProvider({ configDir: config, dataDir: temp() }).scan(counted().context())
    expect(found.map((s) => [s.sessionId, s.title])).toEqual([[ID, 'Stored'], [ID2, 'Fix the build']])
    expect(readdirSync(dir).sort()).toEqual(['store.db'])
    void provider
  })

  it('reads a store its Cursor still has open through the WAL, where the latest metadata is', async () => {
    const Database = builtinSqlite() as unknown as new (path: string, options: { readOnly: boolean }) => { exec(sql: string): void; close(): void }
    const { config } = roots()
    const dir = chat(config, CWD, ID, { meta: null })
    rmSync(join(dir, 'store.db'))
    const writer = new Database(join(dir, 'store.db'), { readOnly: false })
    try {
      writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('0', '${hex({ agentId: ID, name: 'Old', latestRootBlobId: 'ab' })}')`)
      writer.exec(`UPDATE meta SET value = '${hex({ agentId: ID, name: 'Latest', latestRootBlobId: 'ab' })}' WHERE key = '0'`)
      expect(existsSync(join(dir, 'store.db-wal')) && existsSync(join(dir, 'store.db-shm'))).toBe(true)
      const read = await readChat(counted().context(), dir, () => builtinSqlite() as unknown as CursorDatabase)
      expect(read.kind === 'chat' && read.chat.meta.title).toBe('Latest')
    } finally {
      writer.close()
    }
  })

  it('tries again next scan when a store cannot be opened, and reads nothing with no SQLite', async () => {
    const { config } = roots()
    const dir = chat(config, CWD, ID, { meta: null })
    let opens = 0
    const Broken = class { constructor() { opens++; throw new Error('database is locked') } } as unknown as CursorDatabase
    const scan = counted()
    expect(await readChat(scan.context(), dir, () => Broken)).toEqual({ kind: 'skip', reason: 'unreadable' })
    expect(await readChat(scan.context(), dir, () => Broken)).toEqual({ kind: 'skip', reason: 'unreadable' })
    expect(opens).toBe(2)
    expect(await readChat(counted().context(), dir, () => null)).toEqual({ kind: 'skip', reason: 'unreadable' })
  })

  it('opens the store in place while its WAL files are there, and as an immutable URL when they are not', async () => {
    const { config } = roots()
    const dir = chat(config, CWD, ID, { meta: null })
    const opened: Array<string | URL> = []
    const value = hex({ agentId: ID, latestRootBlobId: 'ab' })
    await readChat(counted().context(), dir, () => fakeDatabase(value, opened))
    writeFileSync(join(dir, 'store.db-wal'), '')
    writeFileSync(join(dir, 'store.db-shm'), '')
    await readChat(counted().context(), dir, () => fakeDatabase(value, opened))
    expect(opened.map(String)).toEqual([`file://${join(dir, 'store.db')}?immutable=1`, join(dir, 'store.db')])
  })
})

describe('cursorProvider.owners', () => {
  const NODE = '/Users/x/.local/share/cursor-agent/versions/2026.09.26/node'
  const cursorRow = (pid: number, args = '', ppid = 1): RunningProcess => ({
    pid, ppid, executable: NODE, args: `cursor-agent --use-system-ca /Users/x/.local/share/cursor-agent/versions/2026.09.26/index.js ${args}`.trim(),
  })

  /** No [files]: `lsof` said nothing at all. */
  function view(rows: RunningProcess[], files?: Record<number, string[]>, alive: (pid: number) => boolean = () => true) {
    const asked: number[][] = []
    const processes: ProcessView = {
      list: async () => rows,
      openFiles: async (pids) => { asked.push([...pids]); return new Map(files ? pids.map((pid) => [pid, files[pid] ?? []]) : []) },
      openFilesOf: async () => new Map(),
      alive,
    }
    return { processes, asked }
  }

  it('claims the chat whose store a running Cursor holds open', async () => {
    const { config, provider } = roots()
    const dir = chat(config, CWD, ID)
    const store = join(dir, 'store.db')
    const { processes } = view([cursorRow(70)], { 70: [store, `${store}-wal`, `${store}-shm`, '/dev/ttys003'] })
    expect(await provider().owners!(processes)).toEqual([{ sessionId: ID, pid: 70, record: store }])
  })

  it('reads the files of Cursor processes only, and nothing when none runs', async () => {
    const { provider } = roots()
    const { processes, asked } = view([{ pid: 5, ppid: 1, executable: '/usr/bin/python3', args: 'python3 cursor-agent.py' }, cursorRow(71)], undefined, (pid) => pid !== 71)
    expect(await provider().owners!(processes)).toEqual([])
    expect(asked).toEqual([])
  })

  it('knows a chat store by where it is, whichever spelling of the config folder `lsof` prints', async () => {
    const { config, provider } = roots()
    const bucket = cursorBucket(CWD)
    const worker = `/Users/x/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-agent-worker/worker-data/w/chats/${bucket}/${ID2}/store.db`
    const { processes } = view([cursorRow(72)], {
      72: [
        join(config, 'chats', bucket, ID, 'store.db'),
        worker,
        join(config, 'chats', bucket, ID3, 'store.db-journal'),
        join(config, 'chats', bucket, 'not-a-uuid', 'store.db'),
        join(config, 'chats', 'not-a-bucket', ID3, 'store.db'),
      ],
    })
    expect(await provider().owners!(processes)).toEqual([{ sessionId: ID, pid: 72, record: join(config, 'chats', bucket, ID, 'store.db') }])
  })

  it('falls back to the chat its `--resume` names when no store is open', async () => {
    const { config, provider } = roots()
    const dir = chat(config, CWD, ID)
    writeFileSync(join(config, 'chats', 'README'), '')
    mkdirSync(join(config, 'chats', 'not-a-bucket', ID2), { recursive: true })
    writeFileSync(join(config, 'chats', 'not-a-bucket', ID2, 'store.db'), '')
    const { processes } = view([
      cursorRow(73, `--resume ${ID}`), cursorRow(74, `--resume=${ID2}`), cursorRow(75, '--resume 0123456789abcdef'), cursorRow(76),
    ])
    // Arguments only say where a process started: a guess, never stopped on.
    expect(await provider().owners!(processes)).toEqual([
      { sessionId: ID, pid: 73, record: join(dir, 'store.db'), fromArgs: true },
      { sessionId: ID2, pid: 74, record: '', fromArgs: true },
    ])
    // A Cursor that has not made its config folder yet.
    const bare = cursorProvider({ configDir: join(config, 'missing'), dataDir: config, database: null })
    expect(await bare.owners!(view([cursorRow(73, `--resume ${ID}`)]).processes)).toEqual([{ sessionId: ID, pid: 73, record: '', fromArgs: true }])
  })

  it('never offers to stop a chat in Cursor\'s own tmux server', async () => {
    const { config, provider } = roots()
    const store = join(chat(config, CWD, ID), 'store.db')
    const rows: RunningProcess[] = [
      { pid: 10, ppid: 1, executable: 'tmux', args: 'tmux -u -L cursor-agent -f /dev/null new-session -d' },
      { pid: 11, ppid: 10, executable: '/bin/bash', args: 'bash -l' },
      cursorRow(80, '', 11),
      { pid: 12, ppid: 1, executable: '/opt/homebrew/bin/tmux', args: '/opt/homebrew/bin/tmux -Lcursor-agent-2 attach' },
      cursorRow(81, `--resume ${ID}`, 12),
      { pid: 13, ppid: 1, executable: 'tmux', args: 'tmux -L harness new-session' },
      cursorRow(82, `--resume ${ID}`, 13),
      { pid: 14, ppid: 1, executable: '/bin/zsh', args: 'tmux -L' },
      cursorRow(83, `--resume ${ID}`, 14),
    ]
    const { processes } = view(rows, { 80: [store] })
    const claims = await provider().owners!(processes)
    expect(claims.map((claim) => [claim.pid, claim.app ?? false])).toEqual([[80, true], [81, true], [82, false], [83, false]])
  })

  it('looks only a few parents up for that tmux server', async () => {
    const { config, provider } = roots()
    chat(config, CWD, ID)
    const rows: RunningProcess[] = [
      { pid: 20, ppid: 1, executable: 'tmux', args: 'tmux -L cursor-agent' },
      ...[21, 22, 23, 24].map((pid) => ({ pid, ppid: pid - 1, executable: '/bin/sh', args: '' })),
      cursorRow(90, `--resume ${ID}`, 24),
    ]
    const claims = await provider().owners!(view(rows).processes)
    expect(claims.map((claim) => claim.app ?? false)).toEqual([false])
  })
})

describe('cursorProvider.busy', () => {
  it('reads the transcript of the chat whose store the owner holds', async () => {
    const { config, data, provider } = roots()
    const open = chat(config, CWD, ID)
    transcript(data, 'work-app', ID, [USER, ASSISTANT, ENDED, USER, ASSISTANT])
    const closed = chat(config, CWD, ID2, { meta: { createdAtMs: 1, hasConversation: true } })
    transcript(data, 'somewhere-else', ID2)
    const cursor = provider()
    expect(await cursor.busy!({ pid: 1, record: join(open, 'store.db') })).toBe(true)
    // No folder in its `meta.json`: its transcript is found by id.
    expect(await cursor.busy!({ pid: 1, record: join(closed, 'store.db') })).toBe(false)
  })

  it('cannot say without a store or a transcript', async () => {
    const { config, provider } = roots()
    const dir = chat(config, CWD, ID)
    expect(await provider().busy!({ pid: 1, record: '' })).toBeNull()
    expect(await provider().busy!({ pid: 1, record: join(dir, 'store.db') })).toBeNull()
  })
})

describe('cursorTurnOpen', () => {
  it('is open when a prompt follows the last `turn_ended`, and cannot say from answers alone', async () => {
    const { data } = roots()
    expect(await cursorTurnOpen(transcript(data, 'p', ID, [USER, ASSISTANT, ENDED]))).toBe(false)
    expect(await cursorTurnOpen(transcript(data, 'p', ID2, [USER, ENDED, USER]))).toBe(true)
    expect(await cursorTurnOpen(transcript(data, 'p', ID3, [ASSISTANT, 'not json']))).toBeNull()
    expect(await cursorTurnOpen(join(data, 'missing.jsonl'))).toBeNull()
  })

  it('reads further back past one long last line', async () => {
    const { data } = roots()
    const long = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] } })
    expect(await cursorTurnOpen(transcript(data, 'p', ID, [USER, long]))).toBe(true)
    const huge = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5 * 1024 * 1024) }] } })
    expect(await cursorTurnOpen(transcript(data, 'p', ID2, [USER, huge]))).toBeNull()
  })
})
