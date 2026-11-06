import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { owedLines } from './inbox.js'
import { createSuperTab, type Actor, type Agent, type Assignment, type Conversation, type SuperTabState } from './model.js'
import { PM_SCHEDULE_TEXT, recordWake, SCHEDULE_SLOT_MS, scheduleRequest } from './pmSchedule.js'
import { latestProcessNote, PROCESS_NOTES } from './processNotes.js'
import { projectPulse } from './pulse.js'

// Task #3581 (anh Dee, 11-06): lamp's PM did not know the Swarm v2 process, and nothing told a running PM that a release changed
// how PMs work. A release that changes the PM's text carries a "what changed" note: each PM is woken once for it, lists it as owed
// until it confirms it, and the board shows a PM that has not. A project with no crew hears so at its PM's wakes and in its inbox.

const T = Date.UTC(2026, 10, 6, 3, 0)
const SLOT = T / SCHEDULE_SLOT_MS
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ id, name: id, contributorId: 'owner', membershipGeneration: 'g', machineId: 'mac',
  harnessId: `h-${id}`, machineOwnerId: 'owner', configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }, ...over } as unknown as Agent)
const working: Assignment = { id: 'w', agentId: 'eng', status: 'working', configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null },
  execution: { machineId: 'mac', harnessId: 'h-eng', machineOwnerId: 'owner' }, result: null, progressAt: T }
const task = (id: string, assignment: Assignment | null): Conversation => ({ id, projectId: 'p1', number: 1, title: 'Task', leadId: 'lead', agentIds: ['lead', 'eng'],
  archived: false, brief: 'Do it.', checks: [], assignment, lastMessageSequence: 1, lastActivityAt: new Date(T).toISOString() })

/** One project led by `lead`, its one task worked on (nothing for the sweep), its Engineer crew unless [crew] is false. */
function swarm(crew = true): SuperTabState {
  return {
    version: 1, id: 'tab', name: 'Swarm', ownerId: 'owner', environment: 'prod', paused: false, invitations: [],
    people: [{ id: 'owner', email: 'owner@example.com', role: 'owner', generation: 'g' }] as SuperTabState['people'],
    agents: [agent('lead'), agent('eng', crew ? { crew: { role: 'Engineer', lane: 'backend', at: T, by: 'owner' } } : {})],
    projects: [{ id: 'p1', name: 'lamp', ownerId: 'owner', leadConversationId: 'lead-p1', visibility: 'public', members: [], updateMinutes: 5 }],
    conversations: [{ ...task('lead-p1', null), number: undefined, title: 'Lead', agentIds: ['lead'] }, task('g1', working)],
  } as SuperTabState
}
const pm = (state: SuperTabState) => state.agents.find(a => a.id === 'lead')!
const project = (state: SuperTabState) => state.projects![0]!
const note = latestProcessNote()!

describe('a release\'s what-changed note for PMs', () => {
  it('pins the built-in PM schedule to the newest note: changing it needs a new note', () => {
    expect(PROCESS_NOTES.length).toBeGreaterThan(0)
    expect(createHash('sha256').update(PM_SCHEDULE_TEXT).digest('hex').slice(0, 12),
      'the built-in PM schedule changed: add a note for it in processNotes.ts, with this fingerprint').toBe(note.schedule)
    // The first note teaches the Swarm v2 process (Faye's case).
    expect(PROCESS_NOTES[0]!.text).toMatch(/crew\.add/)
  })

  it('wakes a PM once for a note it has not confirmed, and not again for it', () => {
    const state = swarm()
    const first = scheduleRequest(state, pm(state), T)!
    expect(first.jobs).toEqual(['process'])
    expect(first.draft.text).toContain(note.id)
    expect(first.draft.text).toContain(note.text)
    expect(first.draft.text).toContain('process.confirm')
    recordWake(project(state), first, T, first.draft.id)
    expect(scheduleRequest(state, pm(state), T + SCHEDULE_SLOT_MS)).toBeNull()
  })

  it('lists the note as owed at every wake and in the inbox until the PM confirms it, and the board shows it until then', () => {
    const state = swarm()
    const told = scheduleRequest(state, pm(state), T)!
    recordWake(project(state), told, T, told.draft.id)
    // A wake due for the sweep still names the note.
    state.conversations.push(task('g2', null))
    expect(scheduleRequest(state, pm(state), T + SCHEDULE_SLOT_MS)!.draft.text).toContain(note.id)
    expect(owedLines(state, project(state), T).join('\n')).toContain(note.id)
    expect(projectPulse(state, project(state), T).process).toEqual({ noteId: note.id })
    project(state).processNote = { ...project(state).processNote, confirmed: note.id }
    expect(scheduleRequest(state, pm(state), T + 2 * SCHEDULE_SLOT_MS)!.draft.text).not.toContain(note.id)
    expect(owedLines(state, project(state), T).join('\n')).not.toContain(note.id)
    expect(projectPulse(state, project(state), T).process).toBeNull()
  })
})

describe('a project with no crew', () => {
  const confirmed = (crew: boolean) => {
    const state = swarm(crew)
    project(state).processNote = { confirmed: note.id }
    return state
  }

  it('says so in its PM\'s due wake, until an agent is marked crew', () => {
    const state = confirmed(false)
    state.conversations.push(task('g2', null))
    expect(scheduleRequest(state, pm(state), T)!.draft.text).toMatch(/no crew/i)
    const marked = confirmed(true)
    marked.conversations.push(task('g2', null))
    expect(scheduleRequest(marked, pm(marked), T)!.draft.text).not.toMatch(/no crew/i)
    expect(owedLines(marked, project(marked), T)).toEqual([])
  })

  it('wakes nobody for it alone', () => {
    const state = confirmed(false)
    expect(scheduleRequest(state, pm(state), T)).toBeNull()
  })
})

describe('process.confirm', () => {
  const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
  const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
  function fixture() {
    let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
    let next = 0
    const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
      const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: T,
        contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, ...context })
      state = effects.state
      return effects
    }
    const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const add = (harnessId: string, lead: boolean) => run({ type: 'agent.add', conversationId: app.conversationId, harnessId, machineId: 'machine', name: harnessId,
      lead, configuration }).result.agentId as string
    return { run, app, pm: add('pm', true), worker: add('worker', false), get state() { return state } }
  }
  const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'owner' })

  it('records the PM\'s confirmation of a note, and refuses an unknown note or another agent', () => {
    const f = fixture()
    expect(() => f.run({ type: 'process.confirm', projectId: f.app.projectId, noteId: 'no-such-note' }, asAgent(f.pm)))
      .toThrow(expect.objectContaining({ code: 'INVALID_NOTE' }))
    expect(() => f.run({ type: 'process.confirm', projectId: f.app.projectId, noteId: note.id }, asAgent(f.worker)))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    f.run({ type: 'process.confirm', projectId: f.app.projectId, noteId: note.id }, asAgent(f.pm))
    expect(f.state.projects!.find(p => p.id === f.app.projectId)!.processNote).toMatchObject({ confirmed: note.id })
  })
})
