import type { Command, CommandContext } from '../commands.js'
import type { Actor, CommandEffects, SuperTabState } from '../model.js'
import { agentProjectId, canReadProject, groupProject, projectsOf } from '../projects.js'
import type { Touch } from './commit.js'
import { waitsNow } from '../leaderboard/record.js'
import { buddiesHearing } from '../buddyNews.js'
import { defaultBuddy } from '../buddies.js'
import { mainBuddyOf } from '../buddySessions.js'

/**
 * The parts a command relies on without writing them (design section 1.2, column T). A part the command also writes is
 * skipped when committing, so listing it here is harmless. Each touch is a guarded version bump: a concurrent command that
 * changes that part makes one of the two retry against the other's result.
 */
export function touchesFor(command: Command, actor: Actor, before: SuperTabState, effects: Pick<CommandEffects, 'state' | 'messages'>,
  context: Pick<CommandContext, 'delivery' | 'routeDecision'> = {}): Touch[] {
  const touches: Touch[] = []
  const group = (key: string | undefined) => { if (key) touches.push({ kind: 'group', key }) }
  const agent = (key: string | undefined) => { if (key && before.agents.some(a => a.id === key)) touches.push({ kind: 'agent', key }) }
  const member = (key: string | undefined) => { if (key && before.people.some(p => p.id === key)) touches.push({ kind: 'member', key }) }
  const head = () => touches.push({ kind: 'head', key: 'head' })
  const machine = (key: string) => touches.push({ kind: 'machine', key })
  const projectOfGroup = (id: string) => { const g = before.conversations.find(c => c.id === id); return g && !g.kind ? groupProject(before, g) : undefined }
  const leadGroupOf = (projectId: string | undefined) => projectsOf(before).find(p => p.id === projectId)?.leadConversationId
  /** The Lead check (`controls`, `mayDrive`, `ruleChange`) reads its project's Lead conversation (design D2). */
  const leadCheck = (projectId: string | undefined) => { if (actor.kind === 'agent') group(leadGroupOf(projectId)) }
  const agentProject = (id: string) => { const a = before.agents.find(x => x.id === id); return a && agentProjectId(before, a) }
  /** Every slot `machineSlots` counts for a start on this machine: the Mac and its team account share them (machines.ts). */
  /** A Member's start, from the first Accept or the dispatch pass (members.ts, task #4697): its free name is claimed on the head,
   *  and its computer's slots counted as any start's. */
  const newMemberStarts = () => {
    for (const start of effects.state.starts ?? []) {
      if ((start.request.member || start.request.helperOf) && !(before.starts ?? []).some(s => s.id === start.id)) { head(); slots(start.request.machineId) }
    }
  }
  const slots = (machineId: string) => machine(machineId)

  // D1: the actor's own part (spec ruling 2).
  if (actor.kind === 'person') member(actor.userId)
  else agent(actor.agentId)
  // D2: the group a command names, which it reads even when it does not write it.
  if ('conversationId' in command && command.type !== 'invite.create') group(command.conversationId)
  // D3: the agent a command names. Not a message's recipients: every recipient is in the conversation the message writes,
  // and removing an agent writes every conversation it is in (rule b), so the conversation guards it. Touching them would
  // make every worker's post touch its Lead, and posts in different groups would conflict again (spec goal 1).
  if ('agentId' in command) agent(command.agentId)
  // D9: a custom role choice reads the role sets on the head.
  if ('roleId' in command && command.roleId) head()
  if (command.type === 'agent.start' && command.request.roleId) head()

  // Buddy input also guards an already awake recipient, so a concurrent sleep retries against that input (#3824).
  for (const buddy of buddiesHearing(effects.state, effects.messages)) { agent(buddy.id); member(buddy.buddyOf!.personId) }

  switch (command.type) {
    // Every person's write relies on the Swarm not being deleted (deletion.ts): the delete moves each person's part, so one
    // landing at the same moment retries against it and is refused (security review 2 of #2457).
    case 'swarm.delete':
      for (const person of before.people) member(person.id)
      break
    case 'tab.rename': case 'tab.project': case 'tab.pause':
      if (actor.kind === 'agent') group('lead')
      break
    case 'machine.contribute':
      if (!before.machines?.some(m => m.machineId === command.machineId)) head()
      break
    case 'buddy.engine': {
      const chat = before.conversations.find(c => c.id === command.conversationId)
      const buddy = command.conversationId ? chat && mainBuddyOf(before, chat)
        : actor.kind === 'person' ? defaultBuddy(before, actor.userId) : undefined
      if (buddy) machine(buddy.machineId)
      break
    }
    case 'task.suggest': case 'task.approve': case 'task.reject': {
      head()
      const card = before.conversations.find(c => c.id === command.conversationId)
      member(card?.taskApproval?.personId)
      agent(card?.taskApproval?.suggestedAgentId)
      leadCheck(card && groupProject(before, card).id)
      newMemberStarts()
      break
    }
    case 'buddy.create':
      // It may record a Buddy-only machine, or count on one that a concurrent removal of its last Buddy ends.
      slots(command.machineId)
      // Its name is claimed against every other name in the Swarm, as buddy.rename's is (below).
      head()
      break
    case 'agent.avatar':
      leadCheck(agentProject(command.agentId))
      break
    // A Buddy's name is claimed against every other name in the Swarm, some of them in chats a command does not load: the
    // head guards the claim, as agent.start and agent.add touch it, so of two claims at once one retries and is refused
    // (review of #2094).
    case 'buddy.rename':
    // A new agent's free name is picked against every name in the Swarm (agentRename.ts newAgentName, review of #3560).
    case 'agent.new':
      head()
      break
    case 'project.report': case 'project.repository':
    // The coordinator's own writes check it leads the project, which a concurrent Lead change ends (review of phase 2).
    case 'instructions.save': case 'note.add': case 'note.remove': case 'project.coordinatorName': case 'project.answers': case 'project.about':
      leadCheck(command.projectId)
      break
    // A rules save writes its own collection, no part of the project: by anyone, it guards on the project's Lead chat, which a
    // project delete and a tab's close write, so a first save never lands on a project being deleted (security review 2 of
    // #3929). The Lead check above is part of the same touch.
    case 'rules.set':
      group(leadGroupOf(command.projectId))
      break
    // An older CLI's rule is a save to its project's instructions, the coordinator's like instructions.save (commands.ts).
    case 'rule.set':
      leadCheck(command.projectId ?? (actor.kind === 'agent' ? agentProject(actor.agentId) : undefined))
      break
    case 'project.sharing':
      // Rule (b): everyone who loses the project sees the change through their own part (design section 1.2).
      for (const person of before.people) {
        const project = projectsOf(before).find(p => p.id === command.projectId)
        const after = projectsOf(effects.state).find(p => p.id === command.projectId)
        const reader = { kind: 'person' as const, userId: person.id, email: person.email }
        if (project && canReadProject(before, reader, project) && !(after && canReadProject(effects.state, reader, after))) member(person.id)
      }
      break
    case 'conversation.create': {
      const projectId = command.projectId ?? (actor.kind === 'agent' ? agentProject(actor.agentId) : 'lead')
      group(leadGroupOf(projectId))
      member(command.requesterId)
      for (const created of effects.state.conversations.filter(c => !before.conversations.some(b => b.id === c.id))) member(created.requesterId)
      break
    }
    case 'conversation.unlink':
      leadCheck(projectOfGroup(command.conversationId)?.id)
      break
    case 'conversation.requester':
      leadCheck(projectOfGroup(command.conversationId)?.id)
      member(command.personId ?? undefined)
      break
    case 'message.send': {
      if (command.handoff) leadCheck(projectOfGroup(command.conversationId)?.id)
      // Every start a post makes, a thread session's or the one Buddy's in an older project chat (commands.ts
      // startOldChatBuddy), counts its machine's slots, as buddy.create's does, and meets a concurrent removal of the Buddy it
      // runs beside: a Remove racing it can never leave it running (security review 2 of #2435).
      const start = effects.state.starts?.find(s => !before.starts?.some(b => b.id === s.id))
      if (start) {
        slots(start.request.machineId)
        head()
        const person = start.request.buddyOf?.personId
        for (const main of before.agents.filter(a => person && a.buddyOf?.personId === person && !a.buddySession)) agent(main.id)
      }
      // An answer to waiting work is credited to the person it waits on (leaderboard/record.ts): a concurrent change to who
      // that is meets the answer here.
      const waiting = before.conversations.find(c => c.id === command.conversationId)
      if (waiting && waitsNow(waiting)) member(waiting.requesterId)
      // An agent named from outside the group joins it (commands.ts joinsProject), so D3's reason for leaving recipients
      // alone does not hold for it yet: its removal meets the post here. A member already there stays untouched.
      for (const id of command.recipientIds) if (waiting && !waiting.agentIds.includes(id)) agent(id)
      break
    }
    case 'agent.add': {
      head()
      const target = effects.state.agents.find(a => a.machineId === command.machineId && a.harnessId === command.harnessId)
      member(target?.contributorId)
      break
    }
    case 'agent.start':
      head()
      group(command.request.conversationId)
      slots(command.request.machineId)
      member(effects.state.starts?.find(s => !before.starts?.some(b => b.id === s.id))?.contributorId)
      break
    case 'agent.startDispatch': case 'agent.started': {
      const start = before.starts?.find(s => s.id === command.startId)
      if (!start) break
      group(start.request.conversationId)
      member(start.contributorId)
      if (command.type === 'agent.startDispatch') slots(start.request.machineId)
      head()
      break
    }
    case 'agent.release':
      leadCheck(agentProject(command.agentId))
      break
    case 'agent.rebind':
      machine(command.machineId)
      break
    case 'conversation.agent':
      head()
      break
    case 'delivery.resolve':
      if (context.delivery) {
        agent(context.delivery.agentId)
        group(context.delivery.conversationId)
      }
      break
    case 'route.record': {
      head()
      const pick = command.decision.candidates.find(c => c.id === command.decision.pick)
      if (pick?.kind === 'member') agent(pick.agentId)
      break
    }
    case 'route.override': {
      const chosen = context.routeDecision?.record.candidates.find(c => c.id === command.candidateId)
      if (chosen?.kind === 'member') agent(chosen.agentId)
      group(context.routeDecision?.conversationId)
      break
    }
    case 'route.modelResult':
      group(context.routeDecision?.conversationId)
      break
    case 'agent.screen': case 'agent.input':
      leadCheck(agentProject(command.agentId))
      break
  }
  return touches
}
