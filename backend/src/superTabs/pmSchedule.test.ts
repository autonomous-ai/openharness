import { describe, expect, it } from 'vitest'
import type { Agent, Assignment, Conversation, SuperTabState, WorkStatus } from './model.js'
import { BUILT_IN_HEADING, PM_SCHEDULE_TEXT, recordWake, SCHEDULE_SLOT_MS, scheduleMessageId, scheduleRequest, scheduleSlot } from './pmSchedule.js'
import { ARCHIVE_QUIET_MS } from './tidy.js'

/** 10:00 on 4 November in Vietnam (03:00 UTC): a slot's first millisecond. */
const T = Date.UTC(2026, 10, 4, 3, 0)
const SLOT = T / SCHEDULE_SLOT_MS

const agent = (id: string): Agent => ({ id, name: id, contributorId: 'owner', membershipGeneration: 'g', machineId: 'mac', harnessId: `h-${id}`,
  machineOwnerId: 'owner', configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } } as unknown as Agent)
const work = (status: WorkStatus, over: Partial<Assignment> = {}): Assignment => ({ id: `w-${status}`, agentId: 'eng', status,
  configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null },
  execution: { machineId: 'mac', harnessId: 'h-eng', machineOwnerId: 'owner' }, result: null, progressAt: T, ...over })
const task = (number: number, assignment: Assignment | null, over: Partial<Conversation> = {}): Conversation => ({ id: `g${number}`,
  projectId: 'p1', number, title: `Task ${number}`, leadId: 'lead', agentIds: ['lead', 'eng'], archived: false, brief: 'Do it.', checks: [],
  assignment, lastMessageSequence: 1, lastActivityAt: new Date(T).toISOString(), ...over })

/** One project whose coordinator is `lead`, with the given work groups. */
function swarm(...groups: Conversation[]): SuperTabState {
  return {
    version: 1, id: 'tab', name: 'Swarm', ownerId: 'owner', environment: 'prod', paused: false, invitations: [],
    people: [{ id: 'owner', email: 'owner@example.com', role: 'owner', generation: 'g' }] as SuperTabState['people'],
    agents: [agent('lead'), agent('eng')],
    projects: [{ id: 'p1', name: 'lampOS', ownerId: 'owner', leadConversationId: 'lead-p1', visibility: 'public', members: [], updateMinutes: 5 }],
    conversations: [{ ...task(0, null), id: 'lead-p1', number: undefined, title: 'Lead' }, ...groups],
  } as SuperTabState
}
const lead = (state: SuperTabState) => state.agents.find(a => a.id === 'lead')!
const wake = (state: SuperTabState, now = T) => scheduleRequest(state, lead(state), now)

describe('the built-in PM schedule', () => {
  it('is due once per slot, from the slot\'s first millisecond', () => {
    const state = swarm(task(1, null))
    expect(scheduleSlot(T)).toBe(SLOT)
    expect(wake(state)).toMatchObject({ slot: SLOT, draft: { id: scheduleMessageId('tab', 'p1', SLOT) } })
    state.projects![0]!.schedule = { lastSlot: SLOT }
    expect(wake(state, T + SCHEDULE_SLOT_MS - 1)).toBeNull()
    expect(wake(state, T + SCHEDULE_SLOT_MS)).toMatchObject({ slot: SLOT + 1 })
  })

  it('records nothing and sends nothing when there is nothing to sweep, so the slot stays due', () => {
    const state = swarm(task(1, work('working')))
    expect(wake(state)).toBeNull()
    // Something to sweep later in the same slot still wakes the coordinator once.
    state.conversations.push(task(2, null))
    expect(wake(state)).toMatchObject({ slot: SLOT, draft: { id: scheduleMessageId('tab', 'p1', SLOT) } })
  })

  it.each([
    ['an unassigned task', task(1, null)],
    ['a task whose agent is lost', task(1, work('lost', { lost: { reason: 'offline', at: T } }))],
    ['a task waiting on a person', task(1, work('needs_human'))],
    ['a stuck task', task(1, work('blocked'))],
    ['a finished task with no pull request, quiet long enough', task(1, work('done'), { lastActivityAt: new Date(T - ARCHIVE_QUIET_MS).toISOString() })],
  ])('wakes the coordinator for %s', (_name, group) => {
    expect(wake(swarm(group))!.draft).toMatchObject({ source: { kind: 'schedule-request' } })
  })

  it.each([
    ['a finished task with a pull request', task(1, work('done'), { lastActivityAt: new Date(T - ARCHIVE_QUIET_MS).toISOString(),
      pullRequestUrls: ['https://github.com/example/lampos/pull/1'] })],
    ['a finished task quiet for less than the archive wait', task(1, work('done'), { lastActivityAt: new Date(T - ARCHIVE_QUIET_MS + 1).toISOString() })],
    ['a step with no agent', task(2, null, { reviewOf: 'g9', step: 'Review' })],
    ['an archived task', task(1, null, { archived: true })],
  ])('does not wake it for %s', (_name, group) => {
    expect(wake(swarm(group))).toBeNull()
  })

  it('does not wake it for a finished group the Swarm would not archive either: tidying off, or a step whose task is still open', () => {
    const quiet = { lastActivityAt: new Date(T - ARCHIVE_QUIET_MS).toISOString() }
    const off = swarm(task(1, work('done'), quiet))
    off.tidy = false
    expect(wake(off)).toBeNull()
    const step = swarm(task(1, work('working')), task(2, work('done'), { ...quiet, reviewOf: 'g1', step: 'Plan' }))
    expect(wake(step)).toBeNull()
  })

  it('sends nothing and records nothing in a paused Swarm, or for an agent that leads nothing', () => {
    const state = swarm(task(1, null))
    expect(scheduleRequest(state, state.agents.find(a => a.id === 'eng')!, T)).toBeNull()
    state.paused = true
    expect(wake(state)).toBeNull()
  })

  it('names the time in the project\'s zone, to the coordinator alone', () => {
    const draft = wake(swarm(task(1, null)))!.draft!
    expect(draft.text.startsWith('Built-in schedule, 10:00 (Asia/Ho_Chi_Minh). This is a scheduled request from the Swarm, not a new task.')).toBe(true)
    expect(draft.text).toContain('Skip a job your project\'s instructions schedule on their own clock.')
    // On its own, for a coordinator whose CLI predates the built-in section.
    expect(draft.text).toContain('Set no timer of your own')
    expect(draft).toMatchObject({ conversationId: 'lead-p1', recipients: ['lead'], source: { kind: 'schedule-request', projectId: 'p1', slot: SLOT } })
  })

  it('says in its own section that the Swarm runs it and that it is never saved', () => {
    expect(PM_SCHEDULE_TEXT.startsWith(`${BUILT_IN_HEADING}\n`)).toBe(true)
    expect(PM_SCHEDULE_TEXT).toContain('Set no timer of your own')
    expect(PM_SCHEDULE_TEXT).toContain('never save it into the document')
  })

  // Task #3022 (Ken, 11-05): lamp's PM was taught the same rule three times and forgot it again within the hour.
  it('tells the coordinator to save what a person teaches it in the same turn, naming who said it, without asking', () => {
    const taught = PM_SCHEDULE_TEXT.slice(PM_SCHEDULE_TEXT.indexOf('What people teach you')).replace(/\s+/g, ' ')
    expect(PM_SCHEDULE_TEXT).toContain('What people teach you')
    for (const words of ['from now on', 'always', 'don\'t', 'I told you', 'again you forgot', 'remember']) expect(taught).toContain(`"${words}"`)
    expect(taught).toContain('save it into the instructions in that same turn, before you answer')
    expect(taught).toContain('naming who said it')
    expect(taught).toContain('Don\'t ask whether to save it')
  })

  // River, 11-05, from a case on lamp: a PM asked directly to write code wrote it, and followed the repository's agent files over
  // the project's instructions.
  it('tells the coordinator it never writes code itself, and that the project\'s instructions outrank the repository\'s agent files', () => {
    const text = PM_SCHEDULE_TEXT.replace(/\s+/g, ' ')
    expect(text).toContain('You never write code yourself, even when a person asks you directly: open a task and give it to an Engineer.')
    expect(text).toContain('The project\'s instructions outrank the repository\'s own agent files (CLAUDE.md, AGENTS.md)')
    expect(text).toContain('follow the instructions and say so')
  })

  // Ken, 11-05: River's own script started Poplar on Gray.local at 14:01 and waited in the foreground until the start failed
  // at 14:09; for 6.5 minutes no person's message was read. The CLI's start returns in about 20 s; the wait was the PM's.
  it('tells the coordinator to run a start in the background and keep answering people', () => {
    const text = PM_SCHEDULE_TEXT.replace(/\s+/g, ' ')
    expect(text).toContain('while a command runs you read no one\'s messages')
    expect(text).toContain('When your tool runs commands in the background (Claude Code: run_in_background)')
    // Only resume finishes a pending start, and an assignment before it settles is refused (START_PENDING): a PM without
    // background commands needs the command by name, once a turn (review of #3121).
    expect(text).toContain('on your next turn run `resume START_ID` once')
    expect(text).toContain('Never repeat `resume` in a loop in the foreground')
  })

  // Ken, 11-05: River ran 1,389 Swarm commands in a day in its own session, and long reads fill its context until it is
  // compacted and the instructions fall out of it.
  it('tells the coordinator to hand long reading to a background subagent, which never writes code or decides', () => {
    const text = PM_SCHEDULE_TEXT.replace(/\s+/g, ' ')
    expect(text).toContain('to a subagent that runs in the background')
    expect(text).toContain('take back only its summary')
    expect(text).toContain('A subagent never writes code and never decides')
  })

  it('keeps the instructions short, and counts what a person had to repeat in the nightly reflection', () => {
    expect(PM_SCHEDULE_TEXT).toContain('past 150 lines')
    expect(PM_SCHEDULE_TEXT).toContain('is a repeat')
    expect(PM_SCHEDULE_TEXT).toContain('nightly reflection')
  })
})

// Task #3022, as River amended it after Ken's proposal (11-05): lamp's PM forgot a rule 15 to 60 minutes after it was taught,
// so the 30-minute wake also asks the coordinator to catch what people taught it, and once a day to tidy the instructions.
describe('the built-in wake\'s jobs for what people teach the coordinator', () => {
  const HOUR = 60 * 60_000
  const chat = (state: SuperTabState) => state.conversations.find(c => c.id === 'lead-p1')!
  /** Nothing to sweep: the one task has its agent working. */
  const busy = () => swarm(task(1, work('working')))
  const project = (state: SuperTabState) => state.projects![0]!

  it('wakes the coordinator when a person wrote to it since the last wake, with nothing to sweep', () => {
    const state = busy()
    chat(state).heardAt = T - 1
    const scheduled = wake(state)!
    expect(scheduled.jobs).toEqual(['heard'])
    expect(scheduled.draft.text).toContain('- What people taught you:')
    expect(scheduled.draft.text).not.toContain('- Open-task sweep:')
  })

  it('wakes it when a person wrote to it in another chat of the project', () => {
    const state = busy()
    state.conversations.find(c => c.id === 'g1')!.heardAt = T - 1
    expect(wake(state)!.jobs).toEqual(['heard'])
    // Another project's chat is not this coordinator's.
    const other = busy()
    other.conversations.push({ ...task(9, null, { projectId: 'p2', archived: true }), heardAt: T - 1 })
    other.conversations.push({ ...task(8, work('working'), { projectId: 'p2' }), heardAt: T - 1 })
    expect(wake(other)).toBeNull()
  })

  it('does not wake it when nobody wrote to it since the last wake', () => {
    const state = busy()
    expect(wake(state)).toBeNull()
    chat(state).heardAt = T - HOUR
    project(state).schedule = { lastSlot: SLOT - 1, heardAt: T - HOUR }
    expect(wake(state)).toBeNull()
  })

  it('names every job due in one wake', () => {
    const state = swarm(task(1, null))
    chat(state).heardAt = T - 1
    project(state).instructionsRevision = 3
    const scheduled = wake(state)!
    expect(scheduled.jobs).toEqual(['sweep', 'heard', 'tidy'])
    for (const line of ['- Open-task sweep:', '- What people taught you:', '- Daily tidy:']) expect(scheduled.draft.text).toContain(line)
  })

  it('tidies once a local day, and only when the instructions changed since the last tidy', () => {
    const state = busy()
    // A project's first document (revision 1) has changed from nothing worth tidying.
    project(state).instructionsRevision = 1
    expect(wake(state)).toBeNull()
    project(state).instructionsRevision = 3
    const first = wake(state)!
    expect(first.jobs).toEqual(['tidy'])
    recordWake(project(state), first, T, first.draft.id)
    expect(project(state).schedule).toMatchObject({ lastSlot: SLOT, tidiedOn: '2026-11-04', tidiedRevision: 3 })
    // A new revision the same day waits for the next day.
    project(state).instructionsRevision = 4
    expect(wake(state, T + SCHEDULE_SLOT_MS)).toBeNull()
    // 00:00 on 5 November in Vietnam.
    const midnight = Date.UTC(2026, 10, 4, 17, 0)
    expect(wake(state, midnight)!.jobs).toEqual(['tidy'])
    // No change since the last tidy: no tidy the next day either.
    project(state).instructionsRevision = 3
    expect(wake(state, midnight)).toBeNull()
  })

  it('records what a written wake carried, and only the slot of one held back, so its jobs stay due', () => {
    const state = busy()
    chat(state).heardAt = T - 1
    project(state).instructionsRevision = 2
    const held = wake(state)!
    recordWake(project(state), held, T, null)
    expect(project(state).schedule).toEqual({ lastSlot: SLOT })
    expect(wake(state, T + SCHEDULE_SLOT_MS)!.jobs).toEqual(['heard', 'tidy'])
    const next = wake(state, T + SCHEDULE_SLOT_MS)!
    recordWake(project(state), next, T + SCHEDULE_SLOT_MS, 'wake-2')
    expect(project(state).schedule).toEqual({ lastSlot: SLOT + 1, wakeId: 'wake-2', heardAt: T + SCHEDULE_SLOT_MS, tidiedOn: '2026-11-04', tidiedRevision: 2 })
    expect(wake(state, T + 2 * SCHEDULE_SLOT_MS)).toBeNull()
  })

  it('says in the built-in section when the Swarm wakes it for them', () => {
    expect(PM_SCHEDULE_TEXT).toContain('when a person wrote to you since the last wake')
    expect(PM_SCHEDULE_TEXT).toContain('Once a day, when the instructions changed')
  })
})
