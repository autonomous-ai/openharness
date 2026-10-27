import { activeWork, author, stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentDisplayName } from './agentNames.js'
import { canReadGroup, ledProject, type SwarmProject } from './projects.js'
import { reportGroups } from './projectUpdates.js'
import { recapDay } from './morning.js'

// Night shift (v2 B): people wake to one message per project saying what the Swarm did overnight. At the project's local
// digest time its Lead's poll wakes the Lead with the lists below, built from state; the Lead checks each pull request is
// merged and posts them to the people.

/** The first digest covers the day before it. */
const FIRST_SPAN_MS = 24 * 60 * 60_000
const IN_PROGRESS: Record<string, string> = { planned: 'planned', working: 'working', review: 'ready for review', reconciling: 'being reconciled' }
const HELD_UP: Record<string, string> = { blocked: 'stuck', lost: 'lost', needs_human: 'waits for a person' }

/** The project's local date and time ("2026-10-27", "08:00") at `now`. */
function localNow(timeZone: string, now: number): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

/** Whether the zone is one this runtime knows. */
export function knownTimeZone(timeZone: string): boolean {
  try { localNow(timeZone, 0); return true } catch { return false }
}

/** The local date of a digest due at `now`, or null: none set, not yet its time today, or today's already sent. */
export function digestDue(project: SwarmProject, now: number): string | null {
  const digest = project.digest
  if (!digest) return null
  const local = localNow(digest.timeZone, now)
  return local.time >= digest.time && digest.lastOn !== local.date ? local.date : null
}

/** Where a project's digest starts: its last one, or the day before the first. */
export const digestSince = (project: SwarmProject, now: number): number => project.digest?.lastAt ?? now - FIRST_SPAN_MS

/** The date a newly set digest counts as sent for: today, when today's time has already passed, so it starts tomorrow. */
export function digestStartsAfter(time: string, timeZone: string, now: number): string | undefined {
  const local = localNow(timeZone, now)
  return local.time >= time ? local.date : undefined
}

/**
 * A project's digest: what shipped since `since` (finished with a pull request; the Lead checks each is merged), what is
 * in progress, what is held up, and the decisions waiting for people. Each part is left out when it is empty, so the
 * decisions part appears only once there are decisions to list.
 */
export function projectDigest(state: SuperTabState, project: SwarmProject, since: number, decisions: string[] = []): string {
  // Work that shipped and was archived since still shipped (#1757 review, 4); only open work is in progress or held up.
  const groups = reportGroups(state, project).filter(g => g.number !== undefined).sort((a, b) => a.number! - b.number!)
  const open = groups.filter(g => !g.archived)
  const named = (g: Conversation) => `#${g.number} ${g.title}`
  const who = (g: Conversation) => agentDisplayName(state.agents, g.assignment!.agentId)
  const pr = (g: Conversation) => g.pullRequestUrls?.at(-1)
  const shipped = groups.filter(g => g.assignment?.status === 'done' && Date.parse(g.lastActivityAt ?? '') >= since)
    .map(g => `- ${named(g)}: ${pr(g) ?? 'done, no pull request'}`)
  const moving = open.filter(g => activeWork(g) && IN_PROGRESS[g.assignment!.status])
    .map(g => `- ${named(g)}: ${IN_PROGRESS[g.assignment!.status]} (${who(g)})${pr(g) ? `, ${pr(g)}` : ''}`)
  const held = open.filter(g => g.assignment && HELD_UP[g.assignment.status]).map(g => {
    const why = g.assignment!.status === 'lost' ? g.assignment!.lost?.reason : g.assignment!.result
    return `- ${named(g)}: ${HELD_UP[g.assignment!.status]} (${who(g)})${why ? `: ${why.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`
  })
  const parts = [['Shipped', shipped], ['In progress', moving], ['Blocked', held], ['Decisions waiting', decisions]] as const
  const text = parts.filter(([, lines]) => lines.length).map(([title, lines]) => [`${title}:`, ...lines].join('\n')).join('\n')
  return text || 'Nothing shipped, in progress or blocked.'
}

/**
 * The decisions waiting in a project (`waiting`: how many per conversation and person), one line per conversation: how
 * many wait for whom. Decisions are read only by the
 * person asked, the agent that asked and the Lead (decisions.ts readerWhere), while the digest goes to the whole project,
 * so it never says what is asked, and leaves out private conversations and people who no longer read the conversation.
 */
export function decisionLines(state: SuperTabState, project: SwarmProject, waiting: ReadonlyArray<{ conversationId: string; personId: string; count: number }>): string[] {
  const chat = state.conversations.find(c => c.id === project.leadConversationId)
  const groups = [...chat ? [chat] : [], ...reportGroups(state, project).filter(g => g.number !== undefined).sort((a, b) => a.number! - b.number!)]
  const counts = new Map<string, Map<string, number>>()
  for (const { conversationId, personId, count } of waiting) {
    const group = groups.find(g => g.id === conversationId), asked = state.people.find(p => p.id === personId)
    if (!group || !asked || !canReadGroup(state, { kind: 'person', userId: asked.id, email: asked.email }, group)) continue
    const people = counts.get(group.id) ?? new Map<string, number>()
    counts.set(group.id, people.set(asked.email, (people.get(asked.email) ?? 0) + count))
  }
  return groups.filter(g => counts.has(g.id)).map(g => `- ${g === chat ? 'This chat' : `#${g.number} ${g.title}`}: `
    + [...counts.get(g.id)!].map(([email, n]) => `${n} for ${email}`).join(', '))
}

/** The Lead's wake-up for its project's digest when one is due, or null. The caller records it as sent (store.ts). */
export function digestRequest(state: SuperTabState, target: Agent, now: number,
  waiting: ReadonlyArray<{ conversationId: string; personId: string; count: number }> = []): MessageDraft | null {
  if (state.paused) return null
  const project = ledProject(state, target.id)
  const on = project && digestDue(project, now)
  if (!project || !on) return null
  const digest = project.digest!
  const text = `Morning digest for project ${JSON.stringify(project.name)} (${digest.time}, ${digest.timeZone}). This is a scheduled request, not a new task. `
    + 'Check that each pull request under Shipped is merged, and move one that is not to In progress. Then post one message to the people in this chat '
    + 'with these parts, in plain words, without commands or internal IDs.\n\n'
    + projectDigest(state, project, digestSince(project, now), decisionLines(state, project, waiting))
    // The cards themselves go out with this wake-up (morning.ts); the Lead adds the human touch.
    + (recapDay(on) ? '\n\nIt is Monday: the weekly recap card is in this chat too. After the digest, post one warm, short thank-you that names everyone it thanks; '
      + 'do not repeat the card.' : '')
  return { id: stableId('digest', state.id, project.id, on), conversationId: project.leadConversationId,
    author: author(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }),
    text, replyTo: null, recipients: [target.id], source: { kind: 'digest-request', projectId: project.id, on } }
}
