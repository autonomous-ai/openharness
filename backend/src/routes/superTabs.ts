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

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const tabParams = z.object({ tabId: id })
const agentQuery = z.object({ asAgentId: id.optional() }).strict()
const create = z.object({ operationId: id, name: z.string().trim().min(1).max(160) }).strict()
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
const deliveryParams = tabParams.extend({ agentId: id })
const deliveryActionParams = deliveryParams.extend({ deliveryId: id })
const deliveryAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claim'), claimId: id }).strict(),
  z.object({ type: z.literal('ack'), claimId: id, receipt: z.string().min(1).max(2000), uncertain: z.boolean() }).strict(),
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
    (req, reply) => respond(reply, () => store.create(req.user!, req.body.operationId, req.body.name)))
  app.get('/api/super-tabs/invitations', (req, reply) => respond(reply, () => store.invitations(req.user!)))
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
