import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { externalEvidence } from '../evidence.js'

import { copilotMovedAt, copilotOrigin, copilotProvider, copilotTurnOpen, readCopilotSession, workspaceYaml } from './copilot.js'
import { scanMemo } from './support.js'
import type { ProcessView, RunningProcess, ScanContext } from './types.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-external-'))
  dirs.push(dir)
  return dir
}

const ID = '10980e65-1a47-45ff-b666-90b8705efe20'
const ID2 = 'ef3f7502-a87c-41fd-b9b1-e1cbc9bcb643'
const ID3 = '5b0c6f7e-2d1a-4c3b-9e8f-7a6b5c4d3e2f'

function event(type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, timestamp = '2026-09-19T09:12:40.000Z'): string {
  return JSON.stringify({ type, data, id: 'e', timestamp, parentId: null, ...extra })
}

const start = (id: string, data: Record<string, unknown> = {}) =>
  event('session.start', { sessionId: id, version: 1, producer: 'copilot-agent', context: { cwd: '/work/start' }, ...data })
const ask = (extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}, at = '2026-09-19T09:12:41.000Z') =>
  event('user.message', { content: 'hello', ...data }, extra, at)
const answer = (at = '2026-09-19T09:12:44.137Z', extra: Record<string, unknown> = {}) => event('assistant.message', { content: 'hi' }, extra, at)
const turnStart = (extra: Record<string, unknown> = {}) => event('assistant.turn_start', { turnId: '1' }, extra)
const turnEnd = (extra: Record<string, unknown> = {}, at = '2026-09-19T09:12:44.200Z') => event('assistant.turn_end', { turnId: '1' }, extra, at)
const shutdown = () => event('session.shutdown', { shutdownType: 'routine' }, {}, '2026-09-20T01:53:00.000Z')

interface Fixture { events?: string[] | string | null; workspace?: string | null }

function session(root: string, id: string, fixture: Fixture = {}): string {
  const dir = join(root, 'session-state', id)
  mkdirSync(dir, { recursive: true })
  const events = fixture.events === undefined ? [start(id), ask(), turnStart(), answer(), turnEnd(), shutdown()] : fixture.events
  if (events !== null) writeFileSync(join(dir, 'events.jsonl'), typeof events === 'string' ? events : `${events.join('\n')}\n`)
  const workspace = fixture.workspace === undefined
    ? `id: ${id}\ncwd: /work/app\nclient_name: vscode-agent-host\nname: Greeting reply\nuser_named: false\nsummary_count: 0\n`
    : fixture.workspace
  if (workspace !== null) writeFileSync(join(dir, 'workspace.yaml'), workspace)
  return dir
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

function view(rows: RunningProcess[], alive: (pid: number) => boolean = () => true): ProcessView & { listed: () => number } {
  let listed = 0
  return {
    list: async () => { listed++; return rows },
    openFiles: async () => new Map(),
    cwds: async () => new Map(), openFilesOf: async () => new Map(),
    alive,
    listed: () => listed,
  }
}

const NATIVE = '/opt/homebrew/lib/node_modules/@github/copilot/node_modules/@github/copilot-darwin-arm64/copilot'
const cli = (pid: number, args = 'copilot'): RunningProcess => ({ pid, ppid: pid - 1, executable: NATIVE, args })

describe('copilotProvider.scan', () => {
  it('offers a session with the folder it is in now, its name, its program, and its last message\'s time', async () => {
    const root = home()
    session(root, ID)
    expect(await copilotProvider({ home: root }).scan(counted().context())).toEqual([{
      sessionId: ID, engine: 'copilot', cwd: '/work/app', origin: 'editor', title: 'Greeting reply',
      // The end of the last turn, not the shutdown written when VS Code quit hours later.
      mtime: Date.parse('2026-09-19T09:12:44.200Z'),
      transcriptPath: join(root, 'session-state', ID, 'events.jsonl'),
    }])
  })

  it('tells a terminal from an editor by `client_name`, and leaves out automation', async () => {
    expect(copilotOrigin('')).toBe('terminal')
    expect(copilotOrigin('copilot-cli')).toBe('terminal')
    for (const client of ['vscode-agent-host', 'GitHub Copilot Language Server', 'github/acp', 'microsoft/visualstudio-chat', 'JetBrains.IntelliJ', 'Google.Antigravity']) {
      expect(copilotOrigin(client)).toBe('editor')
    }
    for (const client of ['sdk', 'github/copilot-cloud-agent', 'github/coverage-agent', 'github/copilot-code-review', 'github/copilot-code-review/verification', 'github/code-scanning', 'github/code-scanning/semantic-query']) {
      expect(copilotOrigin(client)).toBeNull()
    }
    const root = home()
    session(root, ID, { workspace: `cwd: /work/app\nname: Terminal one\n` })
    session(root, ID2, { workspace: `cwd: /work/app\nclient_name: github/copilot-cloud-agent\n` })
    const found = await copilotProvider({ home: root }).scan(counted().context())
    expect(found.map((s) => [s.sessionId, s.origin])).toEqual([[ID, 'terminal']])
    expect(await readCopilotSession(join(root, 'session-state', ID2), ID2)).toEqual({ kind: 'skip', reason: 'automation' })
  })

  it('leaves out cloud tasks, detached rem-agent runs, and streams that are not this session\'s', async () => {
    const root = home()
    session(root, ID, { workspace: 'cwd: /work/app\nmc_task_id: task-1\n' })
    session(root, ID2, { events: [start(ID2, { detachedFromSpawningParentSessionId: ID }), ask()] })
    session(root, ID3, { events: [start(ID), ask()] })
    expect(await copilotProvider({ home: root }).scan(counted().context())).toEqual([])
    expect(await readCopilotSession(join(root, 'session-state', ID), ID)).toEqual({ kind: 'skip', reason: 'cloud-task' })
    expect(await readCopilotSession(join(root, 'session-state', ID2), ID2)).toEqual({ kind: 'skip', reason: 'detached' })
    expect(await readCopilotSession(join(root, 'session-state', ID3), ID3)).toEqual({ kind: 'skip', reason: 'mismatch' })
  })

  it('does not offer a stream that does not open with `session.start`', async () => {
    const root = home()
    session(root, ID, { events: [ask(), start(ID)] })
    session(root, ID3, { events: [event('session.start', {}), ask()].map((line) => line.replace('"data":{}', '"data":"x"')) })
    const blank = '66666666-6666-4666-8666-666666666666'
    session(root, blank, { events: ['', start(blank), ask()] })
    expect(await copilotProvider({ home: root }).scan(counted().context())).toEqual([])
    for (const id of [ID, ID3, blank]) expect(await readCopilotSession(join(root, 'session-state', id), id)).toEqual({ kind: 'skip', reason: 'unreadable' })
  })

  it('reads a session again next scan while its first line is half-written', async () => {
    const root = home()
    const dir = session(root, ID, { events: start(ID).slice(0, 40) })
    await expect(readCopilotSession(dir, ID)).rejects.toThrow('not written yet')
    const provider = copilotProvider({ home: root })
    const scan = counted()
    expect(await provider.scan(scan.context())).toEqual([])
    expect(await provider.scan(scan.context())).toEqual([])
    expect(scan.reads()).toBe(2)
    writeFileSync(join(dir, 'events.jsonl'), `${[start(ID), ask()].join('\n')}\n`)
    expect((await provider.scan(scan.context())).map((s) => s.sessionId)).toEqual([ID])
  })

  it('offers a session only once a person asked something: not a sub-agent, a skill, another agent or autopilot', async () => {
    const root = home()
    const noise = [
      ask({ agentId: 'sub-1' }), ask({ ephemeral: true }), ask({}, { source: 'skill-pdf' }), ask({}, { source: 'agent-7' }),
      ask({}, { isAutopilotContinuation: true }), event('user.message', 'not data' as unknown as Record<string, unknown>),
      event('system.message', { content: 'user.message' }), '{"type":"user.message",',
    ]
    session(root, ID, { events: [start(ID), ...noise, answer()] })
    session(root, ID2, { events: [start(ID2), ...noise, ask({}, { source: 'user' }), answer()] })
    session(root, ID3, { events: [start(ID3)] })
    // A prompt stays found when a sub-agent's prompt follows it in the same read.
    const later = '55555555-5555-4555-8555-555555555555'
    session(root, later, { events: [start(later), ask(), ask({ agentId: 'sub-1' }), answer()] })
    const found = await copilotProvider({ home: root }).scan(counted().context())
    expect(found.map((s) => s.sessionId).sort()).toEqual([later, ID2].sort())
    expect(await readCopilotSession(join(root, 'session-state', ID), ID)).toEqual({ kind: 'skip', reason: 'empty' })
    // A stream that went away between the listing and the read.
    expect(await readCopilotSession(join(root, 'session-state', 'gone'), 'gone')).toEqual({ kind: 'skip', reason: 'unreadable' })
  })

  it('follows a `/cwd` change, and falls back to the folder the session began in', async () => {
    const root = home()
    session(root, ID, { workspace: 'cwd: /work/moved\n' })
    session(root, ID2, { workspace: null })
    session(root, ID3, { workspace: 'cwd: relative/path\n' })
    const found = await copilotProvider({ home: root }).scan(counted().context())
    expect(Object.fromEntries(found.map((s) => [s.sessionId, [s.cwd, s.origin, s.title]]))).toEqual({
      [ID]: ['/work/moved', 'terminal', ''], [ID2]: ['/work/start', 'terminal', ''], [ID3]: ['/work/start', 'terminal', ''],
    })
    const nowhere = '44444444-4444-4444-8444-444444444444'
    session(root, nowhere, { events: [start(nowhere, { context: {} }), ask()], workspace: '' })
    expect(await readCopilotSession(join(root, 'session-state', nowhere), nowhere)).toEqual({ kind: 'skip', reason: 'no-folder' })
  })

  it('reads a quoted, escaped or wrapped folder and name exactly', async () => {
    const root = home()
    session(root, ID, { workspace: `cwd: '/work/it''s: here'\nname: "Fix \\"quotes\\" \\u00e9"\n` })
    session(root, ID2, { workspace: `cwd: /Users/x/Library/Application Support/Autonomous Workshop/runs/wish-20260827-173926\n  /workspace one\nname: >-\n  a folded\n  name\n` })
    const found = await copilotProvider({ home: root }).scan(counted().context())
    expect(Object.fromEntries(found.map((s) => [s.sessionId, [s.cwd, s.title]]))).toEqual({
      [ID]: ["/work/it's: here", 'Fix "quotes" é'],
      [ID2]: ['/Users/x/Library/Application Support/Autonomous Workshop/runs/wish-20260827-173926 /workspace one', 'a folded name'],
    })
  })

  it('skips what is not a session folder, and folders Harness keeps its own sessions in', async () => {
    const root = home()
    session(root, ID)
    session(root, ID2, { events: null })
    mkdirSync(join(root, 'session-state', 'not-a-uuid'))
    writeFileSync(join(root, 'session-state', ID3), 'a file')
    expect((await copilotProvider({ home: root }).scan(counted().context())).map((s) => s.sessionId)).toEqual([ID])
    expect(await copilotProvider({ home: root }).scan(counted(['/work']).context())).toEqual([])
    expect(await copilotProvider({ home: join(root, 'missing') }).scan(counted().context())).toEqual([])
  })

  it('reads a session again only when its stream or workspace changed', async () => {
    const root = home()
    const dir = session(root, ID)
    const provider = copilotProvider({ home: root })
    const scan = counted()
    await provider.scan(scan.context())
    await provider.scan(scan.context())
    expect([scan.reads(), scan.paces()]).toEqual([1, 2])
    writeFileSync(join(dir, 'workspace.yaml'), 'cwd: /work/app\nname: Renamed\n')
    expect((await provider.scan(scan.context()))[0].title).toBe('Renamed')
    expect(scan.reads()).toBe(2)
  })
})

describe('when a Copilot conversation last moved', () => {
  it('is its last prompt, answer or turn end, else the stream\'s own time', async () => {
    const root = home()
    const a = session(root, ID, { events: [start(ID), ask(), turnEnd({}, '2026-09-19T10:00:00.000Z'), event('hook.start', {}, {}, '2026-09-19T11:00:00.000Z')] })
    expect(await copilotMovedAt(join(a, 'events.jsonl'))).toBe(Date.parse('2026-09-19T10:00:00.000Z'))
    const b = session(root, ID2, { events: [start(ID2), ask({}, {}, 'not a time'), shutdown()] })
    utimesSync(join(b, 'events.jsonl'), 1_700_000_000, 1_700_000_000)
    const found = await copilotProvider({ home: root }).scan(counted().context())
    expect(found.find((s) => s.sessionId === ID2)?.mtime).toBe(1_700_000_000_000)
  })

  it('reads further back past one long last line, and gives up past four megabytes', async () => {
    const root = home()
    const long = event('tool.execution_complete', { result: { content: 'x'.repeat(300 * 1024) } })
    const a = session(root, ID, { events: [start(ID), ask(), answer(), long] })
    expect(await copilotMovedAt(join(a, 'events.jsonl'))).toBe(Date.parse('2026-09-19T09:12:44.137Z'))
    const huge = event('tool.execution_complete', { result: { content: 'x'.repeat(5 * 1024 * 1024) } })
    const b = session(root, ID2, { events: [start(ID2), ask(), huge] })
    expect(await copilotMovedAt(join(b, 'events.jsonl'))).toBeNull()
    expect(await copilotMovedAt(join(root, 'missing.jsonl'))).toBeNull()
  })
})

describe('copilotProvider.owners', () => {
  const lock = (root: string, id: string, pid: number | string, at: number) => {
    const path = join(root, 'session-state', id, `inuse.${pid}.lock`)
    writeFileSync(path, '')
    utimesSync(path, at, at)
  }

  it('holds admission for equal newest locks or a live process whose start cannot be proved', async () => {
    const root = home(); session(root, ID); session(root, ID2)
    lock(root, ID, 4242, 1_700_000_000)
    const provider = copilotProvider({ home: root })
    expect(await externalEvidence(() => provider.owners!(view([cli(4242)])))).toMatchObject({ ok: false })
    expect(await externalEvidence(() => provider.owners!(view([])))).toMatchObject({ ok: false })
    const processes = view([{ ...cli(4242), started: 1_700_000_000_000 }])
    expect(await externalEvidence(() => provider.owners!(processes))).toMatchObject({ ok: true, value: [{ sessionId: ID }] })
    lock(root, ID2, 4242, 1_700_000_000)
    expect(await externalEvidence(() => provider.owners!(processes))).toMatchObject({ ok: false })
    lock(root, ID2, 4242, 1_700_000_100)
    expect(await externalEvidence(() => provider.owners!(processes))).toMatchObject({ ok: true, value: [{ sessionId: ID2 }] })
  })

  it('claims the session a live Copilot holds a lock on', async () => {
    const root = home()
    session(root, ID)
    lock(root, ID, 4242, 1_700_000_000)
    expect(await copilotProvider({ home: root }).owners!(view([cli(4242)]))).toEqual([
      { sessionId: ID, pid: 4242, record: join(root, 'session-state', ID, 'events.jsonl') },
    ])
  })

  it('reads nothing of the machine when no session is locked', async () => {
    const root = home()
    session(root, ID)
    lock(root, ID, 'x', 1_700_000_000)
    lock(root, ID, 0, 1_700_000_000)
    mkdirSync(join(root, 'session-state', ID, 'inuse.77.lock'))
    writeFileSync(join(root, 'session-state', 'inuse.5.lock'), '')
    mkdirSync(join(root, 'session-state', 'not-a-uuid'))
    writeFileSync(join(root, 'session-state', 'not-a-uuid', 'inuse.6.lock'), '')
    const processes = view([cli(4242)])
    expect(await copilotProvider({ home: root }).owners!(processes)).toEqual([])
    expect(await copilotProvider({ home: join(root, 'missing') }).owners!(processes)).toEqual([])
    expect(processes.listed()).toBe(0)
  })

  it('takes a pid\'s newest lock as the session it is in: `/resume` inside Copilot keeps the old one', async () => {
    const root = home()
    for (const id of [ID, ID2, ID3]) session(root, id)
    lock(root, ID, 4242, 1_700_000_000)
    lock(root, ID2, 4242, 1_700_000_100)
    lock(root, ID3, 5151, 1_700_000_000)
    lock(root, ID, 5151, 1_700_000_000)
    lock(root, ID, 6161, 1_700_000_200)
    lock(root, ID2, 6161, 1_700_000_000)
    const claims = await copilotProvider({ home: root }).owners!(view([cli(4242), cli(5151), cli(6161)]))
    // Two locks written in the same instant: the later id, for an answer that does not change.
    expect(claims.map((claim) => [claim.pid, claim.sessionId]).sort()).toEqual([[4242, ID2], [5151, ID3], [6161, ID]])
  })

  it('ignores a lock a crash left behind: a dead pid, one gone from the list, or one another program now has', async () => {
    const root = home()
    for (const id of [ID, ID2, ID3]) session(root, id)
    lock(root, ID, 11, 1_700_000_000)
    lock(root, ID2, 12, 1_700_000_000)
    lock(root, ID3, 13, 1_700_000_000)
    const rows: RunningProcess[] = [cli(11), { pid: 13, ppid: 1, executable: '/usr/bin/python3', args: '' }]
    expect(await copilotProvider({ home: root }).owners!(view(rows, (pid) => pid !== 11))).toEqual([])
  })

  it('ignores a lock older than the process that now has its pid, allowing the second `ps` truncates', async () => {
    const root = home()
    const ids = [ID, ID2, ID3, '77777777-7777-4777-8777-777777777777']
    for (const id of ids) session(root, id)
    ids.forEach((id, index) => lock(root, id, 31 + index, 1_700_000_000))
    const rows = [
      { ...cli(31), started: 1_700_000_005_000 },
      { ...cli(32), started: 1_700_000_000_500 },
      { ...cli(33), started: 1_699_999_940_000 },
      { ...cli(34), started: 1_700_000_001_001 },
    ]
    const claims = await copilotProvider({ home: root }).owners!(view(rows))
    expect(claims.map((claim) => claim.pid).sort()).toEqual([32, 33])
  })

  it('never offers to stop an editor\'s runtime or a Copilot serving other programs', async () => {
    const root = home()
    for (const id of [ID, ID2, ID3]) session(root, id)
    lock(root, ID, 21, 1_700_000_000)
    lock(root, ID2, 22, 1_700_000_000)
    lock(root, ID3, 23, 1_700_000_000)
    const rows: RunningProcess[] = [
      { pid: 21, ppid: 1, executable: '/Users/x/Library/Caches/copilot/sdk/runtime/1.0.15-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime', args: 'copilot-runtime --headless --no-auto-update --stdio' },
      cli(22, `${NATIVE} --headless --stdio`),
      cli(23, `${NATIVE} --resume=${ID3}`),
    ]
    const claims = await copilotProvider({ home: root }).owners!(view(rows))
    expect(claims.map((claim) => [claim.pid, claim.app ?? false]).sort()).toEqual([[21, true], [22, true], [23, false]])
  })
})

describe('copilotProvider.busy', () => {
  const busy = (path: string) => copilotProvider({ home: '/nowhere' }).busy!({ pid: 1, record: path })

  it('is mid-turn when a prompt or a round started after the last round ended', async () => {
    const root = home()
    const open = session(root, ID, { events: [start(ID), ask(), turnStart(), answer(), turnEnd(), ask(), turnStart()] })
    expect(await busy(join(open, 'events.jsonl'))).toBe(true)
    const closed = session(root, ID2, { events: [start(ID2), ask(), turnStart(), answer(), turnEnd()] })
    expect(await busy(join(closed, 'events.jsonl'))).toBe(false)
  })

  it('is not mid-turn after Esc or a shutdown', async () => {
    const root = home()
    const aborted = session(root, ID, { events: [start(ID), ask(), turnStart(), event('abort', { reason: 'user' })] })
    expect(await copilotTurnOpen(join(aborted, 'events.jsonl'))).toBe(false)
    const down = session(root, ID2, { events: [start(ID2), ask(), turnStart(), shutdown()] })
    expect(await copilotTurnOpen(join(down, 'events.jsonl'))).toBe(false)
  })

  it('leaves a sub-agent\'s rounds out: they end inside the parent\'s turn', async () => {
    const root = home()
    const dir = session(root, ID, { events: [start(ID), ask(), turnStart(), turnStart({ agentId: 'sub' }), turnEnd({ agentId: 'sub' })] })
    expect(await copilotTurnOpen(join(dir, 'events.jsonl'))).toBe(true)
  })

  it('reads further back past one long last line, and cannot say with no turn event at all', async () => {
    const root = home()
    const long = event('tool.execution_complete', { result: { content: 'x'.repeat(300 * 1024) } })
    const a = session(root, ID, { events: [start(ID), ask(), turnStart(), long] })
    expect(await copilotTurnOpen(join(a, 'events.jsonl'))).toBe(true)
    const b = session(root, ID2, { events: [start(ID2), event('hook.start', {})] })
    expect(await copilotTurnOpen(join(b, 'events.jsonl'))).toBeNull()
    const huge = event('tool.execution_complete', { result: { content: 'x'.repeat(5 * 1024 * 1024) } })
    const c = session(root, ID3, { events: [start(ID3), ask(), huge] })
    expect(await copilotTurnOpen(join(c, 'events.jsonl'))).toBeNull()
    expect(await copilotTurnOpen(join(root, 'missing.jsonl'))).toBeNull()
  })
})

describe('workspaceYaml', () => {
  const value = (yaml: string, key = 'v') => workspaceYaml(yaml).get(key)

  it('reads the flat keys libyaml writes, whatever the line ending', () => {
    const parsed = workspaceYaml('\ufeffid: abc\r\ncwd: /work/app\r\nuser_named: false\r\nsummary_count: 0\r\n')
    expect(Object.fromEntries(parsed)).toEqual({ id: 'abc', cwd: '/work/app', user_named: 'false', summary_count: '0' })
    expect(workspaceYaml('')).toEqual(new Map())
  })

  it('reads plain values: comments, nulls, and lines folded into one', () => {
    expect(value('v: C# is fine # but this is a comment')).toBe('C# is fine')
    expect(value('v: a long\n  folded\n\n  value\nnext: x')).toBe('a long folded\nvalue')
    for (const none of ['v: ~', 'v: null', 'v: Null', 'v: NULL', 'v:', 'v: # only a comment']) expect(value(none)).toBeNull()
  })

  it('reads single quotes: a doubled quote is one, and lines fold', () => {
    expect(value("v: 'it''s: #here'")).toBe("it's: #here")
    expect(value("v: '  padded  '")).toBe('  padded  ')
    expect(value("v: 'one\n  two  \n\n\n  three'")).toBe('one two\n\nthree')
    expect(value("v: 'unterminated")).toBeNull()
    expect(value("v: 'ends here\n  '")).toBe('ends here ')
  })

  it('reads double quotes: every escape, escaped line breaks, and folded ones', () => {
    expect(value('v: "tab\\there \\"q\\" back\\\\slash \\/ \\x41 \\u00e9 \\U0001F600"')).toBe('tab\there "q" back\\slash / A é 😀')
    expect(value('v: "\\0\\a\\b\\v\\f\\r\\e\\ \\N\\_\\L\\P\\\t|"')).toBe('\0\x07\b\v\f\r\x1b \x85\xa0\u2028\u2029\t|')
    expect(value('v: "joined \\\n    here"')).toBe('joined here')
    expect(value('v: "a\n  \\ b"')).toBe('a  b')
    expect(value('v: "one\n  two\n\n  three"')).toBe('one two\nthree')
    expect(value('v: "trailing  "')).toBe('trailing  ')
  })

  it('refuses a double-quoted value it cannot read', () => {
    for (const bad of ['v: "\\q"', 'v: "\\x4"', 'v: "\\xZZ"', 'v: "\\U00110000"', 'v: "ends in \\', 'v: "unterminated']) {
      expect(value(bad)).toBeNull()
    }
  })

  it('reads block values: literal and folded, each chomping, and an explicit indent', () => {
    expect(value('v: |-\n  one\n  two\nnext: x')).toBe('one\ntwo')
    expect(value('v: |\n  one\n  two\n')).toBe('one\ntwo\n')
    expect(value('v: |+\n  one\n\n\nnext: x')).toBe('one\n\n\n')
    expect(value('v: |2-\n    indented\n  kept')).toBe('  indented\nkept')
    expect(value('v: |-2\n  a')).toBe('a')
    expect(value('v: | # a comment\n  a')).toBe('a\n')
    expect(value('v: >-\n  one\n  two\n\n  three\n    more\n  four')).toBe('one two\nthree\n  more\nfour')
    expect(value('v: >\n\n  after a blank\n')).toBe('\nafter a blank\n')
    expect(value('v: |\n\nnext: x')).toBe('')
    expect(value('v: |x\n  a')).toBeNull()
  })

  it('reads a map or a list as nothing, and ignores what is not a key', () => {
    const parsed = workspaceYaml('# comment\n---\nnested:\n  a: 1\n  b: 2\nlist:\n  - x\nkey:value\n  stray\nname: kept\n')
    expect(Object.fromEntries(parsed)).toEqual({ nested: null, list: null, name: 'kept' })
  })
})
