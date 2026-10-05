import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { execFileSync, spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeContinuation } from './sessionRepair.js'

/**
 * Repair binds a live launcher back to a session the daemon lost track of. The danger is not failing to
 * find one — that only costs a tile until the next turn — it is finding the WRONG one and pointing an
 * agent at another agent's transcript. So these tests are mostly about when it must refuse.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.GROK_HOME
  vi.resetModules()
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repair-'))
  dirs.push(dir)
  return dir
}

/** A claude-shaped transcript: `<id>.jsonl` under a project dir, first line carrying its cwd. */
function writeTranscript(root: string, project: string, id: string, cwd: string, mtimeMs: number): void {
  const dir = join(root, project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', cwd, id })}\n`)
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
}

async function load(claudeProjectsDir: string) {
  vi.resetModules()
  process.env.CLAUDE_PROJECTS_DIR = claudeProjectsDir
  return import('./sessionRepair.js')
}

const STARTED_AT = Date.parse('2026-08-03T09:00:00Z')
const CWD = '/Users/demo/work/project'

describe('session repair', () => {
  it('finds the session the running engine started in this directory', async () => {
    const root = tempRoot()
    writeTranscript(root, 'proj', 'sess-live', CWD, STARTED_AT + 5_000)
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT))
      .resolves.toMatchObject({ sessionId: 'sess-live' })
  })

  it('finds the cwd even when the transcript opens with bookkeeping lines', async () => {
    // Claude's first records are `leafUuid` / `mode` with no cwd anywhere in them. A first-line-only read
    // therefore matched NO claude session on a real machine — the repair returned null for a pane whose
    // transcript was sitting right there.
    const root = tempRoot()
    const dir = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sess-meta-first.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'summary', leafUuid: 'x', sessionId: 'sess-meta-first' }),
      JSON.stringify({ type: 'x-mode', mode: 'default', sessionId: 'sess-meta-first' }),
      JSON.stringify({ type: 'user', cwd: CWD, sessionId: 'sess-meta-first' }),
      '',
    ].join('\n'))
    utimesSync(file, new Date(STARTED_AT + 5_000), new Date(STARTED_AT + 5_000))
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT))
      .resolves.toMatchObject({ sessionId: 'sess-meta-first' })
  })

  it('ignores a session that predates the process now running the pane', async () => {
    // A transcript older than the engine cannot be what it is running — that would be a resume, and
    // resumes name their id on the command line (discoverTmuxResumes handles those).
    const root = tempRoot()
    writeTranscript(root, 'proj', 'sess-yesterday', CWD, STARTED_AT - 24 * 3_600_000)
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('ignores a session belonging to a different directory', async () => {
    const root = tempRoot()
    writeTranscript(root, 'other', 'sess-elsewhere', '/Users/demo/other', STARTED_AT + 5_000)
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('does not hand a just-exited session to the engine that replaced it', async () => {
    // Real sequence: `/exit`, then relaunch in the same pane seconds later. The dead transcript's last
    // write is still fresh, so a mtime-only rule with a generous slack bound the NEW agent to the OLD
    // session id (measured on a live pane). Its file was created before this process and has not been
    // written to since it started — neither tier may accept it.
    const root = tempRoot()
    const dir = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sess-just-exited.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: CWD })}\n`)
    const born = Date.now()                    // the temp file's real birthtime
    const lastWrite = born + 20_000            // it wrote, then the user exited…
    utimesSync(file, new Date(lastWrite), new Date(lastWrite))
    const { findLiveSession } = await load(root)

    // …and the replacement process started AFTER that last write.
    await expect(findLiveSession('claude', CWD, born + 40_000)).resolves.toBeNull()
  })

  it('still finds a RESUMED session, whose file is old but freshly written', async () => {
    // The other side of the same coin: `claude --resume` writes to a transcript created earlier. A write
    // that lands after the process started is what marks it as the one being run right now.
    const root = tempRoot()
    const dir = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sess-resumed.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: CWD })}\n`)
    const born = Date.now()
    const startedAt = born + 30_000            // the engine started well after the file was created…
    utimesSync(file, new Date(startedAt + 10_000), new Date(startedAt + 10_000)) // …and wrote after that
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, startedAt))
      .resolves.toMatchObject({ sessionId: 'sess-resumed' })
  })

  it('refuses to choose when two agents are running in the same directory', async () => {
    // The whole point: a wrong guess wires one agent's tile to the other's transcript, and nothing
    // downstream could tell. Staying invisible for one more turn is the cheaper failure.
    const root = tempRoot()
    writeTranscript(root, 'proj', 'sess-a', CWD, STARTED_AT + 5_000)
    writeTranscript(root, 'proj', 'sess-b', CWD, STARTED_AT + 9_000)
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('picks the transcript path along with the id, so the session can actually be tailed', async () => {
    const root = tempRoot()
    writeTranscript(root, 'proj', 'sess-live', CWD, STARTED_AT + 1_000)
    const { findLiveSession } = await load(root)

    const found = await findLiveSession('claude', CWD, STARTED_AT)
    expect(found?.transcriptPath).toBe(join(root, 'proj', 'sess-live.jsonl'))
  })

  it('skips sidecar files that are not transcripts', async () => {
    // Command Code writes `<id>.checkpoints.jsonl` next to the real transcript; adopting one would
    // register a session id that no reader can follow.
    const root = tempRoot()
    const dir = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    const sidecar = join(dir, 'sess-live.checkpoints.jsonl')
    writeFileSync(sidecar, `${JSON.stringify({ cwd: CWD })}\n`)
    utimesSync(sidecar, new Date(STARTED_AT + 5_000), new Date(STARTED_AT + 5_000))
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('says nothing rather than throwing when the engine store is missing', async () => {
    const { findLiveSession } = await load(join(tempRoot(), 'does-not-exist'))
    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('has no answer for cursor, and says so instead of guessing', async () => {
    // Cursor transcripts are located by id, not listed by directory; its resumes have their own path.
    const { findLiveSession } = await load(tempRoot())
    await expect(findLiveSession('cursor', CWD, STARTED_AT)).resolves.toBeNull()
  })
})

/**
 * A fork is bound by the repair sweep (`bornOnly`) while its parent is usually still running. The parent's
 * Claude subagents write transcripts of their own right next to it, and being the youngest file in the
 * project they used to be picked as the fork's session — wiring the fork to a subagent of its parent.
 */
describe('session repair — Claude subagent transcripts', () => {
  const lines = (...records: object[]) => `${records.map(r => JSON.stringify(r)).join('\n')}\n`
  function write(root: string, rel: string, body: string, mtimeMs: number): string {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body)
    utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
    return file
  }
  function projects(): string { return join(tempRoot(), 'projects') }
  async function sweep(root: string) {
    const { findLiveSession } = await load(root)
    return findLiveSession('claude', CWD, STARTED_AT, { bornOnly: true, pid: 4242 })
  }
  function parentWithSubagent(root: string): void {
    write(root, 'proj/p-sess.jsonl', lines({ type: 'user', isSidechain: false, cwd: CWD }), STARTED_AT - 3_600_000)
    write(root, 'proj/p-sess/subagents/agent-a1.jsonl',
      lines({ type: 'user', isSidechain: true, cwd: CWD, sessionId: 'p-sess' }), STARTED_AT + 60_000)
  }

  it('S1 never binds a subagent transcript, even when it is the only candidate', async () => {
    const root = projects()
    parentWithSubagent(root)
    await expect(sweep(root)).resolves.toBeNull()
  })

  it('S2 binds the fork own transcript instead of the parent subagent', async () => {
    const root = projects()
    parentWithSubagent(root)
    const file = write(root, 'proj/fork-sess.jsonl',
      lines({ type: 'permission-mode' }, { type: 'user', isSidechain: false, cwd: CWD }), STARTED_AT + 30_000)
    await expect(sweep(root)).resolves.toEqual({ sessionId: 'fork-sess', transcriptPath: file })
  })

  it('S3 skips a sidechain transcript even outside a subagents directory', async () => {
    const root = projects()
    write(root, 'proj/agent-b2.jsonl', lines({ type: 'user', isSidechain: true, cwd: CWD }), STARTED_AT + 10_000)
    await expect(sweep(root)).resolves.toBeNull()
  })

  it('S4 reads the first isSidechain flag past bookkeeping records and ignores later ones', async () => {
    const root = projects()
    const file = write(root, 'proj/main-sess.jsonl', lines(
      { type: 'summary' }, { type: 'x-mode' },
      { type: 'user', isSidechain: false, cwd: CWD },
      { type: 'assistant', isSidechain: true },
    ), STARTED_AT + 10_000)
    await expect(sweep(root)).resolves.toEqual({ sessionId: 'main-sess', transcriptPath: file })
  })

  it('does not refuse every transcript because the projects root sits under a folder named subagents', async () => {
    const root = join(tempRoot(), 'subagents', 'projects')
    const file = write(root, 'proj/main-sess.jsonl', lines({ type: 'user', isSidechain: false, cwd: CWD }), STARTED_AT + 10_000)
    await expect(sweep(root)).resolves.toEqual({ sessionId: 'main-sess', transcriptPath: file })
  })

  it('still refuses a subagents directory below such a root', async () => {
    const root = join(tempRoot(), 'subagents', 'projects')
    write(root, 'proj/p/subagents/agent-a1.jsonl', lines({ type: 'user', cwd: CWD }), STARTED_AT + 10_000)
    await expect(sweep(root)).resolves.toBeNull()
  })

  it('reads only the head of a large transcript', async () => {
    const root = projects()
    const filler = JSON.stringify({ type: 'assistant', text: 'x'.repeat(300 * 1024) })
    // The opening record fits the head; a huge record after it must not be needed.
    const file = write(root, 'proj/big-sess.jsonl',
      `${JSON.stringify({ type: 'user', isSidechain: false, cwd: CWD })}\n${filler}\n`, STARTED_AT + 10_000)
    await expect(sweep(root)).resolves.toEqual({ sessionId: 'big-sess', transcriptPath: file })
  })

  it('treats a transcript with no isSidechain flag as a main session', async () => {
    const root = projects()
    const file = write(root, 'proj/plain-sess.jsonl', lines({ type: 'user', cwd: CWD }), STARTED_AT + 10_000)
    await expect(sweep(root)).resolves.toEqual({ sessionId: 'plain-sess', transcriptPath: file })
  })
})

describe('session repair — Claude subagent transcripts, verifier cases', () => {
  const lines = (...records: object[]) => `${records.map(r => JSON.stringify(r)).join('\n')}\n`
  function write(root: string, rel: string, body: string, mtimeMs: number): string {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body)
    utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
    return file
  }
  afterEach(() => { delete process.env.PI_HOME })

  it('does not let a subagent file make a resumed main session ambiguous (wrote tier)', async () => {
    // A `claude --resume` pane: its own file is old but freshly written, and a Task subagent it ran wrote
    // next to it. Before the fix both sat in the `wrote` tier and the pane was never repaired.
    const root = join(tempRoot(), 'projects')
    const born = Date.now()
    const startedAt = born + 30_000
    const main = write(root, 'proj/main-sess.jsonl', lines({ type: 'user', isSidechain: false, cwd: CWD }), startedAt + 10_000)
    write(root, 'proj/main-sess/subagents/agent-a1.jsonl',
      lines({ type: 'user', isSidechain: true, cwd: CWD, sessionId: 'main-sess' }), startedAt + 20_000)
    const { findLiveSession } = await load(root)
    await expect(findLiveSession('claude', CWD, startedAt)).resolves.toEqual({ sessionId: 'main-sess', transcriptPath: main })
  })

  it('binds the fork next to an old-layout sidechain file that used to tie with it', async () => {
    const root = join(tempRoot(), 'projects')
    write(root, 'proj/agent-b2.jsonl', lines({ type: 'user', isSidechain: true, cwd: CWD, sessionId: 'p-sess' }), STARTED_AT + 50_000)
    const fork = write(root, 'proj/fork-sess.jsonl', lines({ type: 'user', isSidechain: false, cwd: CWD }), STARTED_AT + 30_000)
    const { findLiveSession } = await load(root)
    await expect(findLiveSession('claude', CWD, STARTED_AT, { bornOnly: true, pid: 4242 }))
      .resolves.toEqual({ sessionId: 'fork-sess', transcriptPath: fork })
  })

  it('reads only the opening for the flag: a sidechain record past the scanned lines does not hide a main session', async () => {
    const root = join(tempRoot(), 'projects')
    const opening = Array.from({ length: 25 }, (_, i) => ({ type: 'x-mode', i }))
    const file = write(root, 'proj/long-sess.jsonl',
      lines({ type: 'summary' }, { type: 'user', cwd: CWD }, ...opening, { type: 'user', isSidechain: true, cwd: CWD }),
      STARTED_AT + 10_000)
    const { findLiveSession } = await load(root)
    await expect(findLiveSession('claude', CWD, STARTED_AT, { bornOnly: true }))
      .resolves.toEqual({ sessionId: 'long-sess', transcriptPath: file })
  })

  it('takes the cwd from a later record when the flagged opening carries none', async () => {
    const root = join(tempRoot(), 'projects')
    const file = write(root, 'proj/split-sess.jsonl',
      lines({ type: 'user', isSidechain: false }, { type: 'assistant', cwd: CWD }), STARTED_AT + 10_000)
    const { findLiveSession } = await load(root)
    await expect(findLiveSession('claude', CWD, STARTED_AT, { bornOnly: true }))
      .resolves.toEqual({ sessionId: 'split-sess', transcriptPath: file })
  })

  it('refuses a file whose first flagged record is a sidechain even when a later one says main', async () => {
    const root = join(tempRoot(), 'projects')
    write(root, 'proj/agent-c3.jsonl',
      lines({ type: 'user', isSidechain: true }, { type: 'user', isSidechain: false, cwd: CWD }), STARTED_AT + 10_000)
    const { findLiveSession } = await load(root)
    await expect(findLiveSession('claude', CWD, STARTED_AT, { bornOnly: true })).resolves.toBeNull()
  })

  it('still finds a main session behind a large opening record', async () => {
    const root = join(tempRoot(), 'projects')
    const file = write(root, 'proj/big-sess.jsonl',
      lines({ type: 'summary', summary: 'x'.repeat(150_000) }, { type: 'user', isSidechain: false, cwd: CWD }),
      STARTED_AT + 10_000)
    const { findLiveSession } = await load(root)
    await expect(findLiveSession('claude', CWD, STARTED_AT, { bornOnly: true }))
      .resolves.toEqual({ sessionId: 'big-sess', transcriptPath: file })
  })

  it('treats a non-boolean isSidechain as no flag', async () => {
    const root = join(tempRoot(), 'projects')
    const file = write(root, 'proj/odd-sess.jsonl',
      lines({ type: 'user', isSidechain: 'true', cwd: CWD }, { type: 'user', isSidechain: false }), STARTED_AT + 10_000)
    const { findLiveSession } = await load(root)
    await expect(findLiveSession('claude', CWD, STARTED_AT, { bornOnly: true }))
      .resolves.toEqual({ sessionId: 'odd-sess', transcriptPath: file })
  })

  it('leaves pi alone: its scan does not apply the Claude subagent rule', async () => {
    const piHome = tempRoot()
    process.env.PI_HOME = piHome
    const file = write(join(piHome, 'agent', 'sessions'), '--proj--/subagents/2026-08-03_pi-sess.jsonl',
      lines({ type: 'session', isSidechain: true, cwd: CWD }), STARTED_AT + 10_000)
    const { findLiveSession } = await load(join(tempRoot(), 'projects'))
    await expect(findLiveSession('pi', CWD, STARTED_AT, { bornOnly: true }))
      .resolves.toEqual({ sessionId: 'pi-sess', transcriptPath: file })
  })
})

/**
 * Muse opens sessions of its OWN under the user's workspace — memory reminders are the ones seen live.
 * They share the workspace_root, sit at the same depth, and are BORN LATER, so they beat the real session
 * on every signal repair used to look at. Measured on a live machine: the daemon tailed an 11-line
 * reminder session while the conversation ran on in another file, and web and device received nothing.
 */
describe('session repair — muse', () => {
  /** `<MUSE_HOME>/sessions/YYYY/MM/DD/<uuid>/session.jsonl`, with the workspace on line one. */
  function writeMuseSession(
    home: string,
    id: string,
    workspace: string,
    events: ReadonlyArray<{ scope: string; event: Record<string, unknown> }>,
    mtimeMs: number,
  ): void {
    const dir = join(home, 'sessions', '2026', '08', '06', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    const lines = [JSON.stringify({ payload: { record: { workspace_root: workspace } } })]
    for (const { scope, event } of events) lines.push(JSON.stringify({ payload: { kind: scope, event } }))
    writeFileSync(file, `${lines.join('\n')}\n`)
    utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
  }

  // `payload.kind` is the discriminator: a RUN is a conversation turn, a TASK is scheduler bookkeeping.
  // Note the run is asserted WITHOUT a prompt — a scheduled run is a real turn nobody typed.
  const runTurn = { scope: 'run', event: { kind: 'started', prompt: 'xin chao' } }
  const scheduledRun = { scope: 'run', event: { kind: 'started', prompt: '' } }
  const taskOnly = [
    { scope: 'task', event: { kind: 'started', task_id: 't-1' } },
    { scope: 'task', event: { kind: 'status', message: 'opening' } },
  ]

  async function loadMuse(museHome: string) {
    vi.resetModules()
    process.env.MUSE_HOME = museHome
    return import('./sessionRepair.js')
  }

  it('ignores a session nobody typed into, and binds the one they did', async () => {
    const home = tempRoot()
    writeMuseSession(home, 'real-session', CWD, [runTurn], STARTED_AT + 5_000)
    writeMuseSession(home, 'reminder-session', CWD, taskOnly, STARTED_AT + 9_000) // younger: used to win
    const { findLiveSession } = await loadMuse(home)

    await expect(findLiveSession('muse', CWD, STARTED_AT))
      .resolves.toMatchObject({ sessionId: 'real-session' })
  })

  it('binds a SCHEDULED run, whose prompt is empty because nobody typed it', async () => {
    // The filter must key on the run lifecycle, not on the presence of a prompt: a scheduled run is a
    // real turn the scheduler triggered. Requiring a prompt would leave those sessions unbindable.
    const home = tempRoot()
    writeMuseSession(home, 'scheduled-session', CWD, [scheduledRun], STARTED_AT + 5_000)
    const { findLiveSession } = await loadMuse(home)

    await expect(findLiveSession('muse', CWD, STARTED_AT))
      .resolves.toMatchObject({ sessionId: 'scheduled-session' })
  })

  it('binds nothing at all when the only candidate has no user turn', async () => {
    const home = tempRoot()
    writeMuseSession(home, 'reminder-session', CWD, taskOnly, STARTED_AT + 5_000)
    const { findLiveSession } = await loadMuse(home)

    await expect(findLiveSession('muse', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('still refuses when two real sessions share a directory', async () => {
    // The filter narrows the field; it must not resolve a genuine tie. Two sessions someone typed into
    // is the case the "one muse agent per directory" rule prevents upstream — repair stays fail-closed,
    // because guessing here wires one agent's tile to the other's transcript.
    const home = tempRoot()
    writeMuseSession(home, 'session-a', CWD, [runTurn], STARTED_AT + 5_000)
    writeMuseSession(home, 'session-b', CWD, [runTurn], STARTED_AT + 6_000)
    const { findLiveSession } = await loadMuse(home)

    await expect(findLiveSession('muse', CWD, STARTED_AT)).resolves.toBeNull()
  })
})

describe('session repair — Grok', () => {
  it('derives cwd and session id from the encoded updates.jsonl layout', async () => {
    const home = tempRoot()
    const id = '8184b11d-175e-46cb-9cee-cf41cafe70d2'
    const file = join(home, 'sessions', encodeURIComponent(CWD), id, 'updates.jsonl')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{}\n')
    vi.resetModules()
    process.env.GROK_HOME = home
    const { findLiveSession } = await import('./sessionRepair.js')

    await expect(findLiveSession('grok', CWD, STARTED_AT)).resolves.toEqual({ sessionId: id, transcriptPath: file })
  })

  it('reads the .cwd sidecar used by Grok for a long-path hash directory', async () => {
    const home = tempRoot()
    const id = '98ee3dac-175e-46cb-9cee-cf41cafe70d2'
    const group = join(home, 'sessions', 'cwd-hash-123')
    const file = join(group, id, 'updates.jsonl')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(join(group, '.cwd'), `${CWD}\n`)
    writeFileSync(file, '{}\n')
    vi.resetModules()
    process.env.GROK_HOME = home
    const { findLiveSession } = await import('./sessionRepair.js')

    await expect(findLiveSession('grok', CWD, STARTED_AT)).resolves.toEqual({ sessionId: id, transcriptPath: file })
  })
})

/** A codex rollout-shaped transcript: session_meta line one, under <codexHome>/sessions/. */
function writeCodexRollout(codexHome: string, id: string, cwd: string, mtimeMs: number): string {
  const dir = join(codexHome, 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-08-03T09-00-00-${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n`)
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

describe('session repair — Codex profiles', () => {
  it('scans the agent\'s own codexHome profile, not the default', async () => {
    const profile = tempRoot()
    const id = 'a1b2c3d4-1111-4a4a-8a8a-000000000001'
    const file = writeCodexRollout(profile, id, CWD, STARTED_AT + 5_000)
    vi.resetModules()
    const { findLiveSession } = await import('./sessionRepair.js')

    await expect(findLiveSession('codex', CWD, STARTED_AT, { codexHome: profile, bornOnly: true }))
      .resolves.toEqual({ sessionId: id, transcriptPath: file })
  })

  it('finds nothing when no codexHome override is given and the rollout lives in a custom profile', async () => {
    const profile = tempRoot()
    const defaultHome = tempRoot() // an empty stand-in default, so the assertion cannot depend on this machine's real ~/.codex
    const id = 'a1b2c3d4-1111-4a4a-8a8a-000000000002'
    writeCodexRollout(profile, id, CWD, STARTED_AT + 5_000)
    vi.resetModules()
    process.env.CODEX_HOME = defaultHome
    const { findLiveSession } = await import('./sessionRepair.js')

    try {
      // No opts.codexHome: falls back to the default CODEX_HOME, which does not contain this rollout.
      await expect(findLiveSession('codex', CWD, STARTED_AT, { bornOnly: true })).resolves.toBeNull()
    } finally {
      delete process.env.CODEX_HOME
    }
  })
})

describe('session repair — a Codex process names its own rollout', () => {
  it('names a fork among its siblings by the rollout its process holds open, where a scan must refuse', async () => {
    const profile = tempRoot()
    const fork = 'a1b2c3d4-1111-4a4a-8a8a-000000000003'
    const sibling = 'a1b2c3d4-1111-4a4a-8a8a-000000000004'
    const forkFile = writeCodexRollout(profile, fork, CWD, STARTED_AT + 1_000)
    const siblingFile = writeCodexRollout(profile, sibling, CWD, STARTED_AT + 2_000)
    const elsewhere = writeCodexRollout(tempRoot(), 'a1b2c3d4-1111-4a4a-8a8a-000000000005', CWD, STARTED_AT)
    vi.resetModules()
    const { codexProcessSession, findLiveSession } = await import('./sessionRepair.js')
    const sessions = join(profile, 'sessions')
    // Two born in the folder since the process started: guessing would wire a tile to a sibling.
    await expect(findLiveSession('codex', CWD, STARTED_AT, { codexHome: profile, bornOnly: true })).resolves.toBeNull()
    // The process holds one of them open, beside files that are not rollouts or not this profile's.
    const held = async () => [forkFile, '/dev/null', join(profile, 'notes.jsonl'), elsewhere]
    await expect(codexProcessSession(42, sessions, CWD, held)).resolves.toEqual({ sessionId: fork, transcriptPath: realpathSync(forkFile) })
    // Two held, or one for another folder: nothing, rather than a guess.
    await expect(codexProcessSession(42, sessions, CWD, async () => [forkFile, siblingFile])).resolves.toBeNull()
    await expect(codexProcessSession(42, sessions, '/Users/demo/elsewhere', held)).resolves.toBeNull()
    await expect(codexProcessSession(42, sessions, CWD, async () => [])).resolves.toBeNull()
  })

  it('reads a live process\'s open files, and binds the repair to the rollout it holds', async () => {
    const profile = tempRoot()
    const fork = 'a1b2c3d4-1111-4a4a-8a8a-000000000006'
    const forkFile = writeCodexRollout(profile, fork, CWD, STARTED_AT + 1_000)
    writeCodexRollout(profile, 'a1b2c3d4-1111-4a4a-8a8a-000000000007', CWD, STARTED_AT + 2_000)
    // A stand-in for Codex: a process that keeps its rollout open.
    const holder = spawn(process.execPath, ['-e', 'require("fs").openSync(process.argv[1], "r"); setInterval(() => {}, 60_000)', forkFile], { stdio: 'ignore' })
    try {
      vi.resetModules()
      const { findLiveSession, openFiles } = await import('./sessionRepair.js')
      await vi.waitFor(async () => expect(await openFiles(holder.pid!)).toContain(realpathSync(forkFile)), { timeout: 10_000, interval: 100 })
      await expect(findLiveSession('codex', CWD, STARTED_AT, { codexHome: profile, bornOnly: true, pid: holder.pid! }))
        .resolves.toEqual({ sessionId: fork, transcriptPath: realpathSync(forkFile) })
      expect(await openFiles(-1)).toEqual([])
    } finally {
      holder.kill()
    }
  })
})

describe('claudeContinuation', () => {
  it('follows a continued-in marker to the new session file', async () => {
    const dir = tempRoot()
    const oldPath = join(dir, 'old-session.jsonl')
    const newId = 'b6758945-6852-4214-8a42-2b448d8ad391'
    writeFileSync(
      oldPath,
      [
        JSON.stringify({ type: 'session', cwd: CWD, id: 'old-session' }),
        JSON.stringify({ type: 'continued-in', sessionId: 'old-session', continuedInSessionId: newId }),
      ].join('\n') + '\n',
    )
    writeFileSync(join(dir, `${newId}.jsonl`), [
      JSON.stringify({ type: 'session', cwd: CWD, id: newId }),
      JSON.stringify({ type: 'user', sessionId: newId, message: { role: 'user', content: 'carry on' } }),
    ].join('\n') + '\n')

    await expect(claudeContinuation(oldPath)).resolves.toEqual({
      sessionId: newId,
      transcriptPath: join(dir, `${newId}.jsonl`),
    })
  })

  it('returns null when the transcript has not rotated', async () => {
    const dir = tempRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, `${JSON.stringify({ type: 'session', cwd: CWD, id: 'session' })}\n`)
    await expect(claudeContinuation(path)).resolves.toBeNull()
  })

  it('returns null when the continued-in target file does not exist yet', async () => {
    const dir = tempRoot()
    const oldPath = join(dir, 'old-session.jsonl')
    writeFileSync(
      oldPath,
      `${JSON.stringify({ type: 'continued-in', continuedInSessionId: 'not-written-yet' })}\n`,
    )
    await expect(claudeContinuation(oldPath)).resolves.toBeNull()
  })

  it('finds the marker even past a large tail (bounded read)', async () => {
    const dir = tempRoot()
    const oldPath = join(dir, 'old-session.jsonl')
    const newId = 'b6758945-6852-4214-8a42-2b448d8ad391'
    const filler = JSON.stringify({ type: 'assistant', text: 'x'.repeat(200) })
    const lines = Array.from({ length: 50 }, () => filler)
    lines.push(JSON.stringify({ type: 'continued-in', continuedInSessionId: newId }))
    writeFileSync(oldPath, lines.join('\n') + '\n')
    writeFileSync(join(dir, `${newId}.jsonl`), [
      JSON.stringify({ type: 'session', cwd: CWD, id: newId }),
      JSON.stringify({ type: 'assistant', sessionId: newId, message: { role: 'assistant', content: 'hello' } }),
    ].join('\n') + '\n')

    await expect(claudeContinuation(oldPath)).resolves.toEqual({
      sessionId: newId,
      transcriptPath: join(dir, `${newId}.jsonl`),
    })
  })

  it('does not follow the marker to a background session nobody has spoken in', async () => {
    // `claude` writes the same marker when it moves a session to the BACKGROUND, and that file holds
    // two bookkeeping lines forever while the conversation goes on in the original. Following it left
    // the agent on an empty session, and Open then asked `--resume` for an id the CLI refuses because
    // it is running in the background (#262 follow-up, measured on a real transcript).
    const dir = tempRoot()
    const oldPath = join(dir, 'old-session.jsonl')
    const newId = '47a2bb52-5511-40ba-a9fb-8390572bc3de'
    writeFileSync(oldPath, [
      JSON.stringify({ type: 'user', sessionId: 'old-session', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'continued-in', sessionId: 'old-session', continuedInSessionId: newId }),
    ].join('\n') + '\n')
    const background = join(dir, `${newId}.jsonl`)
    writeFileSync(background, [
      JSON.stringify({ type: 'ai-title', sessionId: newId, title: 'Merge PR' }),
      JSON.stringify({ type: 'agent-name', sessionId: newId, name: 'harness Merge PR' }),
    ].join('\n') + '\n')

    await expect(claudeContinuation(oldPath)).resolves.toBeNull()

    // The pass after its first turn lands binds it, so a real continuation is only ever deferred.
    writeFileSync(background, [
      JSON.stringify({ type: 'ai-title', sessionId: newId, title: 'Merge PR' }),
      JSON.stringify({ type: 'user', sessionId: newId, message: { role: 'user', content: 'carry on' } }),
    ].join('\n') + '\n')
    await expect(claudeContinuation(oldPath)).resolves.toEqual({ sessionId: newId, transcriptPath: background })
  })

  it.each(['x', '漢', '📘'])('follows a continuation past the byte cap with %s bookkeeping', async (character) => {
    // A rollover can open on a `file-history-snapshot` big enough to push the first turn out of the
    // head this check reads. What it rules out is two short lines, so size alone answers for a file
    // larger than the bound — the bound must never be the thing that refuses a real conversation.
    const dir = tempRoot()
    const oldPath = join(dir, 'old-session.jsonl')
    const newId = 'c1d2e3f4-5511-40ba-a9fb-8390572bc3de'
    writeFileSync(oldPath, `${JSON.stringify({ type: 'continued-in', continuedInSessionId: newId })}\n`)
    const nextPath = join(dir, `${newId}.jsonl`)
    writeFileSync(nextPath, [
      JSON.stringify({ type: 'file-history-snapshot', sessionId: newId, blob: character.repeat(300 * 1024) }),
      JSON.stringify({ type: 'user', sessionId: newId, message: { role: 'user', content: 'carry on' } }),
    ].join('\n') + '\n')

    await expect(claudeContinuation(oldPath)).resolves.toEqual({ sessionId: newId, transcriptPath: nextPath })

    // Small Unicode-only bookkeeping is still an empty background session, not a conversation.
    writeFileSync(nextPath, JSON.stringify({ type: 'ai-title', title: character.repeat(12) }) + '\n')
    await expect(claudeContinuation(oldPath)).resolves.toBeNull()
  })

  it('returns null for a missing file', async () => {
    await expect(claudeContinuation('/nonexistent/path/session.jsonl')).resolves.toBeNull()
  })
})

describe('findResumedTranscript', () => {
  // A `claude --resume <id>` / `codex resume <id>` names its session on argv, and discovery binds that
  // id without waiting for a hook — but only to a transcript this machine actually holds, because the
  // registry refuses a claude/codex session with no file behind it.
  it('finds a claude transcript by its id across the project folders', async () => {
    const root = tempRoot()
    const id = 'f56f0a36-aa58-4af1-a6e2-a77386122332'
    writeTranscript(root, '-home-agent-abc', id, '/home/agent/abc', STARTED_AT)
    writeTranscript(root, '-home-agent-proj', 'other-session', '/home/agent/proj', STARTED_AT)
    const { findResumedTranscript } = await load(root)

    await expect(findResumedTranscript('claude', id)).resolves.toBe(join(root, '-home-agent-abc', `${id}.jsonl`))
    await expect(findResumedTranscript('claude', 'f56f0a36-0000-4af1-a6e2-a77386122332')).resolves.toBeNull()
  })

  it('finds a codex rollout under the agent\'s own profile', async () => {
    const profile = tempRoot()
    const id = 'a1b2c3d4-1111-4a4a-8a8a-000000000003'
    const file = writeCodexRollout(profile, id, CWD, STARTED_AT)
    vi.resetModules()
    const { findResumedTranscript } = await import('./sessionRepair.js')

    await expect(findResumedTranscript('codex', id, { codexHome: profile })).resolves.toBe(file)
  })

  it('never treats an argv value that is not a session id as one', async () => {
    const root = tempRoot()
    const { findResumedTranscript } = await load(root)
    await expect(findResumedTranscript('claude', '../../etc/passwd')).resolves.toBeNull()
    await expect(findResumedTranscript('cursor', 'f56f0a36-aa58-4af1-a6e2-a77386122332')).resolves.toBeNull()
  })
})

it.each(['local', 'utc'])('recovers an old Claude process in a busy project from its native %s record', async zone => {
  const home = tempRoot(); const root = join(home, 'projects')
  const id = '11111111-2222-4333-8444-555555555555'
  writeTranscript(root, 'project', id, CWD, STARTED_AT)
  writeTranscript(root, 'project', 'another-session', CWD, STARTED_AT)
  mkdirSync(join(home, 'sessions'))
  const procStart = zone === 'utc' ? new Date(STARTED_AT).toUTCString().replace(/ GMT$/, '') : new Date(STARTED_AT).toString()
  writeFileSync(join(home, 'sessions', '77.json'), JSON.stringify({ pid: 77, cwd: CWD, sessionId: id, procStart }))
  const { findLiveSession } = await load(root)
  expect(await findLiveSession('claude', CWD, STARTED_AT, { pid: 77, bornOnly: true })).toMatchObject({ sessionId: id })
})
it.each(['bad pid', 'bad start', 'missing file', 'bad json', 'different pid', 'different start', 'missing start', 'different cwd', 'missing cwd', 'missing id', 'invalid id', 'missing history'])('refuses stale/invalid Claude native metadata: %s', async mode => {
  const home = tempRoot(); const root = join(home, 'projects'); mkdirSync(root)
  const { claudeProcessSession } = await load(root)
  const record: Record<string, unknown> = { pid: 77, cwd: CWD, sessionId: '11111111-2222-4333-8444-555555555555', procStart: new Date(STARTED_AT).toUTCString() }
  if (mode === 'different pid') record.pid = 78
  if (mode === 'different start') record.procStart = new Date(STARTED_AT + 1000).toUTCString()
  if (mode === 'missing start') delete record.procStart
  if (mode === 'different cwd') record.cwd = '/different'
  if (mode === 'missing cwd') delete record.cwd
  if (mode === 'missing id') delete record.sessionId
  if (mode === 'invalid id') record.sessionId = '../escape'
  mkdirSync(join(home, 'sessions'))
  if (mode !== 'missing file') writeFileSync(join(home, 'sessions', '77.json'), mode === 'bad json' ? '{' : JSON.stringify(record))
  expect(await claudeProcessSession(mode === 'bad pid' ? -1 : 77, CWD, mode === 'bad start' ? NaN : STARTED_AT)).toBeNull()
})

/**
 * Hermes keeps one store per HOME, and `hermes -p <name>` has its own. A repair that only asked
 * `<HERMES_HOME>/state.db` could never rebind a profile agent after a restart — its row is in a
 * database that store has never heard of (openharness#191).
 */
describe('hermes repair across profile homes', () => {
  const hasSqlite = (() => {
    try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
  })()
  const t = hasSqlite ? it : it.skip
  const SID_DEFAULT = '20260727_162325_e25264'
  const SID_PROFILE = '20260921_152236_a1b2c3'

  /** A home whose store holds one session started in `cwd`. */
  function hermesHome(root: string, sessionId: string | null, cwd = CWD): string {
    mkdirSync(root, { recursive: true })
    execFileSync('sqlite3', [join(root, 'state.db'),
      'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT, started_at REAL);'
      + (sessionId ? `INSERT INTO sessions VALUES ('${sessionId}','cli','${cwd}',${Math.trunc(STARTED_AT / 1000) + 5});` : '')])
    return root
  }

  async function loadWithHome(home: string) {
    vi.resetModules()
    process.env.CLAUDE_PROJECTS_DIR = home
    process.env.HERMES_HOME = home
    const homes = await import('../engines/hermes/home.js')
    homes.forgetHermesHomes()
    return import('./sessionRepair.js')
  }

  t('binds a profile session and says which home it came from', async () => {
    const home = tempRoot()
    hermesHome(home, null)                                          // the default store: no session here
    const demo = hermesHome(join(home, 'profiles', 'demo'), SID_PROFILE)
    const { findLiveSession } = await loadWithHome(home)

    expect(await findLiveSession('hermes', CWD, STARTED_AT, { bornOnly: true }))
      .toMatchObject({ sessionId: SID_PROFILE, hermesHome: demo })
  })

  t('a default-home session still binds, and names the default home', async () => {
    const home = tempRoot()
    hermesHome(home, SID_DEFAULT)
    hermesHome(join(home, 'profiles', 'demo'), null)
    const { findLiveSession } = await loadWithHome(home)

    expect(await findLiveSession('hermes', CWD, STARTED_AT, { bornOnly: true }))
      .toMatchObject({ sessionId: SID_DEFAULT, hermesHome: home })
  })

  t('refuses when two homes both claim the directory', async () => {
    // Same rule as two rows in one store: ambiguous is a refusal, not a coin toss — pointing an agent
    // at another agent's history is the failure this whole file exists to prevent.
    const home = tempRoot()
    hermesHome(home, SID_DEFAULT)
    hermesHome(join(home, 'profiles', 'demo'), SID_PROFILE)
    const { findLiveSession } = await loadWithHome(home)

    expect(await findLiveSession('hermes', CWD, STARTED_AT, { bornOnly: true })).toBeNull()
  })
})
