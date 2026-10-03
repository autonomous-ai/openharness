import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { agyHistoryFolders, agyLatestFolders, agyProvider } from './agy.js'
import { scanMemo } from './support.js'
import type { ExternalProvider, ProcessView, RunningProcess } from './types.js'

// Shapes follow agy 1.1.14 as the repo measured it (engines/agy/session.ts, hook/notify.mjs, the
// recorded transcript lib/__fixtures__/agy-session.jsonl) and agy's documented `last_conversations.json`.
// `history.jsonl`'s fields are from a third-party reader of it (agentgrep). Values are made up.
const ID = 'ae51057a-0000-4000-8000-000000000001'
const ID2 = 'be51057a-0000-4000-8000-000000000002'
const ID3 = 'ce51057a-0000-4000-8000-000000000003'
const T0 = Date.parse('2026-09-01T10:00:00.000Z')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-external-'))
  dirs.push(dir)
  return dir
}

const jsonl = (...lines: unknown[]) => `${lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`
const step = (index: number, type: string) => ({ step_index: index, source: 'USER_EXPLICIT', type, status: 'DONE', created_at: '2026-09-01T10:00:00Z', content: 'words' })

function write(path: string, content: string, mtimeSeconds?: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mtimeSeconds !== undefined) utimesSync(path, new Date(T0 + mtimeSeconds * 1000), new Date(T0 + mtimeSeconds * 1000))
  return path
}

const transcriptOf = (home: string, id: string) => join(home, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl')

/** A top-level conversation: its transcript and its presence lock. */
function conversation(home: string, id: string, mtimeSeconds = 10, lock = true): string {
  const path = write(transcriptOf(home, id), jsonl(step(0, 'USER_INPUT'), step(1, 'PLANNER_RESPONSE')), mtimeSeconds)
  if (lock) write(join(home, 'presence', `${id}.lock`), '')
  return path
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

describe('agyHistoryFolders', () => {
  it("takes each conversation's workspace from its latest prompt that names both", async () => {
    const dir = temp()
    const path = write(join(dir, 'history.jsonl'), jsonl(
      { display: 'first', timestamp: T0, workspace: '/w/old', conversationId: ID },
      { display: 'no conversation', timestamp: T0, workspace: '/w/none' },
      { display: '/help', timestamp: T0, workspace: '/w/new', type: 'slash_command', conversationId: ID },
      { display: 'relative', timestamp: T0, workspace: 'w/rel', conversationId: ID2 },
      { display: 'no workspace', timestamp: T0, conversationId: ID3 },
      { display: 'empty id', timestamp: T0, workspace: '/w/x', conversationId: '' },
      '{"conversationId": torn',
    ))
    expect(await agyHistoryFolders(path)).toEqual(new Map([[ID, '/w/new']]))
    expect(await agyHistoryFolders(join(dir, 'missing.jsonl'))).toEqual(new Map())
  })
})

describe('agyLatestFolders', () => {
  it('turns the workspace → latest conversation map around, and places no conversation it names twice', async () => {
    const dir = temp()
    const path = write(join(dir, 'last.json'), JSON.stringify({ '/w/a': ID, '/w/b': ID2, '/w/c': ID2, 'rel/d': ID3, '/w/e': 7, '/w/f': '' }))
    expect(await agyLatestFolders(path)).toEqual(new Map([[ID, '/w/a']]))
    expect(await agyLatestFolders(write(join(dir, 'list.json'), '[1]'))).toEqual(new Map())
    expect(await agyLatestFolders(join(dir, 'missing.json'))).toEqual(new Map())
  })
})

describe('agyProvider', () => {
  it('lists each top-level conversation with a transcript, in the workspace its prompts name', async () => {
    const home = temp()
    const path = conversation(home, ID, 42)
    write(join(home, 'history.jsonl'), jsonl({ display: 'x', timestamp: T0, workspace: '/Users/me/Work/app', conversationId: ID }))
    expect(await scanner(agyProvider({ home }))()).toEqual([
      { sessionId: ID, engine: 'agy', cwd: '/Users/me/Work/app', origin: 'terminal', title: '', mtime: T0 + 42_000, transcriptPath: path },
    ])
  })

  it('places a conversation its prompts do not by the latest-conversation map, and the prompts win when both do', async () => {
    const home = temp()
    conversation(home, ID)
    conversation(home, ID2)
    write(join(home, 'history.jsonl'), jsonl({ display: 'x', timestamp: T0, workspace: '/w/from-history', conversationId: ID }))
    write(join(home, 'cache', 'last_conversations.json'), JSON.stringify({ '/w/from-cache': ID, '/w/latest': ID2 }))
    const found = await scanner(agyProvider({ home }))()
    expect(Object.fromEntries(found.map((s) => [s.sessionId, s.cwd]))).toEqual({ [ID]: '/w/from-history', [ID2]: '/w/latest' })
  })

  it('leaves out sub-agents (no lock), `-p` runs (no workspace), empty or missing transcripts, excluded folders and stray entries', async () => {
    const home = temp()
    conversation(home, ID, 10, false)                                    // a sub-agent: no presence lock
    conversation(home, ID2)                                              // `-p`: a lock, but no workspace anywhere
    write(transcriptOf(home, ID3), '')                                   // nobody has spoken in it yet
    write(join(home, 'presence', `${ID3}.lock`), '')
    const noTranscript = 'de51057a-0000-4000-8000-000000000004'
    mkdirSync(join(home, 'brain', noTranscript), { recursive: true })
    write(join(home, 'presence', `${noTranscript}.lock`), '')
    const lockIsFolder = 'ee51057a-0000-4000-8000-000000000005'
    conversation(home, lockIsFolder, 10, false)
    mkdirSync(join(home, 'presence', `${lockIsFolder}.lock`), { recursive: true })
    const scratch = 'fe51057a-0000-4000-8000-000000000006'
    conversation(home, scratch)
    mkdirSync(join(home, 'brain', 'not-a-conversation'), { recursive: true })
    write(join(home, 'brain', 'aa51057a-0000-4000-8000-000000000007'), 'a file, not a folder')
    const kept = '0a51057a-0000-4000-8000-000000000008'
    conversation(home, kept)
    write(join(home, 'history.jsonl'), jsonl(...[ID, ID3, noTranscript, lockIsFolder, kept].map((id) => ({ display: 'x', timestamp: T0, workspace: `/w/${id}`, conversationId: id })),
      { display: 'x', timestamp: T0, workspace: '/data/harness/summary-scratch', conversationId: scratch }))
    const found = await scanner(agyProvider({ home }), ['/data/harness'])()
    expect(found.map((s) => s.sessionId)).toEqual([kept])
  })

  it('reads the history again only when it changed', async () => {
    const home = temp()
    conversation(home, ID)
    const history = write(join(home, 'history.jsonl'), jsonl({ display: 'x', timestamp: T0, workspace: '/w/aaa', conversationId: ID }), 100)
    const scan = scanner(agyProvider({ home }))
    expect((await scan())[0].cwd).toBe('/w/aaa')
    write(history, jsonl({ display: 'x', timestamp: T0, workspace: '/w/bbb', conversationId: ID }), 100)
    expect((await scan())[0].cwd).toBe('/w/aaa')
    write(history, jsonl({ display: 'x', timestamp: T0, workspace: '/w/bbb', conversationId: ID }), 200)
    expect((await scan())[0].cwd).toBe('/w/bbb')
    rmSync(history)
    expect(await scan()).toEqual([])
  })

  it('finds nothing in a home agy never wrote', async () => {
    expect(await scanner(agyProvider({ home: join(temp(), 'nothing') }))()).toEqual([])
  })

  it('names the process that holds a conversation\'s lock open, however the presence folder is reached, and never says whether it is mid-turn', async () => {
    // lsof reports a file by its real path (on macOS the temp folder itself is behind a link).
    const real = realpathSync(temp())
    mkdirSync(join(real, 'presence'), { recursive: true })
    const home = join(temp(), 'linked-home')
    symlinkSync(real, home)
    const asked: number[][] = []
    const provider = agyProvider({ home })
    const view: ProcessView = {
      list: async () => [
        row(91701, 'agy', 'agy'),
        row(91702, '/Users/me/.local/bin/agy', '/Users/me/.local/bin/agy --conversation ' + ID3),
        row(91703, '/Applications/Antigravity.app/Contents/Resources/bin/agy', '/Applications/Antigravity.app/Contents/Resources/bin/agy'),
        row(91704, 'node', 'node server.js'),
      ],
      openFiles: async (pids) => {
        asked.push([...pids])
        return new Map([
          [91701, [join(home, 'presence', `${ID}.lock`), join(home, 'brain', ID, 'x.jsonl'), '/dev/ttys003']],
          [91702, [join(real, 'presence', `${ID2}.lock`), join(real, 'presence', 'not-an-id.lock'), join(real, 'elsewhere', `${ID3}.lock`), join(real, 'presence', `${ID3}.pid`)]],
        ])
      },
      openFilesOf: async () => { throw new Error('not used') },
      alive: () => true,
    }
    const claims = await provider.owners!(view)
    expect(asked).toEqual([[91701, 91702]])
    expect(claims).toEqual([
      { sessionId: ID, pid: 91701, record: join(home, 'presence', `${ID}.lock`) },
      { sessionId: ID2, pid: 91702, record: join(real, 'presence', `${ID2}.lock`) },
    ])
    expect(await provider.busy!(claims[0])).toBeNull()
  })

  it('asks nothing when no agy is running, and names the lock as configured when the folder is missing', async () => {
    const home = join(temp(), 'no-presence')
    const provider = agyProvider({ home })
    let asked = 0
    const view = (rows: RunningProcess[]): ProcessView => ({
      list: async () => rows,
      openFiles: async () => { asked++; return new Map([[5, [join(home, 'presence', `${ID}.lock`)]]]) },
      openFilesOf: async () => new Map(),
      alive: () => true,
    })
    expect(await provider.owners!(view([row(1, 'zsh', '-zsh')]))).toEqual([])
    expect(asked).toBe(0)
    expect(await provider.owners!(view([row(5, 'agy', 'agy')]))).toEqual([{ sessionId: ID, pid: 5, record: join(home, 'presence', `${ID}.lock`) }])
  })
})
