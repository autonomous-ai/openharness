/**
 * The project's status card, written by the server (task #3593, anh Dee 11-06, rules to code). The PM was woken every 15 minutes
 * to reread task messages and rewrite one line per task: the largest steady token cost found. The state the lines say is
 * already stored, so the server builds them: where each active task is, what it waits on, who owns it, and since when.
 *
 * Kept like the pulse (pulse.ts recordPulse): after each command, where every open group is loaded, written onto the project's
 * chat only when a line changed. The PM's own lines (project.report) follow them.
 */
import { agentDisplayName } from './agentNames.js'
import { holdOf, type PulseIndex } from './pulse.js'
import type { Conversation, SuperTabState } from './model.js'
import { PROJECT_STATUS_MAX, type SwarmProject } from './projects.js'
import { stepName } from './steps.js'
import { usernameOf } from './usernames.js'

/** One active task's line without its time: `id` its conversation, `since` when the line last changed. */
export interface CardLine { id: string; text: string; since: number }
/** What the project's chat keeps: the lines (at most CARD_LINES_MAX) and how many more tasks were left out. */
export interface StatusCard { lines: CardLine[]; more?: number }

/** A growth bound on the chat's part: far above the tasks a project has open at once. */
export const CARD_LINES_MAX = 50
/** The most of the card the PM's own lines may take, so the generated lines always have room. */
const EXTRA_MAX = PROJECT_STATUS_MAX / 2
const ENDED = new Set(['done', 'stopped', 'cancelled'])
const DONE_STEP = new Set(['done', 'stopped', 'cancelled'])

const pullRequest = (url: string): string => { const n = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1]; return n ? `PR #${n}` : url }

/** The steps of [task] that are not finished, by name: what a task in review or at work waits on. */
function openSteps(state: SuperTabState, task: Conversation): string[] {
  return (task.stepIds ?? []).flatMap(id => {
    const step = state.conversations.find(c => c.id === id)
    return step && !step.archived && !DONE_STEP.has(step.assignment?.status ?? '') ? [stepName(step)] : []
  })
}

/** Whether a release still has to carry [task]'s merge: its entry on the project's list with a component not shipped. */
function awaitingRelease(project: SwarmProject, task: Conversation): boolean {
  return !!project.releases?.pending.some(e => e.groupId === task.id
    && (e.components ? e.components.some(c => !e.shippedIn?.[c]) : !Object.keys(e.shippedIn ?? {}).length))
}

/** [task]'s line (no time), or none when its work ended and nothing of it waits. */
function lineOf(state: SuperTabState, project: SwarmProject, task: Conversation, today: string): string | null {
  const assignment = task.assignment
  const merged = task.ledger?.mergedAt != null
  const waiting = merged && awaitingRelease(project, task)
  if (assignment && ENDED.has(assignment.status) && !waiting) return null
  const name = task.number !== undefined ? `#${task.number} ${JSON.stringify(task.title)}` : JSON.stringify(task.title)
  const owner = assignment ? agentDisplayName(state.agents, assignment.agentId) ?? 'an agent that left' : 'none'
  const steps = openSteps(state, task)
  const stepsText = steps.length ? `${steps.length > 1 ? 'steps' : 'step'} ${steps.join(', ')}` : null
  const prs = [...new Set([...task.pullRequestUrls ?? []])]
  const prText = prs.length ? ` (${prs.slice(-2).map(pullRequest).join(', ')})` : ''
  let status: string, waits: string
  if (merged && (waiting || !assignment || assignment.status !== 'done')) {
    status = `merged${prText}`
    waits = waiting ? 'the next release' : 'its builder to close it'
  } else if (!assignment) {
    const hold = holdOf(task, today)
    status = hold ? 'held' : 'to do'
    waits = hold ? hold.reason ?? 'a person\'s word' : 'an owner'
  } else switch (assignment.status) {
    case 'review': status = `in review${prText}`; waits = stepsText ?? 'a review'; break
    case 'needs_human': {
      const asked = assignment.askedOf && usernameOf(state, assignment.askedOf)
      status = 'needs a person'; waits = asked ? `@${asked}` : 'a decision'; break
    }
    case 'blocked': status = 'blocked'; waits = 'the PM'; break
    case 'lost': status = 'lost'; waits = 'another engineer'; break
    case 'reconciling': status = 'stopping'; waits = 'its host'; break
    case 'planned': status = 'to do'; waits = 'its builder to start'; break
    default: status = 'working'; waits = stepsText ?? 'nothing'
  }
  return `${name}: ${status}. Waits on: ${waits}. Owner: ${owner}.`
}

/** [project]'s lines now, one per active task by number; a line keeps its `since` while its text is the same as in [previous]. */
export function projectCard(state: SuperTabState, project: SwarmProject, index: PulseIndex, previous: StatusCard | undefined, now: number, today: string): StatusCard {
  const before = new Map((previous?.lines ?? []).map(l => [l.id, l]))
  const tasks = (index.work.get(project.id) ?? []).filter(g => !g.reviewOf && !g.kind && !g.audience)
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
  const lines: CardLine[] = []
  for (const task of tasks) {
    const text = lineOf(state, project, task, today)
    if (text === null) continue
    const was = before.get(task.id)
    lines.push({ id: task.id, text, since: was && was.text === text ? was.since : now })
  }
  return { lines: lines.slice(0, CARD_LINES_MAX), ...(lines.length > CARD_LINES_MAX ? { more: lines.length - CARD_LINES_MAX } : {}) }
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16)

/** The card readers see: each line with its time, then the PM's own lines, within PROJECT_STATUS_MAX. When the lines do not all
 *  fit, the last line says how many tasks it leaves out. */
export function cardText(lines: readonly CardLine[], extra?: string | null, more = 0): string {
  const own = extra ? extra.slice(0, EXTRA_MAX) : ''
  const room = PROJECT_STATUS_MAX - (own ? own.length + 1 : 0)
  const shown: string[] = []
  let used = 0
  for (const line of lines) {
    const text = `${line.text} Since ${clock(line.since)} UTC.`
    // Keep room for the "N more tasks." line, which is at most this long.
    if (used + text.length + 1 + 24 > room) break
    shown.push(text)
    used += text.length + 1
  }
  const left = lines.length - shown.length + more
  return [...shown, ...(left ? [`${left} more tasks.`] : []), ...(own ? [own] : [])].join('\n')
}
