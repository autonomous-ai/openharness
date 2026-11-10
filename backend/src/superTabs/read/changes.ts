/**
 * Which changed parts one reader receives (design 4.4). A live part goes as the reader sees it now; a removal or a
 * dormant group goes as a one-line stub, and only to a reader who could read the part's last data. Where that check
 * cannot be made (its project is gone), the change also moved the visibility epoch and every reader reloads.
 */
import { type Actor, type Agent, type AgentStart, type Conversation } from '../model.js'
import { canReadAgent, canReadGroup } from '../projects.js'
import { knownKind, type MachineData, type Part } from '../parts/index.js'
import type { ChangesDelta, DormantStub, MachineView, Tombstone } from './contract.js'
import { envelope, progressView, seenIn, visibleGroupView, type ReaderView } from './views.js'

export type PartChanges = Pick<ChangesDelta, 'head' | 'members' | 'agents' | 'groups' | 'machines' | 'machineReadings' | 'starts' | 'progress'>

/** A command's own time can be a little before the stamp of the part it wrote, so a read between them still finds the card moved. */
const CARD_SKEW_MS = 60_000
const stub = (part: Part): Tombstone => ({ key: part.key, version: part.version, changedAt: part.changedAt, deleted: true })
const dormantStub = (part: Part): DormantStub => ({ key: part.key, version: part.version, changedAt: part.changedAt, dormant: true })
/** A read check that names a project which no longer exists answers no. */
const safely = (check: () => boolean): boolean => { try { return check() } catch { return false } }

/** [light]: the reader asked for a line for a machine's own reading, and its cursor's time: anything else since then sends the part. */
export function changesFor(view: ReaderView, changed: Part[], actor: Actor, light?: { since: number }, cursor?: number): PartChanges {
  const { state, parts: seen } = view
  const live = <T>(list: Array<{ key: string } & T>, key: string) => list.find(p => p.key === key)
  const groupReadable = (group: Conversation) => safely(() => canReadGroup(state, actor, group))
  const groupOf = (id: string) => state.conversations.find(c => c.id === id)
    ?? changed.find(p => p.kind === 'group' && p.key === id)?.data as Conversation | undefined
  const visibleAgents = new Set(seen.agents.map(a => a.key))
  const seenMachines = seenIn(seen)
  const out: PartChanges = { head: null, members: [], agents: [], groups: [], machines: [], ...light ? { machineReadings: [] } : {}, starts: [], progress: [] }
  for (const part of changed) {
    switch (part.kind) {
      case 'head': out.head = seen.head; break
      case 'member': {
        const member = live(seen.members, part.key)
        if (part.deleted) out.members.push(stub(part))
        else if (member) out.members.push(member)
        break
      }
      case 'agent': {
        const agent = live(seen.agents, part.key)
        if (part.deleted) { if (safely(() => canReadAgent(state, actor, part.data as Agent))) out.agents.push(stub(part)) }
        else if (agent) out.agents.push(agent)
        break
      }
      case 'group': {
        // A conversation of a kind this release does not know is parked by reassembly, so a first load leaves it out: so
        // do changes, removals and dormant stubs, or an older reader meets it during a rolling deploy (review of #1745).
        if (part.data && !knownKind(part.data as Conversation)) break
        if (part.deleted || part.dormant) { if (groupReadable(part.data as Conversation)) out.groups.push(part.deleted ? stub(part) : dormantStub(part)) }
        // Sent from the changed part itself: the reader's view may hold only a conversation's light fields (parts/light.ts).
        else if (groupReadable(part.data as Conversation)) {
          const group = part.data as Conversation
          out.groups.push(envelope(part, visibleGroupView(group, visibleAgents, seenMachines)))
          // A task whose status line moved since the reader's cursor (statusCard.ts, tasks #3593, #4419): readers get the card in the
          // head's project, so the head goes with it, or a live reader keeps the old card until something else moves the head. Only
          // then: a task changes with every message, and the head is large. A reader with no cursor to compare gets it.
          if (group.statusLine && !out.head && (cursor === undefined || group.statusLine.since >= cursor - CARD_SKEW_MS)) out.head = seen.head
        }
        break
      }
      case 'machine': {
        const machine = live(seen.machines, part.key)
        const receivedAt = (machine?.data as MachineView | undefined)?.observation?.receivedAt
        if (machine && !part.deleted && light && receivedAt !== undefined && Math.max(part.changedAt, part.contentAt ?? 0) <= light.since) {
          out.machineReadings!.push({ key: part.key, version: part.version, receivedAt })
        } else if (machine && !part.deleted) out.machines.push(machine)
        // Machine ids are no secret among members, unlike conversations: a contribution that ended reads as a removal.
        else if (part.deleted || !(part.data as MachineData | null)?.contribution) out.machines.push(stub(part))
        break
      }
      case 'start': {
        const start = live(seen.starts, part.key), group = groupOf((part.data as AgentStart).request.conversationId)
        if (part.deleted) { if (group && groupReadable(group)) out.starts.push(stub(part)) }
        else if (start) out.starts.push(start)
        break
      }
      case 'progress': {
        if (!part.deleted && seen.head.data.projects?.some(p => p.id === part.key)) out.progress.push(envelope(part, progressView(part.data as never)))
        break
      }
    }
  }
  return out
}
