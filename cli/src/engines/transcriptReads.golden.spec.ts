import { clearEngineHomeFixture } from '../testing/engineHomeFixture.js'
/**
 * What core and the readers make of Claude Code's and Codex's conversations on disk, answer for answer: recorded
 * from the code as it stood before their adoption, activity and paging rules became declared data the kit applies,
 * and before the core stopped loading their normalizers (docs/design/2026-10-08-engine-launch.md, (c5)). It covers:
 *
 *  - adoption: the conversations each engine's provider finds in every home (heads read in widening windows, files
 *    still being written, sub-agents, programs and Harness's own left out, thread names), which process holds
 *    each, and whether it is mid-turn;
 *  - the latest conversation activity an agent's frame shows, from a transcript's tail;
 *  - pages of a thread, followed cursor by cursor, with turns too long for a page and lines too long for any;
 *  - history and the last turn, through each engine's reader and through core's `session_get`.
 *
 * Each case runs with `process.platform` pinned to darwin and to linux, and linux's are stored where they
 * differ. Local time is pinned (`TZ`): a timestamp written without a zone is read in it. Sizes in a case never
 * depend on the temporary folder's path.
 *
 * `RECORD_TRANSCRIPT_READS_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter what
 * core reads, and say so in that change.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import type { ProcessView, RunningProcess } from '../lib/sessionSearch/externals/types.js'

process.env.TZ = 'America/New_York'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/transcript-reads.golden.json', import.meta.url))
const RECORD = process.env.RECORD_TRANSCRIPT_READS_GOLDEN === '1'

let root = ''
const saved: Record<string, string | undefined> = {}
const VARS = ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const
type Modules = {
  index: typeof import('../lib/sessionSearch/externals/index.js')
  support: typeof import('../lib/sessionSearch/externals/support.js')
  homes: typeof import('../lib/engineHomes.js')
  activity: typeof import('../lib/transcriptActivity.js')
  pages: typeof import('../lib/transcriptPages.js')
  transcripts: typeof import('./transcripts.js')
  history: typeof import('../core/transcripts/history.js')
  lastTurn: typeof import('../core/transcripts/lastTurn.js')
}
let m: Modules

const write = (path: string, lines: unknown[], end = '\n'): string => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + end)
  chmodSync(path, 0o644)
  return path
}
const norm = (value: unknown): unknown => value === undefined ? '<undefined>' : JSON.parse(JSON.stringify(value).split(root).join('<root>'))
const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
async function attempt<T>(run: () => T | Promise<T>): Promise<unknown> {
  try { return norm(await run()) } catch (error) { return { threw: norm(error instanceof Error ? error.message : String(error)) } }
}
const uuid = (n: number, tag = 'a') => `${tag.repeat(8).slice(0, 8)}-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'transcript-reads-golden-')))
  for (const name of VARS) saved[name] = process.env[name]
  process.env.ADAPTER_DATA_DIR = join(root, 'data')
  process.env.CLAUDE_PROJECTS_DIR = join(root, 'claude', 'projects')
  process.env.CODEX_HOME = join(root, 'codex')
  delete process.env.CLAUDE_CONFIG_DIR
  mkdirSync(join(root, 'data'), { recursive: true })
  chmodSync(join(root, 'data'), 0o700)
  vi.resetModules()
  m = {
    index: await import('../lib/sessionSearch/externals/index.js'),
    support: await import('../lib/sessionSearch/externals/support.js'),
    homes: await import('../lib/engineHomes.js'),
    activity: await import('../lib/transcriptActivity.js'),
    pages: await import('../lib/transcriptPages.js'),
    transcripts: await import('./transcripts.js'),
    history: await import('../core/transcripts/history.js'),
    lastTurn: await import('../core/transcripts/lastTurn.js'),
  }
})

afterAll(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  m?.homes.resetEngineHomes()
  rmSync(root, { recursive: true, force: true })
  vi.resetModules()
})

function adoptMoved(): void {
  m.homes.resetEngineHomes()
  clearEngineHomeFixture(join(root, 'data'))
  m.homes.adoptEngineHomes({ CLAUDE_CONFIG_DIR: join(root, 'moved-claude'), CODEX_HOME: join(root, 'moved-codex') },
    { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') })
}
function forgetMoved(): void {
  m.homes.resetEngineHomes()
  clearEngineHomeFixture(join(root, 'data'))
}

// --------------------------------------------------------------------------------------------- adoption

const WORK = '/work/dial'
const claudeLine = (sessionId: unknown, entrypoint: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', sessionId, cwd: WORK, entrypoint, timestamp: '2026-09-20T10:00:00Z',
  message: { role: 'user', content: 'fix the dial scroll' }, ...extra,
})
const codexMeta = (id: string, source: unknown, originator = 'codex-tui', cwd: unknown = WORK, instructions = 40_000) => ({
  timestamp: '2026-09-20T10:00:00Z', type: 'session_meta',
  payload: { id, cwd, originator, source, base_instructions: 'x'.repeat(instructions) },
})
const codexEvent = (type: string) => ({ type: 'event_msg', payload: { type } })
const rolloutName = (id: string) => `rollout-2026-09-20T10-00-00-${id}.jsonl`

/** A provider's sessions, in an order of their own, with nothing that depends on when the files were written. */
const sessions = (found: Array<Record<string, unknown>>) => norm(found.map(({ mtime, ...rest }) => ({ ...rest, mtime: typeof mtime === 'number' && mtime > 0 }) as Record<string, unknown>)
  .sort((a, b) => `${a.engine}:${a.transcriptPath}`.localeCompare(`${b.engine}:${b.transcriptPath}`)))

async function adoptionCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  const projects = join(root, 'claude', 'projects')
  const folder = join(projects, '-work-dial')
  const claude = (name: string, lines: unknown[]) => write(join(folder, `${name}.jsonl`), lines)
  claude(uuid(1), [{ type: 'permission-mode' }, '{"entrypoint": half', claudeLine(uuid(1), 'cli')])
  claude(uuid(2), [claudeLine(uuid(2), 'claude-desktop')])
  claude(uuid(3), [claudeLine(uuid(3), 'sdk-cli')])
  claude(uuid(4), [claudeLine(uuid(4), 'cli', { isSidechain: true })])
  claude(uuid(5), [claudeLine(uuid(5), 'cli', { cwd: 'relative/path' })])
  claude('short', [claudeLine('short', 'cli')])
  claude('number-id', [claudeLine(7, 'cli')])
  const unsettled = claude(uuid(6), ['["entrypoint"]'])
  claude(uuid(7), [{ type: 'summary', summary: 'nothing else' }])
  claude(uuid(8), [{ type: 'permission-mode' }, claudeLine(uuid(8), 'cli', { message: { role: 'user', content: [{ type: 'image', source: { data: 'i'.repeat(300 * 1024) } }] } })])
  claude(uuid(9), [{ type: 'summary', summary: 'x'.repeat(4 * 1024 * 1024 + 100) }, claudeLine(uuid(9), 'cli')])
  claude(uuid(10), [claudeLine(uuid(10), 'cli', { cwd: join(root, 'data', 'recap-scratch') })])
  claude('array', ['["entrypoint", 1]', claudeLine(uuid(13), 'cli')])
  claude('later-line', [claudeLine(uuid(14), 'cli', { cwd: 7 }), claudeLine(uuid(15), 'cli')])
  write(join(folder, uuid(11), 'subagents', 'agent-1.jsonl'), [claudeLine(uuid(11), 'cli')])
  write(join(folder, 'notes.txt'), ['not a transcript'])
  writeFileSync(join(projects, 'stray-file'), '')
  mkdirSync(join(folder, 'odd.jsonl'), { recursive: true })
  symlinkSync(join(root, 'nowhere.jsonl'), join(folder, 'broken.jsonl'))
  write(join(root, 'elsewhere', `${uuid(12)}.jsonl`), [claudeLine(uuid(12), 'cli')])
  symlinkSync(join(root, 'elsewhere', `${uuid(12)}.jsonl`), join(folder, 'linked.jsonl'))
  write(join(root, 'moved-claude', 'projects', '-work-moved', `${uuid(16)}.jsonl`), [claudeLine(uuid(16), 'cli', { cwd: '/work/moved' })])

  const home = join(root, 'codex')
  const day = join(home, 'sessions', '2026', '09', '20')
  const codex = (id: string, lines: unknown[], dir = day) => write(join(dir, rolloutName(id)), lines)
  const C = (n: number) => uuid(n, 'c')
  codex(C(1), [codexMeta(C(1), 'cli'), codexEvent('x')])
  codex(C(2), [codexMeta(C(2), 'vscode', 'Codex Desktop'), codexEvent('x')])
  codex(C(3), [codexMeta(C(3), 'vscode', 'codex_vscode'), codexEvent('x')])
  codex(C(4), [codexMeta(C(4), 'exec', 'codex_exec')])
  codex(C(5), [codexMeta(C(5), { subagent: { other: 'guardian' } })])
  codex(C(6), [codexMeta(C(6), 'cli', 'codex-tui', 'relative')])
  codex(C(7), [{ ...codexMeta('x', 'cli') }])
  codex(C(8), [{ type: 'other', payload: {} }])
  codex(C(9), [{ type: 'session_meta' }])
  codex(C(10), ['not json'])
  codex(C(11), [codexMeta(C(11), 'cli', 'codex-tui', WORK, 1)])
  const partial = join(day, rolloutName(C(12)))
  writeFileSync(partial, JSON.stringify(codexMeta(C(12), 'cli')))
  writeFileSync(join(day, rolloutName(C(13))), 'x'.repeat(1024 * 1024 + 10))
  codex(C(14), [codexMeta(C(14), 'cli')], join(home, 'sessions', 'a', 'b', 'c', 'd', 'e'))
  codex(C(15), [codexMeta(C(15), 'cli')], join(home, 'sessions', '2026', '09'))
  write(join(day, 'notes.jsonl'), ['x'])
  write(join(day, `rolling-${C(21)}.jsonl`), [codexMeta(C(21), 'cli')])
  mkdirSync(join(day, rolloutName(C(16))), { recursive: true })
  codex(C(17), [codexMeta(C(17), 'cli')], join(home, 'archived_sessions'))
  symlinkSync(join(root, 'nowhere.jsonl'), join(home, 'archived_sessions', rolloutName(C(18))))
  codex(C(19), [codexMeta(C(19), 'cli', 'codex-tui', join(root, 'data', 'recap'))])
  utimesSync(join(day, rolloutName(C(1))), new Date('2026-09-25T00:00:00Z'), new Date('2026-09-25T00:00:00Z'))
  write(join(home, 'session_index.jsonl'), [
    { id: C(1), thread_name: 'Old name' }, { id: C(1), thread_name: 'Retention cohorts' }, { id: C(2), thread_name: '   ' },
    { thread_name: 'no id' }, 'half a line', { id: C(17), thread_name: 'Archived one' },
  ])
  codex(C(20), [codexMeta(C(20), 'cli', 'codex-tui', '/work/moved')], join(root, 'moved-codex', 'sessions', '2026', '09', '21'))
  write(join(root, 'moved-codex', 'session_index.jsonl'), [{ id: C(20), thread_name: 'Moved home' }])

  const paths = { ...m.index.externalPaths(), claudeProjectsDir: projects, codexHome: home }
  const providerOf = (engine: string, from = paths) => m.index.externalProviders(from).find((provider) => provider.engine === engine)!
  for (const moved of [false, true]) {
    if (moved) adoptMoved(); else forgetMoved()
    const label = moved ? 'moved homes' : 'default homes'
    for (const engine of ['claude', 'codex']) {
      const memo = m.support.scanMemo({ excluded: [join(root, 'data')] })
      cases[`scan · ${label} · ${engine}`] = sessions(await providerOf(engine).scan(memo.context()) as unknown as Array<Record<string, unknown>>)
      // Again, from what the first scan kept: the same answer, read only where something changed.
      cases[`scan again · ${label} · ${engine}`] = sessions(await providerOf(engine).scan(memo.context()) as unknown as Array<Record<string, unknown>>)
    }
  }
  forgetMoved()
  // The two files still being written, once their first lines are: found by the same scan's memory.
  const memo = m.support.scanMemo({ excluded: [join(root, 'data')] })
  await providerOf('claude').scan(memo.context())
  await providerOf('codex').scan(memo.context())
  write(unsettled, ['["entrypoint"]', claudeLine(uuid(6), 'cli')])
  writeFileSync(partial, JSON.stringify(codexMeta(C(12), 'cli')) + '\n')
  // A first line longer than any window is judged for good: written whole since, it is still not read again.
  writeFileSync(join(day, rolloutName(C(13))), JSON.stringify(codexMeta(C(13), 'cli', 'codex-tui', WORK, 1024 * 1024 + 10)) + '\n')
  cases['scan · written since · codex · past every window'] = sessions((await providerOf('codex').scan(memo.context())).filter((s) => s.sessionId === C(13)) as unknown as Array<Record<string, unknown>>)
  cases['scan · written since · claude'] = sessions((await providerOf('claude').scan(memo.context())).filter((s) => s.sessionId === uuid(6)) as unknown as Array<Record<string, unknown>>)
  cases['scan · written since · codex'] = sessions((await providerOf('codex').scan(memo.context())).filter((s) => s.sessionId === C(12)) as unknown as Array<Record<string, unknown>>)

  // Owners: Claude's process records, in its own home and a moved one.
  const started = Date.parse('2026-09-27T10:00:00Z')
  const records = join(root, 'claude', 'sessions')
  const record = (dir: string, name: string, lines: unknown[]) => write(join(dir, name), lines)
  record(records, '101.json', [{ pid: 101, sessionId: uuid(1), status: 'busy', startedAt: started + 400 }])
  record(records, '102.json', [{ pid: 102, sessionId: uuid(2), status: 'idle' }])
  record(records, '103.json', [{ pid: 103, sessionId: uuid(2) }])
  record(records, '104.json', ['{ being written'])
  record(records, '105.json', [{ pid: '105', sessionId: uuid(2) }])
  record(records, '106.json', [{ pid: 106 }])
  record(records, '107.json', [{ pid: 107, sessionId: 'reused-by-a-shell', startedAt: started }])
  record(records, '108.json', [{ pid: 108, sessionId: 'reused-by-claude', startedAt: started }])
  record(records, '109.json', [{ pid: 109, sessionId: 'unlisted' }])
  record(records, '110.json', [{ pid: 110, sessionId: uuid(3), status: 'thinking', startedAt: started + 2_000 }])
  record(records, '111.json', [{ pid: 111, sessionId: uuid(4), startedAt: started - 2_001 }])
  record(records, '112.json', [{ pid: 112, sessionId: uuid(5), startedAt: started - 1_500 }])
  record(records, '113.json', [{ pid: 113, sessionId: uuid(7), startedAt: started - 2_500 }])
  record(records, 'notes.txt', ['x'])
  mkdirSync(join(records, 'dir.json'), { recursive: true })
  record(join(root, 'moved-claude', 'sessions'), '201.json', [{ pid: 201, sessionId: uuid(16), status: 'idle' }])
  const running: RunningProcess[] = [
    { pid: 101, ppid: 1, executable: 'claude', args: 'claude --resume x', started },
    { pid: 102, ppid: 1, executable: 'claude', args: 'claude' },
    { pid: 106, ppid: 1, executable: 'claude', args: 'claude', started },
    { pid: 107, ppid: 1, executable: '-zsh', args: '-zsh', started: started + 60_000 },
    { pid: 108, ppid: 1, executable: 'claude', args: 'claude', started: started + 60_000 },
    { pid: 110, ppid: 1, executable: 'claude', args: 'claude', started },
    { pid: 111, ppid: 1, executable: 'node', args: 'node /opt/claude/cli.js', started },
    { pid: 112, ppid: 1, executable: 'claude', args: 'claude', started },
    { pid: 113, ppid: 1, executable: 'claude', args: 'claude', started },
    { pid: 201, ppid: 1, executable: 'claude', args: 'claude' },
  ]
  const alive = new Set([101, 102, 106, 107, 108, 109, 110, 111, 112, 113, 201])
  const claudeView: ProcessView = { list: async () => running, openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map(), alive: (pid) => alive.has(pid) }
  for (const moved of [false, true]) {
    if (moved) adoptMoved(); else forgetMoved()
    const claims = await providerOf('claude').owners!(claudeView)
    cases[`owners · ${moved ? 'moved homes' : 'default homes'} · claude`] = norm(claims.sort((a, b) => a.pid - b.pid))
  }
  forgetMoved()
  let looked = false
  cases['owners · no records · claude'] = norm({
    claims: await providerOf('claude', { ...paths, claudeProjectsDir: join(root, 'none', 'projects') }).owners!({ ...claudeView, list: async () => { looked = true; return [] } }),
    looked,
  })
  for (const name of ['101.json', '102.json', '110.json', '104.json', 'gone.json', 'dir.json']) {
    cases[`busy · claude · ${name}`] = await attempt(() => providerOf('claude').busy!({ pid: 1, record: join(records, name) }))
  }

  // Owners: the rollouts Codex processes hold open; a server's are an app's.
  const held = (pid: number, files: string[]) => [pid, files] as [number, string[]]
  const C1 = join(day, rolloutName(C(1)))
  const codexView: ProcessView = {
    list: async () => [
      { pid: 301, ppid: 1, executable: 'codex', args: '/opt/codex/bin/codex resume x' },
      { pid: 303, ppid: 1, executable: 'codex', args: '/opt/codex/bin/codex app-server --listen stdio' },
      { pid: 304, ppid: 1, executable: '/opt/bin/codex-acp', args: '/opt/bin/codex-acp' },
      { pid: 305, ppid: 1, executable: 'node', args: 'node /opt/lib/codex-acp --stdio' },
      { pid: 306, ppid: 1, executable: 'codex', args: 'codex --verbose mcp' },
      { pid: 307, ppid: 1, executable: 'codex', args: 'codex -m o3 "run the mcp tests"' },
      { pid: 309, ppid: 1, executable: 'codex', args: 'codex proto' },
      { pid: 310, ppid: 1, executable: 'codex', args: 'codex mcp-server' },
      { pid: 312, ppid: 1, executable: '/opt/bin/codex-acp', args: 'codex-acp-wrapper --stdio' },
      { pid: 313, ppid: 1, executable: 'codex-acp-wrapper', args: 'codex-acp-wrapper --stdio' },
    ],
    openFiles: async () => new Map(), alive: () => true,
    cwds: async () => new Map(), openFilesOf: async (commands) => {
      cases['owners · codex · asked for'] = commands
      return new Map([
        held(301, [C1, '/dev/ttys003', join(root, 'tmp', 'rollout-notes.txt')]), held(302, ['/x/rollout-2026-not-an-id.jsonl']),
        held(303, [join(day, rolloutName(C(2)))]), held(304, [join(day, rolloutName(C(3)))]), held(305, [join(day, rolloutName(C(4)))]),
        held(306, [join(day, rolloutName(C(5)))]), held(307, [join(day, rolloutName(C(6)))]), held(308, [join(day, rolloutName(C(7)))]),
        held(309, [join(day, rolloutName(C(8)))]), held(310, [join(day, rolloutName(C(9))), join(day, rolloutName(C(10)))]),
        held(311, [`/x/${rolloutName(C(11)).replace('.jsonl', '.JSONL')}`, `/x/ROLLOUT-${C(11)}.jsonl`, `/x/rollout-${C(11).toUpperCase()}.jsonl`]),
        held(312, [join(day, rolloutName(C(15)))]), held(313, [join(day, rolloutName(C(16)))]),
      ])
    },
  }
  cases['owners · codex'] = norm(await providerOf('codex').owners!(codexView))
  let listed = false
  cases['owners · nothing held · codex'] = norm({ claims: await providerOf('codex').owners!({ ...codexView, openFilesOf: async () => new Map(), list: async () => { listed = true; return [] } }), listed })
  const turns = join(root, 'turns')
  const talk = { type: 'response_item', payload: { type: 'message', content: [{ text: 'then "task_complete" arrives' }] } }
  const turnFile = (name: string, lines: unknown[]) => write(join(turns, `${name}.jsonl`), [codexMeta(C(1), 'cli'), ...lines])
  const turnCases: Record<string, string> = {
    ended: turnFile('ended', [codexEvent('task_started'), talk, codexEvent('task_complete'), talk]),
    aborted: turnFile('aborted', [codexEvent('task_started'), codexEvent('turn_aborted')]),
    working: turnFile('working', [codexEvent('task_complete'), codexEvent('task_started'), talk]),
    other: turnFile('other', [codexEvent('task_started'), { type: 'event_msg', payload: { type: 'task_complete_ish' } }]),
    unsaid: turnFile('unsaid', []),
    quoted: turnFile('quoted', [codexEvent('task_complete'), { type: 'event_msg', payload: { type: 'agent_message', phase: 'task_started' } }]),
    'first line only': write(join(turns, 'first.jsonl'), [codexEvent('task_started')]),
    'past the first window': turnFile('mid', [codexEvent('task_complete'), { type: 'response_item', payload: { big: 'x'.repeat(300 * 1024) } }]),
    'past every window': turnFile('long', [codexEvent('task_complete'), { type: 'response_item', payload: { big: 'x'.repeat(5 * 1024 * 1024) } }]),
    gone: join(turns, 'gone.jsonl'),
  }
  for (const [name, path] of Object.entries(turnCases)) cases[`busy · codex · ${name}`] = await attempt(() => providerOf('codex').busy!({ pid: 1, record: path }))
  return cases
}

// --------------------------------------------------------------------------------------------- activity

async function activityCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  const dir = join(root, 'activity')
  const at = (minute: number, zone = 'Z') => `2026-09-20T10:${String(minute).padStart(2, '0')}:00${zone === 'Z' ? '.000Z' : zone}`
  const claudeFiles: Record<string, unknown[]> = {
    'a prompt': [{ type: 'user', timestamp: at(1) }],
    'an answer after a prompt': [{ type: 'user', timestamp: at(1) }, { type: 'assistant', timestamp: at(2) }],
    'newest last, older after': [{ type: 'assistant', timestamp: at(5) }, { type: 'user', timestamp: at(3) }],
    'a turn duration': [{ type: 'system', subtype: 'turn_duration', timestamp: at(4) }],
    'a stop hook summary': [{ type: 'system', subtype: 'stop_hook_summary', timestamp: at(4) }],
    'a compact boundary': [{ type: 'system', subtype: 'compact_boundary', timestamp: at(4) }],
    'another system record': [{ type: 'system', subtype: 'informational', timestamp: at(4) }],
    'a subtype that reads as a counted one': [{ type: 'system', subtype: ['turn_duration'], timestamp: at(4) }],
    'metadata only': [{ type: 'summary', timestamp: at(1) }, { type: 'file-history-snapshot', timestamp: at(2) }, { type: 'custom-title', timestamp: at(3) }],
    'a local time': [{ type: 'user', timestamp: '2026-09-20T10:00:00' }],
    'a bad time': [{ type: 'user', timestamp: 'yesterday' }],
    'a number for a time': [{ type: 'user', timestamp: 1_790_000_000_000 }],
    'a record that is not an object': ['["user"]', '7', 'not json'],
    'a large last record': [{ type: 'user', timestamp: at(1) }, { type: 'assistant', timestamp: at(2), pad: 'p'.repeat(150 * 1024) }],
    'a large last record, not counted': [{ type: 'user', timestamp: at(1) }, { type: 'summary', timestamp: at(2), pad: 'p'.repeat(150 * 1024) }],
    'activity past the bound': [{ type: 'user', timestamp: at(1) }, ...Array.from({ length: 300 }, () => ({ type: 'summary', pad: 'p'.repeat(8 * 1024) }))],
    'a codex rollout': [{ type: 'event_msg', timestamp: at(1), payload: { type: 'user_message' } }],
  }
  const codexFiles: Record<string, unknown[]> = {
    'each counted event': ['user_message', 'UserMessage', 'agent_message', 'AgentMessage', 'task_started', 'task_complete', 'turn_aborted', 'context_compacted']
      .map((type, minute) => ({ type: 'event_msg', timestamp: at(minute), payload: { type } })),
    'an uncounted event': [{ type: 'event_msg', timestamp: at(9), payload: { type: 'token_count' } }],
    'each counted response': ['reasoning', 'function_call', 'custom_tool_call', 'tool_search_call', 'function_call_output', 'custom_tool_call_output', 'tool_search_output']
      .map((type, minute) => ({ type: 'response_item', timestamp: at(minute), payload: { type } })),
    'messages by role': ['user', 'assistant', 'system', 'developer'].map((role, minute) => ({ type: 'response_item', timestamp: at(30 + minute), payload: { type: 'message', role } })),
    'a system message only': [{ type: 'response_item', timestamp: at(40), payload: { type: 'message', role: 'system' } }],
    'a type that reads as a message': [{ type: 'response_item', timestamp: at(41), payload: { type: ['message'], role: 'user' } }],
    'a type that reads as a counted one': [{ type: 'event_msg', timestamp: at(42), payload: { type: ['user_message'] } }],
    'an item below the payload': [{ type: 'response_item', timestamp: at(12), payload: { item: { type: 'reasoning' } } }],
    'an item below the payload, not counted': [{ type: 'response_item', timestamp: at(12), payload: { item: { type: 'web_search' }, type: 'reasoning' } }],
    'a compaction': [{ type: 'compacted', timestamp: at(13) }],
    'metadata only': [{ type: 'session_meta', timestamp: at(1), payload: { id: 'x' } }, { type: 'turn_context', timestamp: at(2) }],
    'no payload': [{ type: 'event_msg', timestamp: at(1) }, { type: 'response_item', timestamp: at(2) }],
    'a local time': [{ type: 'compacted', timestamp: '2026-09-20T10:00:00' }],
    'a claude transcript': [{ type: 'user', timestamp: at(1) }],
  }
  for (const [engine, files] of [['claude', claudeFiles], ['codex', codexFiles]] as const) {
    for (const [name, lines] of Object.entries(files)) {
      const path = write(join(dir, engine, `${name.replace(/\W+/g, '-')}.jsonl`), lines)
      cases[`${engine} · ${name}`] = await attempt(() => m.activity.transcriptActivityAt(path, engine))
      cases[`${engine} · ${name} · read again`] = await attempt(() => m.activity.transcriptActivityAt(path, engine))
    }
  }
  const one = write(join(dir, 'one.jsonl'), [{ type: 'user', timestamp: at(1) }])
  writeFileSync(join(dir, 'empty.jsonl'), '')
  cases['an empty file'] = await attempt(() => m.activity.transcriptActivityAt(join(dir, 'empty.jsonl'), 'claude'))
  cases['a missing file'] = await attempt(() => m.activity.transcriptActivityAt(join(dir, 'missing.jsonl'), 'codex'))
  cases['a folder'] = await attempt(() => m.activity.transcriptActivityAt(dir, 'claude'))
  cases['no path'] = await attempt(() => m.activity.transcriptActivityAt(null, 'claude'))
  for (const engine of ['pi', 'cursor', 'terminal', 'toString']) cases[`another engine · ${engine}`] = await attempt(() => m.activity.transcriptActivityAt(one, engine))
  // A file that grew is read again; one that did not is the same answer.
  appendFileSync(one, JSON.stringify({ type: 'assistant', timestamp: at(7) }) + '\n')
  cases['grown since'] = await attempt(() => m.activity.transcriptActivityAt(one, 'claude'))
  return cases
}

// ------------------------------------------------------------------------------------------------ pages

const claudeTurn = (k: number, opts: { huge?: boolean; tools?: number; crlf?: boolean } = {}): string[] => {
  const lines: unknown[] = [
    { type: 'user', uuid: `u-${k}`, sessionId: 's', timestamp: '2026-09-20T10:00:00Z', message: { role: 'user', content: `ask ${k}` } },
  ]
  for (let t = 0; t < (opts.tools ?? 1); t++) {
    lines.push({ type: 'assistant', uuid: `a-${k}-${t}`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${k}-${t}`, name: 'Bash', input: { command: `ls ${t}` } }] } })
    lines.push({ type: 'user', uuid: `r-${k}-${t}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${k}-${t}`, content: opts.huge && t === 0 ? 'y'.repeat(10 * 1024) : `out ${t}` }] } })
  }
  lines.push({ type: 'assistant', uuid: `a-${k}-z`, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${k}` }] } })
  if (k % 5 === 0) lines.push({ type: 'summary', summary: `turn ${k}` })
  const text = lines.map((line) => JSON.stringify(line))
  if (opts.crlf) text[0] += '\r'
  if (k % 4 === 0) text.push('   ')
  return text
}
const codexTurn = (k: number, opts: { huge?: boolean; tools?: number; goal?: boolean } = {}): string[] => {
  const lines: unknown[] = [opts.goal
    ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<codex_internal_context source="goal"><objective>goal ${k}</objective></codex_internal_context>` }] } }
    : { type: 'event_msg', payload: { type: 'user_message', message: `ask ${k}` } }]
  for (let t = 0; t < (opts.tools ?? 1); t++) {
    lines.push({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: `c-${k}-${t}`, arguments: '{"command":["ls"]}' } })
    lines.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: `c-${k}-${t}`, output: opts.huge && t === 0 ? 'y'.repeat(10 * 1024) : `out ${t}` } })
  }
  lines.push({ type: 'event_msg', payload: { type: 'agent_message', message: `answer ${k}` } })
  lines.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${k}` }] } })
  return lines.map((line) => JSON.stringify(line))
}

/** A page as the golden keeps it: its lines by count and digest, and what it says of the page before. */
const pageView = (page: Record<string, unknown>) => {
  const { lines, ...rest } = page as { lines: string[] } & Record<string, unknown>
  return norm({ lines: lines.length, sha: sha(lines.join('\n')), first: lines[0]?.slice(0, 60) ?? null, ...rest })
}

async function pageCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  const dir = join(root, 'pages')
  const claudeFile = join(dir, 'claude.jsonl')
  const codexFile = join(dir, 'codex.jsonl')
  const claudeLines: string[] = [JSON.stringify({ type: 'permission-mode', permissionMode: 'default' })]
  const codexLines: string[] = [JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: WORK } })]
  for (let k = 1; k <= 30; k++) {
    const opts = { huge: k % 7 === 0, tools: k === 11 ? 60 : k === 17 ? 3 : 1, crlf: k === 13, goal: k % 6 === 0 }
    claudeLines.push(...claudeTurn(k, opts))
    codexLines.push(...codexTurn(k, opts))
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(claudeFile, claudeLines.join('\n') + '\n')
  writeFileSync(codexFile, codexLines.join('\n'))
  const pager = () => new m.pages.TranscriptPager({ maxBytes: 8 * 1024, stride: { lines: 7, bytes: 2048 } })
  for (const engine of ['claude', 'codex'] as const) {
    const file = engine === 'claude' ? claudeFile : codexFile
    for (const limit of [3, 10, undefined]) {
      const pages = pager()
      const chain: unknown[] = []
      let before: string | undefined
      for (let n = 0; n < 60; n++) {
        const page = await m.transcripts.pageOf(pages, engine, file, { ...(limit ? { limit } : {}), ...(before !== undefined ? { before } : {}) })
        chain.push(pageView(page as unknown as Record<string, unknown>))
        if (!page.hasMore || !page.oldestCursor || page.staleCursor) break
        before = page.oldestCursor
      }
      cases[`${engine} · chain · limit ${limit ?? 'none'}`] = chain
    }
    cases[`${engine} · lines`] = await pager().lineCount(file)
  }
  const claudeAsks: Record<string, { limit?: number; before?: string }> = {
    'a prompt': { limit: 4, before: 'u-20' }, 'a tool call': { limit: 4, before: 'a-20-0' }, 'the huge line': { limit: 2, before: 'r-14-0' },
    'the first line': { limit: 4, before: 'u-1' }, 'unknown': { limit: 4, before: 'missing' }, 'empty': { limit: 4, before: '' },
    'a quoted id': { limit: 4, before: 'a "quoted" id' }, 'no limit, before a prompt': { before: 'u-29' },
  }
  for (const [name, ask] of Object.entries(claudeAsks)) cases[`claude · before · ${name}`] = pageView(await m.transcripts.pageOf(pager(), 'claude', claudeFile, ask) as unknown as Record<string, unknown>)
  const codexCount = await pager().lineCount(codexFile)
  const codexAsks: Record<string, { limit?: number; before?: string }> = {
    'the start': { limit: 4, before: 'codex:0' }, 'a line': { limit: 4, before: 'codex:40' }, 'a leading zero': { limit: 4, before: 'codex:040' },
    'the end': { limit: 4, before: `codex:${codexCount}` }, 'past the end': { limit: 4, before: `codex:${codexCount + 1}` },
    'negative': { limit: 4, before: 'codex:-1' }, 'not a number': { limit: 4, before: 'codex:x' }, 'garbage': { limit: 4, before: 'u-20' },
    'unsafe': { limit: 4, before: 'codex:9007199254740993' }, 'no limit': { before: 'codex:60' },
  }
  for (const [name, ask] of Object.entries(codexAsks)) cases[`codex · before · ${name}`] = pageView(await m.transcripts.pageOf(pager(), 'codex', codexFile, ask) as unknown as Record<string, unknown>)
  // A file that cannot be read is an empty one, with the cursor an empty file has.
  for (const engine of ['claude', 'codex'] as const) {
    for (const before of [undefined, 'u-1', 'codex:0', 'codex:00', 'codex:5', 'garbage']) {
      cases[`${engine} · missing · ${before ?? 'none'}`] = pageView(await m.transcripts.pageOf(pager(), engine, join(dir, 'missing.jsonl'), { limit: 4, ...(before !== undefined ? { before } : {}) }) as unknown as Record<string, unknown>)
    }
    cases[`${engine} · missing · lines`] = await pager().lineCount(join(dir, 'missing.jsonl'))
    // A folder cannot be read as a file at all.
    mkdirSync(join(dir, 'folder.jsonl'), { recursive: true })
    for (const before of [undefined, 'u-1', 'codex:0', 'codex:00', 'codex:5', 'garbage']) {
      cases[`${engine} · unreadable · ${before ?? 'none'}`] = pageView(await m.transcripts.pageOf(pager(), engine, join(dir, 'folder.jsonl'), { limit: 4, ...(before !== undefined ? { before } : {}) }) as unknown as Record<string, unknown>)
    }
  }
  // The same pager again after the file grew: the cursors it remembers still name their lines.
  const grown = pager()
  const first = await m.transcripts.pageOf(grown, 'claude', claudeFile, { limit: 3 })
  const second = await m.transcripts.pageOf(grown, 'claude', claudeFile, { limit: 3, before: first.oldestCursor! })
  appendFileSync(claudeFile, claudeTurn(31).join('\n') + '\n')
  cases['claude · grown · the remembered cursor'] = pageView(await m.transcripts.pageOf(grown, 'claude', claudeFile, { limit: 3, before: first.oldestCursor! }) as unknown as Record<string, unknown>)
  cases['claude · grown · the next'] = pageView(await m.transcripts.pageOf(grown, 'claude', claudeFile, { limit: 3, before: second.oldestCursor! }) as unknown as Record<string, unknown>)
  cases['claude · grown · from the end'] = pageView(await m.transcripts.pageOf(grown, 'claude', claudeFile, { limit: 3 }) as unknown as Record<string, unknown>)
  const codexPages = pager()
  const latest = await m.transcripts.pageOf(codexPages, 'codex', codexFile, { limit: 3 })
  appendFileSync(codexFile, '\n' + codexTurn(31).join('\n'))
  cases['codex · grown · the old cursor'] = pageView(await m.transcripts.pageOf(codexPages, 'codex', codexFile, { limit: 3, before: latest.oldestCursor! }) as unknown as Record<string, unknown>)
  cases['codex · grown · from the end'] = pageView(await m.transcripts.pageOf(codexPages, 'codex', codexFile, { limit: 3 }) as unknown as Record<string, unknown>)
  cases['codex · grown · lines'] = await codexPages.lineCount(codexFile)
  return cases
}

// ---------------------------------------------------------------------------------------------- history

const eventsView = (answer: Record<string, unknown>) => {
  const { timestamp, events, ...rest } = answer as { timestamp: unknown; events: Array<{ type: string }> } & Record<string, unknown>
  return norm({ sha: sha(JSON.stringify(events)), types: events.map((event) => event.type).join(','), timestamp: typeof timestamp, ...rest })
}

async function historyCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  const dir = join(root, 'history')
  const claudePath = join(dir, 'claude', 'session-a.jsonl')
  mkdirSync(join(dir, 'claude'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('../lib/__fixtures__/transcript-async-subagents.jsonl', import.meta.url)), claudePath)
  // Two of its three background agents have transcripts of their own: their cards take their totals.
  const subagent = (id: string, lines: unknown[]) => write(join(dir, 'claude', 'session-a', 'subagents', `agent-${id}.jsonl`), lines)
  subagent('a523fae36e503c7a1', [
    { type: 'user', timestamp: '2026-09-20T10:00:00Z' },
    { type: 'assistant', timestamp: '2026-09-20T10:00:05Z', message: { content: [{ type: 'tool_use' }, { type: 'tool_use' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } } },
    { type: 'assistant', timestamp: '2026-09-20T10:01:00Z', message: { content: [{ type: 'text' }], usage: { output_tokens: 3 } } },
  ])
  subagent('a316a821c79b054b9', [{ type: 'assistant', timestamp: '2026-09-20T10:00:00', message: { content: [{ type: 'tool_use' }] } }, 'not json'])
  const claudeCorpus = join(dir, 'claude', 'corpus.jsonl')
  copyFileSync(join(root, 'pages', 'claude.jsonl'), claudeCorpus)
  const codexPath = join(dir, 'codex', 'rollout-session.jsonl')
  mkdirSync(join(dir, 'codex'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('../lib/fixtures/session-work-codex.jsonl', import.meta.url)), codexPath)
  const codexCorpus = join(dir, 'codex', 'corpus.jsonl')
  copyFileSync(join(root, 'pages', 'codex.jsonl'), codexCorpus)
  const session = (engine: string, transcriptPath: string | null, sessionId = 'session') => ({
    agentId: `agent-${engine}`, sessionId, engine, transcriptPath, touchedAt: 1_791_374_400_000, registeredAt: 1_791_374_400_000, cwd: WORK,
    codexHome: join(root, 'codex'),
  }) as unknown as RegisteredSession
  const files: Array<[string, string, string]> = [['claude', 'fixture', claudePath], ['claude', 'corpus', claudeCorpus], ['codex', 'fixture', codexPath], ['codex', 'corpus', codexCorpus]]
  for (const [engine, name, path] of files) {
    const reader = m.transcripts.engineTranscriptFor(engine)!
    const pages = new m.pages.TranscriptPager()
    const s = session(engine, path)
    cases[`reader · ${engine} · ${name} · whole`] = eventsView(await reader.historyPage(s, {}, pages) as unknown as Record<string, unknown>)
    const latest = await reader.historyPage(s, { limit: 3 }, pages)
    cases[`reader · ${engine} · ${name} · latest`] = eventsView(latest as unknown as Record<string, unknown>)
    if (latest.oldestCursor) cases[`reader · ${engine} · ${name} · older`] = eventsView(await reader.historyPage(s, { limit: 3, before: latest.oldestCursor }, pages) as unknown as Record<string, unknown>)
    cases[`reader · ${engine} · ${name} · stale`] = eventsView(await reader.historyPage(s, { limit: 3, before: 'missing-cursor' }, pages) as unknown as Record<string, unknown>)
    cases[`reader · ${engine} · ${name} · last turn`] = await attempt(() => reader.lastTurnText(s))
  }
  for (const engine of ['claude', 'codex']) {
    const reader = m.transcripts.engineTranscriptFor(engine)!
    cases[`reader · ${engine} · no transcript`] = eventsView(await reader.historyPage(session(engine, null), { limit: 3 }, new m.pages.TranscriptPager()) as unknown as Record<string, unknown>)
    cases[`reader · ${engine} · no transcript · last turn`] = await attempt(() => reader.lastTurnText(session(engine, null)))
  }

  // Through core: `session_get`, `sessions_list` and the recap's last turn, with the readers core is handed.
  for (const [engine, name, path] of files) {
    const s = session(engine, path)
    const deps = {
      readerFor: m.transcripts.engineTranscriptFor, resolve: (id: string) => id === 'session' || id === s.agentId ? s : undefined,
      stopped: () => [], pages: new m.pages.TranscriptPager(), dbs: { opencode: '', kilo: '', devin: '' }, hermesDb: async () => '',
    }
    const history = m.history.createHistory(deps as unknown as Parameters<typeof m.history.createHistory>[0])
    const whole = await history.sessionGet({ sessionId: 'session' })
    cases[`core · ${engine} · ${name} · whole`] = eventsView(whole)
    const latest = await history.sessionGet({ sessionId: 'session', limit: 3 })
    cases[`core · ${engine} · ${name} · latest`] = eventsView(latest)
    if (latest.oldestCursor) cases[`core · ${engine} · ${name} · older`] = eventsView(await history.sessionGet({ sessionId: 'session', limit: 3, before: latest.oldestCursor as string }))
    cases[`core · ${engine} · ${name} · stale`] = eventsView(await history.sessionGet({ sessionId: 'session', limit: 3, before: 'missing-cursor' }))
    const listed = await history.sessionsList({ agentId: s.agentId }) as { sessions: Array<Record<string, unknown>> }
    cases[`core · ${engine} · ${name} · list`] = norm(listed.sessions.map(({ lastActivity, ...rest }) => ({ ...rest, lastActivity: typeof lastActivity })))
    const readLast = m.lastTurn.createLastTurnReader({ ...deps, bySession: () => s } as unknown as Parameters<typeof m.lastTurn.createLastTurnReader>[0])
    cases[`core · ${engine} · ${name} · last turn`] = await attempt(() => readLast('session'))
  }
  return cases
}

type Sections = Record<string, Record<string, unknown>>
const PLATFORMS = ['darwin', 'linux'] as const

async function sectionsOn(platform: (typeof PLATFORMS)[number]): Promise<Sections> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  // Each platform reads files of its own: nothing either one wrote or remembered is the other's.
  for (const name of ['claude', 'codex', 'moved-claude', 'moved-codex', 'elsewhere', 'turns', 'activity', 'pages', 'history', 'none', 'tmp']) rmSync(join(root, name), { recursive: true, force: true })
  try {
    return { adoption: await adoptionCases(), activity: await activityCases(), pages: await pageCases(), history: await historyCases() }
  } finally { Object.defineProperty(process, 'platform', real) }
}

describe('core reads Claude Code\'s and Codex\'s conversations as it did before their reading rules were declared', () => {
  it('adoption, activity, pages, history and the last turn match the record, on darwin and linux', async () => {
    const darwin = await sectionsOn('darwin')
    const linux = await sectionsOn('linux')
    const linuxDiffers = Object.fromEntries(Object.entries(linux).map(([section, cases]) => [section,
      Object.fromEntries(Object.entries(cases).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(darwin[section]![key])))]))
    if (RECORD) {
      const block = (cases: Record<string, unknown>): string => Object.entries(cases).map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')
      const sections = (all: Sections): string => Object.entries(all).map(([section, cases]) => `${JSON.stringify(section)}: {\n${block(cases)}\n}`).join(',\n')
      writeFileSync(GOLDEN, `{\n${sections(darwin)},\n"linux": {\n${sections(linuxDiffers)}\n}\n}\n`)
      return
    }
    const { linux: linuxGolden, ...darwinGolden } = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Sections & { linux: Sections }
    for (const [platform, actual, golden] of [
      ['darwin', darwin, darwinGolden],
      ['linux', linux, Object.fromEntries(Object.entries(darwinGolden).map(([section, cases]) => [section, { ...cases, ...linuxGolden[section] }]))],
    ] as const) {
      expect(Object.keys(actual), platform).toEqual(Object.keys(golden))
      for (const [section, cases] of Object.entries(golden)) {
        expect(Object.keys(actual[section]!).sort(), `${platform} · ${section}`).toEqual(Object.keys(cases).sort())
        for (const [key, value] of Object.entries(cases)) expect(actual[section]![key], `${platform} · ${section} · ${key}`).toEqual(value)
      }
    }
  }, 240_000)

  it('records no machine-specific path', () => {
    const text = readFileSync(GOLDEN, 'utf8')
    expect(text).not.toContain('transcript-reads-golden-')
    expect(text).not.toContain(root)
    expect(text).not.toMatch(/\/Users\/|\/home\/runner/)
  })
})

// Filesystem durability deadlines are exercised separately from these deterministic fixture reads.
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
