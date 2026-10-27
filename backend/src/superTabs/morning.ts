import { stableId, type Author, type Conversation, type MessageDraft, type SuperTabState, type WorkStatus } from './model.js'
import { agentDisplayName } from './agentNames.js'
import { canReadProject, projectsOf, type SwarmProject } from './projects.js'
import { reportGroups } from './projectUpdates.js'
import type { ContributedMachine } from './machines.js'
import { leaderboard } from './leaderboard/stats.js'
import { waitedOn } from './leaderboard/record.js'
import type { Medal } from './leaderboard/contract.js'
import { WEEK_MS, weekStart } from './leaderboard/week.js'

// Start each day and end each week together (v2 J): with the morning digest (digest.ts) the project chat gets a stand-up
// card, and on Mondays a "shipped together" recap of last week. Clients render `source.card`; `text` is the plain fallback.
// People are member ids and agents agent ids, which clients name from the members they already read, as the leaderboard does.
// Only shared work counts: private chats and Chat with PM never appear (reportGroups, leaderboard).

export interface ShippedItem { number: number; title: string; pullRequestUrl: string | null; askedBy: string | null; builtBy: string; reviewedBy: string[] }
export interface OpenItem { number: number; title: string; status: WorkStatus; agentId: string; note: string | null }
export interface StandupCard {
  kind: 'standup'
  /** The project's local date. */
  on: string
  shipped: ShippedItem[]
  inProgress: OpenItem[]
  blocked: OpenItem[]
  /** Agents waiting on a person: who they wait on (leaderboard/record.ts waitedOn). */
  waiting: Array<OpenItem & { personId: string }>
}
export interface RecapCard {
  kind: 'recap'
  /** The Monday 00:00 UTC the recapped week starts (leaderboard/week.ts). */
  week: number
  shipped: ShippedItem[]
  /** The team's median ask-to-shipped time that week and the week before, from the leaderboard. */
  askToShipMs: { lastWeek: number | null; weekBefore: number | null }
  /** The leaderboard's medal winners. */
  top: Array<{ personId: string; medal: Medal; points: number }>
  /** Everyone who helped: people who asked or earned points, agents who built or reviewed. */
  thanks: { personIds: string[]; agentIds: string[] }
}

const IN_PROGRESS: readonly WorkStatus[] = ['planned', 'working', 'review', 'reconciling']
const BLOCKED: readonly WorkStatus[] = ['blocked', 'lost']

/** Requests only: a review is credited on the work it reviewed. */
const requests = (state: SuperTabState, project: SwarmProject): Conversation[] =>
  reportGroups(state, project).filter(g => g.number !== undefined && !g.reviewOf).sort((a, b) => a.number! - b.number!)

function shippedItem(state: SuperTabState, group: Conversation): ShippedItem {
  const reviewedBy = state.conversations.filter(c => c.reviewOf === group.id && c.assignment).map(c => c.assignment!.agentId)
  return { number: group.number!, title: group.title, pullRequestUrl: group.pullRequestUrls?.at(-1) ?? null, askedBy: group.requesterId ?? null,
    builtBy: group.assignment!.agentId, reviewedBy }
}

function openItem(group: Conversation): OpenItem {
  const work = group.assignment!
  const note = work.status === 'lost' ? work.lost?.reason : work.result
  return { number: group.number!, title: group.title, status: work.status, agentId: work.agentId, note: note ? note.replace(/\s+/g, ' ').slice(0, 300) : null }
}

/** The day's stand-up: shipped since `since` (work done before the leaderboard recorded ships by its last activity), and open work. */
export function standupCard(state: SuperTabState, project: SwarmProject, on: string, since: number): StandupCard {
  const all = requests(state, project), open = all.filter(g => !g.archived && g.assignment)
  const shippedAt = (g: Conversation) => g.ledger?.shippedAt ?? Date.parse(g.lastActivityAt ?? '')
  const status = (statuses: readonly WorkStatus[]) => open.filter(g => statuses.includes(g.assignment!.status)).map(openItem)
  return {
    kind: 'standup', on,
    shipped: all.filter(g => g.assignment?.status === 'done' && shippedAt(g) >= since).map(g => shippedItem(state, g)),
    inProgress: status(IN_PROGRESS),
    blocked: status(BLOCKED),
    waiting: open.filter(g => g.assignment!.status === 'needs_human').map(g => ({ ...openItem(g), personId: waitedOn(state, g) })),
  }
}

/** The leaderboard week before the project's local Monday `on` (review of #1763): where that Monday is still Sunday in
 *  UTC, as at 08:00 in Auckland, the week `now` is in would be last week, and the recap would go two weeks back. */
export const recapWeek = (on: string): number => weekStart(Date.parse(`${on}T00:00:00Z`)) - WEEK_MS

/** The machines every person reading the project chat may see (model.ts visibleState): the card is read by all of them, so
 *  its Lent counts no machine one of them could not see on the leaderboard. A machine the Lead project alone was given is
 *  seen only by that project's readers. */
function cardMachines(state: SuperTabState, project: SwarmProject): ContributedMachine[] {
  const leadProject = projectsOf(state).find(p => p.id === 'lead')
  const readers = state.people.map(p => ({ kind: 'person' as const, userId: p.id, email: p.email })).filter(p => canReadProject(state, p, project))
  const allSeeLead = !!leadProject && readers.every(p => canReadProject(state, p, leadProject))
  return (state.machines ?? []).filter(m => allSeeLead || m.scope === 'swarm')
}

/** Last week by the project's local date `on`, as the leaderboard counts it. */
export function recapCard(state: SuperTabState, project: SwarmProject, on: string, now: number): RecapCard {
  const week = recapWeek(on)
  const board = leaderboard({ state, groups: state.conversations, machines: cardMachines(state, project), projectId: project.id, week, now })
  const shipped = requests(state, project).filter(g => g.ledger?.shippedAt != null && g.ledger.shippedAt >= week && g.ledger.shippedAt < week + WEEK_MS)
    .map(g => shippedItem(state, g))
  return {
    kind: 'recap', week, shipped,
    askToShipMs: { lastWeek: board.goal.thisWeek.medianAskToShipMs, weekBefore: board.goal.lastWeek.medianAskToShipMs },
    top: board.people.flatMap(p => p.medal ? [{ personId: p.personId, medal: p.medal, points: p.points }] : []),
    thanks: {
      personIds: unique([...shipped.flatMap(s => s.askedBy ? [s.askedBy] : []), ...board.people.filter(p => p.points > 0).map(p => p.personId)]),
      agentIds: unique(shipped.flatMap(s => [s.builtBy, ...s.reviewedBy])),
    },
  }
}

/** The cards that go out with a project's digest on its local date `on`: the stand-up, and the recap on Mondays. Posted once
 *  each, since the digest itself goes out once a day (store.ts); `recipients` is empty, so no agent is woken by them. */
export function morningCards(state: SuperTabState, project: SwarmProject, from: Author, on: string, since: number, now: number): MessageDraft[] {
  const post = (card: StandupCard | RecapCard, text: string): MessageDraft => ({ id: stableId(card.kind, state.id, project.id, on),
    conversationId: project.leadConversationId, author: from, text, replyTo: null, recipients: [], source: { kind: card.kind, projectId: project.id, on, card } })
  const standup = standupCard(state, project, on, since)
  const cards = [post(standup, `Stand-up for ${on}: ${standup.shipped.length} shipped, ${standup.inProgress.length} in progress, `
    + `${standup.blocked.length} blocked, ${standup.waiting.length} waiting on people.`)]
  if (recapDay(on)) {
    const recap = recapCard(state, project, on, now)
    const names = [...recap.thanks.personIds.map(id => state.people.find(p => p.id === id)?.email.split('@')[0] ?? id),
      ...recap.thanks.agentIds.map(id => agentDisplayName(state.agents, id) ?? id)]
    const thanks = names.length ? ` Thank you, ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}!` : ''
    cards.push(post(recap, `Shipped together, week of ${new Date(recap.week).toISOString().slice(0, 10)}: ${recap.shipped.length} shipped.${thanks}`))
  }
  return cards
}

/** The recap goes out with Monday's digest, by the project's local date. */
export const recapDay = (on: string): boolean => new Date(`${on}T00:00:00Z`).getUTCDay() === 1

const unique = (ids: string[]): string[] => [...new Set(ids)]
