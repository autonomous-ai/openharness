import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validateBody, validateParams, validateQuery } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { operationSchema } from '../superTabs/commands.js'
import { SuperTabError } from '../superTabs/model.js'
import { SuperTabStore } from '../superTabs/store.js'
import { routingPolicySchema } from '../superTabs/routingPolicy.js'
import { nativeEventSchema, openNativeSchema } from '../superTabs/native.js'
import { machineObservationSchema } from '../superTabs/machines.js'
import { joinSwarmSchema, previewJoinSchema, saveSharingSchema } from '../superTabs/sharing.js'
import { holdReason } from '../superTabs/holdNotice.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const tabParams = z.object({ tabId: id })
const agentQuery = z.object({ asAgentId: id.optional() }).strict()
const create = z.object({ operationId: id, name: z.string().trim().min(1).max(160), projectVisibility: z.enum(['public', 'private']).optional() }).strict()
const operation = operationSchema.extend({ asAgentId: id.optional() })
const listQuery = z.object({ after: id.optional() }).strict()
const startParams = tabParams.extend({ startId: id })
const nativeParams = tabParams.extend({ contextId: id })
const messageParams = tabParams.extend({ conversationId: id })
const messageQuery = agentQuery.extend({ after: z.coerce.number().int().nonnegative().safe().optional(),
  before: z.coerce.number().int().nonnegative().safe().optional(), messageId: id.optional() })
  .refine(q => [q.after, q.before, q.messageId].filter(value => value !== undefined).length <= 1, 'Choose one message cursor or exact message.')
const decisionParams = tabParams.extend({ decisionId: id })
const hostParams = z.object({ machineId: id })
const hostStartParams = hostParams.extend({ tabId: id, startId: id })
const machineParams = hostParams.extend({ tabId: id })
const deliveryParams = tabParams.extend({ agentId: id })
const deliveryActionParams = deliveryParams.extend({ deliveryId: id })
const deliveryAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claim'), claimId: id }).strict(),
  z.object({ type: z.literal('ack'), claimId: id, receipt: z.string().min(1).max(2000), uncertain: z.boolean() }).strict(),
  z.object({ type: z.literal('hold'), claimId: id, reason: holdReason }).strict(),
])
const savePolicy = z.object({ revision: z.number().int().nonnegative().safe(), policy: routingPolicySchema }).strict()
const stop = z.object({ assignmentId: id, receipt: z.string().min(1).max(2000) }).strict()

async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try { sendSuccess(reply, await action()) } catch (error) {
    if (!(error instanceof SuperTabError)) throw error
    sendError(reply, error.message, error.code, error.status)
  }
}

/** Uses the normal authenticated control API. It never accepts caller-provided host/contributor identities. */
export async function superTabRoutes(app: FastifyInstance, options: { store?: SuperTabStore } = {}) {
  const store = options.store ?? new SuperTabStore(prisma)
  app.get<{ Params: z.infer<typeof hostParams> }>('/api/super-tabs/hosts/:machineId/pools', { preHandler: validateParams(hostParams) },
    (req, reply) => respond(reply, () => store.hostPools(req.user!, req.params.machineId)))
  app.get<{ Params: z.infer<typeof hostStartParams> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId', { preHandler: validateParams(hostStartParams) },
    (req, reply) => respond(reply, () => store.start(req.user!, req.params.tabId, req.params.startId, undefined, req.params.machineId)))
  app.post<{ Params: z.infer<typeof hostStartParams>; Body: z.infer<typeof operationSchema> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId',
    { preHandler: [validateParams(hostStartParams), validateBody(operationSchema)] }, (req, reply) => respond(reply, async () => {
      if (!('startId' in req.body.command) || req.body.command.startId !== req.params.startId) throw new SuperTabError('FORBIDDEN', 'The host request must name this start.', 403)
      return store.execute(req.user!, req.params.tabId, req.body, undefined, req.params.machineId)
    }))
  app.post<{ Params: z.infer<typeof machineParams>; Body: z.infer<typeof machineObservationSchema> }>('/api/super-tabs/:tabId/machines/:machineId',
    { preHandler: [validateParams(machineParams), validateBody(machineObservationSchema)] },
    (req, reply) => respond(reply, () => store.observeMachine(req.user!, req.params.tabId, req.params.machineId, req.body)))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof openNativeSchema> }>('/api/super-tabs/:tabId/native',
    { preHandler: [validateParams(tabParams), validateBody(openNativeSchema)] },
    (req, reply) => respond(reply, () => store.native.open(req.user!, req.params.tabId, req.body)))
  app.get<{ Params: z.infer<typeof nativeParams> }>('/api/super-tabs/:tabId/native/:contextId',
    { preHandler: validateParams(nativeParams) },
    (req, reply) => respond(reply, () => store.native.read(req.user!, req.params.tabId, req.params.contextId)))
  app.post<{ Params: z.infer<typeof nativeParams>; Body: z.infer<typeof nativeEventSchema> }>('/api/super-tabs/:tabId/native/:contextId',
    { preHandler: [validateParams(nativeParams), validateBody(nativeEventSchema)] },
    (req, reply) => respond(reply, () => store.native.append(req.user!, req.params.tabId, req.params.contextId, req.body)))
  app.get('/api/super-tabs/routing-policy', (req, reply) => respond(reply, () => store.accountPolicy(req.user!)))
  app.post<{ Body: z.infer<typeof savePolicy> }>('/api/super-tabs/routing-policy', { preHandler: validateBody(savePolicy) },
    (req, reply) => respond(reply, () => store.saveAccountPolicy(req.user!, req.body.revision, req.body.policy)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/routing-policy',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.tabPolicy(req.user!, req.params.tabId, req.query.asAgentId)))
  app.get<{ Querystring: z.infer<typeof listQuery> }>('/api/super-tabs', { preHandler: validateQuery(listQuery) },
    (req, reply) => respond(reply, () => store.list(req.user!, req.query.after)))
  app.post<{ Body: z.infer<typeof create> }>('/api/super-tabs', { preHandler: validateBody(create) },
    (req, reply) => respond(reply, () => store.create(req.user!, req.body.operationId, req.body.name, req.body.projectVisibility)))
  app.get('/api/super-tabs/invitations', (req, reply) => respond(reply, () => store.invitations(req.user!)))
  app.get<{ Params: z.infer<typeof tabParams> }>('/api/super-tabs/:tabId/sharing',
    { preHandler: validateParams(tabParams) },
    (req, reply) => respond(reply, () => store.sharing(req.user!, req.params.tabId)))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof saveSharingSchema> }>('/api/super-tabs/:tabId/sharing',
    { preHandler: [validateParams(tabParams), validateBody(saveSharingSchema)] },
    (req, reply) => respond(reply, () => store.saveSharing(req.user!, req.params.tabId, req.body)))
  // Preview uses a body so bearer link tokens never enter HTTP access/error logs.
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof previewJoinSchema> }>('/api/super-tabs/:tabId/join/preview',
    { preHandler: [validateParams(tabParams), validateBody(previewJoinSchema)] },
    (req, reply) => respond(reply, () => store.previewJoin(req.user!, req.params.tabId, req.body.token)))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof joinSwarmSchema> }>('/api/super-tabs/:tabId/join',
    { preHandler: [validateParams(tabParams), validateBody(joinSwarmSchema)] },
    (req, reply) => respond(reply, () => store.join(req.user!, req.params.tabId, req.body)))
  app.get<{ Params: z.infer<typeof hostParams> }>('/api/super-tabs/hosts/:machineId', { preHandler: validateParams(hostParams) },
    (req, reply) => respond(reply, () => store.hostTabs(req.user!, req.params.machineId)))
  app.get<{ Params: z.infer<typeof hostParams> }>('/api/super-tabs/hosts/:machineId/assignments', { preHandler: validateParams(hostParams) },
    (req, reply) => respond(reply, () => store.hostAssignments(req.user!, req.params.machineId)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.read(req.user!, req.params.tabId, req.query.asAgentId)))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof operation> }>('/api/super-tabs/:tabId/commands',
    { preHandler: [validateParams(tabParams), validateBody(operation, { named: true })] },
    (req, reply) => respond(reply, () => store.execute(req.user!, req.params.tabId,
      { operationId: req.body.operationId, command: req.body.command }, req.body.asAgentId)))
  app.get<{ Params: z.infer<typeof startParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/starts/:startId',
    { preHandler: [validateParams(startParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.start(req.user!, req.params.tabId, req.params.startId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof messageParams>; Querystring: z.infer<typeof messageQuery> }>('/api/super-tabs/:tabId/conversations/:conversationId/messages',
    { preHandler: [validateParams(messageParams), validateQuery(messageQuery)] },
    (req, reply) => respond(reply, () => store.messages(req.user!, req.params.tabId, req.params.conversationId, req.query, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof messageParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/conversations/:conversationId/attempts',
    { preHandler: [validateParams(messageParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.attempts(req.user!, req.params.tabId, req.params.conversationId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/route-decisions',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.routeDecisions(req.user!, req.params.tabId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof decisionParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/route-decisions/:decisionId',
    { preHandler: [validateParams(decisionParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.routeDecision(req.user!, req.params.tabId, req.params.decisionId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof deliveryParams> }>('/api/super-tabs/:tabId/agents/:agentId/deliveries',
    { preHandler: validateParams(deliveryParams) },
    (req, reply) => respond(reply, () => store.deliveries(req.user!, req.params.tabId, req.params.agentId)))
  app.post<{ Params: z.infer<typeof deliveryActionParams>; Body: z.infer<typeof deliveryAction> }>('/api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId',
    { preHandler: [validateParams(deliveryActionParams), validateBody(deliveryAction)] },
    (req, reply) => respond(reply, () => store.delivery(req.user!, req.params.tabId, req.params.agentId, req.params.deliveryId, req.body)))
  app.get<{ Params: z.infer<typeof deliveryActionParams> }>('/api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId',
    { preHandler: validateParams(deliveryActionParams) },
    (req, reply) => respond(reply, () => store.deliveryReceipt(req.user!, req.params.tabId, req.params.agentId, req.params.deliveryId)))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof stop> }>('/api/super-tabs/:tabId/stopped',
    { preHandler: [validateParams(tabParams), validateBody(stop)] },
    (req, reply) => respond(reply, () => store.stopped(req.user!, req.params.tabId, req.body.assignmentId, req.body.receipt)))
}
