import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { piActivity, piProvider, piSessionFolder, piTurnOpen, readPiHead, readPiTitle } from './pi.js'
import { scanMemo } from './support.js'
import { type ExternalProvider, type ProcessView, type RunningProcess, UNSETTLED } from './types.js'

// Shapes follow Pi 0.85.1's own writer (session-manager.js) and the repo's recorded Pi session
// (engines/pi/normalizer.spec.ts); every value here is made up.
const ID = '019fa2a5-a26d-700c-bf8c-97af19ae3d5f'
const ID2 = '019fa2a6-0000-7000-8000-000000000002'
const T0 = Date.parse('2026-09-01T10:00:00.000Z')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-external-'))
  dirs.push(dir)
  return dir
}

const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const header = (id: string, cwd: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: at(0), cwd, ...extra })
const message = (role: string, seconds: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'message', id: `m${seconds}`, parentId: null, timestamp: at(seconds), message: { role, content: [{ type: 'text', text: 'words' }], ...extra } })
const info = (name: unknown, seconds = 50) => JSON.stringify({ type: 'session_info', id: `i${seconds}`, parentId: null, timestamp: at(seconds), name })
const jsonl = (...lines: string[]) => `${lines.join('\n')}\n`

function write(path: string, content: string, mtimeSeconds?: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mtimeSeconds !== undefined) utimesSync(path, new Date(T0 + mtimeSeconds * 1000), new Date(T0 + mtimeSeconds * 1000))
  return path
}

/** A session file where Pi would put it: `<agentDir>/sessions/<folder of cwd>/<time>_<id>.jsonl`. */
function session(agentDir: string, cwd: string, id: string, lines: string[], mtimeSeconds?: number): string {
  return write(join(agentDir, 'sessions', piSessionFolder(cwd), `2026-09-01T10-00-00-000Z_${id}.jsonl`), jsonl(header(id, cwd), ...lines), mtimeSeconds)
}

/** Scans the way ExternalSessions does: one memo across scans, pruned after each. */
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

describe('readPiHead', () => {
  it('reads the id and folder from the header, as Pi resolves the folder', async () => {
    const dir = temp()
    expect(await readPiHead(write(join(dir, 'a.jsonl'), jsonl(header(ID, '/work/app/'))))).toEqual({ sessionId: ID, cwd: '/work/app' })
    expect(await readPiHead(write(join(dir, 'b.jsonl'), jsonl(header(ID, '/work/x/../app'), message('user', 1))))).toEqual({ sessionId: ID, cwd: '/work/app' })
  })

  it("takes a person's own id, within what Pi and Harness both accept", async () => {
    const dir = temp()
    const head = (id: unknown) => readPiHead(write(join(dir, `${Math.random()}.jsonl`), jsonl(header(id as string, '/w'))))
    expect(await head('my.session_2')).toEqual({ sessionId: 'my.session_2', cwd: '/w' })
    expect(await head('ab')).toEqual({ sessionId: 'ab', cwd: '/w' })
    expect(await head('a')).toBeNull()                      // Harness takes two characters at least
    expect(await head('-abc')).toBeNull()                   // Pi: starts and ends with a letter or digit
    expect(await head('abc-')).toBeNull()
    expect(await head('a/b')).toBeNull()
    expect(await head('x'.repeat(129))).toBeNull()
    expect(await head('notes.jsonl')).toBeNull()            // `--session notes.jsonl` is read as a path
    expect(await head(42)).toBeNull()
  })

  it('reads every header version (Pi migrates old ones on load) and a fork, which is a conversation of its own', async () => {
    const dir = temp()
    const v1 = JSON.stringify({ type: 'session', id: ID, timestamp: at(0), cwd: '/w' })
    expect(await readPiHead(write(join(dir, 'v1.jsonl'), jsonl(v1, JSON.stringify({ type: 'message', message: { role: 'user', content: 'x' } }))))).toEqual({ sessionId: ID, cwd: '/w' })
    expect(await readPiHead(write(join(dir, 'v2.jsonl'), jsonl(header(ID, '/w', { version: 2 }))))).toEqual({ sessionId: ID, cwd: '/w' })
    expect(await readPiHead(write(join(dir, 'fork.jsonl'), jsonl(header(ID2, '/w', { parentSession: join(dir, 'v2.jsonl') }))))).toEqual({ sessionId: ID2, cwd: '/w' })
  })

  it('skips blank and malformed lines before the header, as Pi does', async () => {
    const dir = temp()
    expect(await readPiHead(write(join(dir, 'a.jsonl'), `\n   \n{broken\nnull\n${header(ID, '/w')}\n`))).toEqual({ sessionId: ID, cwd: '/w' })
  })

  it('refuses a file whose first entry is not a session header, or one without an absolute folder', async () => {
    const dir = temp()
    expect(await readPiHead(write(join(dir, 'a.jsonl'), jsonl(message('user', 1), header(ID, '/w'))))).toBeNull()
    expect(await readPiHead(write(join(dir, 'b.jsonl'), jsonl('[1,2]')))).toBeNull()
    expect(await readPiHead(write(join(dir, 'c.jsonl'), jsonl(header(ID, 'relative/dir'))))).toBeNull()
    expect(await readPiHead(write(join(dir, 'd.jsonl'), jsonl(JSON.stringify({ type: 'session', id: ID }))))).toBeNull()
  })

  it('says "not yet" while the header is being written, and "never" past Pi\'s own bound', async () => {
    const dir = temp()
    expect(await readPiHead(write(join(dir, 'a.jsonl'), header(ID, '/w')))).toBe(UNSETTLED)
    expect(await readPiHead(write(join(dir, 'b.jsonl'), ''))).toBe(UNSETTLED)
    expect(await readPiHead(write(join(dir, 'c.jsonl'), 'x'.repeat(1024 * 1024 + 10)))).toBeNull()
    // A header larger than the first read (a long folder, extra fields) is read whole on a second.
    expect(await readPiHead(write(join(dir, 'd.jsonl'), jsonl(header(ID, '/w', { extra: 'y'.repeat(40_000) }), message('user', 1))))).toEqual({ sessionId: ID, cwd: '/w' })
  })
})

describe('piSessionFolder', () => {
  it("names a working directory's folder as Pi does, collisions and all", () => {
    expect(piSessionFolder('/Users/me/a-b/c')).toBe('--Users-me-a-b-c--')
    expect(piSessionFolder('/Users/me/a/b-c')).toBe('--Users-me-a-b-c--')
    expect(piSessionFolder('/tmp/with space')).toBe('--tmp-with space--')
    expect(piSessionFolder('/c:\\x')).toBe('--c--x--')
  })
})

describe('readPiTitle', () => {
  it("takes the latest session_info name; an empty one clears it; other lines never count", async () => {
    const dir = temp()
    const path = write(join(dir, 'a.jsonl'), jsonl(header(ID, '/w'), message('user', 1), info('  First name  ', 2)))
    expect((await readPiTitle(path)).title).toBe('First name')
    appendFileSync(path, jsonl(info('', 3)))
    expect((await readPiTitle(path)).title).toBe('')
    // A message that mentions the entry type is still a message.
    appendFileSync(path, jsonl(info('Second', 4), message('user', 5, { content: 'what is "session_info"?' }), '{"type":"session_info", torn', info(7, 6)))
    expect((await readPiTitle(path)).title).toBe('')
    expect((await readPiTitle(write(join(dir, 'b.jsonl'), jsonl(header(ID, '/w'), message('user', 1))))).title).toBe('')
  })

  it('reads on from where it stopped while the file only grows', async () => {
    const dir = temp()
    const path = write(join(dir, 'a.jsonl'), jsonl(header(ID, '/w'), info('Named', 1)))
    const first = await readPiTitle(path)
    expect(first).toMatchObject({ end: statSync(path).size, title: 'Named' })
    // Planted where a resumed read never looks: proof that it did not start over.
    const planted = { ...first, title: 'Kept from before' }
    appendFileSync(path, jsonl(message('user', 2)))
    expect(await readPiTitle(path, planted)).toEqual({ end: statSync(path).size, lead: first.lead, title: 'Kept from before' })
    appendFileSync(path, jsonl(info('Renamed', 3)))
    expect((await readPiTitle(path, planted)).title).toBe('Renamed')
  })

  it('starts over when the file was rewritten (a migration changes its header) or shrank', async () => {
    const dir = temp()
    const path = write(join(dir, 'a.jsonl'), jsonl(header(ID, '/w', { version: 2 }), info('Old', 1), message('user', 2)))
    const first = await readPiTitle(path)
    const planted = { ...first, title: 'stale' }
    write(path, jsonl(header(ID, '/w'), info('Old', 1), message('user', 2), message('assistant', 3, { stopReason: 'stop' })))
    expect((await readPiTitle(path, planted)).title).toBe('Old')
    write(path, jsonl(header(ID, '/w', { version: 2 })))
    expect(await readPiTitle(path, { ...first, lead: (await readPiTitle(path)).lead, title: 'stale' })).toMatchObject({ title: '' })
  })

  it('gives nothing to carry over when the file cannot be read', async () => {
    const dir = temp()
    expect(await readPiTitle(join(dir, 'gone.jsonl'))).toEqual({ end: 0, lead: '', title: '' })
    expect(await readPiTitle(join(dir, 'gone.jsonl'), { end: 10, lead: '', title: 'x' })).toEqual({ end: 0, lead: '', title: '' })
  })
})

describe('piActivity', () => {
  it("is Pi's own time: the newest user or assistant message, its own time first", async () => {
    const dir = temp()
    const path = write(join(dir, 'a.jsonl'), jsonl(
      header(ID, '/w'),
      message('user', 10),
      message('assistant', 20, { stopReason: 'toolUse', timestamp: T0 + 15_000 }),
      message('toolResult', 30),
      info('Named', 40),
      JSON.stringify({ type: 'message', message: 'not an object' }),
      '{"message": broken',
      JSON.stringify({ type: 'message', timestamp: 'never', message: { role: 'user', content: 'x' } }),
    ))
    expect(await piActivity(path)).toBe(T0 + 15_000)
  })

  it('reads only the end of a long file, and says nothing when no message is there', async () => {
    const dir = temp()
    const big = write(join(dir, 'a.jsonl'), jsonl(header(ID, '/w'), message('user', 5), JSON.stringify({ type: 'custom', data: 'x'.repeat(70_000) }), message('assistant', 9, { stopReason: 'stop' })))
    expect(await piActivity(big)).toBe(T0 + 9_000)
    expect(await piActivity(write(join(dir, 'b.jsonl'), jsonl(header(ID, '/w'), info('n'))))).toBeNull()
    expect(await piActivity(join(dir, 'gone.jsonl'))).toBeNull()
  })
})

describe('piTurnOpen', () => {
  const turn = async (...lines: string[]) => piTurnOpen(write(join(temp(), 's.jsonl'), jsonl(header(ID, '/w'), ...lines)))

  it("is open after a person's message or a tool's result, and while the assistant calls tools", async () => {
    expect(await turn(message('user', 1))).toBe(true)
    expect(await turn(message('user', 1), message('assistant', 2, { stopReason: 'toolUse' }), message('toolResult', 3))).toBe(true)
    expect(await turn(message('user', 1), message('assistant', 2, { stopReason: 'toolUse' }))).toBe(true)
  })

  it('is closed on any other stop, whatever bookkeeping follows it', async () => {
    for (const stopReason of ['stop', 'length', 'error', 'aborted']) {
      expect(await turn(message('user', 1), message('assistant', 2, { stopReason }))).toBe(false)
    }
    expect(await turn(message('user', 1), message('assistant', 2, { stopReason: 'stop' }), info('Named', 3),
      message('bashExecution', 4, { command: 'ls' }), JSON.stringify({ type: 'label', targetId: 'm1', label: 'x' }))).toBe(false)
  })

  it('cannot say without a message, or with an assistant message that names no stop', async () => {
    expect(await turn()).toBeNull()
    expect(await turn(message('assistant', 2))).toBeNull()
    expect(await piTurnOpen('')).toBeNull()
    expect(await piTurnOpen(join(temp(), 'gone.jsonl'))).toBeNull()
  })

  it('looks further back when one long entry fills the end of the file', async () => {
    expect(await turn(message('user', 1), message('assistant', 2, { stopReason: 'stop' }), JSON.stringify({ type: 'custom', data: 'x'.repeat(300_000) }))).toBe(false)
  })
})

describe('piProvider', () => {
  it("lists each session under its header's id and folder, folder-name collisions included", async () => {
    const agentDir = temp()
    const a = session(agentDir, '/tmp/a-b/c', ID, [message('user', 1), message('assistant', 2, { stopReason: 'stop' })])
    const b = session(agentDir, '/tmp/a/b-c', 'my.custom_id', [message('user', 3)], 100)
    expect(a.split('/').at(-2)).toBe(b.split('/').at(-2))
    const found = await scanner(piProvider({ agentDir }))()
    expect(found.sort((x, y) => x.sessionId.localeCompare(y.sessionId))).toEqual([
      { sessionId: ID, engine: 'pi', cwd: '/tmp/a-b/c', origin: 'terminal', title: '', mtime: T0 + 2_000, transcriptPath: a },
      { sessionId: 'my.custom_id', engine: 'pi', cwd: '/tmp/a/b-c', origin: 'terminal', title: '', mtime: T0 + 3_000, transcriptPath: b },
    ])
  })

  it('names a session by its latest session_info, and dates one with no message by its file', async () => {
    const agentDir = temp()
    session(agentDir, '/w/one', ID, [message('user', 1), info('Refactor auth', 2)])
    session(agentDir, '/w/two', ID2, [info('Just a name', 2)], 500)
    const found = await scanner(piProvider({ agentDir }))()
    expect(found.find((s) => s.sessionId === ID)).toMatchObject({ title: 'Refactor auth', mtime: T0 + 1_000 })
    expect(found.find((s) => s.sessionId === ID2)).toMatchObject({ title: 'Just a name', mtime: T0 + 500_000 })
  })

  it("leaves out what is not a resumable session: a file in another's folder, a bad header, an excluded folder, and what is not a file", async () => {
    const agentDir = temp()
    const sessions = join(agentDir, 'sessions')
    // A session whose folder is not its header's: `pi --session` from its folder would offer to fork it.
    write(join(sessions, piSessionFolder('/w/other'), `x_${ID}.jsonl`), jsonl(header(ID, '/w/moved'), message('user', 1)))
    write(join(sessions, piSessionFolder('/w/bad'), 'x_bad.jsonl'), jsonl(message('user', 1)))
    session(agentDir, '/data/harness/summary-scratch', ID2, [message('user', 1)])
    write(join(sessions, piSessionFolder('/w/ok'), 'notes.txt'), 'not a session')
    mkdirSync(join(sessions, piSessionFolder('/w/ok'), 'dir.jsonl'), { recursive: true })
    write(join(sessions, 'stray.jsonl'), jsonl(header(ID, '/w/ok')))
    const ok = session(agentDir, '/w/ok', 'kept-one', [message('user', 1)])
    const found = await scanner(piProvider({ agentDir }), ['/data/harness'])()
    expect(found.map((s) => s.transcriptPath)).toEqual([ok])
  })

  it('follows a linked folder, as Pi does', async () => {
    const agentDir = temp()
    const elsewhere = temp()
    const real = write(join(elsewhere, `x_${ID}.jsonl`), jsonl(header(ID, '/w/linked'), message('user', 1)))
    mkdirSync(join(agentDir, 'sessions'), { recursive: true })
    symlinkSync(elsewhere, join(agentDir, 'sessions', piSessionFolder('/w/linked')))
    const found = await scanner(piProvider({ agentDir }))()
    expect(found.map((s) => [s.sessionId, s.cwd])).toEqual([[ID, '/w/linked']])
    expect(real).toContain(elsewhere)
  })

  it('reads a moved sessions folder, flat, when the env or the settings file names one, and then only that', async () => {
    const agentDir = temp()
    const home = temp()
    session(agentDir, '/w/default', ID, [message('user', 1)])
    const flat = write(join(home, 'pi-sessions', `x_${ID2}.jsonl`), jsonl(header(ID2, '/w/anywhere'), message('user', 1)))
    const byEnv = await scanner(piProvider({ agentDir, sessionDir: join(home, 'pi-sessions') }))()
    expect(byEnv.map((s) => [s.sessionId, s.transcriptPath])).toEqual([[ID2, flat]])

    write(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '~/pi-sessions' }))
    expect((await scanner(piProvider({ agentDir, home }))()).map((s) => s.sessionId)).toEqual([ID2])
    write(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '~' }))
    expect(await scanner(piProvider({ agentDir, home }))()).toEqual([])
    write(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: 'relative/sessions' }))
    expect(await scanner(piProvider({ agentDir, home }))()).toEqual([])
  })

  it("uses Pi's own tree when the settings file names no folder, or cannot be read", async () => {
    const agentDir = temp()
    session(agentDir, '/w/default', ID, [message('user', 1)])
    for (const settings of [JSON.stringify({ theme: 'dark' }), JSON.stringify({ sessionDir: 5 }), '{torn', '[]']) {
      write(join(agentDir, 'settings.json'), settings)
      expect((await scanner(piProvider({ agentDir }))()).map((s) => s.sessionId)).toEqual([ID])
    }
    // No settings file, no sessions folder: nothing, and no error.
    expect((await scanner(piProvider({ agentDir: temp() }))())).toEqual([])
  })

  it('lists a session whose header was still being written once it is whole', async () => {
    const agentDir = temp()
    const path = write(join(agentDir, 'sessions', piSessionFolder('/w'), `x_${ID}.jsonl`), header(ID, '/w'))
    const scan = scanner(piProvider({ agentDir }))
    expect(await scan()).toEqual([])
    appendFileSync(path, `\n${message('user', 1)}\n`)
    expect((await scan()).map((s) => s.sessionId)).toEqual([ID])
  })

  it('reads a file again only when it changed; its header never', async () => {
    const agentDir = temp()
    const path = session(agentDir, '/w', ID, [message('user', 1), info('Before', 2)], 100)
    const scan = scanner(piProvider({ agentDir }))
    expect((await scan())[0]).toMatchObject({ title: 'Before', cwd: '/w' })
    // Same size and time: the memo answers, so a changed name goes unseen.
    write(path, jsonl(header(ID, '/w'), message('user', 1), info('Beforx', 2)), 100)
    expect((await scan())[0].title).toBe('Before')
    // Changed: read again, from where the last read stopped.
    appendFileSync(path, jsonl(info('After', 3)))
    expect((await scan())[0]).toMatchObject({ title: 'After', mtime: T0 + 1_000 })
    // The header is read once: what it says is not read again.
    write(path, jsonl(header(ID, '/w/elsewhere'), message('user', 1), info('Again', 4)), 200)
    expect((await scan())[0]).toMatchObject({ cwd: '/w', title: 'Again' })
  })

  it('forgets a deleted file, and reads a new one at its path from the start', async () => {
    const agentDir = temp()
    const kept = session(agentDir, '/w/kept', ID2, [message('user', 1)])
    const path = session(agentDir, '/w', ID, [info('Long gone name', 1), message('user', 1)])
    const scan = scanner(piProvider({ agentDir }))
    expect((await scan()).length).toBe(2)
    rmSync(path)
    expect((await scan()).map((s) => s.transcriptPath)).toEqual([kept])
    write(path, jsonl(header(ID, '/w'), message('user', 1)))
    expect((await scan()).find((s) => s.sessionId === ID)?.title).toBe('')
  })

  it("says which Pi has a session open from its arguments, and whether it is mid-turn from the session's file", async () => {
    const agentDir = temp()
    // Two files of one id (a copy): Pi's `--session` opens the one that moved last, and so does `busy`.
    const newer = write(join(agentDir, 'sessions', piSessionFolder('/w'), `a_${ID}.jsonl`), jsonl(header(ID, '/w'), message('user', 30)), 10)
    const older = write(join(agentDir, 'sessions', piSessionFolder('/w'), `b_${ID}.jsonl`), jsonl(header(ID, '/w'), message('user', 1), message('assistant', 2, { stopReason: 'stop' })), 20)
    const provider = piProvider({ agentDir })
    // Before any scan nothing says where a session's file is: it cannot say whether it is mid-turn.
    const early = await provider.owners!(view([row(7, 'pi', `pi --session ${ID}`)]))
    expect(early).toEqual([{ sessionId: ID, pid: 7, record: '', fromArgs: true }])
    expect(await provider.busy!(early[0])).toBeNull()

    await scanner(provider)()
    const claims = await provider.owners!(view([
      row(7, 'pi', `pi --session ${ID}`),
      row(8, 'node', `node /opt/lib/node_modules/pi-coding-agent/dist/cli.js --session-id ${ID2}`),
      // Pi renames its process, which leaves nothing to read.
      row(9, 'pi', 'pi'),
      row(10, 'node', `node server.js --session ${ID}`),
      row(11, 'pi', 'pi --session my.custom_id'),
    ]))
    expect(claims).toEqual([
      { sessionId: ID, pid: 7, record: newer, fromArgs: true },
      { sessionId: ID2, pid: 8, record: '', fromArgs: true },
    ])
    expect(await provider.busy!(claims[0])).toBe(true)
    expect(await provider.busy!({ pid: 7, record: older })).toBe(false)
  })
})
