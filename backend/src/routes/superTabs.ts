import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { env } from '../config/env.js'
import multipart from '@fastify/multipart'
import { attachmentsFromEnv, MAX_ATTACHMENT_BYTES, MAX_AVATAR_BYTES } from '../superTabs/attachments.js'
import { validateBody, validateParams, validateQuery } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { operationSchema } from '../superTabs/commands.js'
import { fail, SuperTabError } from '../superTabs/model.js'
import { SuperTabStore } from '../superTabs/store.js'
import { routingPolicySchema } from '../superTabs/routingPolicy.js'
import { nativeEventSchema, openNativeSchema } from '../superTabs/native.js'
import { machineObservationSchema } from '../superTabs/machines.js'
import { joinSwarmSchema, previewJoinSchema, saveSharingSchema } from '../superTabs/sharing.js'
import { holdReason } from '../superTabs/holdReason.js'
import { GitHubAppError } from '../github/app.js'
import { githubRepository } from '../github/repository.js'
import { attribution } from '../github/attribution.js'
import { githubTokensFromEnv, type GitHubTokens } from '../github/tokens.js'
import { logger } from '../utils/logger.js'
import { SwarmReads } from '../superTabs/read/service.js'
import { HostReads } from '../superTabs/read/host.js'
import { UPDATE_REQUIRED } from '../superTabs/read/contract.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const tabParams = z.object({ tabId: id })
const agentQuery = z.object({ asAgentId: id.optional() }).strict()
const create = z.object({ operationId: id, name: z.string().trim().min(1).max(160), projectVisibility: z.enum(['public', 'private']).optional() }).strict()
const operation = operationSchema.extend({ asAgentId: id.optional() })
const listQuery = z.object({ after: id.optional() }).strict()
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/)
const changesQuery = agentQuery.extend({ cursor })
const leaderboardQuery = z.object({ projectId: id, week: z.coerce.number().int().nonnegative().safe().optional() }).strict()
const dormantQuery = agentQuery.extend({ dormant: z.literal('1'), projectId: id.optional(), before: cursor.optional() })
const groupParams = tabParams.extend({ conversationId: id })
const hostChangesQuery = z.object({ cursor: cursor.optional(), full: z.literal('1').optional() }).strict()
const etag = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const hostChangesBody = z.object({ cursor: cursor.optional(), full: z.boolean().optional(),
  held: z.record(id, etag).refine(held => Object.keys(held).length <= 500, 'At most 500 Swarms.').optional() }).strict()
const startParams = tabParams.extend({ startId: id })
const nativeParams = tabParams.extend({ contextId: id })
const messageParams = tabParams.extend({ conversationId: id })
// Pages by (sequence, id) (design 4.6): `afterId`/`beforeId` go with `after`/`before`, from the previous page's `next`.
const messageQuery = agentQuery.extend({ after: z.coerce.number().int().nonnegative().safe().optional(),
  before: z.coerce.number().int().nonnegative().safe().optional(), messageId: id.optional(), afterId: id.optional(), beforeId: id.optional() })
  .refine(q => [q.after, q.before, q.messageId].filter(value => value !== undefined).length <= 1, 'Choose one message cursor or exact message.')
  .refine(q => (q.afterId === undefined || q.after !== undefined) && (q.beforeId === undefined || q.before !== undefined), 'Send afterId with after, beforeId with before.')
const decisionParams = tabParams.extend({ decisionId: id })
const roleParams = tabParams.extend({ projectId: id, roleId: id })
const terminalParams = tabParams.extend({ requestId: id })
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
const mentionQuery = z.object({ state: z.enum(['waiting', 'earlier']) }).strict()
const personDecisionQuery = agentQuery.extend({ state: z.enum(['open', 'answered']) }).strict()
const savePolicy = z.object({ revision: z.number().int().nonnegative().safe(), policy: routingPolicySchema }).strict()
const stop = z.object({ assignmentId: id, receipt: z.string().min(1).max(2000) }).strict()
const githubToken = z.object({ machineId: id }).strict()
const githubStartToken = z.object({ always: z.boolean().optional() }).strict()


async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try { sendSuccess(reply, await action()) } catch (error) {
    if (error instanceof GitHubAppError) return sendError(reply, error.message, error.code, error.status, error.details)
    if (!(error instanceof SuperTabError)) throw error
    sendError(reply, error.message, error.code, error.status)
  }
}

/** Uses the normal authenticated control API. It never accepts caller-provided host/contributor identities.
 *  `github` is the Harness GitHub App (github/tokens.ts): read from the environment unless given, null when off. */
/** Full-state reads of clients from before Swarms were stored by parts (design 4.11): every old client reads one of them
 *  before or right after any action, so it meets this at once. */
const updateRequired = (_req: unknown, reply: FastifyReply) => sendError(reply, UPDATE_REQUIRED.message, UPDATE_REQUIRED.code, UPDATE_REQUIRED.status)

export async function superTabRoutes(app: FastifyInstance, options: { store?: SuperTabStore; github?: GitHubTokens | null; reads?: SwarmReads; hosts?: HostReads } = {}) {
  const github = options.github !== undefined ? options.github : await githubTokensFromEnv(env)
  // A task that ends revokes the token it was given; a revoke that fails is logged inside and never blocks the write.
  const store = options.store ?? new SuperTabStore(prisma, Date.now, attachmentsFromEnv(env),
    { workEnded: (tabId, ended) => { void github?.release(tabId, ended).catch(error => logger.warn('[github] release failed', { tabId, error: String(error) })) },
      // A team account has no git login of its own: without the app it takes no teammates' work.
      teamAccountsIdle: !github })
  const reads = options.reads ?? new SwarmReads(store, { githubApp: !!github })
  const hosts = options.hosts ?? new HostReads(store, { githubApp: !!github, teamAccountsIdle: !github })
  app.get('/api/super-tabs/grids', (req, reply) => respond(reply, () => store.hostGrids(req.user!)))
  // Each row says whether this server has the Harness GitHub App, so the host knows to ask for a start's token below.
  app.get('/api/super-tabs/hosts/:machineId/pools', updateRequired)
  // Replaces the three host reads above and below: every Swarm of the machine with `full=1` (at start and at least every
  // 60 s), else only those with a change that concerns it since the cursor (design 4.10).
  app.get<{ Params: z.infer<typeof hostParams>; Querystring: z.infer<typeof hostChangesQuery> }>('/api/super-tabs/hosts/:machineId/changes',
    { preHandler: [validateParams(hostParams), validateQuery(hostChangesQuery)] },
    (req, reply) => respond(reply, () => hosts.changes(req.user!, req.params.machineId, { cursor: req.query.cursor, full: req.query.full === '1' })))
  // The same read for a host that holds etags (`held`, design 4.10): too many for a URL, so in a body.
  app.post<{ Params: z.infer<typeof hostParams>; Body: z.infer<typeof hostChangesBody> }>('/api/super-tabs/hosts/:machineId/changes',
    { preHandler: [validateParams(hostParams), validateBody(hostChangesBody)] },
    (req, reply) => respond(reply, () => hosts.changes(req.user!, req.params.machineId, req.body)))
  // A read-only token for a queued start's project repository, for its host to clone and fetch the folder before the agent
  // exists, so that the machine owner's own git login is never used for another person's project (docs/swarm-github-app.md).
  // The machine owner's own project answers `github: false` and the host uses its own login, unless it asks `always` (a
  // Harness Team account, which has none).
  app.post<{ Params: z.infer<typeof hostStartParams>; Body: z.infer<typeof githubStartToken> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId/github-token',
    { preHandler: [validateParams(hostStartParams), validateBody(githubStartToken)] }, (req, reply) => respond(reply, async () => {
      if (!github) throw new GitHubAppError('GITHUB_APP_NOT_CONFIGURED', 'This Harness server has no GitHub App configured.', 503)
      const grant = await store.githubStart(req.user!, req.params.tabId, req.params.startId, req.params.machineId)
      if (grant.own && req.body?.always !== true) return { github: false }
      const repository = githubRepository(grant.repositoryUrl)
      if (!repository) {
        throw new SuperTabError('REPOSITORY_NOT_GITHUB', grant.repositoryUrl
          ? 'This project\'s repository is not on github.com, so the Harness GitHub App cannot give a token for it.'
          : 'This project has no repository address yet. Its owner or Lead can share it (project.repository).', 409)
      }
      return { github: true, ...await github.prepare(repository), requestedBy: grant.requester }
    }))
  app.get<{ Params: z.infer<typeof hostStartParams> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId', { preHandler: validateParams(hostStartParams) },
    (req, reply) => respond(reply, () => store.start(req.user!, req.params.tabId, req.params.startId, undefined, req.params.machineId)))
  app.post<{ Params: z.infer<typeof hostStartParams>; Body: z.infer<typeof operationSchema> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId',
    { preHandler: [validateParams(hostStartParams), validateBody(operationSchema)] }, (req, reply) => respond(reply, async () => {
      if (!('startId' in req.body.command) || req.body.command.startId !== req.params.startId) throw new SuperTabError('FORBIDDEN', 'The host request must name this start.', 403)
      return store.execute(req.user!, req.params.tabId, req.body, undefined, req.params.machineId)
    }))
  app.get<{ Params: z.infer<typeof machineParams> }>('/api/super-tabs/:tabId/machines/:machineId/removal', { preHandler: validateParams(machineParams) },
    (req, reply) => respond(reply, () => store.machineRemoval(req.user!, req.params.tabId, req.params.machineId)))
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
  app.get('/api/super-tabs', updateRequired)
  app.get<{ Querystring: z.infer<typeof listQuery> }>('/api/super-tabs/list', { preHandler: validateQuery(listQuery) },
    (req, reply) => respond(reply, () => reads.list(req.user!, req.query.after)))
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
  app.get('/api/super-tabs/hosts/:machineId', updateRequired)
  app.post<{ Params: z.infer<typeof hostParams> }>('/api/super-tabs/hosts/:machineId/terminal', { preHandler: validateParams(hostParams) },
    (req, reply) => respond(reply, () => store.hostTerminal(req.user!, req.params.machineId)))
  // Long-polls about 20 seconds; a request still waiting then answers `pending` and is read again.
  app.get<{ Params: z.infer<typeof terminalParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/terminal/:requestId',
    { preHandler: [validateParams(terminalParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.terminalResult(req.user!, req.params.tabId, req.params.requestId, req.query.asAgentId, 20_000)))
  app.get('/api/super-tabs/hosts/:machineId/assignments', updateRequired)
  app.get('/api/super-tabs/:tabId', updateRequired)
  // The read API by parts (design section 4, superTabs/read/contract.ts). `githubApp` on a first load (only when the server
  // has the app) lets a Lead's start wire its token into another person's work (cli/src/superTabs/start.ts).
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/parts',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => reads.firstLoad(req.user!, req.params.tabId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof changesQuery> }>('/api/super-tabs/:tabId/changes',
    { preHandler: [validateParams(tabParams), validateQuery(changesQuery)] },
    (req, reply) => respond(reply, () => reads.changes(req.user!, req.params.tabId, req.query.cursor, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof leaderboardQuery> }>('/api/super-tabs/:tabId/leaderboard',
    { preHandler: [validateParams(tabParams), validateQuery(leaderboardQuery)] },
    (req, reply) => respond(reply, () => reads.leaderboard(req.user!, req.params.tabId, req.query.projectId, req.query.week)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof dormantQuery> }>('/api/super-tabs/:tabId/groups',
    { preHandler: [validateParams(tabParams), validateQuery(dormantQuery)] },
    (req, reply) => respond(reply, () => reads.dormant(req.user!, req.params.tabId, { projectId: req.query.projectId, before: req.query.before }, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof groupParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/groups/:conversationId',
    { preHandler: [validateParams(groupParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => reads.group(req.user!, req.params.tabId, req.params.conversationId, req.query.asAgentId)))
  // A one-hour installation token for the repository of the calling agent's task, for git and gh on its machine
  // (docs/swarm-github-app.md). Only that agent's host, on the machine running it, while the task is in its hands.
  app.post<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery>; Body: z.infer<typeof githubToken> }>('/api/super-tabs/:tabId/github-token',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery), validateBody(githubToken)] },
    (req, reply) => respond(reply, async () => {
      if (!github) throw new GitHubAppError('GITHUB_APP_NOT_CONFIGURED', 'This Harness server has no GitHub App configured.', 503)
      const grant = await store.githubAssignment(req.user!, req.params.tabId, req.query.asAgentId, req.body.machineId)
      const repository = githubRepository(grant.repositoryUrl)
      if (!repository) {
        throw new SuperTabError('REPOSITORY_NOT_GITHUB', grant.repositoryUrl
          ? 'This project\'s repository is not on github.com, so the Harness GitHub App cannot give a token for it.'
          : 'This project has no repository address yet. Its owner or Lead can share it (project.repository).', 409)
      }
      const issued = await github.issue({ tabId: grant.tabId, agentId: grant.agentId, assignmentId: grant.assignmentId, repository })
      return { ...issued, ...attribution(grant) }
    }))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof operation> }>('/api/super-tabs/:tabId/commands',
    { preHandler: [validateParams(tabParams), validateBody(operation, { named: true })] },
    (req, reply) => respond(reply, () => store.execute(req.user!, req.params.tabId,
      { operationId: req.body.operationId, command: req.body.command }, req.body.asAgentId)))
  // A chat file comes straight from the client (the desktop's and the browser's account token, or the daemon's for
  // `post --attach`), never through a machine or the relay. Multipart is parsed in this scope alone, so no other
  // Super Tab route's body handling changes.
  await app.register(async scope => {
    // One byte over the limit, so the store sees an oversized file and refuses it rather than keeping a cut one.
    await scope.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: 1, fields: 1, parts: 2 } })
    scope.post<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/attachments',
      { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] }, (req, reply) => respond(reply, async () => {
        let conversationId: string | null = null, uploaded: unknown = null, stored: unknown = null
        try {
          for await (const part of req.parts()) {
            if (part.type === 'field') {
              if (part.fieldname !== 'conversationId' || conversationId !== null || uploaded) fail('INVALID_ATTACHMENT', 'Send conversationId, then one file.', 400)
              conversationId = id.safeParse(part.value).data ?? fail('INVALID_ATTACHMENT', 'Name the conversation to attach the file to.', 400)
            } else {
              if (!conversationId || uploaded) { part.file.resume(); fail('INVALID_ATTACHMENT', 'Send conversationId, then one file.', 400) }
              try {
                uploaded = await store.upload(req.user!, req.params.tabId, conversationId,
                  { name: part.filename, mime: part.mimetype, body: part.file }, req.query.asAgentId)
              } catch (error) { stored = error; throw error } finally { part.file.resume() }
            }
          }
        } catch (error) {
          // Only the form itself is the client's fault; the store's own failures keep their status.
          const code = error && typeof error === 'object' && 'code' in error ? error.code : null
          if (code === 'FST_REQ_FILE_TOO_LARGE') fail('ATTACHMENT_TOO_LARGE', 'A file can be at most 10 MB.', 413)
          if (error instanceof SuperTabError || (error === stored && !(code && String(code).startsWith('FST_')))) throw error
          fail('INVALID_ATTACHMENT', 'Send a multipart form with conversationId and one file.', 400)
        }
        return uploaded ?? fail('INVALID_ATTACHMENT', 'Attach one file.', 400)
      }))
  })
  // An avatar picture (superTabs/profile.ts) comes the same way, alone in its form; the command that sets it names whose it is.
  await app.register(async scope => {
    await scope.register(multipart, { limits: { fileSize: MAX_AVATAR_BYTES + 1, files: 1, fields: 0, parts: 1 } })
    scope.post<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/avatars',
      { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] }, (req, reply) => respond(reply, async () => {
        let uploaded: unknown = null, stored: unknown = null
        try {
          for await (const part of req.parts()) {
            if (part.type === 'field' || uploaded) { if (part.type === 'file') part.file.resume(); fail('INVALID_AVATAR', 'Send one picture.', 400) }
            try { uploaded = await store.uploadAvatar(req.user!, req.params.tabId, { body: part.file }, req.query.asAgentId) }
            catch (error) { stored = error; throw error } finally { part.file.resume() }
          }
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : null
          if (code === 'FST_REQ_FILE_TOO_LARGE') fail('AVATAR_TOO_LARGE', 'An avatar can be at most 1 MB.', 413)
          if (error instanceof SuperTabError || (error === stored && !(code && String(code).startsWith('FST_')))) throw error
          fail('INVALID_AVATAR', 'Send a multipart form with one picture.', 400)
        }
        return uploaded ?? fail('INVALID_AVATAR', 'Send one picture.', 400)
      }))
  })
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof mentionQuery> }>('/api/super-tabs/:tabId/mentions',
    { preHandler: [validateParams(tabParams), validateQuery(mentionQuery)] },
    (req, reply) => respond(reply, () => store.mentions(req.user!, req.params.tabId, req.query.state)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof personDecisionQuery> }>('/api/super-tabs/:tabId/decisions',
    { preHandler: [validateParams(tabParams), validateQuery(personDecisionQuery)] },
    (req, reply) => respond(reply, () => store.decisions(req.user!, req.params.tabId, req.query.state, req.query.asAgentId)))
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
  app.get<{ Params: z.infer<typeof roleParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/projects/:projectId/roles/:roleId',
    { preHandler: [validateParams(roleParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.roleText(req.user!, req.params.tabId, req.params.projectId, req.params.roleId, req.query.asAgentId)))
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
