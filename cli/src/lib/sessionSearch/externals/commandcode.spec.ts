import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { commandCodeActivity, commandcodeProvider, readCommandCodeHead, readCommandCodeMeta } from './commandcode.js'
import { scanMemo } from './support.js'
import { type ExternalProvider, type ProcessView, type RunningProcess, UNSETTLED } from './types.js'

// Shapes follow command-code 1.66.0's own writer and the repo's recorded Command Code session
// (engines/commandcode/normalizer.spec.ts); every value here is made up.
const ID = '34e1385f-c18a-4f54-bf12-f8f57e151a3d'
const ID2 = '5d2c9b1e-0000-4000-8000-000000000002'
const T0 = Date.parse('2026-09-01T10:00:00.000Z')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commandcode-external-'))
  dirs.push(dir)
  return dir
}

const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const header = (id: string, cwd: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: at(0), cwd, ...extra })
const message = (role: string, seconds: number, source = role === 'user' ? 'user' : 'model') =>
  JSON.stringify({ type: 'message', id: `m${seconds}`, parentId: null, timestamp: at(seconds), message: { role, content: [{ type: 'text', text: 'words' }], meta: { source } } })
const jsonl = (...lines: string[]) => `${lines.join('\n')}\n`

function write(path: string, content: string, mtimeSeconds?: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mtimeSeconds !== undefined) utimesSync(path, new Date(T0 + mtimeSeconds * 1000), new Date(T0 + mtimeSeconds * 1000))
  return path
}

/** A transcript where Command Code puts it; the slug is not derived here, since it is never read. */
function transcript(home: string, slug: string, id: string, lines: string[], mtimeSeconds?: number): string {
  return write(join(home, 'projects', slug, `${id}.jsonl`), jsonl(...lines), mtimeSeconds)
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
  list: async () => rows, openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map(), alive: () => true,
})

describe('readCommandCodeHead', () => {
  const head = async (content: string, id = ID) => readCommandCodeHead(write(join(temp(), `${id}.jsonl`), content), id)

  it("reads the folder from Command Code's v3 header, when it names the file's own id", async () => {
    expect(await head(jsonl(header(ID, '/work/app'), message('user', 1)))).toEqual({ sessionId: ID, cwd: '/work/app' })
    expect(await head(`\n  \n${jsonl(header(ID, '/work/app'))}`)).toEqual({ sessionId: ID, cwd: '/work/app' })
    // A fork (`/fork`, `--fork`) is a session of its own that names its parent.
    expect(await head(jsonl(header(ID, '/w', { parentSession: '/elsewhere/parent.jsonl' })))).toEqual({ sessionId: ID, cwd: '/w' })
    // A later format keeps the header's shape: its sessions are still listed.
    expect(await head(jsonl(header(ID, '/w', { version: 4 })))).toEqual({ sessionId: ID, cwd: '/w' })
  })

  it('refuses a v3 header that names another id, no time or a relative folder', async () => {
    expect(await head(jsonl(header(ID2, '/w')))).toBeNull()
    expect(await head(jsonl(header(ID, '/w', { timestamp: 5 })))).toBeNull()
    expect(await head(jsonl(header(ID, 'relative')))).toBeNull()
  })

  it('cannot judge yet a file from before v3 (Command Code rewrites it when it opens it) or a first line that is no header', async () => {
    expect(await head(jsonl(JSON.stringify({ sessionId: ID, role: 'user', content: 'x', metadata: { version: 2, entrypoint: 'interactive' } })))).toBe(UNSETTLED)
    expect(await head(jsonl(header(ID, '/w', { version: 2 })))).toBe(UNSETTLED)
    expect(await head(jsonl(header(ID, '/w', { version: '3' })))).toBe(UNSETTLED)
    expect(await head(jsonl(message('user', 1)))).toBe(UNSETTLED)
    expect(await head(jsonl('{torn'))).toBe(UNSETTLED)
  })

  it('says "not yet" while the header is being written, and "never" when no line fits the bound', async () => {
    expect(await head(header(ID, '/w'))).toBe(UNSETTLED)
    expect(await head('\n\n')).toBe(UNSETTLED)
    expect(await head('x'.repeat(256 * 1024 + 1))).toBeNull()
    // A header larger than the first read is read whole on a second.
    expect(await head(jsonl(header(ID, '/w', { extra: 'y'.repeat(40_000) }), message('user', 1)))).toEqual({ sessionId: ID, cwd: '/w' })
  })
})

describe('readCommandCodeMeta', () => {
  it('reads the title, and whether a headless run made the session', async () => {
    const dir = temp()
    expect(await readCommandCodeMeta(write(join(dir, 'a.meta.json'), JSON.stringify({ title: '  Fix the build  ', model: 'm', userRenamed: true }))))
      .toEqual({ title: 'Fix the build', headless: false })
    expect(await readCommandCodeMeta(write(join(dir, 'b.meta.json'), JSON.stringify({ entrypoint: 'print' })))).toEqual({ title: '', headless: true })
    expect(await readCommandCodeMeta(write(join(dir, 'c.meta.json'), JSON.stringify({ entrypoint: 'interactive', title: 7 })))).toEqual({ title: '', headless: false })
    expect(await readCommandCodeMeta(write(join(dir, 'd.meta.json'), '{"title": "torn'))).toEqual({ title: '', headless: false })
    expect(await readCommandCodeMeta(join(dir, 'missing.meta.json'))).toEqual({ title: '', headless: false })
  })
})

describe('commandCodeActivity', () => {
  it("is Command Code's own time: its newest entry's, never the header's", async () => {
    const dir = temp()
    expect(await commandCodeActivity(write(join(dir, 'a.jsonl'), jsonl(
      header(ID, '/w', { timestamp: at(999) }), message('user', 10), message('assistant', 30),
      JSON.stringify({ type: 'session_info', id: 'i', parentId: null, timestamp: at(20), name: 'n' }),
      JSON.stringify({ type: 'label', timestamp: 'never' }), '{torn',
    )))).toBe(T0 + 30_000)
    expect(await commandCodeActivity(write(join(dir, 'b.jsonl'), jsonl(header(ID, '/w'))))).toBeNull()
    expect(await commandCodeActivity(join(dir, 'gone.jsonl'))).toBeNull()
  })

  it('reads only the end of a long transcript', async () => {
    const dir = temp()
    const long = JSON.stringify({ type: 'message', id: 'big', timestamp: at(5), message: { role: 'user', content: 'x'.repeat(70_000) } })
    expect(await commandCodeActivity(write(join(dir, 'a.jsonl'), jsonl(header(ID, '/w'), long, message('assistant', 6))))).toBe(T0 + 6_000)
  })
})

describe('commandcodeProvider', () => {
  it('lists each transcript under its header, titled from its meta file, beside the sidecars that are not transcripts', async () => {
    const home = temp()
    const path = transcript(home, 'users-me-work-app', ID, [header(ID, '/Users/me/Work/App'), message('user', 1), message('assistant', 2)])
    const folder = join(home, 'projects', 'users-me-work-app')
    write(join(folder, `${ID}.meta.json`), JSON.stringify({ title: 'Ship it' }))
    write(join(folder, `${ID}.prompts.jsonl`), jsonl(JSON.stringify({ prompt: 'x', cwd: '/Users/me/Work/App' })))
    write(join(folder, `${ID}.checkpoints.jsonl`), jsonl(JSON.stringify({ cwd: '/Users/me/Work/App' })))
    write(join(folder, `${ID}.share.json`), '{}')
    write(join(folder, `${ID}.v2.bak`), 'old')
    write(join(folder, 'notes.jsonl'), jsonl(header('notes', '/w')))
    expect(await scanner(commandcodeProvider({ home }))()).toEqual([
      { sessionId: ID, engine: 'commandcode', cwd: '/Users/me/Work/App', origin: 'terminal', title: 'Ship it', mtime: T0 + 2_000, transcriptPath: path },
    ])
  })

  it('leaves out headless runs, excluded folders, files from before the v3 format, and what is not a transcript file', async () => {
    const home = temp()
    transcript(home, 'a', ID, [header(ID, '/w/headless'), message('user', 1)])
    write(join(home, 'projects', 'a', `${ID}.meta.json`), JSON.stringify({ entrypoint: 'print' }))
    transcript(home, 'b', ID2, [header(ID2, '/data/harness/summary-scratch'), message('user', 1)])
    transcript(home, 'c', 'aaaaaaaa-0000-4000-8000-000000000003', [JSON.stringify({ sessionId: 'x', role: 'user', content: 'x', metadata: { version: 2 } })])
    write(join(home, 'projects', 'stray.jsonl'), jsonl(header(ID, '/w')))
    mkdirSync(join(home, 'projects', 'd', 'bbbbbbbb-0000-4000-8000-000000000004.jsonl'), { recursive: true })
    symlinkSync(join(home, 'nowhere.jsonl'), join(home, 'projects', 'd', 'cccccccc-0000-4000-8000-000000000005.jsonl'))
    const kept = transcript(home, 'e', 'dddddddd-0000-4000-8000-000000000006', [header('dddddddd-0000-4000-8000-000000000006', '/w/kept'), message('user', 1)])
    const found = await scanner(commandcodeProvider({ home }), ['/data/harness'])()
    expect(found.map((s) => [s.transcriptPath, s.title])).toEqual([[kept, '']])
  })

  it('titles a session with a torn meta file by nothing, dates one with no entry time by its file, and follows a linked project folder', async () => {
    const home = temp()
    const elsewhere = temp()
    write(join(elsewhere, `${ID}.jsonl`), jsonl(header(ID, '/w/linked'), JSON.stringify({ type: 'message', timestamp: 'later', message: { role: 'user', content: 'x' } })), 700)
    write(join(elsewhere, `${ID}.meta.json`), '{"title": "to')
    mkdirSync(join(home, 'projects'), { recursive: true })
    symlinkSync(elsewhere, join(home, 'projects', 'w-linked'))
    expect(await scanner(commandcodeProvider({ home }))()).toMatchObject([{ sessionId: ID, cwd: '/w/linked', title: '', mtime: T0 + 700_000 }])
  })

  it('lists a transcript whose header was still being written once it is whole', async () => {
    const home = temp()
    const path = write(join(home, 'projects', 'w', `${ID}.jsonl`), header(ID, '/w'))
    const scan = scanner(commandcodeProvider({ home }))
    expect(await scan()).toEqual([])
    appendFileSync(path, `\n${message('user', 1)}\n`)
    expect((await scan()).map((s) => s.sessionId)).toEqual([ID])
  })

  it('lists a file from before v3 once Command Code rewrites it in place with a header', async () => {
    const home = temp()
    const legacy = JSON.stringify({ sessionId: ID, role: 'user', content: 'x', timestamp: at(1), metadata: { version: 2, entrypoint: 'interactive' } })
    const path = transcript(home, 'w', ID, [legacy], 100)
    const scan = scanner(commandcodeProvider({ home }))
    expect(await scan()).toEqual([])
    // Unchanged: not read again, and still not listed.
    expect(await scan()).toEqual([])
    // Migrated as Command Code does it: a new file renamed over the old one.
    write(`${path}.tmp`, jsonl(header(ID, '/w/migrated'), message('user', 1)), 200)
    renameSync(`${path}.tmp`, path)
    expect((await scan()).map((s) => [s.sessionId, s.cwd])).toEqual([[ID, '/w/migrated']])
  })

  it('reads a meta file again only when it changed, and the header never again', async () => {
    const home = temp()
    const path = transcript(home, 'w', ID, [header(ID, '/w'), message('user', 1)], 100)
    const metaPath = write(join(home, 'projects', 'w', `${ID}.meta.json`), JSON.stringify({ title: 'First' }), 100)
    const scan = scanner(commandcodeProvider({ home }))
    expect((await scan())[0]).toMatchObject({ title: 'First', mtime: T0 + 1_000 })
    write(metaPath, JSON.stringify({ title: 'Firsx' }), 100)
    expect((await scan())[0].title).toBe('First')
    write(metaPath, JSON.stringify({ title: 'Renamed' }), 200)
    expect((await scan())[0].title).toBe('Renamed')
    // Headless learned late (the meta file is written after the transcript's header): dropped then.
    write(metaPath, JSON.stringify({ entrypoint: 'print' }), 300)
    expect(await scan()).toEqual([])
    rmSync(metaPath)
    write(path, jsonl(header(ID, '/w/elsewhere'), message('user', 1), message('assistant', 9)), 400)
    expect((await scan())[0]).toMatchObject({ cwd: '/w', title: '', mtime: T0 + 9_000 })
  })

  it('says which process has a session open from a resume in its arguments, and never whether it is mid-turn', async () => {
    const home = temp()
    const path = transcript(home, 'w', ID, [header(ID, '/w'), message('user', 1)])
    const provider = commandcodeProvider({ home })
    await scanner(provider)()
    const claims = await provider.owners!(view([
      // A process that kept its arguments (the recorded macOS row in tmux.spec.ts has these).
      row(4242, '⌘ Greeting', `cmd -r ${ID}`),
      row(4243, 'node', `node /opt/lib/node_modules/command-code/dist/index.mjs --resume ${ID2}`),
      // Renamed, as 1.66.0 does at start: nothing left to read.
      row(4244, 'command-code', 'command-code'),
      row(4247, '⌘ Greeting', '⌘ Greeting'),
      row(4245, '⌘ Other', 'cmd -r "Fix the build"'),
      row(4246, 'python3', `python3 tool.py --resume ${ID}`),
    ]))
    expect(claims).toEqual([
      { sessionId: ID, pid: 4242, record: path, fromArgs: true },
      { sessionId: ID2, pid: 4243, record: '', fromArgs: true },
    ])
    expect(await provider.busy!(claims[0])).toBeNull()
  })
})
