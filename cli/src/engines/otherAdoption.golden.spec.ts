/**
 * What the core's adoption finds of the other engines' conversations, recorded from main before their adoption
 * readers left the core's static imports (docs/design/2026-10-08-other-engines-out-of-core.md, (o5)). Through the
 * core's own entries: the providers `externalProviders` builds from the environment, scanned by `ExternalSessions`
 * (each conversation as the index takes it, and a database engine's history read whole), and asked by
 * `OpenSessions` which process has which open, whether it is mid-turn, and how it is shown.
 *
 * Each engine's store holds conversations in the shapes its own adoption spec builds (externals/<engine>.spec.ts),
 * under a throwaway root named through the environment and pinned whatever the host sets. The process table, open
 * files and terminals are given; the clock, `process.platform` and `TZ` are pinned, file times are set, and no
 * path's length matters. Results name the root `<root>`. `RECORD_OTHER_ENGINES_GOLDEN=1` writes the fixture.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/other-adoption.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OTHER_ENGINES_GOLDEN === '1'
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const T0 = Date.parse('2026-09-20T10:00:00.000Z')
const S0 = T0 / 1000

let root = ''
let golden: Record<string, unknown> = {}
const recorded: Record<string, unknown> = {}
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'))
function check(key: string, value: unknown): void {
  const result = normalize(value)
  recorded[key] = result
  if (!RECORD) expect({ key, result }).toEqual({ key, result: golden[key] })
}

/** A file, written, whose modification time is [seconds] after T0. */
function write(path: string, content: string, seconds = 60): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  utimesSync(path, (T0 + seconds * 1000) / 1000, (T0 + seconds * 1000) / 1000)
  return path
}
const jsonl = (...lines: unknown[]) => `${lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

const ID = {
  cursor: '6c3b2a1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d', grok: '01a0438c-0e05-73b1-98f9-978079f9e0a5', copilot: '10980e65-1a47-45ff-b666-90b8705efe20',
  opencode: 'ses_person', kilo: 'ses_kiloperson', hermes: '20260920_100000_a1b2c3', hermesAcp: '3f2a9c1e-8b4d-4e6f-9a1b-2c3d4e5f6a7b',
  devin: 'brisk-otter', pi: '019fa2a5-a26d-700c-bf8c-97af19ae3d5f', piMoved: '019fa2a6-0000-7000-8000-000000000002', commandcode: '34e1385f-c18a-4f54-bf12-f8f57e151a3d',
  muse: '8a5b11e5-5eae-441c-ba9d-903608a9632e', agy: 'ae51057a-0000-4000-8000-000000000001',
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved: Record<string, string | undefined> = {}
type Modules = {
  index: typeof import('../lib/sessionSearch/externals/index.js')
  external: typeof import('../lib/sessionSearch/external.js')
}
let m: Modules
const home = (...parts: string[]) => join(root, 'home', ...parts)

/** An OpenCode or Kilo store with one conversation a person started, and its finished turn. */
function opencodeStore(Database: new (path: string, options: { readOnly: boolean }) => { exec(sql: string): void; prepare(sql: string): { all(...args: unknown[]): unknown }; close(): void }, path: string, id: string, cwd: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new Database(path, { readOnly: false })
  db.exec(`CREATE TABLE \`project\` (\`id\` text PRIMARY KEY, \`worktree\` text NOT NULL, \`vcs\` text, \`name\` text, \`icon_url\` text,
  \`icon_url_override\` text, \`icon_color\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  \`time_initialized\` integer, \`sandboxes\` text NOT NULL, \`commands\` text);
CREATE TABLE \`message\` (\`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL);
CREATE TABLE \`part\` (\`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL);
CREATE TABLE \`session\` (\`id\` text PRIMARY KEY, \`project_id\` text NOT NULL, \`workspace_id\` text, \`parent_id\` text, \`slug\` text NOT NULL,
  \`directory\` text NOT NULL, \`path\` text, \`title\` text NOT NULL, \`version\` text NOT NULL, \`share_url\` text,
  \`summary_additions\` integer, \`summary_deletions\` integer, \`summary_files\` integer, \`summary_diffs\` text,
  \`metadata\` text, \`cost\` real DEFAULT 0 NOT NULL, \`tokens_input\` integer DEFAULT 0 NOT NULL,
  \`tokens_output\` integer DEFAULT 0 NOT NULL, \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
  \`tokens_cache_read\` integer DEFAULT 0 NOT NULL, \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`revert\` text,
  \`permission\` text, \`agent\` text, \`model\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  \`time_compacting\` integer, \`time_archived\` integer);`)
  db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('p', '/', 0, 0, '[]')").all()
  const session = (sessionId: string, title: string, parent: string | null, updated: number) => db.prepare(
    'INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, permission, time_created, time_updated, time_archived)'
    + " VALUES (?, 'p', ?, 'slug', ?, ?, '1.18.31', NULL, ?, ?, NULL)",
  ).all(sessionId, parent, cwd, title, T0, updated)
  let seq = 0
  const message = (sessionId: string, data: Record<string, unknown>, at: number, parts: Array<Record<string, unknown>>) => {
    const messageId = `msg_${String(++seq).padStart(4, '0')}`
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').all(messageId, sessionId, at, at, JSON.stringify(data))
    parts.forEach((part, index) => db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
      .all(`prt_${messageId}_${index}`, messageId, sessionId, at + index, at + index, JSON.stringify(part)))
  }
  session(id, 'Fix the build', null, T0 + 10_000)
  message(id, { role: 'user', time: { created: T0 + 5_000 } }, T0 + 5_000, [{ type: 'text', text: 'please fix the build' }])
  message(id, { role: 'assistant', time: { created: T0 + 6_000, completed: T0 + 7_000 }, finish: 'stop' }, T0 + 6_000, [{ type: 'text', text: 'Done.' }, { type: 'step-finish', reason: 'stop' }])
  // A sub-agent's session, which is never offered.
  session(`${id}child`, 'A child', id, T0 + 11_000)
  db.close()
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'other-adoption-golden-')))
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  const env: Record<string, string | undefined> = {
    HOME: home(), ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), TZ: 'UTC',
    CLAUDE_PROJECTS_DIR: home('.claude', 'projects'), CODEX_HOME: home('.codex'), CLAUDE_CONFIG_DIR: undefined,
    CURSOR_HOME: home('.cursor'), CURSOR_CONFIG_DIR: undefined, CURSOR_DATA_DIR: home('.cursor-data'), XDG_CONFIG_HOME: undefined, XDG_DATA_HOME: undefined,
    GROK_HOME: home('.grok'), COPILOT_HOME: home('.copilot'), OPENCODE_DATA_DIR: home('.local', 'share', 'opencode'), OPENCODE_DB: undefined,
    KILO_DATA_DIR: home('.local', 'share', 'kilo'), KILO_DB: undefined, HERMES_HOME: home('.hermes'), DEVIN_HOME: home('.local', 'share', 'devin', 'cli'),
    PI_HOME: home('.pi'), PI_CODING_AGENT_DIR: undefined, PI_CODING_AGENT_SESSION_DIR: undefined, COMMANDCODE_HOME: home('.commandcode'),
    MUSE_HOME: home('.muse'), AGY_HOME: home('.gemini', 'antigravity-cli'),
  }
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  for (const dir of ['data', 'runtime', join('home', '.claude', 'projects'), join('home', '.codex')]) mkdirSync(join(root, dir), { recursive: true })
  const { DatabaseSync } = (process as unknown as { getBuiltinModule(name: string): unknown }).getBuiltinModule('node:sqlite') as {
    DatabaseSync: new (path: string, options?: { readOnly: boolean }) => { exec(sql: string): void; prepare(sql: string): { all(...args: unknown[]): unknown }; close(): void }
  }

  // Cursor: a chat with its metadata in its config folder, and its transcript in its data folder, a folder of its own.
  const { createHash } = await import('node:crypto')
  const chat = home('.cursor', 'chats', createHash('md5').update('/work/cursor').digest('hex'), ID.cursor)
  write(join(chat, 'store.db'), '')
  write(join(chat, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: T0, hasConversation: true, title: ' Fix the build ', updatedAtMs: T0 + 100_000, cwd: '/work/cursor' }))
  write(home('.cursor-data', 'projects', 'work-cursor', 'agent-transcripts', ID.cursor, `${ID.cursor}.jsonl`), jsonl(
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>hi</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'turn_ended', status: 'success' },
  ))
  // Grok: a session's summary, context and updates, and the list of sessions open now.
  const grokLine = (kind: string, seconds: number, extra: Record<string, unknown>) => ({
    timestamp: S0 + seconds, method: 'session/update',
    params: { sessionId: ID.grok, update: { sessionUpdate: kind, ...extra }, _meta: { eventId: 'e', agentTimestampMs: T0 + seconds * 1000 } },
  })
  const grokDir = home('.grok', 'sessions', encodeURIComponent('/work/grok'), ID.grok)
  write(join(grokDir, 'summary.json'), JSON.stringify({ info: { id: ID.grok, cwd: '/work/grok' }, generated_title: '  Fix the build  ', last_active_at: iso(200) }))
  write(join(grokDir, 'prompt_context.json'), JSON.stringify({ audience: 'primary', is_non_interactive: false, working_directory: '/work/grok' }))
  write(join(grokDir, 'updates.jsonl'), jsonl(
    grokLine('user_message_chunk', 100, { content: { type: 'text', text: 'hello' } }),
    grokLine('agent_message_chunk', 150, { content: { type: 'text', text: 'hi' } }),
  ))
  write(home('.grok', 'active_sessions.json'), JSON.stringify([{ session_id: ID.grok, pid: 102, cwd: '/work/grok', opened_at: iso(90) }]))
  // Copilot: a session's events and workspace, and the lock its process holds.
  const copilotEvent = (type: string, data: Record<string, unknown>, seconds: number) => ({ type, data, id: 'e', timestamp: iso(seconds), parentId: null })
  const copilotDir = home('.copilot', 'session-state', ID.copilot)
  write(join(copilotDir, 'events.jsonl'), jsonl(
    copilotEvent('session.start', { sessionId: ID.copilot, version: 1, producer: 'copilot-agent', context: { cwd: '/work/copilot' } }, 0),
    copilotEvent('user.message', { content: 'hello' }, 1),
    copilotEvent('assistant.turn_start', { turnId: '1' }, 2),
  ))
  write(join(copilotDir, 'workspace.yaml'), `id: ${ID.copilot}\ncwd: /work/copilot\nclient_name: cli\nname: Greeting reply\nuser_named: false\nsummary_count: 0\n`)
  write(join(copilotDir, 'inuse.103.lock'), '')
  // OpenCode and Kilo: their stores.
  opencodeStore(DatabaseSync, home('.local', 'share', 'opencode', 'opencode.db'), ID.opencode, '/work/opencode')
  opencodeStore(DatabaseSync, home('.local', 'share', 'kilo', 'kilo.db'), ID.kilo, '/work/kilo')
  // Hermes: a CLI session with a finished turn, an editor's, and a delegated one never offered.
  {
    mkdirSync(home('.hermes'), { recursive: true })
    const db = new DatabaseSync(home('.hermes', 'state.db'), { readOnly: false })
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, session_key TEXT, chat_id TEXT,
  chat_type TEXT, thread_id TEXT, model TEXT, model_config TEXT, system_prompt TEXT, parent_session_id TEXT,
  started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0,
  cwd TEXT, git_branch TEXT, git_repo_root TEXT, billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT,
  estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT, cost_source TEXT, pricing_version TEXT, title TEXT,
  api_call_count INTEGER DEFAULT 0, handoff_state TEXT, handoff_platform TEXT, handoff_error TEXT,
  compression_failure_cooldown_until REAL, compression_failure_error TEXT, rewind_count INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, "display_name" TEXT, "origin_json" TEXT, "expiry_finalized" INTEGER DEFAULT 0,
  "compression_fallback_streak" INTEGER NOT NULL DEFAULT 0, "profile_name" TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
  token_count INTEGER, finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT,
  codex_reasoning_items TEXT, codex_message_items TEXT, platform_message_id TEXT, observed INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0, "effect_disposition" TEXT, "api_content" TEXT);
CREATE TABLE compression_locks (session_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL);`)
    const session = (sessionId: string, source: string, parent: string | null, title: string | null) => db.prepare(
      'INSERT INTO sessions (id, source, model_config, parent_session_id, started_at, ended_at, end_reason, cwd, git_repo_root, title, archived)'
      + ' VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, NULL, ?, 0)').all(sessionId, source, parent, S0, '/work/hermes', title)
    const message = (sessionId: string, role: string, at: number, finish: string | null) => db.prepare(
      'INSERT INTO messages (session_id, role, content, finish_reason, timestamp) VALUES (?, ?, ?, ?, ?)').all(sessionId, role, role === 'user' ? 'please look at the tests' : 'ok', finish, at)
    session(ID.hermes, 'cli', null, 'Repl work')
    message(ID.hermes, 'user', S0 + 10, null)
    message(ID.hermes, 'assistant', S0 + 10.5, 'stop')
    session(ID.hermesAcp, 'acp', null, null)
    message(ID.hermesAcp, 'user', S0 + 20, null)
    session('20260920_100100_d4e5f6', 'subagent', ID.hermes, null)
    message('20260920_100100_d4e5f6', 'user', S0 + 30, null)
    db.close()
  }
  // Devin: its store, a session with a turn.
  {
    const devinHome = home('.local', 'share', 'devin', 'cli')
    mkdirSync(devinHome, { recursive: true })
    const db = new DatabaseSync(join(devinHome, 'sessions.db'), { readOnly: false })
    db.exec(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL,
  agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT,
  main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0, workspace_dirs TEXT, metadata TEXT);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER,
  chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id));
CREATE TABLE tool_call_state (session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT);
CREATE TABLE subagent_heads (session_id TEXT, agent_id TEXT, chain_node_id INTEGER);`)
    db.prepare('INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, hidden)'
      + " VALUES (?, '/work/devin', 'cloud', 'swe-1', 'normal', ?, ?, 'Fix the tests', 0)").all(ID.devin, S0, S0 + 50)
    const node = (n: number, message: Record<string, unknown>) => db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)')
      .all(ID.devin, n, JSON.stringify(message), S0 + n)
    node(1, { role: 'user', content: [{ type: 'text', text: 'fix the tests' }] })
    node(2, { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }], stop_reason: 'end_turn' })
    db.close()
  }
  // Pi: a session file in its folder for the cwd.
  const piHeader = { type: 'session', version: 3, id: ID.pi, timestamp: iso(0), cwd: '/work/pi' }
  const piMessage = (role: string, seconds: number) => ({ type: 'message', id: `m${seconds}`, parentId: null, timestamp: iso(seconds), message: { role, content: [{ type: 'text', text: 'words' }] } })
  write(home('.pi', 'agent', 'sessions', '--work-pi--', `2026-09-20T10-00-00-000Z_${ID.pi}.jsonl`), jsonl(piHeader, piMessage('user', 1), piMessage('assistant', 2)))
  // …and one in a sessions folder the person moved (`PI_CODING_AGENT_SESSION_DIR`), which Pi keeps flat.
  write(home('pi-moved', `2026-09-20T10-00-00-000Z_${ID.piMoved}.jsonl`), jsonl({ ...piHeader, id: ID.piMoved, cwd: '/work/pi-moved' }, piMessage('user', 3)))
  // Command Code: a v3 transcript in its project folder.
  const ccMessage = (role: string, seconds: number) => ({ type: 'message', id: `m${seconds}`, parentId: null, timestamp: iso(seconds), message: { role, content: [{ type: 'text', text: 'words' }], meta: { source: role === 'user' ? 'user' : 'model' } } })
  write(home('.commandcode', 'projects', 'work-commandcode', `${ID.commandcode}.jsonl`), jsonl(
    { type: 'session', version: 3, id: ID.commandcode, timestamp: iso(0), cwd: '/work/commandcode' }, ccMessage('user', 1), ccMessage('assistant', 2),
  ))
  // Muse: a log whose run started and finished.
  let sequence = 0
  const museRecord = (seconds: number, payload: Record<string, unknown>) => JSON.stringify({
    schema_version: 1, id: `r-${++sequence}`, stream: { kind: 'session', id: ID.muse }, sequence, recorded_at: (T0 + seconds * 1000) * 1000,
    record_type: 'event', durability: 'durable', causation_id: null, payload_type: 'runtime.session', payload_schema_version: 1, payload,
  })
  write(home('.muse', 'sessions', '2026', '09', '20', ID.muse, 'session.jsonl'), jsonl(
    museRecord(0, { kind: 'metadata', record: { workspace_root: '/work/muse', provider_id: 'meta', build: { sha: 'x', semver: '0.1.0' } } }),
    museRecord(1, { kind: 'run', run_id: 'run-1', event: { kind: 'started', prompt: 'hi' } }),
    museRecord(5, { kind: 'run', run_id: 'run-1', event: { kind: 'completed' } }),
  ))
  // agy: a conversation's transcript, its presence lock, and where it was asked from.
  write(home('.gemini', 'antigravity-cli', 'brain', ID.agy, '.system_generated', 'logs', 'transcript_full.jsonl'), jsonl(
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(0), content: 'words' },
    { step_index: 1, source: 'USER_EXPLICIT', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(1), content: 'words' },
  ))
  write(home('.gemini', 'antigravity-cli', 'presence', `${ID.agy}.lock`), '')
  write(home('.gemini', 'antigravity-cli', 'history.jsonl'), jsonl({ display: 'first', timestamp: T0, workspace: '/work/agy', conversationId: ID.agy }))

  vi.resetModules()
  m = {
    index: await import('../lib/sessionSearch/externals/index.js'),
    external: await import('../lib/sessionSearch/external.js'),
  }
  golden = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>
})

afterAll(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) rmSync(root, { recursive: true, force: true })
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(recorded, null, 1) + '\n')
})

describe('what the core\'s adoption finds of the other engines\' conversations', () => {
  it('lists each engine\'s conversations, and reads a database engine\'s history whole', async () => {
    const providers = m.index.externalProviders(m.index.externalPaths(process.env))
    check('providers', providers.map((provider) => [provider.engine, typeof provider.owners, typeof provider.busy]))
    const sessions = new m.external.ExternalSessions({ providers, excluded: [join(root, 'data')], log: () => {} })
    const found = await sessions.scan()
    const listed: unknown[] = []
    for (const session of found) {
      const history = session.readHistory ? await session.readHistory() : null
      listed.push({ ...session, readHistory: history && history.map((event) => event.type) })
    }
    check('scan', listed.filter((session) => !['claude', 'codex'].includes((session as { engine: string }).engine)))
    check('aliases', ['20260920_100100_d4e5f6', ID.hermes].map((id) => sessions.get(id)?.sessionId ?? null))
    // Pi's sessions in the folder the person moved them to, where its environment says.
    const moved = m.index.externalProviders(m.index.externalPaths({ ...process.env, PI_CODING_AGENT_SESSION_DIR: home('pi-moved') }))
    const movedSessions = await new m.external.ExternalSessions({ providers: moved, excluded: [join(root, 'data')], log: () => {} }).scan()
    check('scan · Pi moved', movedSessions.filter((session) => session.engine === 'pi'))
  }, 60_000)

  it('says which process has which conversation open, whether it is mid-turn, and how it is shown', async () => {
    const providers = m.index.externalProviders(m.index.externalPaths(process.env))
    const row = (pid: number, executable: string, args = executable) => ({ pid, ppid: 1, executable, args })
    const rows = [
      row(101, 'cursor-agent', `cursor-agent --resume ${ID.cursor}`), row(102, 'grok'), row(103, 'copilot'),
      row(104, 'opencode', `opencode --session ${ID.opencode}`), row(105, 'kilo', `kilo -s ${ID.kilo}`),
      row(106, 'python3', `python3 /opt/hermes-agent/hermes --resume ${ID.hermes}`), row(107, 'devin', `devin -r ${ID.devin}`),
      row(108, 'pi', `pi --session ${ID.pi}`), row(109, 'cmd', `cmd --resume ${ID.commandcode}`),
      row(110, 'muse-bin-1.2.3', `muse-bin-1.2.3 resume ${ID.muse}`), row(111, 'agy'),
      row(112, 'opencode', 'opencode serve --session ses_served'),
    ]
    const files = new Map<number, string[]>([
      [101, [join(home('.cursor', 'chats'), (await import('node:crypto')).createHash('md5').update('/work/cursor').digest('hex'), ID.cursor, 'store.db')]],
      [111, [home('.gemini', 'antigravity-cli', 'presence', `${ID.agy}.lock`)]],
    ])
    const view = {
      list: async () => rows,
      openFiles: async (pids: readonly number[]) => new Map(pids.flatMap((pid) => files.has(pid) ? [[pid, files.get(pid)!] as [number, string[]]] : [])),
      cwds: async () => new Map(), openFilesOf: async () => new Map<number, string[]>(),
      alive: () => true,
    }
    const scanned = new m.external.ExternalSessions({ providers, excluded: [join(root, 'data')], log: () => {} })
    await scanned.scan()
    const open = new m.external.OpenSessions({
      providers, view: () => view, now: () => NOW, log: () => {},
      ttys: async (pids) => new Map(pids.map((pid) => [pid, pid === 107 ? null : `/dev/ttys${String(pid).padStart(3, '0')}`])),
      harnessTtys: async () => new Set(['/dev/ttys104']),
    })
    const shown = [...(await open.fresh())].sort(([a], [b]) => a.localeCompare(b))
    const owners: unknown[] = []
    for (const [sessionId] of shown) {
      const owner = await open.owner(sessionId)
      owners.push([sessionId, owner, owner ? await open.busy(owner) : null, await open.working(sessionId)])
    }
    check('open', shown)
    check('owners', owners)
  }, 60_000)

  it('keeps Kilo history and ownership in its own store when it is the only reader asked', async () => {
    const provider = m.index.externalProviders(m.index.externalPaths(process.env)).find(row => row.engine === 'kilo')!
    const sessions = await new m.external.ExternalSessions({ providers: [provider], excluded: [], log: () => {} }).scan()
    const owners = await provider.owners!({
      list: async () => [
        { pid: 105, ppid: 1, executable: 'kilo', args: `kilo -s ${ID.kilo}` },
        { pid: 104, ppid: 1, executable: 'opencode', args: `opencode -s ${ID.opencode}` },
      ],
      openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map(), alive: () => true,
    })
    check('Kilo alone', {
      sessions: await Promise.all(sessions.map(async session => ({ ...session, readHistory: await session.readHistory?.() }))),
      owners, busy: await Promise.all(owners.map(owner => provider.busy!(owner))),
    })
  })

  it('has a recorded outcome for every case, and no other', () => {
    if (RECORD) return
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(golden).sort())
  })
})
