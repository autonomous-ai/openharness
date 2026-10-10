import { clearEngineHomeFixture } from '../testing/engineHomeFixture.js'
import { nativeConversationFixture } from '../testing/nativeConversationEvidence.js'
/**
 * Where Claude Code and Codex keep their sessions, and what core reads there, answer for answer: recorded
 * from the code as it stood before their session stores became declared data applied by the kit
 * (docs/design/2026-10-08-engine-launch.md, (c4)). It covers what runs as the registry loads, on the hook path
 * and in session repair:
 *
 *  - the engine homes a person moves, as adopted, remembered and searched;
 *  - which transcript paths the registry accepts, for every kind of engine;
 *  - the registry's load: a Codex parent's transcript put back after a sub-agent's hook overwrote it, and
 *    bindings released when their transcript is not the engine's own;
 *  - a session found by its id, by a process's own record, by the session file a process holds open, and by a
 *    scan of the engine's store; a conversation continued in another file;
 *  - a Codex rollout's first record, and a rollout found by its thread id;
 *  - what Stop captures before a pause, and which finder the handoff asks for each engine.
 *
 * Each case runs with `process.platform` pinned to darwin and to linux, and linux's are stored where they
 * differ. Fixture birth/mtime and the clock are fixed: running both platform passes under load must not
 * age a "new" transcript beyond the process-start slack. The `wrote` tier is the unit specs'.
 *
 * `RECORD_SESSION_STORE_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter what
 * core finds, and say so in that change.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'

const fixtureClock = vi.hoisted(() => ({ root: '', now: Date.parse('2026-10-09T00:00:00Z') }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
// Other test processes create and remove siblings under the host's temporary directory. Those
// mutations are outside this recording; keep ancestor content stamps stable, retaining native inode
// identity and all content stamps within the fixture. The expected artifact remains unchanged.
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    const info = Reflect.apply(fs.lstatSync, fs, args)
    const path = String(args[0])
    if (!info || !fixtureClock.root || path === fixtureClock.root || path.startsWith(fixtureClock.root + '/') || !info.isDirectory()) return info
    return new Proxy(info, { get: (value, key) => ['size', 'mtimeNs', 'ctimeNs'].includes(String(key)) ? 0n : Reflect.get(value, key) })
  } }
})


vi.mock('../lib/bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('../lib/processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
vi.mock('../lib/processEvidence.js', async () => {
  const { nativeConversationFixture } = await import('../testing/nativeConversationEvidence.js')
  return { readProcessEvidence: nativeConversationFixture(async () => [], async () => []).processes }
})
vi.mock('fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, stat: async (path: string, ...args: unknown[]) => {
    const result = await Reflect.apply(fs.stat, fs, [path, ...args])
    return String(path).startsWith(fixtureClock.root + '/')
      ? new Proxy(result, { get: (value, key) => key === 'birthtimeMs' || key === 'mtimeMs' ? fixtureClock.now : Reflect.get(value, key) })
      : result
  } }
})

// The record holds a UTC record read against a process started in local time, so the answer depends on the zone.
// It was recorded in America/New_York; pinned here, it is the same on every host (Linux CI runs in UTC, run 37828754630).
process.env.TZ = 'America/New_York'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/session-store.golden.json', import.meta.url))
const RECORD = process.env.RECORD_SESSION_STORE_GOLDEN === '1'

let root = ''
const saved: Record<string, string | undefined> = {}
const VARS = ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_HOME', 'PI_HOME'] as const
type Modules = {
  homes: typeof import('../lib/engineHomes.js')
  registry: typeof import('../lib/registry.js')
  repair: typeof import('../lib/sessionRepair.js')
  stores: typeof import('./sessionStores.js')
  capture: typeof import('../lib/captureResumeIdentity.js')
  handoff: typeof import('../lib/handoffDiscovery.js')
}
let m: Modules

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const C = 'cccccccc-3333-4333-8333-cccccccccccc'
const CHILD = 'dddddddd-4444-4444-8444-dddddddddddd'
const OTHER = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
const PROFILE_ID = 'ffffffff-6666-4666-8666-ffffffffffff'
const MOVED_ID = '12121212-7777-4777-8777-121212121212'
const D = 'abababab-8888-4888-8888-abababababab'
const E = 'cdcdcdcd-9999-4999-8999-cdcdcdcdcdcd'

const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o644)
}
const jsonl = (...records: unknown[]): string => records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n'
const meta = (id: string, cwd: string, source: unknown = 'cli') => ({ timestamp: 't', type: 'session_meta', payload: { id, cwd, source } })
const child = (id: string, parent: string | null, cwd: string) => meta(id, cwd, { subagent: parent ? { thread_spawn: { parent_thread_id: parent, depth: 1 } } : 'review' })

const norm = (value: unknown): unknown => value === undefined ? '<undefined>' : JSON.parse(JSON.stringify(value).split(root).join('<root>'))
async function attempt<T>(run: () => T | Promise<T>): Promise<unknown> {
  try { return norm(await run()) } catch (error) { return { threw: norm(error instanceof Error ? error.message : String(error)) } }
}

let paths: Record<string, string> = {}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'session-store-golden-')))
  fixtureClock.root = root
  vi.useFakeTimers({ toFake: ['Date'], now: fixtureClock.now })
  for (const name of VARS) saved[name] = process.env[name]
  process.env.ADAPTER_DATA_DIR = join(root, 'data')
  process.env.CLAUDE_PROJECTS_DIR = join(root, 'claude', 'projects')
  process.env.CODEX_HOME = join(root, 'codex')
  process.env.CURSOR_HOME = join(root, 'cursor')
  process.env.PI_HOME = join(root, 'pi')
  delete process.env.CLAUDE_CONFIG_DIR
  mkdirSync(join(root, 'data'), { recursive: true })
  chmodSync(join(root, 'data'), 0o700)
  // The work folders sessions name. `linked` is the same folder by another path.
  for (const dir of ['work/a', 'work/b', 'work/c', 'elsewhere']) mkdirSync(join(root, dir), { recursive: true })
  symlinkSync(join(root, 'work/a'), join(root, 'linked-a'))
  const work = (name: string) => join(root, 'work', name)
  const day = (home: string) => join(home, 'sessions', '2026', '10', '08')
  paths = {
    claudeA: join(root, 'claude/projects/-work-a', `${A}.jsonl`),
    claudeSub: join(root, 'claude/projects/-work-a', A, 'subagents', 'agent-1.jsonl'),
    claudeOldSub: join(root, 'claude/projects/-work-a', 'agent-2.jsonl'),
    claudeB: join(root, 'claude/projects/-work-b', `${B}.jsonl`),
    claudeMoved: join(root, 'moved-claude/projects/-work-c', `${MOVED_ID}.jsonl`),
    claudeContinued: join(root, 'claude/projects/-work-b', `${C}.jsonl`),
    codexA: join(day(join(root, 'codex')), `rollout-2026-10-08T00-00-00-${A}.jsonl`),
    codexChild: join(day(join(root, 'codex')), `rollout-2026-10-08T00-00-01-${CHILD}.jsonl`),
    codexB: join(day(join(root, 'codex')), `rollout-2026-10-08T00-00-02-${B}.jsonl`),
    codexMoved: join(day(join(root, 'moved-codex')), `rollout-2026-10-08T00-00-03-${MOVED_ID}.jsonl`),
    codexProfile: join(day(join(root, 'profile')), `rollout-2026-10-08T00-00-04-${PROFILE_ID}.jsonl`),
    outside: join(root, 'elsewhere', `${OTHER}.jsonl`),
  }
  write(paths.claudeA, jsonl({ type: 'summary', leafUuid: 'x' }, { type: 'user', cwd: work('a'), isSidechain: false, sessionId: A }))
  write(paths.claudeSub, jsonl({ type: 'user', cwd: work('a'), isSidechain: true, sessionId: A }))
  write(paths.claudeOldSub, jsonl({ type: 'user', cwd: work('a'), isSidechain: true, sessionId: A }))
  write(paths.claudeB, jsonl({ type: 'user', cwd: work('b'), sessionId: B }, { type: 'continued-in', continuedInSessionId: C }))
  write(paths.claudeContinued, jsonl({ type: 'ai-title' }, { type: 'user', cwd: work('b'), sessionId: C }))
  write(paths.claudeMoved, jsonl({ type: 'user', cwd: work('c'), sessionId: MOVED_ID }))
  write(paths.codexA, jsonl(meta(A, work('a')), { type: 'response_item', payload: {} }))
  write(paths.codexChild, jsonl(child(CHILD, A, work('a'))))
  write(paths.codexB, jsonl(meta(B, work('b'))))
  write(paths.codexMoved, jsonl(meta(MOVED_ID, work('c'))))
  write(paths.codexProfile, jsonl(meta(PROFILE_ID, work('a'))))
  write(paths.outside, jsonl({ type: 'user', cwd: work('a') }))
  vi.resetModules()
  m = {
    homes: await import('../lib/engineHomes.js'),
    registry: await import('../lib/registry.js'),
    repair: await import('../lib/sessionRepair.js'),
    stores: await import('./sessionStores.js'),
    capture: await import('../lib/captureResumeIdentity.js'),
    handoff: await import('../lib/handoffDiscovery.js'),
  }
})

afterAll(() => {
  vi.useRealTimers()
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  m?.homes.resetEngineHomes()
  rmSync(root, { recursive: true, force: true })
  vi.resetModules()
})

/** The person's moved homes: adopted, so remembered in the data folder, as the core does at start. */
function adoptMoved(): unknown {
  m.homes.resetEngineHomes()
  clearEngineHomeFixture(join(root, 'data'))
  return m.homes.adoptEngineHomes({ CLAUDE_CONFIG_DIR: join(root, 'moved-claude'), CODEX_HOME: join(root, 'moved-codex') },
    { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') })
}
function forgetMoved(): void {
  m.homes.resetEngineHomes()
  clearEngineHomeFixture(join(root, 'data'))
}

// --------------------------------------------------------------------------------------------- homes

async function homeCases(): Promise<Record<string, unknown>> {
  const h = m.homes
  const cases: Record<string, unknown> = {}
  const probe = () => ({
    moved: h.movedEngineHomes(),
    claudeRoots: h.claudeProjectsRoots(join(root, 'claude', 'projects')),
    codexRoots: h.codexHomeRoots(join(root, 'codex')),
    codexSettingRoots: h.homeRoots('CODEX_HOME'),
    sessionCodexHome: [
      h.sessionCodexHome({ codexHome: join(root, 'profile') }),
      h.sessionCodexHome({ transcriptPath: paths.codexMoved }),
      h.sessionCodexHome({ transcriptPath: join(root, 'moved-codex', 'archived_sessions', 'x.jsonl') }),
      h.sessionCodexHome({ transcriptPath: paths.codexA }),
      h.sessionCodexHome({ transcriptPath: paths.outside }),
      h.sessionCodexHome({}),
    ],
    sessionClaudeHome: [h.sessionClaudeHome({ transcriptPath: paths.claudeMoved }), h.sessionClaudeHome({ transcriptPath: paths.claudeA }),
      h.sessionClaudeHome({ transcriptPath: paths.outside }), h.sessionClaudeHome({})],
    saved: (() => { h.resetEngineHomes(); const catalog = h.movedEngineHomes(); return Object.values(catalog).some(homes => homes.length) ? JSON.stringify(catalog) + '\n' : null })(),
  })
  forgetMoved()
  cases['none moved'] = norm(probe())
  cases['moved'] = norm({ adopted: adoptMoved(), ...probe() })
  cases['moved again'] = norm({ adopted: h.adoptEngineHomes({ CLAUDE_CONFIG_DIR: join(root, 'moved-claude'), CODEX_HOME: join(root, 'moved-codex') },
    { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') }), ...probe() })
  forgetMoved()
  cases['moved to the defaults, a relative path and a tilde'] = norm({
    adopted: [
      h.adoptEngineHomes({ CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') }, { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') }),
      h.adoptEngineHomes({ CLAUDE_CONFIG_DIR: 'relative/claude', CODEX_HOME: '~/codex' }, { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') }),
      h.adoptEngineHomes({ CLAUDE_CONFIG_DIR: `${join(root, 'moved-claude')}/`, CODEX_HOME: ` ${join(root, 'moved-codex')} ` }, { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') }),
    ],
    ...probe(),
  })
  // Remembered across a restart: a fresh module state reads the saved file.
  h.resetEngineHomes()
  cases['remembered'] = norm(probe())
  forgetMoved()
  const environments: Record<string, NodeJS.ProcessEnv> = {
    'no variables': {},
    'moved': { CODEX_HOME: join(root, 'moved-codex'), CLAUDE_CONFIG_DIR: join(root, 'moved-claude') },
    'relative': { CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude' },
    'trailing slash': { CODEX_HOME: `${join(root, 'moved-codex')}/`, CLAUDE_CONFIG_DIR: `${join(root, 'moved-claude')}/` },
  }
  for (const [name, environment] of Object.entries(environments)) {
    cases[`launch homes · ${name}`] = norm({
      codex: h.launchCodexHome(null, environment), codexProfile: h.launchCodexHome(join(root, 'profile'), environment),
      // Else the home folder itself, the spec run's own throwaway one.
      claude: h.launchClaudeConfigDir(environment).startsWith(root) ? h.launchClaudeConfigDir(environment) : '<home folder>',
    })
  }
  return cases
}

// ------------------------------------------------------------------------------------------- transcripts

function transcriptCases(): Record<string, unknown> {
  adoptMoved()
  const valid = m.registry.validTranscriptPath
  const link = join(root, 'claude/projects/-work-a', 'link-out.jsonl')
  if (!existsSync(link)) symlinkSync(paths.outside, link)
  const linkIn = join(root, 'elsewhere', 'link-in.jsonl')
  if (!existsSync(linkIn)) symlinkSync(paths.claudeA, linkIn)
  const cursor = join(root, 'cursor', 'projects', 'ws', 'agent-transcripts', A, `${A}.jsonl`)
  write(cursor, '{}\n')
  const cursorWrong = join(root, 'cursor', 'projects', 'ws', 'agent-transcripts', B, `${A}.jsonl`)
  write(cursorWrong, '{}\n')
  const files: Record<string, string> = {
    ...paths, link, linkIn, cursor, cursorWrong,
    missingClaude: join(root, 'claude/projects/-work-a', 'missing.jsonl'),
    missingCodex: join(root, 'codex/sessions/2026/10/08', 'rollout-missing.jsonl'),
    claudeDir: join(root, 'claude/projects/-work-a'),
    missingDir: join(root, 'claude/projects/-nope', 'x.jsonl'),
  }
  const cases: Record<string, unknown> = {}
  for (const engine of ['claude', 'codex', 'cursor', 'pi', 'opencode', 'terminal'] as const) {
    for (const [name, path] of Object.entries(files)) {
      const answers = [valid(engine, path), valid(engine, path, join(root, 'profile')), valid(engine, path, undefined, true), valid(engine, path, join(root, 'profile'), true)]
      if (answers.some(Boolean)) cases[`${engine} · ${name}`] = answers
    }
  }
  forgetMoved()
  for (const name of ['claudeMoved', 'codexMoved']) {
    cases[`not moved · ${name}`] = [valid('claude', paths[name]!), valid('codex', paths[name]!)]
  }
  cases['keeps a file'] = Object.fromEntries((['claude', 'codex', 'cursor', 'pi', 'opencode', 'kilo', 'hermes', 'devin', 'terminal'] as const)
    .map((engine) => [engine, m.registry.engineKeepsTranscriptFile(engine)]))
  return cases
}

// ---------------------------------------------------------------------------------------- finding a session

async function findCases(): Promise<Record<string, unknown>> {
  const r = m.repair
  const s = m.stores
  const cases: Record<string, unknown> = {}
  const work = (name: string) => join(root, 'work', name)
  for (const moved of [false, true]) {
    if (moved) adoptMoved(); else forgetMoved()
    const label = moved ? 'moved homes' : 'default homes'
    for (const [engine, id, opts] of [
      ['claude', A, undefined], ['claude', MOVED_ID, undefined], ['claude', 'not-hex', undefined], ['claude', OTHER, undefined],
      ['codex', A, undefined], ['codex', CHILD, undefined], ['codex', MOVED_ID, undefined], ['codex', PROFILE_ID, undefined],
      ['codex', PROFILE_ID, { codexHome: join(root, 'profile') }], ['codex', A, { codexHome: join(root, 'profile') }], ['codex', 'short', undefined],
      ['cursor', A, undefined], ['opencode', A, undefined],
    ] as const) {
      cases[`resumed · ${label} · ${engine} · ${id}${opts ? ' · profile' : ''}`] = await attempt(() => r.findResumedTranscript(engine, id, opts))
    }
    // Born after their process: every session file above was written just now.
    const now = Date.now()
    for (const [engine, cwd, opts] of [
      ['claude', work('a'), undefined], ['claude', work('b'), undefined], ['claude', work('c'), undefined], ['claude', join(root, 'linked-a'), undefined],
      ['claude', work('a'), { bornOnly: true }], ['claude', join(root, 'elsewhere'), undefined],
      ['codex', work('a'), undefined], ['codex', work('b'), undefined], ['codex', work('c'), undefined], ['codex', work('a'), { codexHome: join(root, 'profile') }],
      ['codex', work('a'), { pid: 2 ** 22 + 11 }],
    ] as const) {
      cases[`live · ${label} · ${engine} · ${cwd.split(root).join('')}${opts ? ` · ${Object.keys(opts).join(',')}` : ''}`] =
        await attempt(() => r.findLiveSession(engine, cwd, now - 1_000, opts))
    }
    // A process started after every file: nothing it could have opened.
    cases[`live · ${label} · claude · started later`] = await attempt(() => r.findLiveSession('claude', work('b'), Date.now() + 600_000))
  }
  forgetMoved()
  // Claude Code's subagent transcripts, each refused by one rule alone: one below a `subagents` folder whose first
  // record says nothing of it, and one in the project folder opening with `isSidechain: true`. Each conversation's
  // own transcript holds a sidechain record later, which does not count.
  write(join(root, 'claude/projects/-work-d', `${D}.jsonl`), jsonl({ type: 'user', cwd: work('d'), isSidechain: false, sessionId: D }, { type: 'user', isSidechain: true }))
  write(join(root, 'claude/projects/-work-d', D, 'subagents', 'agent-3.jsonl'), jsonl({ type: 'user', cwd: work('d'), sessionId: D }))
  write(join(root, 'claude/projects/-work-e', `${E}.jsonl`), jsonl({ type: 'mode' }, { type: 'user', cwd: work('e'), isSidechain: false, sessionId: E }, { type: 'user', isSidechain: true }))
  write(join(root, 'claude/projects/-work-e', 'agent-4.jsonl'), jsonl({ type: 'mode' }, { type: 'user', cwd: work('e'), isSidechain: true, sessionId: E }))
  // A moved home below a folder named `subagents`: the rule is read below the projects folder, never above it.
  write(join(root, 'subagents/home/projects/-work-f', `${OTHER}.jsonl`), jsonl({ type: 'user', cwd: work('f'), sessionId: OTHER }))
  for (const dir of ['work/d', 'work/e', 'work/f']) mkdirSync(join(root, dir), { recursive: true })
  const scanned = Date.now()
  cases['live · claude · a subagent below its folder'] = await attempt(() => r.findLiveSession('claude', work('d'), scanned - 1_000))
  cases['live · claude · a subagent by its first flag'] = await attempt(() => r.findLiveSession('claude', work('e'), scanned - 1_000))
  m.homes.adoptEngineHomes({ CLAUDE_CONFIG_DIR: join(root, 'subagents', 'home') }, { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') })
  cases['live · claude · a moved home below a subagents folder'] = await attempt(() => r.findLiveSession('claude', work('f'), scanned - 1_000))
  forgetMoved()
  // A process's own record (Claude's `<home>/sessions/<pid>.json`), in the default and a moved home.
  const procStart = 'Thu Oct  8 10:00:00 2026'
  const utc = '2026-10-08T10:00:00.000Z'
  const record = (home: string, pid: number, fields: Record<string, unknown>) =>
    write(join(root, home, 'sessions', `${pid}.json`), JSON.stringify({ pid, procStart, cwd: work('a'), sessionId: A, ...fields }))
  record('claude', 101, {})
  record('claude', 102, { procStart: utc })
  record('claude', 103, { pid: 999 })
  record('claude', 104, { cwd: work('b') })
  record('claude', 105, { sessionId: 7 })
  record('claude', 106, { sessionId: OTHER })
  record('claude', 107, { procStart: 3 })
  record('moved-claude', 108, { sessionId: MOVED_ID, cwd: work('c') })
  write(join(root, 'claude', 'sessions', '109.json'), '{not json')
  const local = Date.parse(procStart)
  const utcMs = Date.parse(utc)
  for (const moved of [false, true]) {
    if (moved) adoptMoved(); else forgetMoved()
    for (const [pid, cwd, startedAt, name] of [
      [101, work('a'), local, 'local start'], [101, join(root, 'linked-a'), local, 'linked folder'], [101, work('a'), local + 1000, 'another start'],
      [102, work('a'), utcMs, 'utc start'], [102, work('a'), local, 'utc record, local start'], [103, work('a'), local, 'another pid'],
      [104, work('a'), local, 'another folder'], [105, work('a'), local, 'no id'], [106, work('a'), local, 'no transcript'], [107, work('a'), local, 'no start'],
      [108, work('c'), local, 'moved home'], [109, work('a'), local, 'unreadable'], [110, work('a'), local, 'no record'], [-1, work('a'), local, 'bad pid'],
      [101, work('a'), Number.NaN, 'bad start'],
    ] as const) {
      cases[`process record · ${moved ? 'moved homes' : 'default homes'} · ${name}`] = await attempt(() => s.processSessionOf('claude', pid, cwd, startedAt))
    }
    cases[`process record · ${moved ? 'moved homes' : 'default homes'} · codex`] = await attempt(() => s.processSessionOf('codex', 101, work('a'), local))
    // Through findLiveSession with a pid: the record first, else the scan.
    cases[`live · ${moved ? 'moved homes' : 'default homes'} · claude · pid with a record`] = await attempt(() => r.findLiveSession('claude', work('a'), local, { pid: 101 }))
  }
  forgetMoved()
  // The rollout a Codex process holds open, and its native child's behind npm's Node launcher.
  const sessions = [join(root, 'codex', 'sessions'), join(root, 'moved-codex', 'sessions')]
  const held: Record<string, string[]> = {
    'its rollout': [paths.codexA, '/dev/null'],
    'a sub-agent rollout': [paths.codexChild],
    'two rollouts': [paths.codexA, paths.codexB],
    'the same rollout twice': [paths.codexA, paths.codexA],
    'outside the sessions': [paths.outside, join(root, 'elsewhere', 'rollout-x.jsonl')],
    'another folder': [paths.codexB],
    'a moved home': [paths.codexMoved],
    'nothing': [],
  }
  for (const [name, files] of Object.entries(held)) {
    for (const [cwdName, cwd] of [['a', work('a')], ['c', work('c')]] as const) {
      cases[`open files · ${name} · ${cwdName}`] = await attempt(() => s.openFileSessionOf('codex', 7, sessions, cwd, { sources: nativeConversationFixture(async () => files) }))
    }
  }
  // Only a file named as a rollout counts, however its first record reads.
  const heldRoot = join(root, 'held')
  write(join(heldRoot, `rollout-held-${B}.jsonl`), jsonl(meta(B, work('a'))))
  write(join(heldRoot, `notes-${C}.jsonl`), jsonl(meta(C, work('a'))))
  cases['open files · a rollout and another session-shaped file'] = await attempt(() => s.openFileSessionOf('codex', 7, heldRoot, work('a'),
    { sources: nativeConversationFixture(async () => [join(heldRoot, `notes-${C}.jsonl`), join(heldRoot, `rollout-held-${B}.jsonl`)]) }))
  cases['open files · one root'] = await attempt(() => s.openFileSessionOf('codex', 7, join(root, 'codex', 'sessions'), work('a'), { sources: nativeConversationFixture(async () => [paths.codexA]) }))
  cases['open files · claude'] = await attempt(() => s.openFileSessionOf('claude', 7, sessions, work('a'), { sources: nativeConversationFixture(async () => [paths.codexA]) }))
  const rows = (args: string, executable: string) => async () => [
    { pid: 7, parentPid: 1, executable, args },
    { pid: 8, parentPid: 7, executable: 'codex', args: 'codex --no-daemon' },
    { pid: 9, parentPid: 8, executable: 'rg', args: 'rg x' },
  ]
  const filesOf = (byPid: Record<number, string[]>) => async (pid: number) => byPid[pid] ?? []
  for (const [name, own, launcher, executable] of [
    ['own rollout', [paths.codexA], 'codex', 'codex'],
    ['node launcher', ['/dev/null'], 'node /opt/codex.js', 'node'],
    ['nodejs launcher', [], '/usr/bin/nodejs /opt/codex.js', '/usr/bin/nodejs'],
    ['not a launcher', ['/dev/null'], 'python3 x', 'python3'],
  ] as const) {
    cases[`process files · ${name}`] = await attempt(() => s.processFilesOf('codex', 7, { sources: nativeConversationFixture(filesOf({ 7: [...own], 8: [paths.codexB] }), rows(launcher, executable)) }))
  }
  cases['process files · no process table'] = await attempt(() => s.processFilesOf('codex', 7, { sources: nativeConversationFixture(filesOf({ 7: ['/dev/null'] }), async () => null) }))
  cases['process files · two children'] = await attempt(() => s.processFilesOf('codex', 7, { sources: nativeConversationFixture(filesOf({ 7: [], 8: [paths.codexB], 10: [paths.codexA] }), async () => [
    { pid: 7, parentPid: 1, executable: 'node', args: 'node /opt/codex.js' },
    { pid: 8, parentPid: 7, executable: 'codex', args: 'codex' }, { pid: 10, parentPid: 7, executable: 'codex', args: 'codex' }]) }))
  return cases
}

// ------------------------------------------------------------------------------------------- continuation

async function continuationCases(): Promise<Record<string, unknown>> {
  const owned: string[] = []
  const put = (path: string, text: string) => { owned.push(path); write(path, text) }
  const dir = join(root, 'claude/projects/-work-b')
  const marker = (id: unknown) => ({ type: 'continued-in', continuedInSessionId: id })
  const big = 'x'.repeat(300 * 1024)
  const files: Record<string, string> = {
    'continued, with a turn': jsonl({ type: 'user' }, marker(C)),
    'continued, background': jsonl({ type: 'user' }, marker('a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0')),
    'continued, next missing': jsonl(marker('b0b0b0b0-0000-4000-8000-b0b0b0b0b0b0')),
    'continued, next is a folder': jsonl(marker('c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0')),
    'continued, next is large': jsonl(marker('d0d0d0d0-0000-4000-8000-d0d0d0d0d0d0')),
    'continued, next turn as assistant': jsonl(marker('e0e0e0e0-0000-4000-8000-e0e0e0e0e0e0')),
    'continued, next is large without a turn': jsonl(marker('f0f0f0f0-0000-4000-8000-f0f0f0f0f0f0')),
    'not the last line': jsonl(marker(C), { type: 'user' }),
    'a marker without an id': jsonl({ type: 'continued-in' }),
    'a marker with a number': jsonl(marker(5)),
    'invalid JSON last': jsonl('{bad'),
    'empty': '',
    'trailing blank lines': `${JSON.stringify(marker(C))}\n\n  \n`,
  }
  put(join(dir, 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0.jsonl'), jsonl({ type: 'ai-title' }, { type: 'agent-name' }))
  owned.push(join(dir, 'c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0.jsonl'))
  mkdirSync(join(dir, 'c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0.jsonl'), { recursive: true })
  put(join(dir, 'd0d0d0d0-0000-4000-8000-d0d0d0d0d0d0.jsonl'), jsonl({ type: 'file-history-snapshot', big }, { type: 'user' }))
  put(join(dir, 'e0e0e0e0-0000-4000-8000-e0e0e0e0e0e0.jsonl'), jsonl({ type: 'mode' }, '{"type":"assistant","x":"\\"user\\""}'))
  // Past the 256 KiB head and short of twice it, with no turn at all: taken for its length.
  put(join(dir, 'f0f0f0f0-0000-4000-8000-f0f0f0f0f0f0.jsonl'), jsonl({ type: 'file-history-snapshot', big }))
  const cases: Record<string, unknown> = {}
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, `${name.replace(/[^a-z]+/g, '-')}.jsonl`)
    put(path, text)
    cases[name] = await attempt(() => m.stores.continuationOf('claude', path))
  }
  cases['missing file'] = await attempt(() => m.stores.continuationOf('claude', join(dir, 'nope.jsonl')))
  cases['codex'] = await attempt(() => m.stores.continuationOf('codex', join(dir, 'continued-with-a-turn.jsonl')))
  // Continuation bodies are not discovery headers. Do not carry these fixtures into the Linux pass.
  for (const path of owned) rmSync(path, { recursive: true, force: true })
  return cases
}

// ----------------------------------------------------------------------------------------- rollouts

/** A rollout whose first line is exactly `bytes` long: its record names no machine path, so neither does its size. */
function sizedFirstLine(bytes: number): string {
  const base = JSON.stringify({ ...meta(A, '/w'), pad: '' })
  return jsonl({ ...meta(A, '/w'), pad: 'x'.repeat(bytes - base.length) })
}

function rolloutCases(): Record<string, unknown> {
  const dir = join(root, 'rollouts')
  const files: Record<string, string> = {
    'a conversation': jsonl(meta(A, '/w')),
    'a sub-agent of a parent': jsonl(child(CHILD, A, '/w')),
    'a sub-agent without a parent': jsonl(child(CHILD, null, '/w')),
    'a null sub-agent': jsonl(meta(A, '/w', { subagent: null })),
    'an empty parent': jsonl(meta(A, '/w', { subagent: { thread_spawn: { parent_thread_id: '' } } })),
    'no id, no cwd': jsonl({ type: 'session_meta', payload: { source: 'cli' } }),
    'an id that is not text': jsonl({ type: 'session_meta', payload: { id: 7, cwd: 8 } }),
    'no payload': jsonl({ type: 'session_meta' }),
    'another record first': jsonl({ type: 'response_item', payload: {} }, meta(A, '/w')),
    'blank lines first': `\n\n${JSON.stringify(meta(A, '/w'))}\n`,
    'invalid JSON': '{bad\n',
    'empty': '',
    'a first line past 128 KiB': jsonl({ ...meta(A, '/w'), pad: 'x'.repeat(130 * 1024) }),
    'a first line just under 128 KiB': jsonl({ ...meta(A, '/w'), pad: 'x'.repeat(127 * 1024) }),
    'a first line 512 bytes past 128 KiB': sizedFirstLine(128 * 1024 + 512),
  }
  const cases: Record<string, unknown> = {}
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, `${name.replace(/[^a-z0-9]+/gi, '-')}.jsonl`)
    write(path, text)
    cases[`meta · ${name}`] = norm(m.stores.sessionMetaOf('codex', path))
  }
  cases['meta · missing'] = norm(m.stores.sessionMetaOf('codex', join(dir, 'missing.jsonl')))
  cases['meta · claude'] = norm(m.stores.sessionMetaOf('claude', paths.codexA))
  // Found by thread id: a `.jsonl` whose name holds it, under a root; folders with a dot are not entered.
  write(join(root, 'walk', '2026', '10', `rollout-x-${A}.jsonl`), '{}\n')
  write(join(root, 'walk', 'v1.2', `rollout-x-${B}.jsonl`), '{}\n')
  write(join(root, 'walk', `rollout-x-${C}.json`), '{}\n')
  for (const [name, id, at] of [
    ['nested', A, join(root, 'walk')], ['in a dotted folder', B, join(root, 'walk')], ['not jsonl', C, join(root, 'walk')],
    ['an id too short', 'abc', join(root, 'walk')], ['an id with a slash', 'aaaaaaaa/1111', join(root, 'walk')], ['a missing root', A, join(root, 'nope')],
  ] as const) {
    cases[`find · ${name}`] = norm(m.stores.findSessionFileOf('codex', id, at))
  }
  for (const moved of [false, true]) {
    if (moved) adoptMoved(); else forgetMoved()
    cases[`find · every home · ${moved ? 'moved' : 'default'}`] = norm([m.stores.findSessionFileOf('codex', A), m.stores.findSessionFileOf('codex', MOVED_ID), m.stores.findSessionFileOf('codex', PROFILE_ID)])
  }
  forgetMoved()
  cases['find · claude'] = norm(m.stores.findSessionFileOf('claude', A, join(root, 'walk')))
  return cases
}

// --------------------------------------------------------------------------------------- the registry

async function registryCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  const row = (over: Record<string, unknown>) => ({
    launcherId: 'h1', engine: 'codex', projectDir: 'p', cwd: join(root, 'work', 'a'), tmuxPane: '%8', source: null, title: null, model: null,
    processIdentity: null, registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1, ...over,
  })
  const scenarios: Record<string, Array<Record<string, unknown>>> = {
    'a codex parent overwritten by its sub-agent': [row({ sessionId: A, transcriptPath: paths.codexChild })],
    'a codex row overwritten by another parent\'s sub-agent': [row({ sessionId: B, transcriptPath: paths.codexChild })],
    'a codex parent whose own rollout is gone': [row({ sessionId: OTHER, transcriptPath: join(root, 'codex/sessions/2026/10/08', `rollout-x-${'1'.repeat(8)}.jsonl`) })],
    'a codex parent on a profile, overwritten': [row({ sessionId: A, transcriptPath: paths.codexChild, codexHome: join(root, 'profile') })],
    'a codex row with its own rollout': [row({ sessionId: A, transcriptPath: paths.codexA })],
    'a codex row in a moved home': [row({ sessionId: MOVED_ID, transcriptPath: paths.codexMoved })],
    'a codex row on a profile': [row({ sessionId: PROFILE_ID, transcriptPath: paths.codexProfile, codexHome: join(root, 'profile') })],
    'a codex row on a profile, with the default rollout': [row({ sessionId: A, transcriptPath: paths.codexA, codexHome: join(root, 'profile') })],
    'a codex row without a transcript': [row({ sessionId: A, transcriptPath: null })],
    'a claude row': [row({ engine: 'claude', sessionId: A, transcriptPath: paths.claudeA })],
    'a claude row in a moved home': [row({ engine: 'claude', sessionId: MOVED_ID, transcriptPath: paths.claudeMoved })],
    'a claude row outside its projects': [row({ engine: 'claude', sessionId: OTHER, transcriptPath: paths.outside })],
    'a claude row without a transcript': [row({ engine: 'claude', sessionId: A, transcriptPath: null })],
    'a cursor row without a transcript': [row({ engine: 'cursor', sessionId: A, transcriptPath: null })],
    'an unbound row': [row({ sessionId: '', transcriptPath: paths.codexA })],
  }
  const project = (s: RegisteredSession) => ({ agentId: s.agentId, engine: s.engine, sessionId: s.sessionId, transcriptPath: s.transcriptPath,
    projectDir: s.projectDir, codexHome: s.codexHome, bound: s.boundAt !== null })
  const logs: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
  try {
    for (const moved of [false, true]) {
      if (moved) adoptMoved(); else forgetMoved()
      for (const [name, rows] of Object.entries(scenarios)) {
        const file = join(root, 'data', 'registry.json')
        writeFileSync(file, JSON.stringify(rows), { mode: 0o644 })
        chmodSync(file, 0o644)
        logs.length = 0
        m.registry.registry.load()
        const persisted = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
        cases[`${moved ? 'moved homes' : 'default homes'} · ${name}`] = norm({
          loaded: m.registry.registry.list().map(project),
          persisted: persisted.map((saved) => ({ sessionId: saved.sessionId, transcriptPath: saved.transcriptPath, projectDir: saved.projectDir })),
          logged: logs.filter((line) => line.includes('[registry] repaired')),
        })
      }
    }
  } finally { log.mockRestore() }
  forgetMoved()
  return cases
}

// ------------------------------------------------------------------------------------- capture and handoff

async function captureCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  const session = (over: Partial<RegisteredSession>) => ({ agentId: 'a1', engine: 'claude', sessionId: A, transcriptPath: null, cwd: join(root, 'work', 'a'),
    codexHome: null, processIdentity: null, ...over }) as RegisteredSession
  adoptMoved()
  const shapes: Record<string, Partial<RegisteredSession>> = {
    'claude, no transcript': {}, 'claude, a stale transcript': { transcriptPath: join(root, 'gone.jsonl') }, 'claude, its transcript': { transcriptPath: paths.claudeA },
    'claude, in a moved home': { sessionId: MOVED_ID }, 'claude, unknown': { sessionId: OTHER },
    'codex, no transcript': { engine: 'codex' }, 'codex, on a profile': { engine: 'codex', sessionId: PROFILE_ID, codexHome: join(root, 'profile') },
    'codex, a sub-agent id': { engine: 'codex', sessionId: CHILD }, 'opencode': { engine: 'opencode' }, 'terminal': { engine: 'terminal' },
    'claude, unbound, no process': { sessionId: '' },
  }
  for (const [name, over] of Object.entries(shapes)) {
    const input = session(over), before = structuredClone(input)
    try {
      const out = await m.capture.captureResumeIdentity(input)
      cases[`capture · ${name}`] = norm({ sessionId: out.sessionId, transcriptPath: out.transcriptPath, source: out.source ?? null })
    } catch (error) {
      if (name !== 'claude, unknown' && name !== 'codex, a sub-agent id') throw error
      expect(error).toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
      expect(input).toEqual(before)
      cases[`capture · ${name}`] = norm({ held: (error as Error).message,
        retained: { sessionId: input.sessionId, transcriptPath: input.transcriptPath, source: input.source ?? null } })
    }
  }
  forgetMoved()
  // Which finder the handoff asks, per engine, and with what.
  for (const engine of ['claude', 'codex', 'pi', 'opencode', 'cursor'] as const) {
    const calls: unknown[] = []
    const discover = m.handoff.sessionDiscovery({
      findLiveSession: async (...args) => { calls.push(['findLiveSession', ...args]); return { sessionId: B, transcriptPath: paths.codexB } },
      processSession: async (...args) => { calls.push(['processSession', ...args]); return { sessionId: A, transcriptPath: paths.claudeA } },
      isLive: () => true, ownedByOther: () => false, isRecentlyDeleted: () => false,
    })
    const found = await discover(session({ engine, sessionId: '', codexHome: engine === 'codex' ? join(root, 'profile') : null,
      processIdentity: { pid: 42, startMarker: 'Thu Oct  8 10:00:00 2026', executable: engine } }))
    cases[`handoff · ${engine}`] = norm({ found, calls: calls.map((call) => (call as unknown[]).map((arg) => typeof arg === 'number' && arg > 1e12 ? '<start>' : arg)) })
  }
  return cases
}

type Sections = Record<string, Record<string, unknown>>
const PLATFORMS = ['darwin', 'linux'] as const

async function sectionsOn(platform: (typeof PLATFORMS)[number]): Promise<Sections> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  try {
    return {
      homes: await homeCases(), transcripts: transcriptCases(), find: await findCases(), continuation: await continuationCases(),
      rollouts: rolloutCases(), registry: await registryCases(), capture: await captureCases(),
    }
  } finally { Object.defineProperty(process, 'platform', real) }
}

describe('core finds sessions where it did before Claude Code and Codex declared their stores', () => {
  it('homes, transcripts, finders, continuations, rollouts, the registry\'s load, capture and handoff match the record, on darwin and linux', async () => {
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
        for (const [key, value] of Object.entries(cases)) {
          // These former successful answers are unsafe for Stop: no usable native
          // file, or a delegated rollout. Keep the historical artifact unchanged,
          // assert its exact former answer, and require the typed hold plus unchanged
          // input now. In particular, do not synthesize the child's former path.
          const captureCorrections = new Map<string, { before: unknown; retained: unknown }>([
            ['capture · claude, unknown', { before: { sessionId: OTHER, transcriptPath: null, source: null },
              retained: { sessionId: OTHER, transcriptPath: null, source: null } }],
            ['capture · codex, a sub-agent id', { before: { sessionId: CHILD, transcriptPath: norm(paths.codexChild), source: null },
              retained: { sessionId: CHILD, transcriptPath: null, source: null } }],
          ])
          const captureCorrection = section === 'capture' ? captureCorrections.get(key) : undefined
          if (captureCorrection) {
            expect(value, `${platform} · ${key} · former unsafe success`).toEqual(captureCorrection.before)
            expect(actual[section]![key], `${platform} · ${key} · retained hold`).toEqual({
              held: 'Conversation identity is held: the saved conversation file is unavailable.', retained: captureCorrection.retained,
            })
            continue
          }
          // Safety correction: an existing unusable process record is not proof of absence. Keep
          // the former artifact intact, assert its exact old answer, and name every changed case.
          const held = new Map<string, string>(['default homes', 'moved homes'].flatMap(home => [
            ...['no id', 'no start', 'unreadable'].map(name => [
              `process record · ${home} · ${name}`, 'the process record is incomplete or invalid',
            ] as const),
            [`process record · ${home} · no transcript`, 'the process names a conversation whose transcript is unavailable'] as const,
            [`process record · ${home} · another folder`, 'the current process record names a different working directory'] as const,
          ]))
          const descriptorCorrections = new Map<string, { before: unknown; reason: string }>([
            ...['a', 'c'].map(cwd => [`open files · outside the sessions · ${cwd}`, {
              before: null, reason: 'the open rollout pathname does not name the process file',
            }] as const),
            ['process files · no process table', { before: ['/dev/null'], reason: 'the native process graph is incomplete' }],
            ['process files · two children', { before: [], reason: 'more than one native child could own the conversation' }],
          ])
          const corrected = section === 'find' ? descriptorCorrections.get(key) : undefined
          const reason = corrected?.reason ?? (section === 'find' ? held.get(key) : undefined)
          if (reason) expect(value, `${platform} · ${key} · former refusal`).toEqual(corrected ? corrected.before : null)
          expect(actual[section]![key], `${platform} · ${section} · ${key}`)
            .toEqual(reason ? { threw: `Conversation identity is held: ${reason}.` } : value)
        }
      }
    }
  }, 120_000)

  it('records no machine-specific path', () => {
    const text = readFileSync(GOLDEN, 'utf8')
    expect(text).not.toContain('session-store-golden-')
    expect(text).not.toContain(root)
    expect(text).not.toMatch(/\/Users\/|\/home\/runner/)
  })
})
