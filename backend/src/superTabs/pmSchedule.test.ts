import { describe, expect, it } from 'vitest'
import type { Agent, Assignment, Conversation, SuperTabState, WorkStatus } from './model.js'
import { BUILT_IN_HEADING, PM_SCHEDULE_TEXT, recordTidy, recordWake, SCHEDULE_SLOT_MS, scheduleMessageId, scheduleRequest, scheduleSlot, tidyMessageId, tidyRequest, tidySaved } from './pmSchedule.js'
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

  it('names every job due in one wake, and never the tidy, which has its own daily message (Ken, 11-05, #3151)', () => {
    const state = swarm(task(1, null))
    chat(state).heardAt = T - 1
    project(state).instructionsRevision = 3
    const scheduled = wake(state)!
    expect(scheduled.jobs).toEqual(['sweep', 'heard'])
    for (const line of ['- Open-task sweep:', '- What people taught you:']) expect(scheduled.draft.text).toContain(line)
    expect(scheduled.draft.text).not.toContain('tidy')
    // A changed document alone wakes nobody every 30 minutes.
    const changed = busy()
    project(changed).instructionsRevision = 3
    expect(wake(changed)).toBeNull()
  })

  // Ken, 11-05 (#3151): the wake only said to read people's new messages, so in a long session, and after compaction, the PM
  // worked from rules it no longer had in mind.
  it('tells the coordinator in every wake to reread the whole instructions before its jobs', () => {
    for (const state of [swarm(task(1, null)), (() => { const s = busy(); chat(s).heardAt = T - 1; return s })()]) {
      const text = wake(state)!.draft.text.replace(/\s+/g, ' ')
      expect(text).toContain('Before these jobs, reread your project\'s instructions whole')
      expect(text).toContain('after your context was compacted')
      expect(text.indexOf('reread your project\'s instructions whole')).toBeLessThan(text.indexOf('- '))
      expect(text).not.toContain('Don\'t reread the whole instructions')
    }
    expect(PM_SCHEDULE_TEXT).not.toContain('Don\'t reread the whole instructions')
    expect(PM_SCHEDULE_TEXT.replace(/\s+/g, ' ')).toContain('Every wake: reread the instructions whole before its jobs')
  })

  it('records what a written wake carried, and only the slot of one held back, so its jobs stay due', () => {
    const state = busy()
    chat(state).heardAt = T - 1
    project(state).instructionsRevision = 2
    const held = wake(state)!
    recordWake(project(state), held, T, null)
    expect(project(state).schedule).toEqual({ lastSlot: SLOT })
    expect(wake(state, T + SCHEDULE_SLOT_MS)!.jobs).toEqual(['heard'])
    const next = wake(state, T + SCHEDULE_SLOT_MS)!
    recordWake(project(state), next, T + SCHEDULE_SLOT_MS, 'wake-2')
    expect(project(state).schedule).toEqual({ lastSlot: SLOT + 1, wakeId: 'wake-2', heardAt: T + SCHEDULE_SLOT_MS })
    expect(wake(state, T + 2 * SCHEDULE_SLOT_MS)).toBeNull()
  })

  it('says in the built-in section when the Swarm wakes it for them', () => {
    expect(PM_SCHEDULE_TEXT).toContain('when a person wrote to you since the last wake')
    expect(PM_SCHEDULE_TEXT).toContain('Once a day, when the instructions changed')
  })
})

// Task #3151 (Ken, 11-05, from lamp): a tidy from revision 70 to 71 dropped Leo's rule, judged impossible, and the "(0xken15,
// 4 Nov)" of a rule it kept. The tidy now has its own message at a quiet hour, counts only when a save follows, and sorts what
// it drops.
describe('the daily tidy', () => {
  /** 23:00 on 4 November in Vietnam, beside the nightly reflection. */
  const NIGHT = Date.UTC(2026, 10, 4, 16, 0)
  const DAY = 24 * 60 * 60_000
  const busy = () => swarm(task(1, work('working')))
  const project = (state: SuperTabState) => state.projects![0]!
  const tidy = (state: SuperTabState, now = NIGHT) => tidyRequest(state, lead(state), now)
  const changed = () => { const state = busy(); project(state).instructionsRevision = 3; return state }

  it('comes in its own message in the project\'s 23:00 hour, to the coordinator alone, when the instructions changed', () => {
    const state = changed()
    expect(tidy(state, T)).toBeNull()
    expect(tidy(state, NIGHT - 1)).toBeNull()
    const asked = tidy(state)!
    expect(asked.day).toBe('2026-11-04')
    expect(asked.draft).toMatchObject({ id: tidyMessageId('tab', 'p1', '2026-11-04'), conversationId: 'lead-p1', recipients: ['lead'],
      source: { kind: 'tidy-request', projectId: 'p1', on: '2026-11-04' } })
    expect(asked.draft.text.startsWith('Daily tidy, 23:00 (Asia/Ho_Chi_Minh). This is a scheduled request from the Swarm, not a new task.')).toBe(true)
    expect(tidy(state, NIGHT + 59 * 60_000)).not.toBeNull()
    expect(tidy(state, NIGHT + 60 * 60_000)).toBeNull()
    // Nothing changed since the project's first document: nothing to tidy.
    project(state).instructionsRevision = 1
    expect(tidy(state)).toBeNull()
    const paused = changed()
    paused.paused = true
    expect(tidy(paused)).toBeNull()
    expect(tidyRequest(changed(), changed().agents.find(a => a.id === 'eng')!, NIGHT)).toBeNull()
  })

  it('counts as done only when a save follows it; without one, the next day\'s message says it was skipped', () => {
    const state = changed()
    recordTidy(project(state), tidy(state)!)
    expect(project(state).schedule).toMatchObject({ tidiedOn: '2026-11-04', tidyPending: true })
    // Once a local day.
    expect(tidy(state, NIGHT + 30 * 60_000)).toBeNull()
    // No save followed: due again the next night though nothing changed, and it says so.
    const again = tidy(state, NIGHT + DAY)!
    expect(again.skipped).toBe(true)
    expect(again.draft.text).toContain('Yesterday\'s tidy was skipped: no save followed it.')
    recordTidy(project(state), again)
    // The coordinator's save after it is the tidy done.
    tidySaved(project(state), 4)
    expect(project(state).schedule).toMatchObject({ tidiedOn: '2026-11-05', tidiedRevision: 4 })
    expect(project(state).schedule!.tidyPending).toBeUndefined()
    project(state).instructionsRevision = 4
    expect(tidy(state, NIGHT + 2 * DAY)).toBeNull()
    project(state).instructionsRevision = 5
    expect(tidy(state, NIGHT + 2 * DAY)!.skipped).toBe(false)
    expect(tidy(state, NIGHT + 2 * DAY)!.draft.text).not.toContain('skipped')
  })

  it('sorts every dropped line, keeps a person\'s rule or asks them, and checks the save against the revision before', () => {
    const text = tidy(changed())!.draft.text.replace(/\s+/g, ' ')
    expect(text).toContain('merge duplicate lines and drop stale ones')
    for (const kind of ['merged (its meaning is kept elsewhere, with who said it)', 'expired (a step or date that has passed)', 'a person\'s rule that is gone']) {
      expect(text).toContain(kind)
    }
    expect(text).toContain('Restore a person\'s rule that is gone, or ask the person who gave it and keep it until they answer')
    expect(text).toContain('never drop or weaken a person\'s rule on your own judgment, even one you think cannot be done')
    expect(text).toContain('The save\'s summary lists each dropped line, in a few words, and its kind')
    expect(text).toContain('After the save, compare it with the previous revision: every person\'s rule, and who gave it, must still be there')
    expect(text).toContain('The Swarm refuses a save that drops one without that person\'s own approval message')
    expect(text).toContain('counts as done only when its save is made')
  })

  it('tells the coordinator, in the built-in section, never to drop or weaken a person\'s rule on its own judgment', () => {
    const text = PM_SCHEDULE_TEXT.replace(/\s+/g, ' ')
    const taught = text.slice(text.indexOf('What people teach you'))
    expect(text).toContain('Once a day, when the instructions changed, at 23:00 in its own message')
    for (const where of [text.slice(0, text.indexOf('How you work')), taught]) {
      expect(where).toContain('Never drop or weaken a person\'s rule on your own judgment, even one you think cannot be done: ask that person, and keep the rule until they answer.')
    }
    expect(text).not.toContain('Keep every rule a person gave and who gave it.')
  })
})
