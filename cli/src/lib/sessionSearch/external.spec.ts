import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ExternalSessions, foregroundJob, OpenSessions, stopSessionOwner, TERMINAL_RESTORE, writeTty } from './external.js'
import type { ExternalEngine, ExternalProvider, ExternalSession, OwnerClaim, ProcessView } from './externals/types.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const session = (sessionId: string, engine: ExternalEngine, mtime: number, extra: Partial<ExternalSession> = {}): ExternalSession => ({
  sessionId, engine, cwd: `/work/${sessionId}`, origin: 'terminal', title: '', mtime, transcriptPath: `/t/${sessionId}.jsonl`, ...extra,
})

describe('ExternalSessions', () => {
  it("joins every engine's list, newest first, one entry per id, and keeps an engine's last list when it fails", async () => {
    let grokFails = false
    let cwdSeen: boolean | null = null
    const providers: ExternalProvider[] = [
      { engine: 'claude', scan: async (ctx) => { cwdSeen = ctx.excluded('/data/harness/x'); return [session('a', 'claude', 3), session('dup', 'claude', 1)] } },
      { engine: 'grok', scan: async () => { if (grokFails) throw new Error('store locked'); return [session('g', 'grok', 5), session('dup', 'grok', 2)] } },
      { engine: 'pi', scan: async () => { throw 'not an error object' } },
    ]
    const log: string[] = []
    const sessions = new ExternalSessions({ providers, excluded: ['/data/harness'], log: (line) => log.push(line) })
    expect(sessions.list()).toEqual([])
    const found = await sessions.scan()
    expect(found.map((s) => s.sessionId)).toEqual(['g', 'a', 'dup'])
    expect(sessions.get('dup')?.engine).toBe('grok')
    expect(sessions.get('none')).toBeUndefined()
    expect(cwdSeen).toBe(true)
    expect(log).toEqual(['[search] pi sessions not read: not an error object'])

    grokFails = true
    expect((await sessions.scan()).map((s) => s.sessionId)).toEqual(['g', 'a', 'dup'])
    expect(log).toContain('[search] grok sessions not read: store locked')
  })

  it('finds a conversation by an older id it carried on from, never over another conversation', async () => {
    const sessions = new ExternalSessions({ providers: [
      { engine: 'hermes', scan: async () => [
        session('tip', 'hermes', 5, { aliases: ['root', 'taken'] }),
        session('taken', 'hermes', 1),
      ] },
    ] })
    await sessions.scan()
    expect(sessions.get('root')?.sessionId).toBe('tip')
    expect(sessions.get('taken')?.sessionId).toBe('taken')
  })

  it('shares one scan between callers, and finds nothing with no engines', async () => {
    const sessions = new ExternalSessions({ providers: [] })
    const [a, b] = [sessions.scan(), sessions.scan()]
    expect(a).toBe(b)
    expect(await a).toEqual([])
  })
})

const quiet: ProcessView = { list: async () => [], openFiles: async () => new Map(), openFilesOf: async () => new Map(), alive: () => true }

describe('OpenSessions', () => {
  function open(providers: ExternalProvider[], extra: Partial<ConstructorParameters<typeof OpenSessions>[0]> = {}) {
    let now = 1_000
    let looks = 0
    const sessions = new OpenSessions({
      providers,
      view: () => { looks++; return quiet },
      ttys: async (pids) => new Map(pids.map((pid) => [pid, pid === 7 ? null : pid === 9 ? '/dev/ttys009' : `/dev/ttys00${pid}`])),
      harnessTtys: async () => new Set(['/dev/ttys009']),
      now: () => now,
      maxAgeMs: 5_000,
      ...extra,
    })
    return { sessions, tick: (ms: number) => { now += ms }, looks: () => looks }
  }

  it("says where each open session is: a terminal, an app, or one of Harness's own panes", async () => {
    const claims: OwnerClaim[] = [
      { sessionId: 'term', pid: 1, record: '/r/term' },
      { sessionId: 'notty', pid: 7, record: '/r/notty' },
      { sessionId: 'leader', pid: 2, record: '/r/leader', app: true },
      { sessionId: 'mine', pid: 9, record: '/r/mine' },
    ]
    const { sessions } = open([
      { engine: 'grok', scan: async () => [], owners: async () => claims },
      { engine: 'pi', scan: async () => [] },
    ])
    expect(sessions.known().size).toBe(0)
    expect(Object.fromEntries(await sessions.fresh())).toEqual({ term: 'terminal', notty: 'app', leader: 'app', mine: 'harness' })
    expect(await sessions.owner('term')).toEqual({ pid: 1, engine: 'grok', tty: '/dev/ttys001', record: '/r/term' })
    expect(await sessions.owner('leader')).toMatchObject({ tty: null })
    expect(await sessions.owner('mine')).toMatchObject({ harness: true })
    expect(await sessions.owner('none')).toBeNull()
  })

  it("calls one only its arguments name 'maybe', and lets harder evidence of the same session win", async () => {
    const { sessions } = open([
      { engine: 'opencode', scan: async () => [], owners: async () => [
        { sessionId: 'guess', pid: 1, record: '/r/1', fromArgs: true },
        { sessionId: 'both', pid: 2, record: '/r/argv', fromArgs: true },
        { sessionId: 'both', pid: 3, record: '/r/lock' },
        { sessionId: 'lockfirst', pid: 4, record: '/r/lock' },
        { sessionId: 'lockfirst', pid: 5, record: '/r/argv', fromArgs: true },
        { sessionId: 'twice', pid: 6, record: '/r/a' },
        { sessionId: 'twice', pid: 1, record: '/r/b' },
      ] },
    ])
    expect(Object.fromEntries(await sessions.fresh())).toMatchObject({ guess: 'maybe', both: 'terminal', lockfirst: 'terminal', twice: 'terminal' })
    expect(await sessions.owner('guess')).toMatchObject({ pid: 1, fromArgs: true })
    expect((await sessions.owner('both'))?.pid).toBe(3)
    expect((await sessions.owner('lockfirst'))?.pid).toBe(4)
    expect((await sessions.owner('twice'))?.pid).toBe(6)
  })

  it('reuses an answer for a while, looks again after, and looks now when asked who owns one', async () => {
    const { sessions, tick, looks } = open([{ engine: 'claude', scan: async () => [], owners: async () => [{ sessionId: 'a', pid: 1, record: '/r' }] }])
    await sessions.fresh()
    tick(1_000)
    await sessions.fresh()
    expect(looks()).toBe(1)
    expect(sessions.known().get('a')).toBe('terminal')
    tick(10_000)
    sessions.known()
    await sessions.fresh()
    expect(looks()).toBe(2)
    await sessions.owner('a')
    expect(looks()).toBe(3)
    // While a look is under way, a second caller shares it rather than starting another.
    const [x, y] = [sessions.owner('a'), sessions.owner('a')]
    await Promise.all([x, y])
    expect(looks()).toBe(4)
  })

  it("carries on when one engine cannot say, and asks nothing more when none has anything open", async () => {
    const log: string[] = []
    let asked = 0
    const { sessions } = open([
      { engine: 'codex', scan: async () => [], owners: async () => { throw new Error('lsof failed') } },
      { engine: 'devin', scan: async () => [], owners: async () => { throw 'odd' } },
      { engine: 'grok', scan: async () => [], owners: async () => [] },
    ], { log: (line) => log.push(line), ttys: async () => { asked++; return new Map() } })
    expect((await sessions.fresh()).size).toBe(0)
    expect(asked).toBe(0)
    expect(log).toEqual(['[search] codex owners not read: lsof failed', '[search] devin owners not read: odd'])
  })

  it("calls a terminal's session 'maybe' when Harness's own panes could not be listed", async () => {
    const { sessions } = open([{ engine: 'claude', scan: async () => [], owners: async () => [{ sessionId: 'a', pid: 1, record: '/r' }] }], {
      harnessTtys: async () => null,
    })
    expect((await sessions.fresh()).get('a')).toBe('maybe')
    expect(await sessions.owner('a')).toMatchObject({ tty: '/dev/ttys001', unverified: true })
  })

  it('reads no terminal and no Harness pane when those lookups fail', async () => {
    const { sessions } = open([{ engine: 'claude', scan: async () => [], owners: async () => [{ sessionId: 'a', pid: 1, record: '/r' }] }], {
      ttys: async () => { throw new Error('ps failed') },
      harnessTtys: async () => { throw new Error('tmux failed') },
    })
    expect(await sessions.owner('a')).toEqual({ pid: 1, engine: 'claude', tty: null, record: '/r' })
  })

  it("asks the owner's engine whether it is mid-turn, and counts not knowing as busy", async () => {
    const { sessions } = open([
      { engine: 'claude', scan: async () => [], busy: async (owner) => owner.pid === 1 },
      { engine: 'grok', scan: async () => [], busy: async () => null },
      { engine: 'codex', scan: async () => [], busy: async () => { throw new Error('unreadable') } },
      { engine: 'pi', scan: async () => [] },
    ])
    expect(await sessions.busy({ engine: 'claude', pid: 1, record: '' })).toBe(true)
    expect(await sessions.busy({ engine: 'claude', pid: 2, record: '' })).toBe(false)
    expect(await sessions.busy({ engine: 'grok', pid: 1, record: '' })).toBe(true)
    expect(await sessions.busy({ engine: 'codex', pid: 1, record: '' })).toBe(true)
    expect(await sessions.busy({ engine: 'pi', pid: 1, record: '' })).toBe(true)
    expect(await sessions.busy({ engine: 'muse', pid: 1, record: '' })).toBe(true)
  })

  it('looks at the real machine by default, and finds nothing open for engines with no owners', async () => {
    const sessions = new OpenSessions({ providers: [{ engine: 'pi', scan: async () => [], owners: async (view) => {
      const me = (await view.list()).find((row) => row.pid === process.pid)
      return me ? [{ sessionId: 'me', pid: me.pid, record: '' }] : []
    } }] })
    const owner = await sessions.owner('me')
    expect(owner?.pid).toBe(process.pid)
    // The default clock and reuse window: a second ask within five seconds is the same answer.
    expect(sessions.known().get('me')).toBeDefined()
    expect(await sessions.fresh()).toBe(await sessions.fresh())
  })
})

describe('stopSessionOwner', () => {
  it('asks it to quit, makes it after five seconds, and gives the terminal back', async () => {
    const signals: string[] = []
    const written: string[] = []
    let living = true
    let slept = 0
    const opts = {
      alive: () => living,
      job: async () => null,
      kill: (_pid: number, signal: NodeJS.Signals) => { signals.push(signal); if (signal === 'SIGTERM' && slept === 0) return; living = false },
      sleep: async (ms: number) => { slept += ms },
      writeTty: async (tty: string, text: string) => { written.push(`${tty} ${JSON.stringify(text)}`) },
    }
    expect(await stopSessionOwner({ pid: 7, tty: '/dev/ttys009' }, opts)).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(slept).toBe(5_000)
    expect(written).toEqual([`/dev/ttys009 ${JSON.stringify(TERMINAL_RESTORE)}`])

    // One that quits when asked is not made to; one that will not quit at all is reported.
    signals.length = 0; living = true; slept = 1
    expect(await stopSessionOwner({ pid: 7, tty: null }, opts)).toBe(true)
    expect(signals).toEqual(['SIGTERM'])
    expect(await stopSessionOwner({ pid: 8, tty: null }, { ...opts, alive: () => true, kill: () => { throw new Error('EPERM') } })).toBe(false)
    // A terminal that cannot be written to is left as it is.
    living = true; slept = 1
    expect(await stopSessionOwner({ pid: 7, tty: '/dev/gone' }, { ...opts, writeTty: async () => { throw new Error('ENOENT') } })).toBe(true)
  })

  it("signals the whole foreground job an engine leads, and only the engine otherwise", async () => {
    const targets: number[] = []
    let living = true
    const opts = { alive: () => living, sleep: async () => undefined, kill: (pid: number) => { targets.push(pid); living = false } }
    expect(await stopSessionOwner({ pid: 40, tty: null }, { ...opts, job: async () => 40 })).toBe(true)
    living = true
    expect(await stopSessionOwner({ pid: 41, tty: null }, { ...opts, job: async () => { throw new Error('ps failed') } })).toBe(true)
    expect(targets).toEqual([-40, 41])
    // Leading its group, and that group in front: the job. Anything else: none.
    const ps = (out: string | null) => async () => out
    expect(await foregroundJob(40, ps('  40   40\n'))).toBe(40)
    expect(await foregroundJob(40, ps('  12   40\n'))).toBeNull()
    expect(await foregroundJob(40, ps('  40   -1\n'))).toBeNull()
    expect(await foregroundJob(40, ps(null))).toBeNull()
    // This process leads no foreground job of a terminal.
    expect(await foregroundJob(process.pid)).toBeNull()
  })

  it('stops a real process, and writes the terminal back to a real file', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    const exited = new Promise((resolve) => child.on('exit', resolve))
    const dir = mkdtempSync(join(tmpdir(), 'external-stop-'))
    dirs.push(dir)
    const tty = join(dir, 'tty')
    writeFileSync(tty, '')
    // The child is ours, so it lingers as a zombie until reaped: count it gone once it has exited.
    let done = false
    void exited.then(() => { done = true })
    expect(await stopSessionOwner({ pid: child.pid!, tty }, { alive: () => !done })).toBe(true)
    expect(readFileSync(tty, 'utf8')).toBe(TERMINAL_RESTORE)
    await expect(writeTty(join(dir, 'missing', 'tty'), 'x')).rejects.toThrow()
  })

  it("stops a process that is not this one's child, as a terminal's never is", async () => {
    const { execFileSync } = await import('node:child_process')
    const pid = Number(execFileSync('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!']).toString().trim())
    expect(await stopSessionOwner({ pid, tty: null })).toBe(true)
  })
})
