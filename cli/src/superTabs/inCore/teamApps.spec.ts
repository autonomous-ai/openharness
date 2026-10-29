import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTeamAppPolicy, readConfidentialMarks } from './teamApps.js'

// A Harness Team daemon's own account's apps: the Mac owner's (#895). The Swarm's Product Manager there reads people's
// private chats, so those apps never reach a confidential session, and while one runs there they only watch the others:
// every agent there is one macOS user, and typing in any of them, or starting one, is a shell that reads its files.

/** A Team daemon running [sessions], whose Swarm marked [marks] confidential (null: the marks could not be read). */
function policy(marks: string[] | null, sessions: Array<{ agentId: string; lead?: boolean }>, team = true) {
  return createTeamAppPolicy({ team: () => team, marks: () => marks, sessions: () => sessions.map(s => ({ lead: false, ...s })) })
}

describe('the Mac owner\'s apps on a Team daemon running a Product Manager', () => {
  const running = () => policy(['pm'], [{ agentId: 'pm' }, { agentId: 'worker' }])

  it('reach nothing of the Product Manager: no terminal, screen, typing, history or file', () => {
    const p = running()
    for (const type of ['terminal_open', 'terminal_info', 'message', 'question_response', 'sessions_list', 'session_get', 'agent_recent',
      'agent_read_file', 'agent_update', 'agent_close', 'agent_fork', 'agent_restart', 'agent_resume']) {
      expect(p.refuse(type, { agentId: 'pm' }), type).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    }
  })

  it('watch the other agents there, but type in none and start none', () => {
    const p = running()
    for (const type of ['terminal_open', 'terminal_info', 'sessions_list', 'session_get', 'agent_recent']) {
      expect(p.refuse(type, { agentId: 'worker' }), type).toBeNull()
    }
    expect(p.refuse('agents_list', {})).toBeNull()
    for (const [type, payload] of [['terminal_input', { streamId: 's' }], ['terminal_paste', { streamId: 's' }], ['message', { agentId: 'worker' }],
      ['agent_create', { engine: 'claude' }], ['agent_fork', { agentId: 'worker' }], ['agent_restart', { agentId: 'worker' }], ['shell', { op: 'open' }],
      ['fs_list_dir', { path: '/' }]] as const) {
      expect(p.refuse(type, payload), type).toMatchObject({ error: 'TEAM_READ_ONLY' })
    }
  })

  it('never hear of the Product Manager: its events are withheld and it is left out of lists', () => {
    const p = running()
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'pm' } } })).toBeNull()
    expect(p.event({ type: 'text_delta', payload: { agentId: 'pm', text: 'private' } })).toBeNull()
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'worker' } } })).toEqual({ type: 'agent_synced', payload: { agent: { id: 'worker' } } })
    expect(p.event({ type: 'agents_list', payload: { agents: [{ id: 'pm' }, { id: 'worker' }] } }))
      .toEqual({ type: 'agents_list', payload: { agents: [{ id: 'worker' }] } })
    expect(p.reply('agents_list', { agents: [{ id: 'pm' }, { id: 'worker' }] })).toEqual({ agents: [{ id: 'worker' }] })
  })

  it('treat a Product Manager as confidential from its launch, before any roster marks it', () => {
    const p = policy([], [{ agentId: 'pm', lead: true }, { agentId: 'worker' }])
    expect(p.refuse('terminal_open', { agentId: 'pm' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.refuse('message', { agentId: 'worker' })).toMatchObject({ error: 'TEAM_READ_ONLY' })
  })
})

describe('the Mac owner\'s apps on a Team daemon whose marks cannot be read', () => {
  it('reach no Swarm session, and type in or start nothing', () => {
    const p = policy(null, [{ agentId: 'worker' }])
    expect(p.refuse('terminal_open', { agentId: 'worker' })).toMatchObject({ error: 'SWARM_CONFIDENTIAL' })
    expect(p.refuse('agent_create', { engine: 'claude' })).toMatchObject({ error: 'TEAM_READ_ONLY' })
    expect(p.event({ type: 'agent_synced', payload: { agent: { id: 'worker' } } })).toBeNull()
  })
})

describe('the Mac owner\'s apps where no confidential session runs', () => {
  it('on a Team daemon running only workers, behave as today', () => {
    const p = policy([], [{ agentId: 'worker' }])
    expect(p.refuse('message', { agentId: 'worker' })).toBeNull()
    expect(p.refuse('agent_create', { engine: 'claude' })).toBeNull()
    expect(p.event({ type: 'text_delta', payload: { agentId: 'worker' } })).not.toBeNull()
  })

  it('on a daemon that is not a Team account, nothing changes, whatever its marks', () => {
    const p = policy(null, [{ agentId: 'pm', lead: true }], false)
    expect(p.refuse('terminal_open', { agentId: 'pm' })).toBeNull()
    expect(p.event({ type: 'text_delta', payload: { agentId: 'pm' } })).not.toBeNull()
  })
})

describe('the Swarm\'s confidential marks, read for the guard', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'team-apps-'))

  it('are the snapshot\'s, for this machine', () => {
    const file = join(dir(), 'observers.json')
    writeFileSync(file, JSON.stringify({ machineId: 'team-mac', confidential: ['pm'] }))
    expect(readConfidentialMarks(file, 'team-mac')).toEqual(['pm'])
  })

  it('are unknown when the snapshot is missing, unreadable, or another machine\'s', () => {
    const d = dir()
    expect(readConfidentialMarks(join(d, 'missing.json'), 'team-mac')).toBeNull()
    writeFileSync(join(d, 'bad.json'), '{')
    expect(readConfidentialMarks(join(d, 'bad.json'), 'team-mac')).toBeNull()
    writeFileSync(join(d, 'other.json'), JSON.stringify({ machineId: 'other', confidential: [] }))
    expect(readConfidentialMarks(join(d, 'other.json'), 'team-mac')).toBeNull()
  })
})
