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
import { redisPollMemory } from '../superTabs/pollMemory.js'
import { routingPolicySchema } from '../superTabs/routingPolicy.js'
import { nativeEventSchema, openNativeSchema } from '../superTabs/native.js'
import { machineObservationSchema } from '../superTabs/machines.js'
import { joinSwarmSchema, previewJoinSchema, saveSharingSchema } from '../superTabs/sharing.js'
import { holdReason } from '../superTabs/holdReason.js'
import { GitHubAppError } from '../github/app.js'
import { projectGitHubAccess } from '../github/projectAccess.js'
import { githubSignIn, PrismaApprovals, readState, signState, stateSecret, type Approvals, type GitHubSignIn } from '../github/approvals.js'
import type { GitHubRepository } from '../github/repository.js'
import { githubRepository } from '../github/repository.js'
import { attribution } from '../github/attribution.js'
import { githubTokensFromEnv, type GitHubTokens } from '../github/tokens.js'
import { logger } from '../utils/logger.js'
import { SwarmReads } from '../superTabs/read/service.js'
import { HostReads } from '../superTabs/read/host.js'
import { UPDATE_REQUIRED } from '../superTabs/read/contract.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../lib/teamSession.js'
import type { AuthUser } from '../lib/ssoAuth.js'
import { DEFAULT_DAYS, MAX_DAYS } from '../superTabs/costs/read.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const tabParams = z.object({ tabId: id })
const agentQuery = z.object({ asAgentId: id.optional() }).strict()
const create = z.object({ operationId: id, name: z.string().trim().min(1).max(160), projectVisibility: z.enum(['public', 'private']).optional(),
  workspaceId: id.optional() }).strict()
const operation = operationSchema.extend({ asAgentId: id.optional() })
// Workspaces (superTabs/workspaceStore.ts). A Team session (lib/teamSession.ts) never acts on a Workspace: only the signed-in person does.
const workspaceParams = z.object({ workspaceId: id })
const workspaceMemberParams = z.object({ workspaceId: id, userId: id })
const workspaceName = z.string().trim().min(1).max(160)
const workspaceCreate = z.object({ operationId: id, name: workspaceName }).strict()
const workspaceRename = z.object({ name: workspaceName }).strict()
const workspaceInvite = z.object({ email: z.email().max(320), role: z.enum(['admin', 'member', 'guest']) }).strict()
const workspaceRole = z.object({ role: z.enum(['admin', 'member', 'guest']) }).strict()
const workspaceTransfer = z.object({ userId: id }).strict()
const workspaceVisibility = z.object({ visibility: z.enum(['invite-only', 'workspace']) }).strict()
const workspaceJoin = z.object({ operationId: id }).strict()
const personOnly = (user: AuthUser) => { if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403) }
const listQuery = z.object({ after: id.optional() }).strict()
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/)
const changesQuery = agentQuery.extend({ cursor })
const costsQuery = z.object({ days: z.coerce.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS), asAgentId: id.optional() }).strict()
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
  before: z.coerce.number().int().nonnegative().safe().optional(), messageId: id.optional(), afterId: id.optional(), beforeId: id.optional(),
  // One thread's root and replies, paged like the conversation.
  thread: id.optional() })
  .refine(q => [q.after, q.before, q.messageId].filter(value => value !== undefined).length <= 1, 'Choose one message cursor or exact message.')
  .refine(q => (q.afterId === undefined || q.after !== undefined) && (q.beforeId === undefined || q.before !== undefined), 'Send afterId with after, beforeId with before.')
const decisionParams = tabParams.extend({ decisionId: id })
const roleParams = tabParams.extend({ projectId: id, roleId: id })
const terminalParams = tabParams.extend({ requestId: id })
const hostParams = z.object({ machineId: id })
const hostStartParams = hostParams.extend({ tabId: id, startId: id })
const machineParams = hostParams.extend({ tabId: id })
const projectParams = tabParams.extend({ projectId: id })
const refreshQuery = z.object({ refresh: z.literal('1').optional() })
const approveBody = z.object({ scope: z.enum(['project', 'swarm']) }).strict()
// What GitHub sends back: a sign-in's code and our state, and after an installation its id and action.
const callbackQuery = z.object({ code: z.string().max(512).optional(), state: z.string().max(4096).optional(), error: z.string().max(128).optional(),
  installation_id: z.string().max(32).optional(), setup_action: z.string().max(32).optional() })

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** The page a person sees in their browser after GitHub sends them back. */
function githubPage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;`
    + `color:#1f2328;background:#fff}@media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}}h1{font-size:1.4rem}</style></head>`
    + `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`
}
const deliveryParams = tabParams.extend({ agentId: id })
const deliveryActionParams = deliveryParams.extend({ deliveryId: id })
const deliveryAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claim'), claimId: id }).strict(),
  z.object({ type: z.literal('ack'), claimId: id, receipt: z.string().min(1).max(2000), uncertain: z.boolean() }).strict(),
  z.object({ type: z.literal('hold'), claimId: id, reason: holdReason }).strict(),
])
const mentionQuery = z.object({ state: z.enum(['waiting', 'earlier']) }).strict()
const personDecisionQuery = agentQuery.extend({ state: z.enum(['open', 'answered', 'settled']) }).strict()
const savePolicy = z.object({ revision: z.number().int().nonnegative().safe(), policy: routingPolicySchema }).strict()
const stop = z.object({ assignmentId: id, receipt: z.string().min(1).max(2000) }).strict()
const githubToken = z.object({ machineId: id }).strict()
const githubStartToken = z.object({ always: z.boolean().optional() }).strict()


async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try { sendSuccess(reply, await action()) } catch (error) {
    if (error instanceof GitHubAppError) return sendError(reply, error.message, error.code, error.status, error.details)
    // A Swarm refusal, a busy Swarm (503 with Retry-After), an expired transaction or a duplicate key: the shared
    // error handler answers each deliberately, and every other failure stays a 500 with its stack logged.
    throw error
  }
}

/** A terminal recording's host stops recording for good on a 409 (cli superTabs/native.ts). A duplicate key that outlived
 *  every transaction retry is not the recording's fault, so it answers busy, which the host retries. */
function busyOnDuplicate(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === 'P2002') fail('SWARM_BUSY', 'This Swarm is busy. Try again in a moment.', 503)
  throw error
}

/** Uses the normal authenticated control API. It never accepts caller-provided host/contributor identities.
 *  `github` is the Harness GitHub App (github/tokens.ts): read from the environment unless given, null when off. */
/** Full-state reads of clients from before Swarms were stored by parts (design 4.11): every old client reads one of them
 *  before or right after any action, so it meets this at once. */
/**
 * The body limit of the routes hosts and agents call every second or every turn (roadmap 2.8), in place of Fastify's 1 MiB:
 * a body is parsed whole on the event loop before its schema is checked. Each route's largest valid body, from its schema's
 * limits with free text in three-byte characters (routes/superTabs.test.ts): host changes with 500 held Swarms 116 KB, a
 * recorded turn 48 KB, a delivery ack or stop receipt 6 KB. Commands and machine readings keep the default: a task at its
 * schema's limits reaches 700 KB.
 */
export const HOT_BODY_LIMIT = 128 * 1024
const updateRequired = (_req: unknown, reply: FastifyReply) => sendError(reply, UPDATE_REQUIRED.message, UPDATE_REQUIRED.code, UPDATE_REQUIRED.status)

/** The store this server runs on. Loaded only here: importing the bus opens its Redis connections. */
async function productionStore(github: GitHubTokens | null): Promise<SuperTabStore> {
  const [bus, { announceSwarmDeliveries }, { announceSwarmHostChanges }, { tellSessionViewers }] = await Promise.all([import('../lib/bus.js'),
    import('../lib/swarmDeliveryPushes.js'), import('../lib/swarmHostPushes.js'), import('./harnessLinks.js')])
  return new SuperTabStore(prisma, Date.now, attachmentsFromEnv(env),
    // A task that ends revokes the token it was given; a revoke that fails is logged inside and never blocks the write.
    { workEnded: (tabId, ended) => { void github?.release(tabId, ended).catch(error => logger.warn('[github] release failed', { tabId, error: String(error) })) },
      workStarted: (tabId, started) => { void github?.resume(tabId, started).catch(error => logger.warn('[github] resume failed', { tabId, error: String(error) })) },
      // A team account has no git login of its own: without the app it takes no teammates' work.
      teamAccountsIdle: !github,
      // Every server answers the quiet delivery poll from any server's full one, and tells the agent's machine of new work
      // through whichever server holds its daemon socket (stability roadmap 2.4). Both only ever drop, never fail, on Redis.
      polls: redisPollMemory(bus.pub),
      deliveriesWaiting: announceSwarmDeliveries,
      // And each machine whose host read a commit changed, so hosts read their Swarm changes only when told (WS Phase 2a).
      hostsChanged: announceSwarmHostChanges,
      // The host's answer often lands on another instance than the sender's wait.
      terminalAnswered: requestId => { void bus.publishTerminalAnswered(requestId) },
      watchTerminal: (requestId, onChange) => bus.subscribeTerminalAnswered(requestId, onChange),
      // Its observer sockets may be on any instance.
      accessChanged: tabId => { void bus.publishSwarmAccessChanged(tabId) },
      sessionsConfidential: sessions => { void tellSessionViewers(sessions) } })
}

export async function superTabRoutes(app: FastifyInstance, options: { store?: SuperTabStore; github?: GitHubTokens | null; reads?: SwarmReads; hosts?: HostReads;
  approvals?: Approvals; signIn?: GitHubSignIn | null } = {}) {
  const github = options.github !== undefined ? options.github : await githubTokensFromEnv(env)
  // Which repositories each Swarm may use the app on, and the app's sign-in that approves one (github/approvals.ts).
  const approvals = options.approvals ?? new PrismaApprovals(prisma)
  const signIn = options.signIn !== undefined ? options.signIn : githubSignIn(env)
  const approvalSecret = github ? stateSecret(github.app.config) : null
  // No token for a repository nobody who can push to it approved for this project: a project names its repository as
  // text, and the app is on other people's repositories too.
  // Rolled out with the team account (machines.ts `teamAccountRequired`): a Swarm outside it gets tokens as before, so a
  // bug here cannot stop other people's Swarms.
  const requireApproval = async (user: { autonomousEnv: string }, grant: { tabId: string; projectId: string; approvalRequired: boolean },
    repository: GitHubRepository) => {
    if (!grant.approvalRequired) return
    const { tabId, projectId } = grant
    if (await approvals.approved(user.autonomousEnv, tabId, projectId, repository.fullName)) return
    throw new SuperTabError('GITHUB_REPOSITORY_NOT_APPROVED', `Nobody who can push to ${repository.fullName} has approved it for this project yet, `
      + 'so teammates\' agents get no access to it. Someone who can push to it approves it in Harness: Project details, GitHub access.', 403)
  }
  const store = options.store ?? await productionStore(github)
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
    { bodyLimit: HOT_BODY_LIMIT, preHandler: [validateParams(hostParams), validateBody(hostChangesBody)] },
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
      await requireApproval(req.user!, grant, repository)
      return { github: true, ...await github.prepare(repository), requestedBy: grant.requester }
    }))
  app.get<{ Params: z.infer<typeof hostStartParams> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId', { preHandler: validateParams(hostStartParams) },
    (req, reply) => respond(reply, () => store.start(req.user!, req.params.tabId, req.params.startId, undefined, req.params.machineId)))
  app.post<{ Params: z.infer<typeof hostStartParams>; Body: z.infer<typeof operationSchema> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId',
    { preHandler: [validateParams(hostStartParams), validateBody(operationSchema)] }, (req, reply) => respond(reply, async () => {
      if (!('startId' in req.body.command) || req.body.command.startId !== req.params.startId) throw new SuperTabError('FORBIDDEN', 'The host request must name this start.', 403)
      return store.execute(req.user!, req.params.tabId, req.body, undefined, req.params.machineId)
    }))
  // Whether teammates' agents can push to a project's repository: the Harness GitHub App installed there
  // (github/projectAccess.ts). `refresh=1`: a person installed it just now and checks again.
  app.get<{ Params: z.infer<typeof projectParams>; Querystring: z.infer<typeof refreshQuery> }>('/api/super-tabs/:tabId/projects/:projectId/github',
    { preHandler: [validateParams(projectParams), validateQuery(refreshQuery)] },
    (req, reply) => respond(reply, async () => {
      const project = await store.projectRepository(req.user!, req.params.tabId, req.params.projectId)
      return projectGitHubAccess(github?.app ?? null, project.repositoryUrl, { canApprove: !!signIn,
        approved: async repository => !project.approvalRequired || approvals.approved(req.user!.autonomousEnv, req.params.tabId, req.params.projectId, repository),
        approvedFor: async repository => {
          const ids = await approvals.approvedProjects(req.user!.autonomousEnv, req.params.tabId, repository)
          return project.others.filter(other => ids.includes(other.id)).map(other => other.name)
        } },
        req.query.refresh === '1')
    }))
  // Approving a project's repository: the person signs in to GitHub through the app (or installs it, which signs them in
  // too), and GitHub sends them back to /api/github/callback with the state signed here for them, this project and scope.
  app.post<{ Params: z.infer<typeof projectParams>; Body: z.infer<typeof approveBody> }>('/api/super-tabs/:tabId/projects/:projectId/github/approve',
    { preHandler: [validateParams(projectParams), validateBody(approveBody)] }, (req, reply) => respond(reply, async () => {
      if (!github || !approvalSecret) throw new GitHubAppError('GITHUB_APP_NOT_CONFIGURED', 'This Harness server has no GitHub App configured.', 503)
      if (!signIn) throw new GitHubAppError('GITHUB_APPROVAL_NOT_CONFIGURED', 'This Harness server cannot approve repositories yet: its administrator sets GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.', 503)
      const { repositoryUrl } = await store.projectRepository(req.user!, req.params.tabId, req.params.projectId)
      const repository = githubRepository(repositoryUrl) ?? fail('REPOSITORY_NOT_GITHUB', 'This project\'s repository is not on github.com.', 409)
      const state = signState(approvalSecret, { userId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv, tabId: req.params.tabId,
        projectId: req.params.projectId, repository: repository.fullName.toLowerCase(), scope: req.body.scope }, Date.now())
      const install = github.app.installUrl()
      return { authorizeUrl: signIn.authorizeUrl(state), installUrl: install ? `${install}?state=${encodeURIComponent(state)}` : null }
    }))
  app.get<{ Querystring: z.infer<typeof callbackQuery> }>('/api/github/callback', { preHandler: validateQuery(callbackQuery) }, async (req, reply) => {
    const page = (title: string, text: string, status = 200) => reply.status(status).type('text/html; charset=utf-8').send(githubPage(title, text))
    const request = approvalSecret && req.query.state ? readState(approvalSecret, req.query.state, Date.now()) : null
    if (!request) return page('This link has expired', 'Go back to Harness and choose Approve again.', 400)
    const named = githubRepository(`https://github.com/${request.repository}`)
    // Cancel on GitHub's sign-in sends the person back with `error` and no code: they were told Harness was installed
    // (local Team account run, 2026-10-28).
    if (req.query.error) return page('Sign-in was cancelled', 'Nothing was approved. Go back to Harness and choose Approve to try again.')
    if (!req.query.code || !signIn || !named) {
      return page('Harness is installed', 'Go back to Harness and choose Approve, so this project can use it.')
    }
    const seen = await signIn.permission(req.query.code, named).catch(() => null)
    if (!seen) return page('GitHub could not confirm your access', 'Go back to Harness and choose Approve again.', 502)
    if (!seen.push) {
      return page(`You can't push to ${named.fullName}`, 'So you can\'t approve it for this Swarm. Someone who can push to it can.', 403)
    }
    await approvals.approve(request, seen.login)
    // Named, so the person knows which project it was for (local Team account run, 2026-10-28: 'This project can now use it').
    const where = request.scope === 'swarm' ? 'every project in this Swarm'
      : await store.projectNameFor(request.userId, request.autonomousEnv as AuthUser['autonomousEnv'], request.tabId, request.projectId).catch(() => null) ?? 'this project'
    return page(`${named.fullName} approved`, `Teammates' agents in ${where} can now push to it. You can go back to Harness.`)
  })
  app.get<{ Params: z.infer<typeof machineParams> }>('/api/super-tabs/:tabId/machines/:machineId/removal', { preHandler: validateParams(machineParams) },
    (req, reply) => respond(reply, () => store.machineRemoval(req.user!, req.params.tabId, req.params.machineId)))
  app.post<{ Params: z.infer<typeof machineParams>; Body: z.infer<typeof machineObservationSchema> }>('/api/super-tabs/:tabId/machines/:machineId',
    { preHandler: [validateParams(machineParams), validateBody(machineObservationSchema)] },
    (req, reply) => respond(reply, () => store.observeMachine(req.user!, req.params.tabId, req.params.machineId, req.body)))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof openNativeSchema> }>('/api/super-tabs/:tabId/native',
    { bodyLimit: HOT_BODY_LIMIT, preHandler: [validateParams(tabParams), validateBody(openNativeSchema)] },
    (req, reply) => respond(reply, () => store.native.open(req.user!, req.params.tabId, req.body)))
  app.get<{ Params: z.infer<typeof nativeParams> }>('/api/super-tabs/:tabId/native/:contextId',
    { preHandler: validateParams(nativeParams) },
    (req, reply) => respond(reply, () => store.native.read(req.user!, req.params.tabId, req.params.contextId)))
  app.post<{ Params: z.infer<typeof nativeParams>; Body: z.infer<typeof nativeEventSchema> }>('/api/super-tabs/:tabId/native/:contextId',
    { bodyLimit: HOT_BODY_LIMIT, preHandler: [validateParams(nativeParams), validateBody(nativeEventSchema)] },
    (req, reply) => respond(reply, () => store.native.append(req.user!, req.params.tabId, req.params.contextId, req.body).catch(busyOnDuplicate)))
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
    (req, reply) => respond(reply, () => store.create(req.user!, req.body.operationId, req.body.name, req.body.projectVisibility, req.body.workspaceId)))
  // Workspaces (docs/plans/2026-10-27-swarm-workspaces.md): the person's Workspaces and the Swarms they may see in each.
  app.get('/api/super-tabs/workspaces', (req, reply) => respond(reply, () => store.workspaceList(req.user!)))
  app.post<{ Body: z.infer<typeof workspaceCreate> }>('/api/super-tabs/workspaces', { preHandler: validateBody(workspaceCreate) },
    (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.create(req.user!, req.body.operationId, req.body.name) }))
  app.get('/api/super-tabs/workspace-invitations', (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.invitationsFor(req.user!) }))
  app.post<{ Params: z.infer<typeof workspaceParams>; Body: z.infer<typeof workspaceRename> }>('/api/super-tabs/workspaces/:workspaceId',
    { preHandler: [validateParams(workspaceParams), validateBody(workspaceRename)] },
    (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.rename(req.user!, req.params.workspaceId, req.body.name) }))
  app.get<{ Params: z.infer<typeof workspaceParams> }>('/api/super-tabs/workspaces/:workspaceId/members', { preHandler: validateParams(workspaceParams) },
    (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.members(req.user!, req.params.workspaceId) }))
  app.post<{ Params: z.infer<typeof workspaceParams>; Body: z.infer<typeof workspaceInvite> }>('/api/super-tabs/workspaces/:workspaceId/invitations',
    { preHandler: [validateParams(workspaceParams), validateBody(workspaceInvite)] },
    (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.invite(req.user!, req.params.workspaceId, req.body.email, req.body.role) }))
  app.post<{ Params: z.infer<typeof workspaceParams> }>('/api/super-tabs/workspaces/:workspaceId/accept', { preHandler: validateParams(workspaceParams) },
    (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.accept(req.user!, req.params.workspaceId) }))
  app.post<{ Params: z.infer<typeof workspaceMemberParams>; Body: z.infer<typeof workspaceRole> }>('/api/super-tabs/workspaces/:workspaceId/members/:userId',
    { preHandler: [validateParams(workspaceMemberParams), validateBody(workspaceRole)] },
    (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.setRole(req.user!, req.params.workspaceId, req.params.userId, req.body.role) }))
  // A POST, not a DELETE: Desktop reaches the backend through the daemon, which forwards only GET and POST (cli superTabs/service.ts).
  app.post<{ Params: z.infer<typeof workspaceMemberParams> }>('/api/super-tabs/workspaces/:workspaceId/members/:userId/remove', { preHandler: validateParams(workspaceMemberParams) },
    (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.remove(req.user!, req.params.workspaceId, req.params.userId) }))
  app.post<{ Params: z.infer<typeof workspaceParams>; Body: z.infer<typeof workspaceTransfer> }>('/api/super-tabs/workspaces/:workspaceId/transfer',
    { preHandler: [validateParams(workspaceParams), validateBody(workspaceTransfer)] },
    (req, reply) => respond(reply, () => { personOnly(req.user!); return store.workspaces.transfer(req.user!, req.params.workspaceId, req.body.userId) }))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof workspaceVisibility> }>('/api/super-tabs/:tabId/workspace-visibility',
    { preHandler: [validateParams(tabParams), validateBody(workspaceVisibility)] },
    (req, reply) => respond(reply, () => store.setWorkspaceVisibility(req.user!, req.params.tabId, req.body.visibility)))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof workspaceJoin> }>('/api/super-tabs/:tabId/workspace-join',
    { preHandler: [validateParams(tabParams), validateBody(workspaceJoin)] },
    (req, reply) => respond(reply, () => store.workspaceJoin(req.user!, req.params.tabId, req.body.operationId)))
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
      await requireApproval(req.user!, grant, repository)
      const issued = await github.issue({ tabId: grant.tabId, agentId: grant.agentId, assignmentId: grant.assignmentId, repository })
      // A Harness Team account has no git identity of its own: its commits are the app's, as its pull requests are
      // (github/app.ts commitIdentity). A person's machine keeps its owner's, as before.
      const commitAs = isTeamSession(req.user) ? await github.app.commitIdentity(issued.token) : null
      return { ...issued, ...attribution(grant), ...(commitAs ? { commitAs } : {}) }
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
  // What routed attempts cost and how they went over a period (superTabs/costs/read.ts).
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof costsQuery> }>('/api/super-tabs/:tabId/costs',
    { preHandler: [validateParams(tabParams), validateQuery(costsQuery)] },
    (req, reply) => respond(reply, () => store.costSummary(req.user!, req.params.tabId, req.query.days, req.query.asAgentId)))
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
    { bodyLimit: HOT_BODY_LIMIT, preHandler: [validateParams(deliveryActionParams), validateBody(deliveryAction)] },
    (req, reply) => respond(reply, () => store.delivery(req.user!, req.params.tabId, req.params.agentId, req.params.deliveryId, req.body)))
  app.get<{ Params: z.infer<typeof deliveryActionParams> }>('/api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId',
    { preHandler: validateParams(deliveryActionParams) },
    (req, reply) => respond(reply, () => store.deliveryReceipt(req.user!, req.params.tabId, req.params.agentId, req.params.deliveryId)))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof stop> }>('/api/super-tabs/:tabId/stopped',
    { bodyLimit: HOT_BODY_LIMIT, preHandler: [validateParams(tabParams), validateBody(stop)] },
    (req, reply) => respond(reply, () => store.stopped(req.user!, req.params.tabId, req.body.assignmentId, req.body.receipt)))
}
