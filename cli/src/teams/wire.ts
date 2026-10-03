import { z } from 'zod'
import { OperationId, TeamError, TEAM_PROTOCOL, type Actor } from './model.js'
import type { TeamService } from './service.js'
import type { TeamMailbox } from './mailbox.js'

export const TEAM_REQUEST_TYPES = new Set(['team', 'team_delivery'])
export const TEAM_RESULT_TYPES = new Set([...TEAM_REQUEST_TYPES].map(type => `${type}_result`))

export function teamFailure(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof TeamError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'TEAM_UNAVAILABLE',
    detail: error instanceof TeamError ? error.message : error instanceof z.ZodError ? error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      : 'Team communication is temporarily unavailable. Your existing records are preserved.',
  }
}

export async function teamRequest(service: TeamService, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const action = z.enum(['capabilities', 'list', 'create', 'get', 'members', 'ask', 'reply', 'inbox', 'status', 'cancel', 'pause', 'resume', 'archive', 'member', 'add_member']).parse(payload.action)
    const actor: Actor = payload.memberKey === undefined ? { kind: 'owner' } : { kind: 'member', key: z.string().parse(payload.memberKey) }
    if (action === 'capabilities') return { protocol: TEAM_PROTOCOL }
    if (action === 'list') return service.list(actor)
    if (action === 'create') return { team: await service.create(payload, actor) }
    const teamId = OperationId.parse(payload.teamId)
    await service.authorizeTask(teamId, actor, action)
    switch (action) {
      case 'get': return { team: await service.snapshot(teamId, actor) }
      case 'members': {
        const team = await service.snapshot(teamId, actor)
        return { teamId, name: team.name, state: team.state, members: team.members,
          ...(actor.kind === 'member' ? { memberId: service.memberId(teamId, actor) } : {}) }
      }
      case 'ask': return { exchange: service.ask(teamId, { ...payload, from: actor.kind === 'member' ? service.memberId(teamId, actor) : payload.from }, actor) }
      case 'reply': {
        const questionId = OperationId.parse(payload.questionId)
        const exchange = service.reply(teamId, questionId, payload.text, payload.evidence, actor, payload.memberId as string | undefined)
        await service.questionReplied(teamId, questionId, actor)
        return { exchange }
      }
      case 'inbox': return service.inbox(teamId, actor, payload.memberId as string | undefined)
      case 'status': return { exchange: await service.readStatus(teamId, OperationId.parse(payload.questionId), actor) }
      case 'cancel': return { exchange: service.cancel(teamId, OperationId.parse(payload.questionId), actor) }
      case 'pause': case 'resume': case 'archive': service.setState(teamId, action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'archived', actor); break
      case 'member': service.updateMember(teamId, payload.member, actor); break
      case 'add_member': await service.addMember(teamId, payload.member, actor); break
    }
    return { team: await service.snapshot(teamId, actor) }
  } catch (error) { return teamFailure(error) }
}

export function teamDeliveryRequest(mailbox: TeamMailbox, payload: Record<string, unknown>): Record<string, unknown> {
  try {
    const action = z.enum(['send', 'status', 'cancel', 'consume', 'hold', 'release']).parse(payload.action)
    const delivery = z.record(z.string(), z.unknown()).parse(payload.delivery)
    const receipt = action === 'send' ? mailbox.accept(delivery)
      : action === 'status' ? mailbox.status(z.string().parse(delivery.id))
        : action === 'hold' || action === 'release' ? mailbox.hold(z.string().parse(delivery.id), action === 'hold')
        : mailbox.cancel(z.string().parse(delivery.id), action === 'consume')
    return { receipt }
  } catch (error) { return teamFailure(error) }
}
