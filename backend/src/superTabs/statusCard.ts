/**
 * The project's status card, written by the server (task #3593, anh Dee 11-06, rules to code). The PM was woken every 15 minutes
 * to reread task messages and rewrite one line per task: the largest steady token cost found. The state the lines say is
 * already stored, so the server builds them: where each active task is, what it waits on, who owns it, and since when.
 *
 * Each task keeps its own line on its own part (task #4419): after each command, where every open group is loaded (pulse.ts
 * recordPulse), a task's line is written only when its text changed. A card kept on the project chat (#3302) moved the chat's
 * part with every line, and the next command read the chat whole: 6-7 KB over #4368's per-command budgets. Readers get the card
 * built from the lines (projectCard, model.ts visibleState). The PM's own lines (project.report) follow them.
 */
import { agentDisplayName } from './agentNames.js'
import { holdOf, pulseIndex, type PulseIndex } from './pulse.js'
import { pullRequestLinks, type Conversation, type SuperTabState } from './model.js'
import { groupRepositoryUrl, type SwarmProject } from './projects.js'
import { isBuddyChat } from './buddies.js'
import { usernameOf } from './usernames.js'

/** A task's own line as it keeps it (Conversation.statusLine): its text without its time, and when it last changed. An empty text
 *  is a task whose line left the card at `since`: a change poll tells a live reader so (read/changes.ts). */
export interface StatusLine { text: string; since: number }
/** One active task's line: `id` its conversation; no `since` for a task that keeps no line yet (projectCard). */
export interface CardLine { id: string; text: string; since?: number }
/** A project's card as readers get it (projectCard): the lines (at most CARD_LINES_MAX), how many more tasks were left out, the
 *  lines' text with their times, and when a line last changed. Built on read, never stored. */
export interface StatusCard { lines: CardLine[]; more?: number; text: string; changedAt?: number }

/** A growth bound on the card: far above the tasks a project has open at once. */
export const CARD_LINES_MAX = 50
const ENDED = new Set(['done', 'stopped', 'cancelled'])

const pullRequest = (url: string): string => { const n = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1]; return n ? `PR #${n}` : url }

/** [task]'s line (no time), or none when its work ended. */
function lineOf(state: SuperTabState, task: Conversation, today: string): string | null {
  const assignment = task.assignment
  const merged = task.ledger?.mergedAt != null
  if (assignment && ENDED.has(assignment.status)) return null
  // A task its requester rejected never runs (taskApproval.ts, Swarm v3): it is no longer active work.
  if (!assignment && task.taskApproval?.state === 'rejected') return null
  const name = task.number !== undefined ? `#${task.number} ${JSON.stringify(task.title)}` : JSON.stringify(task.title)
  const owner = assignment ? agentDisplayName(state.agents, assignment.agentId) ?? 'an agent that left' : 'none'
  // Its linked pull requests, and those its builder's result names: the store links those right after the command (store.ts), so a
  // line written by the command says them already, as the card built after says them.
  const unlinked = new Set(task.unlinkedPullRequests?.map(entry => entry.url))
  const prs = [...new Set([...task.pullRequestUrls ?? [],
    ...pullRequestLinks(assignment?.result ?? '', groupRepositoryUrl(state, task)).filter(url => !unlinked.has(url))])]
  const prText = prs.length ? ` (${prs.slice(-2).map(pullRequest).join(', ')})` : ''
  let status: string, waits: string
  if (merged && (!assignment || assignment.status !== 'done')) {
    status = `merged${prText}`
    waits = 'its builder to close it'
  } else if (task.paused) {
    // Paused by someone who steers the project (boardRights.ts): its worker stops at a safe point, whatever its status says.
    status = 'paused'; waits = `a person to resume it${task.paused.reason ? ` (${task.paused.reason})` : ''}`
  } else if (!assignment && task.taskApproval?.state === 'proposal') {
    // No work starts before the requesting person approves it (taskApproval.ts, Swarm v3).
    const asked = usernameOf(state, task.taskApproval.personId)
    status = 'proposed'; waits = asked ? `@${asked}'s approval` : 'its requester\'s approval'
  } else if (!assignment) {
    const hold = holdOf(task, today)
    status = hold ? 'held' : 'to do'
    waits = hold ? hold.reason ?? 'a person\'s word' : 'an owner'
  } else switch (assignment.status) {
    case 'review': status = `in review${prText}`; waits = 'a review'; break
    case 'needs_human': {
      const asked = assignment.askedOf && usernameOf(state, assignment.askedOf)
      status = 'needs a person'; waits = asked ? `@${asked}` : 'a decision'; break
    }
    case 'blocked': status = 'blocked'; waits = 'the PM'; break
    case 'lost': status = 'lost'; waits = 'another engineer'; break
    case 'reconciling': status = 'stopping'; waits = 'its host'; break
    case 'planned': status = 'to do'; waits = 'its builder to start'; break
    default: status = 'working'; waits = 'nothing'
  }
  return `${name}: ${status}. Waits on: ${waits}. Owner: ${owner}.`
}

const lineNow = (state: SuperTabState, task: Conversation, today: string): string | null =>
  task.dormant || task.archived ? null : lineOf(state, task, today)
/** Each open task's line (null: none, its work ended) before a pass changes anything, by task: what noteTaskLines compares with. */
export type LinesBefore = ReadonlyMap<string, string | null>

/** The lines of [state]'s open tasks at [now] (of project [only], or every project): taken before a command or a sweep changes
 *  anything, so noteTaskLines writes only the lines that pass moved. */
export function linesOf(state: SuperTabState, now: number, only?: string): LinesBefore {
  const index = pulseIndex(state, undefined, only), today = new Date(now).toISOString().slice(0, 10), lines = new Map<string, string | null>()
  for (const project of state.projects ?? []) for (const task of index.work.get(project.id) ?? []) {
    if (!task.reviewOf) lines.set(task.id, lineNow(state, task, today))
  }
  return lines
}

/**
 * Writes each of [project]'s open tasks' own line ([index], the pulse's: every open group loaded) where this pass moved it, dated
 * [now]: its line in [before] is another, or it was not there (a task the command made). A task whose line ended keeps it empty,
 * dated when it ended, so a reader learns the card dropped it. The text is only what the time goes with: the card builds every
 * line from task state (projectCard). Comparing with each task's stored text instead would write every open task at once
 * whenever those go stale (tasks stored before #4419, or a release that rewords the lines): ~200 parts in one transaction, and
 * the Swarm answers busy.
 */
export function noteTaskLines(state: SuperTabState, project: SwarmProject, index: PulseIndex, now: number, today: string, before: LinesBefore): void {
  for (const task of index.work.get(project.id) ?? []) {
    if (task.reviewOf) continue
    const text = lineNow(state, task, today)
    const old = before.has(task.id) ? before.get(task.id)! : undefined
    if (old === text || (old === undefined && text === null)) continue
    task.statusLine = { text: text ?? '', since: now }
  }
}

/** [project]'s card at [now], one line per active task by number, each built from task state: what readers get (model.ts
 *  visibleState). A line's time is the one its task keeps while that is for the same text; none otherwise (a task stored before
 *  #4419 and not moved since, or a line a release reworded). A task archived, dormant, a step or with an audience of its own is
 *  not on it. */
export function projectCard(state: SuperTabState, project: SwarmProject, now: number): StatusCard {
  const today = new Date(now).toISOString().slice(0, 10)
  const lines: CardLine[] = state.conversations
    .filter(task => (task.projectId ?? 'lead') === project.id && task.id !== project.leadConversationId
      && !task.reviewOf && !task.kind && !task.audience && !isBuddyChat(task) && !task.archived && !task.dormant)
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
    .flatMap(task => {
      const text = lineOf(state, task, today)
      if (text === null) return []
      return [{ id: task.id, text, ...task.statusLine?.text === text ? { since: task.statusLine.since } : {} }]
    })
  const kept = lines.slice(0, CARD_LINES_MAX), more = lines.length - kept.length
  const times = kept.flatMap(line => line.since === undefined ? [] : [line.since])
  const changedAt = times.length ? Math.max(...times) : undefined
  return { lines: kept, ...(more ? { more } : {}), text: cardText(kept, null, more), ...(changedAt !== undefined ? { changedAt } : {}) }
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16)

/** The card readers see: each line with its time, then the PM's own lines. When the lines do not all fit in LINES_ROOM, the last line says
 *  how many tasks it leaves out. */
export function cardText(lines: readonly CardLine[], extra?: string | null, more = 0): string {
  return withExtra(linesText(lines, more), extra)
}

/** The coordinator's own lines after the card's lines, at most EXTRA_ROOM of them. The whole card is at most PROJECT_STATUS_MAX. */
export function withExtra(text: string, extra?: string | null): string {
  const own = extra ? extra.slice(0, EXTRA_ROOM) : ''
  return own ? (text ? `${text}\n${own}` : own) : text
}

/** What the lines take of the card: LINES_ROOM, the rest being the coordinator's. */
const LINES_ROOM = 1_500
const EXTRA_ROOM = 500

function linesText(lines: readonly CardLine[], more: number): string {
  const shown: string[] = []
  let used = 0
  for (const line of lines) {
    const text = line.since === undefined ? line.text : `${line.text} Since ${clock(line.since)} UTC.`
    // Keep room for the "N more tasks." line, which is at most this long.
    if (used + text.length + 1 + 24 > LINES_ROOM) break
    shown.push(text)
    used += text.length + 1
  }
  const left = lines.length - shown.length + more
  return [...shown, ...(left ? [`${left} more tasks.`] : [])].join('\n')
}
