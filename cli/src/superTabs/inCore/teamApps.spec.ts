import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Never this Mac's own Team config or sign-in: a throwaway path, and a sign-in the test sets.
const fixtures = vi.hoisted(() => ({ configFile: '', signedIn: null as null | { kind: string } }))
vi.mock('../../team/layout.js', async (original) => ({ ...await original<object>(), get TEAM_CONFIG_FILE() { return fixtures.configFile } }))
vi.mock('../../lib/authSession.js', async (original) => ({ ...await original<object>(), readAuthSession: () => fixtures.signedIn }))
import { CONFIDENTIAL_RECORD_MAX, confidentialRecord, confidentialRecordFile, createConfidentialPurge, createTeamAppPolicy, isTeamDaemon,
  readConfidentialMarks, teamAppPolicyFor, type HeldSession, type TeamAppDeps } from './teamApps.js'

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
  const p = createTeamAppPolicy({ marks: () => marks, sessions: () => sessions.map(s => ({ lead: false, ...s })),
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
    const deps: TeamAppDeps = { marks: () => [], sessions: () => [{ agentId: 'worker', lead: false }], recorded: () => [], record: () => {} }
    deps[what] = (() => { throw new Error('EIO: disk') }) as never
    if (what === 'record') deps.marks = () => ['pm']
    return createTeamAppPolicy(deps)
  }
  it.each(['marks', 'sessions', 'recorded', 'record'] as const)('fails closed, without throwing, when %s fails', what => {
    const p = failing(what)
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'worker' } } })).toBeNull()
    expect(p.refuse('agents_list', {})).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.reply('agents_list', { agents: [{ id: 'worker' }], ok: true })).toEqual({ agents: [], ok: true })
    expect(p.watchOnly()).toBe(true)
  })
  it('reads once for frames close together, and again after', () => {
    let clock = 1_000
    const sessions = vi.fn(() => [{ agentId: 'worker', lead: false }])
    const p = createTeamAppPolicy({ marks: () => [], sessions, recorded: () => [], record: () => {}, now: () => clock })
    for (let i = 0; i < 5; i++) p.event({ type: 'text_delta', payload: { agentId: 'worker' } })
    expect(sessions).toHaveBeenCalledOnce()
    clock += 1_000
    p.event({ type: 'text_delta', payload: { agentId: 'worker' } })
    expect(sessions).toHaveBeenCalledTimes(2)
  })
})

// A Product Manager removed or replaced for good: its chats stay with the Swarm, and its session files in the Team account go.
describe('the session data of a confidential session the Swarm ended', () => {
  it('is deleted through the reviewed purge, its worktree kept', async () => {
    const purge = vi.fn(async (request: Record<string, unknown>) => request.mode === 'inspect' ? { reviewId: 'review-1' } : { ok: true })
    const ended = createConfidentialPurge({ confidential: id => id === 'pm', session: id => ({ agentId: id, sessionId: `${id}-session`, registeredAt: 5 }), purge })
    expect(await ended('pm')).toEqual({ ok: true })
    expect(purge.mock.calls.map(([r]) => r)).toEqual([
      { agentId: 'pm', sessionId: 'pm-session', createdAt: 5, mode: 'inspect' },
      { agentId: 'pm', sessionId: 'pm-session', createdAt: 5, mode: 'delete', reviewId: 'review-1', choices: { sessionData: true, worktreeData: false } }])
  })
  it('of any other session, or one no longer held, is left alone; a refused review deletes nothing', async () => {
    const purge = vi.fn(async () => ({ error: 'NOT_FOUND' }))
    const ended = createConfidentialPurge({ confidential: id => id === 'pm', session: id => id === 'pm' ? { agentId: id, sessionId: null, registeredAt: 5 } : null, purge })
    expect(await ended('worker')).toEqual({ skipped: true })
    expect(await createConfidentialPurge({ confidential: () => true, session: () => null, purge })('gone')).toEqual({ skipped: true })
    expect(await ended('pm')).toEqual({ error: 'NOT_FOUND' })
    expect(purge).toHaveBeenCalledOnce()
  })
})

describe('the Mac owner\'s apps on a Team daemon whose marks cannot be read', () => {
  it('reach no session, and type in or start nothing, and are told it waits for its Swarm, not that it holds private chats', () => {
    const p = policy(null, [{ agentId: 'worker' }])
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toEqual({ error: 'SWARM_CONFIDENTIAL',
      message: 'This computer\'s Harness Team account has not heard from its Swarm yet, so its agents are not shown here until it does.' })
    expect(p.refuse('agent_create', { engine: 'claude' })).toMatchObject({ error: 'TEAM_READ_ONLY' })
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
  it('read but unreadable, is unknown: every session then counts as confidential', () => {
    const d = dir(), file = confidentialRecordFile(d)
    confidentialRecord(file).add(['pm'])
    writeFileSync(file, '{')
    expect(confidentialRecord(file).unknown()).toBe(true)
    writeFileSync(file, '{"not":"a list"}')
    expect(confidentialRecord(file).unknown()).toBe(true)
    const p = teamAppPolicyFor(d, () => 'team-mac', () => [{ agentId: 'worker' }])
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
  })
})

describe('the policy as the core runs it', () => {
  it('reads the Swarm\'s marks and keeps a launched Product Manager in its record', () => {
    const d = dir()
    const snapshot = join(d, 'super-tabs', 'observers-team-mac.json')
    confidentialRecord(confidentialRecordFile(d)).add([])
    writeFileSync(snapshot, JSON.stringify({ machineId: 'team-mac', confidential: ['marked'] }))
    const p = teamAppPolicyFor(d, () => 'team-mac', () => [{ agentId: 'pm', sessionId: null, swarmSkill: { role: 'lead' } }, { agentId: 'marked' }, { agentId: 'worker' }])
    expect(p.refuse('terminal_open', { agentId: 'marked' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toBeNull()
    expect(confidentialRecord(confidentialRecordFile(d)).ids()).toEqual(['marked', 'pm'])
    expect(p.isConfidential('marked')).toBe(true)
  })
})
