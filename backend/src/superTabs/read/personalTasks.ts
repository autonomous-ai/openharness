import type { Actor, Conversation, Person } from '../model.js'
import type { GroupData, Part } from '../parts/types.js'
import { FEED_IDS, FEED_PAGE, FEED_READS } from '../parts/load.js'
import { canReadGroup, canReadProject, groupProject } from '../projects.js'
import { logger } from '../../utils/logger.js'
import { askedKey } from './feedIds.js'
import { undecidedProposal, type ApprovalMode } from '../taskApproval.js'
import type { AgentView } from './contract.js'
import { decodeDormantPage } from './dormantPage.js'
import type { ReaderView } from './views.js'

export interface PersonalTask {
  id: string
  version: number
  /** Its last activity (ms): the feed's order, newest first, and its pages'. */
  at: number
  projectId: string
  projectName: string
  title: string
  agent: { id: string; name: string; avatar?: AgentView['avatar'] } | null
  /** The person who asked for it, when the Swarm still lists them: the name they show or chose, absent when neither is set. */
  requester: { id: string; name?: string; avatar?: Person['avatar'] } | null
  /** Its newest linked pull request. */
  pullRequestUrl?: string
  status: import('../model.js').WorkStatus | 'proposal' | 'rejected'
  suggested: boolean
  canApprove: boolean
  reason?: string
}
export interface PersonalTasks {
  approvalMode: ApprovalMode
  reset: boolean
  upserts: PersonalTask[]
  removed: string[]
  /** A first load's or a page's cursor for the next older page (SwarmReads.personalTasks); null when there is none. A change
   *  poll sends none: it carries only what changed. */
  olderCursor?: string | null
}

/** Who reads a feed: the person and their own agents, those running under their login (Desktop's My agents), never by
 *  machine owner and never another person's Buddy; the newest FEED_IDS − 2 of them, after the person's own two keys. */
interface Reader { actor: Actor; member: Person; agents: Set<string>; view: ReaderView }

function readerOf(view: ReaderView, actor: Actor): Reader | undefined {
  if (actor.kind !== 'person') return undefined
  const member = view.state.people.find(p => p.id === actor.userId)
  if (!member) return undefined
  const own = view.state.agents.filter(a => a.contributorId === member.id && (!a.buddyOf || a.buddyOf.personId === member.id))
  return { actor, member, view, agents: new Set(own.slice(-(FEED_IDS - 2)).map(a => a.id)) }
}

/** The keys a page of the reader's feed reads by (read/feedIds.ts): theirs at this membership, their id and their own agents. */
const feedReadIds = (reader: Reader): string[] => [askedKey(reader.member.id, reader.member.generation), reader.member.id, ...reader.agents]

/** The projects whose tasks the reader may read; null too for conversations stored with no project, which are the default one's. */
function readableProjects(reader: Reader): Array<string | null> {
  const ids = (reader.view.state.projects ?? []).filter(p => canReadProject(reader.view.state, reader.actor, p)).map(p => p.id)
  return ids.includes('lead') ? [...ids, null] : ids
}

const activityAt = (part: Part<GroupData>): number => Date.parse(part.data?.lastActivityAt ?? '') || part.changedAt

/** One changed part as the reader's feed takes it: a row, gone from the feed, or none of the reader's business (never said). */
function summary(part: Part, reader: Reader): PersonalTask | 'gone' | null {
  if (part.kind !== 'group' || !part.data) return null
  const group = part.data as Conversation, { actor, member, view } = reader
  // Every id, including a removal's, passes today's read rules; revocation uses the existing visibility epoch reload.
  try { if (!canReadGroup(view.state, actor, group)) return null } catch { return null }
  if (group.kind || group.audience || group.reviewOf) return null
  const project = groupProject(view.state, group)
  if (group.id === project.leadConversationId) return null
  const approval = group.taskApproval
  const asked = approval ? approval.personId === member.id && approval.generation === member.generation
    : group.proposal ? group.proposal.senders.some(s => s.personId === member.id && s.generation === member.generation)
    : group.requesterId === member.id
  // Did, doing or about to do: its assignee, or the agent suggested before anyone is assigned; or an agent that ran under the
  // reader's login, closed since (read/feedIds.ts).
  const worker = group.assignment?.agentId ?? approval?.suggestedAgentId
  const own = asked || (!!worker && reader.agents.has(worker)) || group.assignment?.execution?.contributorId === member.id
  if (part.deleted || group.proposal?.mergedInto || !own) return 'gone'
  const agent = view.parts.agents.find(a => a.key === worker)?.data
  const asker = group.requesterId ? view.state.people.find(p => p.id === group.requesterId) : undefined
  const askerName = asker && (asker.name ?? asker.username)
  // A proposal the PM declined shows as rejected, with its reason (task #4252).
  const declined = group.proposal?.decision?.kind === 'no'
  const status = declined ? 'rejected' : approval?.state === 'proposal' || approval?.state === 'rejected' ? approval.state
    : group.assignment?.status ?? (group.proposal && !['accept', 'reshape'].includes(group.proposal.decision?.kind ?? '') ? 'proposal' : 'planned')
  const pullRequestUrl = group.pullRequestUrls?.at(-1)
  return { id: group.id, version: part.version, at: activityAt(part as Part<GroupData>), projectId: project.id, projectName: project.name,
    title: group.title, status, suggested: !group.assignment && !!approval?.suggestedAgentId, canApprove: approval?.state === 'proposal' && asked && !undecidedProposal(group),
    agent: agent ? { id: agent.id, name: agent.displayName ?? agent.name, ...agent.avatar ? { avatar: agent.avatar } : {} } : null,
    requester: asker ? { id: asker.id, ...askerName ? { name: askerName } : {}, ...asker.avatar ? { avatar: asker.avatar } : {} } : null,
    ...pullRequestUrl ? { pullRequestUrl } : {}, ...declined ? { reason: group.proposal!.decision!.reason } : approval?.reason ? { reason: approval.reason } : {} }
}

const newestFirst = (a: PersonalTask, b: PersonalTask) => b.at - a.at || a.id.localeCompare(b.id)

/** A change poll's feed: a summary of each changed part of the reader's, and the ids that left it. Dormant and archived
 *  tasks stay: the feed is their history. */
export function personalTasksFor(changed: readonly Part[], view: ReaderView, actor: Actor): PersonalTasks | undefined {
  const reader = readerOf(view, actor)
  if (!reader) return undefined
  const out: PersonalTasks = { approvalMode: reader.member.approvalMode ?? 'autoApprove', reset: false, upserts: [], removed: [] }
  for (const part of changed) {
    const row = summary(part, reader)
    if (row === 'gone') out.removed.push(part.key)
    else if (row) out.upserts.push(row)
  }
  out.upserts.sort(newestFirst)
  return out
}

type FeedRead = (ids: string[], projectIds: Array<string | null>, before?: { lastActivityAt: number; key: string }) =>
  Promise<Array<{ part: Part<GroupData>; activityAt: number }>>

/** A page of the reader's feed, newest first: the first (a first load's, `reset`) or the one older than `cursor`. Rows the
 *  reader may not read never shorten a page, and the cursor names the last row it returns, never a hidden one (as the
 *  dormant pager, security review 2 of #2115). Each batch reads on from the last row of the one before. */
export async function personalTasksPage(read: FeedRead, view: ReaderView, actor: Actor, cursor?: string): Promise<PersonalTasks | undefined> {
  let before = cursor ? decodeDormantPage(cursor) : undefined
  const reader = readerOf(view, actor)
  if (!reader) return undefined
  const ids = feedReadIds(reader), projects = readableProjects(reader), upserts: PersonalTask[] = []
  let last: { lastActivityAt: number; key: string } | undefined, more = false
  for (let reads = 1; ; reads++) {
    const rows = await read(ids, projects, before)
    for (const { part, activityAt } of rows) {
      const row = summary(part, reader)
      if (!row || row === 'gone') continue
      if (upserts.length === FEED_PAGE) { more = true; break }
      upserts.push(row)
      last = { lastActivityAt: activityAt, key: part.key }
    }
    if (more || rows.length < FEED_PAGE) break
    if (reads === FEED_READS) {
      // Ends the feed here rather than hand out a cursor at a row it never sent: the next page would read the same rows again.
      logger.warn('[swarm-reads] a Tasks feed page ended early: its reads returned rows the feed refused', { reads, kept: upserts.length })
      break
    }
    const end = rows.at(-1)!
    before = { lastActivityAt: end.activityAt, key: end.part.key }
  }
  return { approvalMode: reader.member.approvalMode ?? 'autoApprove', reset: !cursor, upserts, removed: [],
    olderCursor: more && last ? Buffer.from(JSON.stringify({ la: last.lastActivityAt, k: last.key })).toString('base64url') : null }
}
