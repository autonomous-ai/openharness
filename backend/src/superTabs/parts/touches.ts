import type { Command, CommandContext } from '../commands.js'
import type { Actor, CommandEffects, SuperTabState } from '../model.js'
import { agentRole } from '../model.js'
import type { ContributedMachine } from '../machines.js'
import { agentProjectId, canReadProject, groupProject, projectsOf } from '../projects.js'
import type { Touch } from './commit.js'
import { waitsNow } from '../leaderboard/record.js'

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
  const progress = (projectId: string | undefined) => { if (projectId && before.projects) touches.push({ kind: 'progress', key: projectId }) }
  const machine = (key: string) => touches.push({ kind: 'machine', key })
  const projectOfGroup = (id: string) => { const g = before.conversations.find(c => c.id === id); return g && !g.kind ? groupProject(before, g) : undefined }
  const leadGroupOf = (projectId: string | undefined) => projectsOf(before).find(p => p.id === projectId)?.leadConversationId
  /** The Lead check (`controls`, `mayDrive`, `ruleChange`) reads its project's Lead conversation (design D2). */
  const leadCheck = (projectId: string | undefined) => { if (actor.kind === 'agent') group(leadGroupOf(projectId)) }
  const agentProject = (id: string) => { const a = before.agents.find(x => x.id === id); return a && agentProjectId(before, a) }
  /** Every slot `machineSlots` counts for a start on this machine: the Mac and its team account share them (machines.ts). */
  const slots = (machineId: string) => {
    const pool = before.machines?.find(m => m.machineId === machineId)
    const mac: ContributedMachine | undefined = pool?.hostMachineId ? before.machines?.find(m => m.machineId === pool.hostMachineId) : pool
    for (const id of new Set([machineId, mac?.machineId, ...(before.machines ?? []).filter(m => mac && m.hostMachineId === mac.machineId).map(m => m.machineId)])) {
      if (id) machine(id)
    }
  }

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

  switch (command.type) {
    case 'tab.rename': case 'tab.project': case 'tab.pause':
      if (actor.kind === 'agent') group('lead')
      break
    case 'machine.contribute':
      if (!before.machines?.some(m => m.machineId === command.machineId)) head()
      break
    case 'agent.avatar':
      leadCheck(agentProject(command.agentId))
      break
    case 'project.report': case 'project.repository': case 'project.skills':
      leadCheck(command.projectId)
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
      group(command.reviewOf)
      member(command.requesterId)
      break
    }
    case 'conversation.merged':
      leadCheck(projectOfGroup(command.conversationId)?.id)
      break
    case 'conversation.requester':
      leadCheck(projectOfGroup(command.conversationId)?.id)
      member(command.personId ?? undefined)
      break
    case 'message.send': {
      // An answer to waiting work is credited to the person it waits on (leaderboard/record.ts): a concurrent change to who
      // that is meets the answer here.
      const waiting = before.conversations.find(c => c.id === command.conversationId)
      if (waiting && waitsNow(waiting)) member(waiting.requesterId)
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
      progress(projectOfGroup(command.request.conversationId)?.id)
      break
    case 'agent.startDispatch': case 'agent.started': {
      const start = before.starts?.find(s => s.id === command.startId)
      if (!start) break
      group(start.request.conversationId)
      member(start.contributorId)
      if (command.type === 'agent.startDispatch') { slots(start.request.machineId); head(); progress(projectOfGroup(start.request.conversationId)?.id) }
      else head()
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
    case 'work.assign': {
      head()
      progress(projectOfGroup(command.conversationId)?.id)
      const target = before.agents.find(a => a.id === command.agentId)
      const reviewers = before.conversations.find(c => c.id === command.conversationId)?.agentIds
        .filter(id => before.agents.some(a => a.id === id && agentRole(a) === 'reviewer')) ?? []
      for (const id of reviewers) agent(id)
      const unsettled = before.starts?.find(s => s.poolGeneration && !s.poolSettled && target && s.request.machineId === target.machineId && s.harnessId === target.harnessId)
      if (unsettled) touches.push({ kind: 'start', key: unsettled.id })
      break
    }
    case 'work.cancel':
      leadCheck(projectOfGroup(command.conversationId)?.id)
      progress(projectOfGroup(command.conversationId)?.id)
      break
    case 'work.status':
      // Finished work puts its worker's decision before the Lead (finishWorker): the Lead's next start, assignment or
      // route touches the same part, so it cannot pass over that decision on a stale read (design ruling R5).
      if (command.status === 'done' || command.status === 'stopped') progress(projectOfGroup(command.conversationId)?.id)
      break
    case 'work.define':
      if (before.conversations.find(c => c.id === command.conversationId)?.assignment) progress(projectOfGroup(command.conversationId)?.id)
      break
    case 'route.record': {
      head()
      progress(projectOfGroup(command.conversationId)?.id)
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
    case 'conversation.audience': {
      // Rule (b): everyone the change removes sees it through their own part (design section 1.2).
      const kept = new Set(effects.state.conversations.find(c => c.id === command.conversationId)?.audience?.people.map(p => p.id))
      for (const person of before.conversations.find(c => c.id === command.conversationId)?.audience?.people ?? []) if (!kept.has(person.id)) member(person.id)
      group(leadGroupOf(projectOfGroup(command.conversationId)?.id))
      break
    }
    case 'agent.screen': case 'agent.input':
      leadCheck(agentProject(command.agentId))
      break
  }
  return touches
}
