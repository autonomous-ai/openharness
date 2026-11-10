import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { buddyChatId, swarmBuddyChatId } from '../src/superTabs/buddies.js'
import type { Agent, BuddySession, Conversation, SuperTabState } from '../src/superTabs/model.js'
import { rewriteParts } from './storedParts.test-support.js'

/**
 * The Buddies a v3 release left in a Swarm's parts. Nothing makes a Buddy since Swarm v4 (2026-11-10): the one-time job and the
 * time checks make each an ordinary agent (buddyConversion.ts), and until then the rules that read one stored still hold
 * (buddies.ts, buddySessions.ts). Each is written as buddy.create, a thread session's start or an older project chat left it.
 */
export interface StoredBuddy { agentId: string; harnessId: string; chat: string }
interface Placement { personId: string; machineId: string; configuration: Agent['configuration']; name?: string }

const personOf = (state: SuperTabState, personId: string) => state.people.find(p => p.id === personId)!
const buddyAgent = (state: SuperTabState, o: Placement, extra: Partial<Agent>): Agent => {
  const me = personOf(state, o.personId)
  return { id: randomUUID(), machineId: o.machineId, harnessId: randomUUID(), machineOwnerId: me.id, contributorId: me.id,
    membershipGeneration: me.generation, hostGrant: null, name: o.name ?? 'Buddy', configuration: o.configuration,
    buddyOf: { personId: me.id, generation: me.generation }, ...extra }
}
const chatOf = (id: string, kind: 'buddy' | 'swarm-buddy', title: string, agentIds: string[], me: { id: string; generation: string }, projectId?: string): Conversation =>
  ({ id, kind, ...(projectId ? { projectId } : {}), title, leadId: null, agentIds, archived: false, brief: '', checks: [], assignment: null,
    lastMessageSequence: 0, audience: { people: [{ id: me.id, generation: me.generation }] } })

/** [personId]'s main Buddy on [machineId], first in their one Buddy chat of the Swarm (buddies.ts swarmBuddyChatId). With
 *  `listed`, a further Buddy of theirs (task #3818) in a chat of its own that their main chat lists. With `ownMachine`, its
 *  machine is their own one outside the Swarm, recorded Buddy-only under that name (machines.ts ContributedMachine.buddyOnly). */
export function storeBuddy(db: PrismaClient, tab: string, o: Placement & { listed?: boolean; ownMachine?: string }): Promise<StoredBuddy> {
  return rewriteParts(db, tab, state => {
    const me = personOf(state, o.personId)
    if (o.ownMachine) {
      (state.machines ??= []).push({ machineId: o.machineId, name: o.ownMachine, cwd: '/swarm', scope: 'swarm', engines: [o.configuration.engine],
        maxAgents: 1, contributorId: me.id, membershipGeneration: me.generation, generation: randomUUID(), paused: false, buddyOnly: true })
    }
    const buddy = buddyAgent(state, o, { buddyScope: 'swarm' })
    state.agents.push(buddy)
    const mainId = swarmBuddyChatId(me)
    const chat = chatOf(o.listed ? `${mainId}-${buddy.id}` : mainId, 'swarm-buddy', buddy.name, [buddy.id], me)
    state.conversations.push(chat)
    if (o.listed) {
      const main = state.conversations.find(c => c.id === mainId)!
      main.buddyChats = [...main.buddyChats ?? [], chat.id]
    }
    return { agentId: buddy.id, harnessId: buddy.harnessId, chat: chat.id }
  })
}

/** A thread session of [chat]'s Buddy, rooted at [session.thread]: plain, or of one project (`projectId`, read narrow), with
 *  its place in the chat's record of its sessions, as its host's start left it. */
export function storeSession(db: PrismaClient, tab: string, chat: string, session: BuddySession): Promise<StoredBuddy> {
  return rewriteParts(db, tab, state => {
    const group = state.conversations.find(c => c.id === chat)!
    const main = state.agents.find(a => group.agentIds.includes(a.id) && a.buddyOf && !a.buddySession)!
    const swarm = group.kind === 'swarm-buddy'
    const narrow = !swarm || !!session.projectId
    const agent = buddyAgent(state, { personId: main.buddyOf!.personId, machineId: main.machineId, configuration: main.configuration, name: main.name }, {
      buddySession: session, ...(narrow ? { buddyNarrow: true as const, projectId: session.projectId ?? group.projectId } : { buddyScope: 'swarm' as const }) })
    state.agents.push(agent)
    group.agentIds.push(agent.id)
    group.buddySessions = [...group.buddySessions ?? [], { thread: session.thread, startId: randomUUID(), agentId: agent.id, at: Date.now() }]
    return { agentId: agent.id, harnessId: agent.harnessId, chat }
  })
}

/** [personId]'s older Buddy chat in [projectId] (buddies.ts buddyChatId), from before one Buddy per Swarm, with its one-project
 *  Buddy on [machineId]. */
export function storeProjectBuddy(db: PrismaClient, tab: string, projectId: string, o: Placement): Promise<StoredBuddy> {
  return rewriteParts(db, tab, state => {
    const me = personOf(state, o.personId)
    const buddy = buddyAgent(state, o, { buddyNarrow: true, projectId })
    state.agents.push(buddy)
    const chat = chatOf(buddyChatId(projectId, me), 'buddy', buddy.name, [buddy.id], me, projectId)
    state.conversations.push(chat)
    return { agentId: buddy.id, harnessId: buddy.harnessId, chat: chat.id }
  })
}
