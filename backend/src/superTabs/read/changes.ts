/**
 * Which changed parts one reader receives (design 4.4). A live part goes as the reader sees it now; a removal or a
 * dormant group goes as a one-line stub, and only to a reader who could read the part's last data. Where that check
 * cannot be made (its project is gone), the change also moved the visibility epoch and every reader reloads.
 */
import type { Actor, Agent, AgentStart, Conversation } from '../model.js'
import { canReadAgent, canReadGroup } from '../projects.js'
import type { MachineData, Part } from '../parts/index.js'
import type { ChangesDelta, DormantStub, Tombstone } from './contract.js'
import { envelope, progressView, type ReaderView } from './views.js'

export type PartChanges = Pick<ChangesDelta, 'head' | 'members' | 'agents' | 'groups' | 'machines' | 'starts' | 'progress'>

const stub = (part: Part): Tombstone => ({ key: part.key, version: part.version, changedAt: part.changedAt, deleted: true })
const dormantStub = (part: Part): DormantStub => ({ key: part.key, version: part.version, changedAt: part.changedAt, dormant: true })
/** A read check that names a project which no longer exists answers no. */
const safely = (check: () => boolean): boolean => { try { return check() } catch { return false } }

export function changesFor(view: ReaderView, changed: Part[], actor: Actor): PartChanges {
  const { state, parts: seen } = view
  const live = <T>(list: Array<{ key: string } & T>, key: string) => list.find(p => p.key === key)
  const groupReadable = (group: Conversation) => safely(() => canReadGroup(state, actor, group))
  const groupOf = (id: string) => state.conversations.find(c => c.id === id)
    ?? changed.find(p => p.kind === 'group' && p.key === id)?.data as Conversation | undefined
  const out: PartChanges = { head: null, members: [], agents: [], groups: [], machines: [], starts: [], progress: [] }
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
        if (part.deleted || part.dormant) { if (groupReadable(part.data as Conversation)) out.groups.push(part.deleted ? stub(part) : dormantStub(part)) }
        else { const group = live(seen.groups, part.key); if (group) out.groups.push(group) }
        break
      }
      case 'machine': {
        const machine = live(seen.machines, part.key)
        if (machine && !part.deleted) out.machines.push(machine)
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
