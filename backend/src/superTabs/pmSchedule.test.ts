import { describe, expect, it } from 'vitest'
import type { Agent, Assignment, Conversation, SuperTabState, WorkStatus } from './model.js'
import { BUILT_IN_HEADING, PM_SCHEDULE_TEXT, SCHEDULE_SLOT_MS, scheduleMessageId, scheduleRequest, scheduleSlot } from './pmSchedule.js'
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

  it('records the slot with no message when there is nothing to sweep', () => {
    expect(wake(swarm(task(1, work('working'))))).toEqual({ slot: SLOT, draft: null })
  })

  it.each([
    ['an unassigned task', task(1, null)],
    ['a task whose agent is lost', task(1, work('lost', { lost: { reason: 'offline', at: T } }))],
    ['a task waiting on a person', task(1, work('needs_human'))],
    ['a stuck task', task(1, work('blocked'))],
    ['a finished task with no pull request, quiet long enough', task(1, work('done'), { lastActivityAt: new Date(T - ARCHIVE_QUIET_MS).toISOString() })],
  ])('wakes the coordinator for %s', (_name, group) => {
    expect(wake(swarm(group))!.draft).not.toBeNull()
  })

  it.each([
    ['a finished task with a pull request', task(1, work('done'), { lastActivityAt: new Date(T - ARCHIVE_QUIET_MS).toISOString(),
      pullRequestUrls: ['https://github.com/example/lampos/pull/1'] })],
    ['a finished task quiet for less than the archive wait', task(1, work('done'), { lastActivityAt: new Date(T - ARCHIVE_QUIET_MS + 1).toISOString() })],
    ['a step with no agent', task(2, null, { reviewOf: 'g9', step: 'Review' })],
    ['an archived task', task(1, null, { archived: true })],
  ])('does not wake it for %s', (_name, group) => {
    expect(wake(swarm(group))).toEqual({ slot: SLOT, draft: null })
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
    expect(draft).toMatchObject({ conversationId: 'lead-p1', recipients: ['lead'], source: { kind: 'schedule-request', projectId: 'p1', slot: SLOT } })
  })

  it('says in its own section that the Swarm runs it and that it is never saved', () => {
    expect(PM_SCHEDULE_TEXT.startsWith(`${BUILT_IN_HEADING}\n`)).toBe(true)
    expect(PM_SCHEDULE_TEXT).toContain('Set no timer of your own')
    expect(PM_SCHEDULE_TEXT).toContain('never save it into the document')
  })
})
