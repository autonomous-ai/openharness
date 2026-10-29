import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Never this Mac's own Team config or sign-in: a throwaway path, and a sign-in the test sets.
const fixtures = vi.hoisted(() => ({ configFile: '', signedIn: null as null | { kind: string } }))
vi.mock('../../team/layout.js', async (original) => ({ ...await original<object>(), get TEAM_CONFIG_FILE() { return fixtures.configFile } }))
vi.mock('../../lib/authSession.js', async (original) => ({ ...await original<object>(), readAuthSession: () => fixtures.signedIn }))
import { CONFIDENTIAL_RECORD_MAX, confidentialRecord, confidentialRecordFile, createConfidentialPurge, createTeamAppPolicy, isTeamDaemon,
  pmEngineHome, readConfidentialMarks, scrubClaudeSession, sweepFor, teamAppPolicyFor, type HeldSession, type TeamAppDeps } from './teamApps.js'

// A Harness Team daemon's own account's apps: the Mac owner's (#895). The Swarm's Product Manager there reads people's
// private chats, so those apps never reach a confidential session, and while one runs there they only watch the others:
// every agent there is one macOS user, and typing in any of them, or starting one, is a shell that reads its files.

const dir = () => mkdtempSync(join(tmpdir(), 'team-apps-'))

/** A Team daemon holding [sessions], running or stopped, whose Swarm marked [marks] confidential (null: the
 *  marks could not be read), with [recorded] kept from before. */
function policy(marks: string[] | null, sessions: Array<Partial<HeldSession> & { agentId: string }>, recorded: string[] = []) {
  const kept = [...recorded]
  const record = vi.fn((ids: string[]) => { kept.push(...ids) })
  // A fresh reading for every call: these tests change nothing between calls, and the cache has its own test below.
  let clock = 0
  const p = createTeamAppPolicy({ marks: () => marks, live: () => sessions.map(s => ({ lead: false, ...s })), stopped: () => [],
    recorded: () => kept, record, now: () => (clock += 10_000) })
  return Object.assign(p, { record, kept })
}

describe('the Mac owner\'s apps on a Team daemon running a Product Manager', () => {
  const running = () => policy(['pm'], [{ agentId: 'pm', sessionId: 'pm-session' }, { agentId: 'worker', sessionId: 'worker-session' }])

  it('reach nothing of the Product Manager, by any field that names it: its agent id or its engine\'s session id', () => {
    const p = running()
    for (const type of ['terminal_open', 'terminal_info', 'message', 'question_response', 'sessions_list', 'agent_recent',
      'agent_read_file', 'agent_update', 'agent_close', 'agent_fork', 'agent_restart', 'agent_resume']) {
      expect(p.refuse(type, { agentId: 'pm' }), type).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    }
    // `session_get` names it by `sessionId`, which the history reader also matches to an agent's id.
    expect(p.refuse('session_get', { sessionId: 'pm' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.refuse('session_get', { sessionId: 'pm-session' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    for (const payload of [{ id: 'pm' }, { harnessId: 'pm' }, { parentAgentId: 'pm' }, { resumeSessionId: 'pm-session' }, { expectedSessionId: 'pm-session' },
      { agentIds: ['worker', 'pm'] }, { sessionIds: ['pm-session'] }, { agents: [{ id: 'pm' }] }, { sessions: [{ sessionId: 'pm-session' }] }]) {
      expect(p.refuse('agents_cleanup', payload), JSON.stringify(payload)).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    }
  })

  it('watch the other agents there, but type in none and start none', () => {
    const p = running()
    for (const type of ['terminal_open', 'terminal_info', 'sessions_list', 'agent_recent']) expect(p.refuse(type, { agentId: 'worker' }), type).toBeNull()
    expect(p.refuse('session_get', { sessionId: 'worker-session' })).toBeNull()
    expect(p.refuse('agents_list', {})).toBeNull()
    for (const [type, payload] of [['terminal_input', { streamId: 's' }], ['terminal_resize', { streamId: 's' }], ['terminal_scroll', { streamId: 's' }],
      ['message', { agentId: 'worker' }], ['agent_create', { engine: 'claude' }], ['agent_fork', { agentId: 'worker' }], ['shell', { op: 'open' }],
      ['fs_list_dir', { path: '/' }]] as const) {
      expect(p.refuse(type, payload), type).toMatchObject({ error: 'TEAM_READ_ONLY' })
    }
    expect(p.watchOnly()).toBe(true)
  })

  it('never hear of the Product Manager: its events are withheld and it is left out of lists', () => {
    const p = running()
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'pm' } } })).toBeNull()
    expect(p.event({ type: 'text_delta', payload: { agentId: 'pm', text: 'private' } })).toBeNull()
    expect(p.event({ type: 'turn', agentId: 'pm', payload: {} })).toBeNull()
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'worker' } } })).toEqual({ type: 'agent_synced', payload: { agent: { id: 'worker' } } })
    expect(p.event({ type: 'agents_list', payload: { agents: [{ id: 'pm' }, { id: 'worker' }] } }))
      .toEqual({ type: 'agents_list', payload: { agents: [{ id: 'worker' }] } })
    expect(p.event({ type: 'ping', payload: [1] })).toEqual({ type: 'ping', payload: [1] })
    // Only plain objects and lists are walked: a Date, a Buffer or a class instance in an answer is left as it is.
    const at = new Date(5), bytes = Buffer.from('x')
    class Row { constructor(readonly agentId: string) {} }
    const row = new Row('pm')
    const kept = p.reply('agents_list', { at, bytes, row, agents: [{ id: 'worker', at }] })
    expect(kept.at).toBe(at)
    expect(kept.bytes).toBe(bytes)
    expect(kept.row).toBe(row)
    expect((kept.agents as Array<{ at: Date }>)[0]!.at).toBe(at)
    // Rows that name no session, or a session no one holds, are kept; list items that are neither ids nor rows name nothing.
    expect(p.reply('agents_list', { agents: [null, 'row', { id: 'elsewhere' }] })).toEqual({ agents: [null, 'row', { id: 'elsewhere' }] })
    expect(p.refuse('agents_cleanup', { agentIds: [7, null, 'worker'] })).toMatchObject({ error: 'TEAM_READ_ONLY' })
    expect(p.reply('agents_list', { agents: [{ id: 'pm' }, { id: 'worker' }] })).toEqual({ agents: [{ id: 'worker' }] })
    expect(p.reply('sessions_list', { sessions: [{ sessionId: 'pm-session' }, { sessionId: 'worker-session' }] }))
      .toEqual({ sessions: [{ sessionId: 'worker-session' }] })
  })

  it('treat a Product Manager as confidential from its launch, before any roster marks it, and keep a record of it', () => {
    const p = policy([], [{ agentId: 'pm', lead: true }, { agentId: 'worker' }])
    expect(p.refuse('terminal_open', { agentId: 'pm' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.refuse('message', { agentId: 'worker' })).toMatchObject({ error: 'TEAM_READ_ONLY' })
    expect(p.record).toHaveBeenCalledWith(['pm'])
    p.refuse('terminal_open', { agentId: 'worker' })
    expect(p.record).toHaveBeenCalledOnce()
  })
})

describe('a Product Manager that stopped', () => {
  it('stays closed to the owner\'s apps by its record, and keeps the account held while it may resume', () => {
    const p = policy([], [{ agentId: 'pm', sessionId: 'pm-session' }, { agentId: 'worker' }], ['pm'])
    expect(p.refuse('session_get', { sessionId: 'pm-session' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.refuse('agent_resume', { agentId: 'pm' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.reply('agents_list', { agents: [{ id: 'pm' }, { id: 'worker' }] })).toEqual({ agents: [{ id: 'worker' }] })
    // Stopped (a crash, a restart, a limit), it may resume: the others are still only watched, and no new agent starts
    // there to read its saved session (security review 2 of #2089).
    expect(p.watchOnly()).toBe(true)
    expect(p.refuse('message', { agentId: 'worker' })).toMatchObject({ error: 'TEAM_READ_ONLY' })
    expect(p.refuse('agent_create', { engine: 'claude', cwd: '/team' })).toMatchObject({ error: 'TEAM_READ_ONLY' })
    // Search finds nothing of it: its hits and catalog rows, by agent or by session, at any depth of the answer.
    expect(p.reply('session_search', { hits: [{ agentId: 'pm', text: 'launch slips' }, { sessionId: 'pm-session' }, { agentId: 'worker', text: 'ok' }],
      catalog: { rows: [{ agentId: 'pm' }, { agentId: 'worker' }] }, total: 3 }))
      .toEqual({ hits: [{ agentId: 'worker', text: 'ok' }], catalog: { rows: [{ agentId: 'worker' }] }, total: 3 })
    expect(p.event({ type: 'search_results', payload: { results: [{ hit: { sessionId: 'pm-session' } }, { hit: { agentId: 'worker' } }] } }))
      .toEqual({ type: 'search_results', payload: { results: [{ hit: { agentId: 'worker' } }] } })
  })

  it('once its session data is deleted, leaves the account as today, still closed by its record', () => {
    const p = policy([], [{ agentId: 'worker' }], ['pm'])
    expect(p.watchOnly()).toBe(false)
    expect(p.refuse('message', { agentId: 'worker' })).toBeNull()
    expect(p.refuse('agent_resume', { agentId: 'pm' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
  })

  it('kept under a new agent id, is still found by its engine session, which the record keeps too', () => {
    const p = policy(['pm'], [{ agentId: 'pm', sessionId: 'pm-session' }])
    p.refuse('agents_list', {})
    expect(p.kept).toEqual(['pm', 'pm-session'])
    // The roster's mark went with the old agent id; the same conversation, registered again, is still closed.
    const later = policy([], [{ agentId: 'pm-again', sessionId: 'pm-session' }], p.kept)
    expect(later.refuse('session_get', { sessionId: 'pm-session' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(later.refuse('terminal_open', { agentId: 'pm-again' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
  })
})

// Security re-review of #2089: the guard runs inside the daemon's broadcast. One that throws broke that frame and every later
// one, so it fails closed instead, and reads what it needs once per burst of frames, not once per frame.
describe('the policy when what it reads fails', () => {
  const failing = (what: keyof TeamAppDeps) => {
    const deps: TeamAppDeps = { marks: () => [], live: () => [{ agentId: 'worker', lead: false }], stopped: () => [], recorded: () => [], record: () => {} }
    deps[what] = (() => { throw new Error('EIO: disk') }) as never
    if (what === 'record') deps.marks = () => ['pm']
    return createTeamAppPolicy(deps)
  }
  it.each(['marks', 'live', 'stopped', 'recorded', 'record'] as const)('fails closed, without throwing, when %s fails', what => {
    const p = failing(what)
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'worker' } } })).toBeNull()
    expect(p.refuse('agents_list', {})).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.reply('agents_list', { agents: [{ id: 'worker' }], ok: true })).toEqual({ agents: [], ok: true })
    expect(p.watchOnly()).toBe(true)
  })
  it('lists the stopped sessions on disk once for frames close together, and again after', () => {
    let clock = 1_000
    const stopped = vi.fn(() => [{ agentId: 'old', lead: false }])
    const p = createTeamAppPolicy({ marks: () => [], live: () => [{ agentId: 'worker', lead: false }], stopped, recorded: () => [], record: () => {}, now: () => clock })
    for (let i = 0; i < 5; i++) p.event({ type: 'text_delta', payload: { agentId: 'worker' } })
    expect(stopped).toHaveBeenCalledOnce()
    clock += 1_000
    p.event({ type: 'text_delta', payload: { agentId: 'worker' } })
    expect(stopped).toHaveBeenCalledTimes(2)
  })
  // Security re-check 1 of #2089: a cached reading let a Product Manager registered in the next half second, or a worker the
  // roster just marked, leak its launch and take input. What is in memory, and the marks, are read every time.
  it('refuses at once a Product Manager registered, or a session marked, right after a reading', () => {
    const live = [{ agentId: 'worker', lead: false }]
    let marks: string[] = []
    const p = createTeamAppPolicy({ marks: () => marks, live: () => live, stopped: () => [], recorded: () => [], record: () => {}, now: () => 1_000 })
    expect(p.refuse('message', { agentId: 'worker' })).toBeNull()
    live.push({ agentId: 'pm', lead: true })
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'pm' } } })).toBeNull()
    expect(p.refuse('message', { agentId: 'worker' })).toMatchObject({ error: 'TEAM_READ_ONLY' })
    live.pop()
    expect(p.refuse('message', { agentId: 'worker' })).toBeNull()
    marks = ['worker']
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
  })
})

// A Product Manager removed or replaced for good: its chats stay with the Swarm, and its session files in the Team account go
// (security re-check 2 of #2089, the Lead's option A): a Codex one's own engine home whole, a Claude Code one's files scrubbed
// from the Team user's shared home, then that home swept for its session id and folder.
describe('the session data of a confidential session the Swarm ended', () => {
  /** The Team user's home with a Claude Code PM's traces among another session's. */
  function teamHome() {
    const home = dir(), claude = join(home, '.claude'), cwd = '/Users/team/swarm/app/.worktrees/pm'
    const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
    for (const sub of ['paste-cache', `projects/${slug}/memory`, 'projects/-other', 'file-history/pm-session', 'session-env/pm-session', 'todos', 'debug', '.codex'])
      mkdirSync(join(sub === '.codex' ? home : claude, sub), { recursive: true })
    writeFileSync(join(claude, 'history.jsonl'), [
      JSON.stringify({ display: 'the launch slips a week', pastedContents: { 1: { id: 1, type: 'text', contentHash: 'abc123' } }, project: cwd, sessionId: 'pm-session' }),
      JSON.stringify({ display: 'other work', pastedContents: {}, project: '/Users/team/swarm/web', sessionId: 'other' }), ''].join('\n'))
    writeFileSync(join(claude, 'paste-cache', 'abc123.txt'), 'pasted secret')
    writeFileSync(join(claude, 'paste-cache', 'keep.txt'), 'other paste')
    writeFileSync(join(claude, 'projects', slug, 'pm-session.jsonl'), 'transcript')
    writeFileSync(join(claude, 'projects', slug, 'memory', 'MEMORY.md'), 'remembered')
    writeFileSync(join(claude, 'projects', '-other', 'other.jsonl'), 'other transcript')
    writeFileSync(join(claude, 'todos', 'pm-session-agent-pm-session.json'), '[]')
    writeFileSync(join(claude, 'todos', 'other-agent-other.json'), '[]')
    writeFileSync(join(claude, 'debug', 'pm-session.txt'), 'debug')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [cwd]: { history: ['secret'] }, '/Users/team/swarm/web': { allowedTools: [] } } }))
    return { home, claude, cwd }
  }

  it('of a Claude Code session, scrubs every file its session or folder names, and leaves the others', () => {
    const { home, claude, cwd } = teamHome()
    scrubClaudeSession(home, 'pm-session', cwd)
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe(`${JSON.stringify({ display: 'other work', pastedContents: {}, project: '/Users/team/swarm/web', sessionId: 'other' })}\n`)
    expect(existsSync(join(claude, 'paste-cache', 'abc123.txt'))).toBe(false)
    expect(existsSync(join(claude, 'paste-cache', 'keep.txt'))).toBe(true)
    expect(existsSync(join(claude, 'todos', 'other-agent-other.json'))).toBe(true)
    expect(existsSync(join(claude, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')))).toBe(false)
    expect(existsSync(join(claude, 'projects', '-other', 'other.jsonl'))).toBe(true)
    for (const gone of ['file-history/pm-session', 'session-env/pm-session', 'todos/pm-session-agent-pm-session.json', 'debug/pm-session.txt']) {
      expect(existsSync(join(claude, gone)), gone).toBe(false)
    }
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ projects: { '/Users/team/swarm/web': { allowedTools: [] } } })
    // Nothing left names it, so the sweep finds nothing.
    expect(sweepFor([claude, join(home, '.claude.json'), join(home, '.codex')], ['pm-session', cwd])).toBeNull()
  })

  it('with no folder, or an id that is no session\'s, never takes another session\'s project folder', () => {
    const { home, claude } = teamHome()
    scrubClaudeSession(home, 'pm-session', null)
    scrubClaudeSession(home, '', '/')
    expect(existsSync(join(claude, 'projects', '-other', 'other.jsonl'))).toBe(true)
    expect(existsSync(join(claude, 'file-history', 'pm-session'))).toBe(false)
    expect(existsSync(join(claude, 'paste-cache', 'abc123.txt'))).toBe(false)
  })

  it('keeps what does not name it, whatever shape: an unreadable line, a paste without a hash, a config without the folder', () => {
    const home = dir(), claude = join(home, '.claude'), cwd = '/Users/team/swarm/pm'
    mkdirSync(join(claude, 'paste-cache'), { recursive: true })
    writeFileSync(join(claude, 'paste-cache', 'keep.txt'), 'kept')
    writeFileSync(join(claude, 'history.jsonl'), ['not json, other work', 'not json, pm-session', `not json, ${cwd}`,
      JSON.stringify({ display: 'x', sessionId: 'pm-session' }), JSON.stringify({ sessionId: 'pm-session', pastedContents: { 1: { contentHash: '../keep' }, 2: null } }), ''].join('\n'))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { '/elsewhere': {} } }))
    scrubClaudeSession(home, 'pm-session', cwd)
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe('not json, other work\n')
    expect(existsSync(join(claude, 'paste-cache', 'keep.txt'))).toBe(true)
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ projects: { '/elsewhere': {} } })
    // Every line its own: the history is left empty; no todos, no config: nothing to do there.
    writeFileSync(join(claude, 'history.jsonl'), `${JSON.stringify({ sessionId: 'pm-session' })}\n`)
    rmSync(join(home, '.claude.json'))
    scrubClaudeSession(home, 'pm-session', cwd)
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe('')
    // A home where Claude Code never ran.
    expect(() => scrubClaudeSession(dir(), 'pm-session', cwd)).not.toThrow()
  })

  it('sweeps names and contents, so a place Claude Code starts writing to cannot slip through', () => {
    const { home, claude, cwd } = teamHome()
    scrubClaudeSession(home, 'pm-session', cwd)
    mkdirSync(join(claude, 'new-feature'), { recursive: true })
    writeFileSync(join(claude, 'new-feature', 'notes.json'), JSON.stringify({ cwd }))
    expect(sweepFor([claude], ['pm-session', cwd])).toBe(join(claude, 'new-feature', 'notes.json'))
    rmSync(join(claude, 'new-feature'), { recursive: true })
    mkdirSync(join(claude, 'later', 'pm-session'), { recursive: true })
    expect(sweepFor([claude], ['pm-session', cwd])).toBe(join(claude, 'later', 'pm-session'))
    // Across the boundary of a read: a mention split between two chunks is still found.
    rmSync(join(claude, 'later'), { recursive: true })
    writeFileSync(join(claude, 'big.log'), `${'x'.repeat(65_536 - 4)}pm-session`)
    expect(sweepFor([claude], ['pm-session'])).toBe(join(claude, 'big.log'))
    expect(sweepFor([join(home, 'missing')], ['pm-session'])).toBeNull()
  })

  it('gives a Codex Product Manager in a Team account its own engine home, under one root, and none to anyone else', () => {
    expect(pmEngineHome('codex', 'super-start-1', true, '/Users/team')).toBe('/Users/team/.harness-pm-homes/super-start-1/codex')
    expect(pmEngineHome('claude', 'super-start-1', true, '/Users/team')).toBeNull()
    expect(pmEngineHome('codex', 'super-start-1', false, '/Users/team')).toBeNull()
    expect(pmEngineHome('codex', '../escape', true, '/Users/team')).toBeNull()
  })

  const purge = (calls: Array<Record<string, unknown>> = []) => vi.fn(async (request: Record<string, unknown>) => {
    calls.push(request)
    return request.mode === 'inspect' ? { reviewId: 'review-1' } : { ok: true }
  })

  it('of a Claude Code session, deletes it through the reviewed purge, scrubs, sweeps, and fails while anything still names it', async () => {
    const { home, claude, cwd } = teamHome()
    const calls: Array<Record<string, unknown>> = []
    const ended = createConfidentialPurge({ confidential: id => id === 'pm', home,
      session: id => ({ agentId: id, sessionId: 'pm-session', registeredAt: 5, engine: 'claude', cwd }), purge: purge(calls) })
    expect(await ended('pm')).toEqual({ ok: true })
    expect(calls.map(c => c.mode)).toEqual(['inspect', 'delete'])
    expect(calls[1]).toMatchObject({ reviewId: 'review-1', choices: { sessionData: true, worktreeData: false } })
    expect(existsSync(join(claude, 'paste-cache', 'abc123.txt'))).toBe(false)
    writeFileSync(join(claude, 'stray.txt'), 'pm-session was here')
    expect(await ended('pm')).toEqual({ error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${join(claude, 'stray.txt')}` })
  })

  it('of a Codex session in its own engine home, deletes that home whole', async () => {
    const home = dir(), codexHome = join(home, '.harness-pm-homes', 'super-start-1', 'codex')
    mkdirSync(join(codexHome, 'sessions'), { recursive: true })
    writeFileSync(join(codexHome, 'history.jsonl'), 'the launch slips a week')
    const ended = createConfidentialPurge({ confidential: () => true, home,
      session: id => ({ agentId: id, sessionId: 'pm-session', registeredAt: 5, engine: 'codex', cwd: '/Users/team/swarm/pm', codexHome }), purge: purge() })
    expect(await ended('pm')).toEqual({ ok: true })
    expect(existsSync(join(home, '.harness-pm-homes', 'super-start-1'))).toBe(false)
  })

  it('stops at a delete the reviewed purge refused, and scrubs nothing then; a session with no id or folder is swept for neither', async () => {
    const calls: Array<Record<string, unknown>> = []
    const refusedDelete = vi.fn(async (request: Record<string, unknown>) => { calls.push(request); return request.mode === 'inspect' ? { reviewId: 'r' } : { error: 'DELETE_IN_PROGRESS' } })
    const { home, claude, cwd } = teamHome()
    const ended = createConfidentialPurge({ confidential: () => true, home, session: id => ({ agentId: id, sessionId: 'pm-session', registeredAt: 5, engine: 'claude', cwd }), purge: refusedDelete })
    expect(await ended('pm')).toEqual({ error: 'DELETE_IN_PROGRESS' })
    expect(existsSync(join(claude, 'paste-cache', 'abc123.txt'))).toBe(true)
    const bare = createConfidentialPurge({ confidential: () => true, home: dir(), session: id => ({ agentId: id, sessionId: null, registeredAt: 5, engine: 'codex', cwd: null }), purge: purge() })
    expect(await bare('pm')).toEqual({ ok: true })
  })

  it('of any other session, or one no longer held, is left alone; a refused review deletes nothing', async () => {
    const refused = vi.fn(async () => ({ error: 'NOT_FOUND' }))
    const home = dir()
    const ended = createConfidentialPurge({ confidential: id => id === 'pm', home,
      session: id => id === 'pm' ? { agentId: id, sessionId: null, registeredAt: 5, engine: 'claude', cwd: '/x' } : null, purge: refused })
    expect(await ended('worker')).toEqual({ skipped: true })
    expect(await createConfidentialPurge({ confidential: () => true, home, session: () => null, purge: refused })('gone')).toEqual({ skipped: true })
    expect(await ended('pm')).toEqual({ error: 'NOT_FOUND' })
    expect(refused).toHaveBeenCalledOnce()
  })
})

describe('the Mac owner\'s apps on a Team daemon whose marks cannot be read', () => {
  it('reach no session, and type in or start nothing, and are told it waits for its Swarm, not that it holds private chats', () => {
    const p = policy(null, [{ agentId: 'worker' }])
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toEqual({ error: 'SWARM_CONFIDENTIAL',
      message: 'This computer\'s Harness Team account has not heard from its Swarm yet, so its agents are not shown here until it does.' })
    // A start is told the same: no Product Manager is known to run there (security re-check 2 of #2089).
    expect(p.refuse('agent_create', { engine: 'claude' })).toEqual({ error: 'TEAM_READ_ONLY',
      message: 'This computer\'s Harness Team account has not heard from its Swarm yet, so its agents can be watched here but not typed in, and no agent can be started in it until it does.' })
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'worker' } } })).toBeNull()
    expect(p.watchOnly()).toBe(true)
  })
})

describe('the Mac owner\'s apps on a Team daemon running only workers', () => {
  it('behave as today', () => {
    const p = policy([], [{ agentId: 'worker' }])
    expect(p.refuse('message', { agentId: 'worker' })).toBeNull()
    expect(p.refuse('agent_create', { engine: 'claude' })).toBeNull()
    expect(p.event({ type: 'text_delta', payload: { agentId: 'worker' } })).not.toBeNull()
    expect(p.watchOnly()).toBe(false)
  })
})

describe('whether a daemon is a Team account\'s, decided at startup', () => {
  const config = (user: string) => ({ user }) as never
  it('is, when the Team config names this macOS user, or the config cannot be read, or it is signed in as a Team account', () => {
    expect(isTeamDaemon({ configExists: () => true, config: () => config('_harness-team'), user: () => '_harness-team', signedInAsTeam: () => false })).toBe(true)
    expect(isTeamDaemon({ configExists: () => true, config: () => null, user: () => 'owner', signedInAsTeam: () => false })).toBe(true)
    expect(isTeamDaemon({ configExists: () => false, signedInAsTeam: () => true })).toBe(true)
  })
  it('reads this computer\'s Team config, user and sign-in when nothing else is given', () => {
    const d = dir()
    fixtures.configFile = join(d, 'team.json')
    fixtures.signedIn = null
    expect(isTeamDaemon()).toBe(false)
    writeFileSync(fixtures.configFile, 'not json')
    expect(isTeamDaemon()).toBe(true)
    fixtures.signedIn = { kind: 'team' }
    rmSync(fixtures.configFile)
    expect(isTeamDaemon()).toBe(true)
    expect(userInfo().username).toBeTruthy()
  })
  it('is not, for the Mac owner\'s own daemon beside a Team account, or a Mac without one', () => {
    expect(isTeamDaemon({ configExists: () => true, config: () => config('_harness-team'), user: () => 'owner', signedInAsTeam: () => false })).toBe(false)
    expect(isTeamDaemon({ configExists: () => false, signedInAsTeam: () => false })).toBe(false)
  })
})

describe('the Swarm\'s confidential marks, read for the guard', () => {
  it('are the snapshot\'s, for this machine', () => {
    const file = join(dir(), 'observers.json')
    writeFileSync(file, JSON.stringify({ machineId: 'team-mac', confidential: ['pm', 7] }))
    expect(readConfidentialMarks(file, 'team-mac')).toEqual(['pm'])
  })
  it('are unknown when the snapshot is missing, unreadable, or another machine\'s', () => {
    const d = dir()
    expect(readConfidentialMarks(join(d, 'missing.json'), 'team-mac')).toBeNull()
    writeFileSync(join(d, 'bad.json'), '{')
    expect(readConfidentialMarks(join(d, 'bad.json'), 'team-mac')).toBeNull()
    writeFileSync(join(d, 'null.json'), 'null')
    expect(readConfidentialMarks(join(d, 'null.json'), 'team-mac')).toBeNull()
    writeFileSync(join(d, 'other.json'), JSON.stringify({ machineId: 'other', confidential: [] }))
    expect(readConfidentialMarks(join(d, 'other.json'), 'team-mac')).toBeNull()
  })
})

describe('the record of confidential sessions', () => {
  it('keeps what it is given across restarts, newest last, and at most its bound', () => {
    const file = confidentialRecordFile(dir())
    const first = confidentialRecord(file)
    expect([first.ids(), first.unknown()]).toEqual([[], false])
    first.add(['a', 'b'])
    first.add(['a'])
    expect(confidentialRecord(file).ids()).toEqual(['b', 'a'])
    const many = Array.from({ length: CONFIDENTIAL_RECORD_MAX + 1 }, (_, i) => `s${i}`)
    first.add(many)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(CONFIDENTIAL_RECORD_MAX)
  })
  it('with no marks snapshot yet, counts every session confidential', () => {
    const p = teamAppPolicyFor(dir(), () => 'team-mac', () => [{ agentId: 'worker' }], () => [])
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
  })
  it('read but unreadable, is unknown: every session then counts as confidential', () => {
    const d = dir(), file = confidentialRecordFile(d)
    confidentialRecord(file).add(['pm'])
    writeFileSync(file, '{')
    expect(confidentialRecord(file).unknown()).toBe(true)
    writeFileSync(file, '{"not":"a list"}')
    expect(confidentialRecord(file).unknown()).toBe(true)
    const p = teamAppPolicyFor(d, () => 'team-mac', () => [{ agentId: 'worker' }], () => [])
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
  })
})

describe('the policy as the core runs it', () => {
  it('reads the Swarm\'s marks and keeps a launched Product Manager in its record', () => {
    const d = dir()
    const snapshot = join(d, 'super-tabs', 'observers-team-mac.json')
    confidentialRecord(confidentialRecordFile(d)).add([])
    writeFileSync(snapshot, JSON.stringify({ machineId: 'team-mac', confidential: ['marked'] }))
    const p = teamAppPolicyFor(d, () => 'team-mac', () => [{ agentId: 'pm', sessionId: null, swarmSkill: { role: 'lead' } }, { agentId: 'marked' }, { agentId: 'worker' }], () => [])
    expect(p.refuse('terminal_open', { agentId: 'marked' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toBeNull()
    expect(confidentialRecord(confidentialRecordFile(d)).ids()).toEqual(['marked', 'pm'])
    expect(p.isConfidential('marked')).toBe(true)
  })
})
