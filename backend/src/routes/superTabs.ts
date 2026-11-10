import { declaredHttpClient } from '../superTabs/refusalLog.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z, ZodError } from 'zod'
import { prisma, prismaSecondary } from '../lib/prisma.js'
import { env } from '../config/env.js'
import { phoneSendersFromEnv, sendPhoneNotices } from '../push/send.js'
import { redisRingMemory } from '../push/rings.js'
import multipart from '@fastify/multipart'
import { attachmentsFromEnv, formFileBody, FORM_TOO_LARGE_MESSAGE, MAX_FORM_ATTACHMENT_BYTES, stopUnpacking, unpackFailed } from '../superTabs/attachments.js'
import { validateBody, validateParams, validateQuery } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { operationSchema } from '../superTabs/commands.js'
import { PERIODS } from '../superTabs/leaderboard/rolling.js'
import { boardQuery, reportBody } from '../superTabs/shipping/contract.js'
import { Shipping } from '../superTabs/shipping/service.js'
import { fail, SuperTabError } from '../superTabs/model.js'
import { SuperTabStore } from '../superTabs/store.js'
import { redisPollMemory } from '../superTabs/pollMemory.js'
import { redisAutoJoinMemory } from '../superTabs/autoJoin.js'
import { redisReportMemory } from '../superTabs/machineReports.js'
import { routingPolicySaveSchema } from '../superTabs/routingPolicy.js'
import { machineObservationSchema } from '../superTabs/machines.js'
import { joinSwarmSchema, previewJoinSchema, saveSharingSchema } from '../superTabs/sharing.js'
import { holdReason } from '../superTabs/holdReason.js'
import { GitHubAppError } from '../github/app.js'
import { projectGitHubAccess } from '../github/projectAccess.js'
import { githubSignIn, PrismaApprovals, readState, signState, stateSecret, type Approvals, type GitHubSignIn } from '../github/approvals.js'
import type { GitHubRepository } from '../github/repository.js'
import { githubRepository } from '../github/repository.js'
import { attribution } from '../github/attribution.js'
import { createRepository, createStateSecret, GITHUB_OWNER, ownerCheckAllowed, readCreateState, repositoryNameProblem, signCreateState } from '../github/repositoryCreate.js'
import { githubTokensFromEnv, type GitHubTokens } from '../github/tokens.js'
import { logger } from '../utils/logger.js'
import { SwarmReads } from '../superTabs/read/service.js'
import { NOTIFY_LEVELS } from '../superTabs/chatSettings.js'
import { COMMENT_KINDS, MAX_COMMENT_IDS } from '../superTabs/githubComments.js'
import { HostReads } from '../superTabs/read/host.js'
import type { AuthUser } from '../lib/ssoAuth.js'
import { DEFAULT_DAYS, MAX_DAYS } from '../superTabs/costs/read.js'
import { markNothingNew } from '../lib/routeLatency.js'
import { onMachineRenamed } from '../superTabs/machineRenames.js'
import { onAccountRenamed } from '../superTabs/accountRenames.js'
import { onComputerSignedIn } from '../superTabs/computerMoves.js'

/** Runs a poll and marks its reply nothing-new for `route latency` when `empty` says so (spec 2026-11-02 poll cost, Part 0). */
const noting = <T>(req: FastifyRequest, run: () => Promise<T>, empty: (result: T) => boolean) => async (): Promise<T> => {
  const result = await run()
  if (empty(result)) markNothingNew(req)
  return result
}
/** A change read that found nothing: no reload, no head, and every list of changed parts empty. */
const nothingChanged = (changes: object): boolean =>
  (changes as { reload?: unknown }).reload === false && (changes as { head?: unknown }).head == null
    && Object.values(changes).every(value => !Array.isArray(value) || value.length === 0)

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const tabParams = z.object({ tabId: id })
const agentQuery = z.object({ asAgentId: id.optional() }).strict()
// A GitHub comment an agent posted (superTabs/githubComments.ts): `owner/name`, and GitHub's numeric id.
const repository = z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
const commentRecordQuery = z.object({ asAgentId: id }).strict()
const commentRecordBody = z.object({ repository, kind: z.enum(COMMENT_KINDS), commentId: z.string().regex(/^[1-9]\d{0,19}$/) }).strict()
const commentAuthorsQuery = z.object({ repository, asAgentId: id.optional(),
  ids: z.string().max(4000).transform(ids => ids.split(',')).pipe(z.array(z.string().regex(/^[a-z-]+:[1-9]\d{0,19}$/)).min(1).max(MAX_COMMENT_IDS)) }).strict()
const uploadParams = z.object({ tabId: id, uploadId: id })
const voiceParams = z.object({ tabId: id, attachmentId: id })
const voiceQuery = agentQuery.extend({ lang: z.string().max(16).optional() })
// The store checks the name, type and size; this only bounds what reaches it.
const uploadLinkBody = z.object({ conversationId: id, name: z.string().max(1000), mime: z.string().max(1000), size: z.number().int() }).strict()
const emptyBody = z.object({}).strict().optional()
const create = z.object({ operationId: id, name: z.string().trim().min(1).max(160), projectVisibility: z.enum(['public', 'private']).optional() }).strict()
const operation = operationSchema.extend({ asAgentId: id.optional() })
const listQuery = z.object({ after: id.optional() }).strict()
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/)
// `derivedEtag`: the summary's etag the client holds (read/derivedEtag.ts, task #2906).
const changesQuery = agentQuery.extend({ cursor, machines: z.literal('light').optional(),
  derivedEtag: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional() })
const costsQuery = z.object({ days: z.coerce.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS), asAgentId: id.optional() }).strict()
const leaderboardQuery = z.object({ projectId: id, week: z.coerce.number().int().nonnegative().safe().optional(), period: z.enum(PERIODS).optional(), scope: z.literal('all').optional() }).strict()
  .refine(query => query.week === undefined || query.period === undefined, 'Ask for a week or a period, not both.')
const dormantQuery = agentQuery.extend({ dormant: z.literal('1'), projectId: id.optional(), before: cursor.optional() })
const groupParams = tabParams.extend({ conversationId: id })
const hostChangesQuery = z.object({ cursor: cursor.optional(), full: z.literal('1').optional() }).strict()
const etag = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const hostChangesBody = z.object({ cursor: cursor.optional(), full: z.boolean().optional(),
  held: z.record(id, etag).refine(held => Object.keys(held).length <= 500, 'At most 500 Swarms.').optional() }).strict()
const startParams = tabParams.extend({ startId: id })
const messageParams = tabParams.extend({ conversationId: id })
// A person's own read mark (superTabs/readMarks.ts): no asAgentId, since agents keep none.
const readMarkBody = z.object({ sequence: z.number().int().nonnegative().safe() }).strict()
// Mark unread names the message it starts from: the mark goes to just before it.
const unreadBody = z.object({ sequence: z.number().int().positive().safe() }).strict()
const notifyBody = z.object({ notify: z.enum(NOTIFY_LEVELS) }).strict()
const threadParams = messageParams.extend({ threadId: id })
const fileParams = messageParams.extend({ messageId: id, attachmentId: id })
const noQuery = z.object({}).strict()
/** The Cmd-N and join project list's query (superTabs/projectList.ts): the project the person was invited to, if any. */
const projectListQuery = z.object({ invitedTo: id.optional() }).strict()
// Pages by (sequence, id) (design 4.6): `afterId`/`beforeId` go with `after`/`before`, from the previous page's `next`.
const messageQuery = agentQuery.extend({ after: z.coerce.number().int().nonnegative().safe().optional(),
  before: z.coerce.number().int().nonnegative().safe().optional(), messageId: id.optional(), afterId: id.optional(), beforeId: id.optional(),
  // One thread's root and replies, paged like the conversation.
  thread: id.optional() })
  .refine(q => [q.after, q.before, q.messageId].filter(value => value !== undefined).length <= 1, 'Choose one message cursor or exact message.')
  .refine(q => (q.afterId === undefined || q.after !== undefined) && (q.beforeId === undefined || q.before !== undefined), 'Send afterId with after, beforeId with before.')
const decisionParams = tabParams.extend({ decisionId: id })
const terminalParams = tabParams.extend({ requestId: id })
const hostParams = z.object({ machineId: id })
const hostStartParams = hostParams.extend({ tabId: id, startId: id })
const machineParams = hostParams.extend({ tabId: id })
const projectParams = tabParams.extend({ projectId: id })
// `record=0`: an app reading again because the project's GitHub revision moved, not a person checking; it records nothing.
const refreshQuery = z.object({ refresh: z.literal('1').optional(), record: z.literal('0').optional() })
const approveBody = z.object({ scope: z.enum(['project', 'swarm']) }).strict()
// New Project's "New repository" (task #1788): an organization the person picked, and the repository's name and privacy.
const ownerParams = tabParams.extend({ owner: z.string().regex(GITHUB_OWNER) })
const repositoryBody = z.object({ owner: z.string().regex(GITHUB_OWNER), name: z.string().max(200), private: z.boolean() }).strict()
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
/** `turn`: whether a PM's turn is open, which today's CLI still sends with its delivery list read and nothing reads since the PM's
 *  inbox went (Swarm v4). Taken until a CLI without it is released. */
const deliveryListQuery = z.object({ turn: z.enum(['idle', 'busy']).optional() }).strict()
const deliveryActionParams = deliveryParams.extend({ deliveryId: id })
const deliveryAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claim'), claimId: id }).strict(),
  z.object({ type: z.literal('ack'), claimId: id, receipt: z.string().min(1).max(2000), uncertain: z.boolean() }).strict(),
  z.object({ type: z.literal('hold'), claimId: id, reason: holdReason }).strict(),
])
const stop = z.object({ assignmentId: id, receipt: z.string().min(1).max(2000) }).strict()
const githubToken = z.object({ machineId: id }).strict()
const githubStartToken = z.object({ always: z.boolean().optional() }).strict()
// Swarm v4 (slice S6, 2026-11-10): agents push with their own person's login on their own computer, so the server no longer
// advertises the app: no read says `githubApp`, a start's token answers as for the machine owner's own project, and the CI load as
// a server without the app. An agent session started with the app before still asks for its task's token every hour, and gets it,
// with its revocation at the task's end: it must never lose push mid-work. Delete the agent tokens (github/tokens.ts, holds.ts,
// attribution.ts, this route and the store's githubAssignment) and these answers on or after 2026-12-10.
const NO_APP = () => new GitHubAppError('GITHUB_APP_NOT_CONFIGURED', 'This Harness server has no GitHub App configured.', 503)


/**
 * The routes about one Swarm that a sign-in may call: the web with the browser's own sign-in (desktop
 * super_tabs/backend_transport.dart), Desktop and the phone through their machine, and a machine's host and its agents.
 * On these, a Swarm, chat, message, project, decision, start, delivery, file or link the caller cannot reach gets one
 * answer, whether it is missing, refused, revoked or in another project, so the answer never says
 * which. The server log keeps the specific reason. Role refusals inside a Swarm the caller reads (read-only,
 * owner-only) keep their own words: they tell nothing the caller cannot already see. Hosts read 403 and 404 alike as
 * access lost (cli superTabs/machines.ts, swarmReads.ts). This is that answer: 404 with the code every client already reads as
 * gone (Desktop and the phone: FORBIDDEN or NOT_FOUND; the CLI: 403 or 404).
 */
export const NOT_AVAILABLE = { code: 'NOT_FOUND', message: 'This is not available to you. It may have been removed, or your access changed.', status: 404 } as const
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['NOT_FOUND', 'JOIN_UNAVAILABLE'])
const unreachable = (error: SuperTabError) => error.unreachable || UNREACHABLE_CODES.has(error.code)

/** At most this many Swarms' readings in one call; the most a machine was seen in is 21 (DB roadmap 2.5). */
export const READINGS_MAX = 64
/** A reading is a few KB, at most ~700 KB at its schema's limits (see HOT_BODY_LIMIT), so a batch gets a limit of its own. */
export const READINGS_BODY_LIMIT = 8 * 1024 * 1024
/** Each observation is checked on its own (machineObservationSchema, in the store), so one a backend refuses fails only its
 *  Swarm, and the host sends that one again through the per-Swarm route with its older fields (cli superTabs/machines.ts). */
const readingsBody = z.object({ readings: z.array(z.object({ tabId: id, observation: z.unknown() }).strict()).min(1).max(READINGS_MAX)
  .refine(list => new Set(list.map(r => r.tabId)).size === list.length, 'Name each Swarm once.') }).strict()

/** One reading's refusal in a batch, answered as the per-Swarm route answers it: a Swarm the caller cannot reach gets the one
 *  NOT_AVAILABLE answer (the default for per-Swarm routes), anything unexpected a 500 for that Swarm alone, logged. */
export function readingError(tabId: string, error: unknown): { code: string; message: string; status: number } {
  if (error instanceof ZodError) return { code: 'VALIDATION_ERROR', message: error.issues[0]?.message ?? 'This reading is not valid.', status: 400 }
  if (error instanceof SuperTabError) {
    if (!unreachable(error)) return { code: error.code, message: error.message, status: error.status }
    logger.warn('Swarm not available to the caller', { code: error.code, statusCode: error.status, reason: error.message, tabId, path: 'readings' })
    return { ...NOT_AVAILABLE }
  }
  logger.error('[super-tab] a machine reading failed', error instanceof Error ? error : new Error(String(error)), { tabId })
  return { code: 'INTERNAL_ERROR', message: 'This reading could not be stored. It is sent again with the next one.', status: 500 }
}

async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try { sendSuccess(reply, await action()) } catch (error) {
    if (error instanceof GitHubAppError) return sendError(reply, error.message, error.code, error.status, error.details)
    const { request } = reply
    if (error instanceof SuperTabError && unreachable(error)
      && /^\/api\/super-tabs\/:tabId(?:\/|$)/.test(request.routeOptions.url ?? '')) {
      logger.warn('Swarm not available to the caller', { code: error.code, statusCode: error.status, reason: error.message,
        path: request.url, method: request.method })
      return sendError(reply, NOT_AVAILABLE.message, NOT_AVAILABLE.code, NOT_AVAILABLE.status)
    }
    // A Swarm refusal, a busy Swarm (503 with Retry-After), an expired transaction or a duplicate key: the shared
    // error handler answers each deliberately, and every other failure stays a 500 with its stack logged.
    throw error
  }
}

/** Uses the normal authenticated control API. It never accepts caller-provided host/contributor identities.
 *  `github` is the Harness GitHub App (github/tokens.ts): read from the environment unless given, null when off. */
/**
 * The body limit of the routes hosts and agents call every second or every turn (roadmap 2.8), in place of Fastify's 1 MiB:
 * a body is parsed whole on the event loop before its schema is checked. Each route's largest valid body, from its schema's
 * limits with free text in three-byte characters (routes/superTabs.test.ts): host changes with 500 held Swarms 116 KB, a
 * delivery ack or stop receipt 6 KB. Commands and machine readings keep the default: a task at its
 * schema's limits reaches 700 KB.
 */
export const HOT_BODY_LIMIT = 128 * 1024

/** The store this server runs on. Loaded only here: importing the bus opens its Redis connections. */
async function productionStore(github: GitHubTokens | null): Promise<SuperTabStore> {
  const [bus, { announceSwarmDeliveries, announceSwarmTerminal }, { announceSwarmHostChanges }, { announceSwarmChanges }, { tellSessionViewers },
    { VoiceQuotaExceededError, voiceQuotaService }, { pickWavLang, transcribeWavWithDeepgram }] = await Promise.all([
    import('../lib/bus.js'), import('../lib/swarmDeliveryPushes.js'), import('../lib/swarmHostPushes.js'), import('../lib/swarmClientPushes.js'),
    import('./harnessLinks.js'), import('../lib/voiceQuota.js'), import('../lib/deepgramWav.js')])
  const phones = phoneSendersFromEnv(env)
  // An agent chat sounds once in five minutes on every server (push/rings.ts).
  const rings = redisRingMemory(bus.pub)
  return new SuperTabStore(prisma, Date.now, attachmentsFromEnv(env),
    // Older history pages and the costs report read the secondaries (lib/prisma.ts, task #2970).
    { replica: prismaSecondary,
      // Thread replies and tags reach the phones of whoever they tell, while the app is closed (push/send.ts, task #2905).
      phoneNotices: notices => { void sendPhoneNotices(prisma, phones, notices, rings) },
      // A task that ends revokes the token it was given; a revoke that fails is logged inside and never blocks the write.
      workEnded: (tabId, ended) => { void github?.release(tabId, ended).catch(error => logger.warn('[github] release failed', { tabId, error: String(error) })) },
      workStarted: (tabId, started) => { void github?.resume(tabId, started).catch(error => logger.warn('[github] resume failed', { tabId, error: String(error) })) },
      // Every server answers the quiet delivery poll from any server's full one, and tells the agent's machine of new work
      // through whichever server holds its daemon socket (stability roadmap 2.4). Both only ever drop, never fail, on Redis.
      polls: redisPollMemory(bus.pub),
      // Each person is tried for joining by domain once per 2 minutes across every server (superTabs/autoJoin.ts).
      autoJoins: redisAutoJoinMemory(bus.pub),
      // What each machine's full report saw, so its heartbeats skip the Swarm load, and one sweep clock per Swarm (DB 2.5).
      reports: redisReportMemory(bus.pub),
      deliveriesWaiting: announceSwarmDeliveries, terminalWaiting: announceSwarmTerminal,
      // And each machine whose host read a commit changed, so hosts read their Swarm changes only when told (WS Phase 2a).
      hostsChanged: announceSwarmHostChanges,
      // And each person in the Swarm, so their apps read it when told instead of every 3–15 s (WS Phase 2a).
      swarmChanged: announceSwarmChanges,
      // The host's answer often lands on another instance than the sender's wait.
      terminalAnswered: requestId => { void bus.publishTerminalAnswered(requestId) },
      watchTerminal: (requestId, onChange) => bus.subscribeTerminalAnswered(requestId, onChange),
      // Its observer sockets may be on any instance.
      accessChanged: tabId => { void bus.publishSwarmAccessChanged(tabId) },
      sessionsConfidential: sessions => { void tellSessionViewers(sessions) },
      // Chat voice messages are transcribed as the dial's and the phone's voice input are (routes/voice.ts), on the same daily
      // quota of the person's account.
      voice: {
        reserve: (user, id, durationMs) => voiceQuotaService.reserveForUser(user.sub, user.autonomousEnv ?? 'prod', id, durationMs)
          .then(() => 'ok' as const, error => { if (error instanceof VoiceQuotaExceededError) return 'limit' as const; throw error }),
        transcribe: (wav, lang) => transcribeWavWithDeepgram(wav, 'audio/wav', pickWavLang(lang)),
        commit: id => voiceQuotaService.commit(id),
        release: id => voiceQuotaService.release(id).then(() => undefined),
      } })
}

export async function superTabRoutes(app: FastifyInstance, options: { store?: SuperTabStore; github?: GitHubTokens | null; reads?: SwarmReads; hosts?: HostReads;
  approvals?: Approvals; signIn?: GitHubSignIn | null; shipping?: Shipping } = {}) {
  const github = options.github !== undefined ? options.github : await githubTokensFromEnv(env)
  // Which repositories each Swarm may use the app on, and the app's sign-in that approves one (github/approvals.ts).
  const approvals = options.approvals ?? new PrismaApprovals(prisma)
  const signIn = options.signIn !== undefined ? options.signIn : githubSignIn(env)
  const approvalSecret = github ? stateSecret(github.app.config) : null
  const createSecret = github ? createStateSecret(github.app.config) : null
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
  // A rename in Machines reaches the Swarms the machine is in at once (MachineService.rename).
  onMachineRenamed(rename => store.machineRenamed(rename))
  // An account's rename: the person's name in each of their Swarms follows it (personNames.ts followAccountName).
  onAccountRenamed(rename => store.accountRenamed(rename))
  // Another account's sign-in on a computer moves the computer's Swarm entries to it (computerMoves.ts).
  onComputerSignedIn(signIn => store.computerSignedIn(signIn))
  const reads = options.reads ?? new SwarmReads(store)
  const hosts = options.hosts ?? new HostReads(store)
  // The store's own database, as the reads above use it: a route table built on another store (a test's) reads that one.
  const shipping = options.shipping ?? new Shipping(store.db)
  // Members' apps read a project's GitHub access again when its revision moves (projects.ts githubRevision). A move that
  // fails is logged and changes no answer: the apps then read again within 5 minutes, as before.
  /** One organization check against GitHub for [userId], within OWNER_CHECKS_PER_MINUTE (security reviews of #3201). */
  const limitOwnerChecks = async (userId: string) => {
    if (!await ownerCheckAllowed(userId)) throw new SuperTabError('RATE_LIMITED', 'Too many organization checks. Try again in a minute.', 429)
  }
  const recorded = (tabId: string, move: () => Promise<unknown>) => move().catch(error => {
    logger.warn('[github] access change not recorded', { tabId, error: String(error) })
  })
  app.get('/api/super-tabs/grids', (req, reply) => respond(reply, () => store.hostGrids(req.user!)))
  // Every Swarm of the machine with `full=1` (at start and at least every 60 s), else only those with a change that concerns it
  // since the cursor (design 4.10).
  app.get<{ Params: z.infer<typeof hostParams>; Querystring: z.infer<typeof hostChangesQuery> }>('/api/super-tabs/hosts/:machineId/changes',
    { preHandler: [validateParams(hostParams), validateQuery(hostChangesQuery)] },
    (req, reply) => respond(reply, () => hosts.changes(req.user!, req.params.machineId, { cursor: req.query.cursor, full: req.query.full === '1' })))
  // The same read for a host that holds etags (`held`, design 4.10): too many for a URL, so in a body.
  app.post<{ Params: z.infer<typeof hostParams>; Body: z.infer<typeof hostChangesBody> }>('/api/super-tabs/hosts/:machineId/changes',
    { bodyLimit: HOT_BODY_LIMIT, preHandler: [validateParams(hostParams), validateBody(hostChangesBody)] },
    (req, reply) => respond(reply, () => hosts.changes(req.user!, req.params.machineId, req.body)))
  // A start's folder is prepared with its machine's own login (retired, above NO_APP): the answer a machine owner's own project
  // got, which a host takes as "use your own login". A Harness Team host has none and asks `always`: it hears there is no app,
  // as its next roster row would tell it.
  app.post<{ Params: z.infer<typeof hostStartParams>; Body: z.infer<typeof githubStartToken> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId/github-token',
    { preHandler: [validateParams(hostStartParams), validateBody(githubStartToken)] }, (req, reply) => respond(reply, async () => {
      if (req.body?.always === true) throw NO_APP()
      return { github: false }
    }))
  app.get<{ Params: z.infer<typeof hostStartParams> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId', { preHandler: validateParams(hostStartParams) },
    (req, reply) => respond(reply, () => store.start(req.user!, req.params.tabId, req.params.startId, undefined, req.params.machineId)))
  app.post<{ Params: z.infer<typeof hostStartParams>; Body: z.infer<typeof operationSchema> }>('/api/super-tabs/hosts/:machineId/starts/:tabId/:startId',
    { preHandler: [validateParams(hostStartParams), validateBody(operationSchema)] }, (req, reply) => respond(reply, async () => {
      if (!('startId' in req.body.command) || req.body.command.startId !== req.params.startId) throw new SuperTabError('FORBIDDEN', 'The host request must name this start.', 403)
      return store.execute(req.user!, req.params.tabId, req.body, undefined, req.params.machineId, declaredHttpClient(req.headers))
    }))
  // Whether teammates' agents can push to a project's repository: the Harness GitHub App installed there
  // (github/projectAccess.ts). `refresh=1`: a person installed it just now and checks again.
  app.get<{ Params: z.infer<typeof projectParams>; Querystring: z.infer<typeof refreshQuery> }>('/api/super-tabs/:tabId/projects/:projectId/github',
    { preHandler: [validateParams(projectParams), validateQuery(refreshQuery)] },
    (req, reply) => respond(reply, async () => {
      const project = await store.projectRepository(req.user!, req.params.tabId, req.params.projectId)
      const access = await projectGitHubAccess(github?.app ?? null, project.repositoryUrl, { canApprove: !!signIn,
        approved: async repository => !project.approvalRequired || approvals.approved(req.user!.autonomousEnv, req.params.tabId, req.params.projectId, repository),
        approvedFor: async repository => {
          const ids = await approvals.approvedProjects(req.user!.autonomousEnv, req.params.tabId, repository)
          return project.others.filter(other => ids.includes(other.id)).map(other => other.name)
        },
        you: repository => approvals.reader(req.user!.autonomousEnv, req.params.tabId, req.params.projectId, repository, req.user!.sub) },
        req.query.refresh === '1')
      // Only a person's check records what it found (opening GitHub access, Check again): every app reads again when the
      // revision moves, on servers whose caches differ, and recording those reads would move it back and forth (review of
      // #2713). A read without `refresh` may answer from an older cache, so it records nothing either.
      if (req.query.refresh === '1' && req.query.record !== '0') await recorded(req.params.tabId, () => store.githubSeen(req.params.tabId, req.params.projectId, access.state))
      return access
    }))
  // Which agent wrote a GitHub comment (superTabs/githubComments.ts): its daemon records each one it posted; the merger and news
  // read them by id, and fall back to the signature for a comment nothing recorded.
  app.post<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof commentRecordQuery>; Body: z.infer<typeof commentRecordBody> }>('/api/super-tabs/:tabId/github-comments',
    { preHandler: [validateParams(tabParams), validateQuery(commentRecordQuery), validateBody(commentRecordBody)] },
    (req, reply) => respond(reply, () => store.recordGithubComment(req.user!, req.params.tabId, req.query.asAgentId, req.body)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof commentAuthorsQuery> }>('/api/super-tabs/:tabId/github-comments',
    { preHandler: [validateParams(tabParams), validateQuery(commentAuthorsQuery)] },
    (req, reply) => respond(reply, () => store.githubCommentAuthors(req.user!, req.params.tabId, req.query.repository, req.query.ids, req.query.asAgentId)))
  // The CI load a CLI's route read (retired with it, above NO_APP): who may read the project hears what a server without the app
  // said; anyone else is refused as before.
  app.get<{ Params: z.infer<typeof projectParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/projects/:projectId/ci-load',
    { preHandler: [validateParams(projectParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, async () => {
      await store.ciRepository(req.user!, req.params.tabId, req.params.projectId, req.query.asAgentId)
      return { state: 'unavailable' as const }
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
  // Whether an organization lets Harness create a repository there, for New Project's owner row before sign-in (F4, F5):
  // 'not-configured' when this server can't (F6), so the apps hide the choice. A person of the Swarm only.
  app.get<{ Params: z.infer<typeof ownerParams> }>('/api/super-tabs/:tabId/github/owners/:owner', { preHandler: validateParams(ownerParams) },
    (req, reply) => respond(reply, async () => {
      await store.requireWriter(req.user!, req.params.tabId)
      if (!github || !signIn || !createSecret) return { state: 'not-configured' }
      await limitOwnerChecks(req.user!.sub)
      const readiness = await github.app.ownerReadiness(req.params.owner)
      return readiness.state === 'not-installed' ? { state: readiness.state, ...(readiness.installUrl ? { installUrl: readiness.installUrl } : {}) } : { state: readiness.state }
    }))
  // A new repository for a project its owner just made: checked, recorded as waiting on the project, and the person sent to
  // GitHub's sign-in, whose callback creates it with their own token (github/repositoryCreate.ts).
  app.post<{ Params: z.infer<typeof projectParams>; Body: z.infer<typeof repositoryBody> }>('/api/super-tabs/:tabId/projects/:projectId/github/repository',
    { preHandler: [validateParams(projectParams), validateBody(repositoryBody)] }, (req, reply) => respond(reply, async () => {
      if (!github || !createSecret) throw new GitHubAppError('GITHUB_APP_NOT_CONFIGURED', 'This Harness server has no GitHub App configured.', 503)
      if (!signIn) throw new GitHubAppError('GITHUB_APPROVAL_NOT_CONFIGURED', 'This Harness server cannot create repositories yet: its administrator sets GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.', 503)
      const { owner, name } = req.body
      const problem = repositoryNameProblem(name)
      if (problem) throw new SuperTabError('REPOSITORY_NAME', problem, 400)
      // Who may, before any call signed with the app's key (security review 1 of #3201).
      await store.mayCreateRepository(req.user!, req.params.tabId, req.params.projectId)
      await limitOwnerChecks(req.user!.sub)
      const readiness = await github.app.ownerReadiness(owner)
      if (readiness.state === 'not-installed') {
        throw new GitHubAppError('GITHUB_APP_NOT_INSTALLED', `Harness isn't on ${owner}'s GitHub yet.`, 409, readiness.installUrl ? { installUrl: readiness.installUrl } : undefined)
      }
      if (readiness.state === 'not-accepted') {
        throw new GitHubAppError('GITHUB_APP_PERMISSIONS', `An owner of ${owner} needs to accept Harness's new permission once: GitHub Settings → GitHub Apps → Harness.`, 409)
      }
      const at = Date.now()
      await store.startRepositoryCreation(req.user!, req.params.tabId, req.params.projectId, { owner, name, private: req.body.private }, at)
      const state = signCreateState(createSecret, { userId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv, tabId: req.params.tabId,
        projectId: req.params.projectId, owner, name, private: req.body.private, at }, at)
      return { authorizeUrl: signIn.authorizeUrl(state), at }
    }))
  app.get<{ Querystring: z.infer<typeof callbackQuery> }>('/api/github/callback', { preHandler: validateQuery(callbackQuery) }, async (req, reply) => {
    const page = (title: string, text: string, status = 200) => reply.status(status).type('text/html; charset=utf-8').send(githubPage(title, text))
    const create = createSecret && github && req.query.state ? readCreateState(createSecret, req.query.state, Date.now()) : null
    if (create && github) {
      const githubApp = github.app
      const expired = () => page('This link has expired', 'Go back to Harness and create the repository again.', 400)
      const deleted = (made: string | null) => page('The project was deleted meanwhile',
        made ? `${made} was made on GitHub, but no project uses it. You can go back to Harness.` : 'Nothing was created. You can go back to Harness.', 410)
      if (!await store.isLive(create.tabId)) return expired()
      // Claimed before the code is used: a replay, or the same link opened twice, finds nothing to claim (security review 2).
      const claimed = await store.claimRepositoryAsk(create.tabId, create.projectId, create.userId, create.at)
      if (claimed === 'gone') return deleted(null)
      if (!claimed) return expired()
      const finish = (outcome: Parameters<SuperTabStore['finishRepositoryCreation']>[4]) =>
        store.finishRepositoryCreation(create.tabId, create.projectId, create.userId, create.at, outcome).catch(error => {
          logger.warn('[github] repository creation outcome not recorded', { tabId: create.tabId, error: String(error) })
          return 'error' as const
        })
      const full = `${create.owner}/${create.name}`
      if (req.query.error || !req.query.code || !signIn) {
        await finish({ state: 'cancelled' })
        return page('Nothing was created', 'Go back to Harness and choose Try again.')
      }
      const outcome = await signIn.withUserToken(req.query.code, call => createRepository(call, githubApp, create)).catch(() => null)
      if (!outcome || outcome.state === 'failed') {
        await finish({ state: 'failed' })
        return page('GitHub didn\'t answer', 'Nothing was created. Go back to Harness and choose Try again.', 502)
      }
      if (outcome.state === 'taken') {
        await finish({ state: 'taken' })
        return page(`${full} already exists`, 'Go back to Harness and choose another name.', 409)
      }
      if (outcome.state === 'refused') {
        await finish({ state: 'refused', reason: outcome.reason })
        return page(`GitHub didn't let you create a repository in ${create.owner}`, `${outcome.reason} Go back to Harness to choose another way.`, 403)
      }
      // Allowed for the project only once its outcome is recorded on it: a project deleted meanwhile, or an ask replaced,
      // gets no approval (security review 1 of #3201). Its creator can push, so it is allowed as their sign-in for it would.
      const written = await finish({ state: 'created', repositoryUrl: outcome.repositoryUrl, reachable: outcome.reachable })
      if (written === 'gone') return deleted(outcome.repository)
      if (written !== 'recorded') {
        return page(`${outcome.repository} is made`, 'Harness could not record it on your project. Go back to Harness and choose Try again: it finds the repository you just made.', 500)
      }
      await approvals.approve({ userId: create.userId, autonomousEnv: create.autonomousEnv, tabId: create.tabId, projectId: create.projectId,
        repository: outcome.repository.toLowerCase(), scope: 'project' }, outcome.login)
      return page(`${outcome.repository} is ready`, outcome.reachable ? 'Go back to Harness: your project starts in it.'
        : `Go back to Harness. Teammates' agents can use it once an owner of ${create.owner} adds it to Harness in GitHub: Settings → GitHub Apps → Harness → Configure.`)
    }
    const request = approvalSecret && req.query.state ? readState(approvalSecret, req.query.state, Date.now()) : null
    if (!request) return page('This link has expired', 'Go back to Harness and choose Continue in GitHub again.', 400)
    // A Swarm deleted since the link was made allows nothing, and says so as an expired link does (superTabs/deletion.ts).
    if (!await store.isLive(request.tabId)) return page('This link has expired', 'Go back to Harness and choose Continue in GitHub again.', 400)
    const named = githubRepository(`https://github.com/${request.repository}`)
    // Cancel on GitHub's sign-in sends the person back with `error` and no code: they were told Harness was installed
    // (local Team account run, 2026-10-28).
    if (req.query.error) return page('Sign-in was cancelled', 'Nothing was allowed. Go back to Harness and choose Continue in GitHub to try again.')
    if (!req.query.code || !signIn || !named) {
      // Installed just now: this server stops keeping "not installed", and members' apps read again (task #2316).
      if (named && github) {
        github.app.forget(named)
        await recorded(request.tabId, () => store.githubChanged(request.tabId, request.repository))
      }
      return page('Harness is installed', 'Go back to Harness and choose Continue in GitHub, so this project can use it.')
    }
    const seen = await signIn.permission(req.query.code, named).catch(() => null)
    if (!seen) return page('GitHub could not confirm your access', 'Go back to Harness and choose Continue in GitHub again.', 502)
    if (!seen.push) {
      // Kept, so the app asks them to send it to someone who can rather than offering this sign-in again.
      await approvals.refuse(request, seen.login).catch(() => undefined)
      return page(`You can't push to ${named.fullName}`, 'So you can\'t allow it. Ask someone who can push to it to open the project in Harness and choose Set up GitHub for teammates.', 403)
    }
    await approvals.approve(request, seen.login)
    await recorded(request.tabId, () => store.githubChanged(request.tabId, request.repository))
    // Named, so the person knows which project it was for (local Team account run, 2026-10-28: 'This project can now use it').
    const where = request.scope === 'swarm' ? 'every project in this Swarm'
      : await store.projectNameFor(request.userId, request.autonomousEnv as AuthUser['autonomousEnv'], request.tabId, request.projectId).catch(() => null) ?? 'this project'
    // Worded as the desktop's GitHub access dialog is (design 2026-10-30): allowed, not approved.
    return page(`${named.fullName} is allowed`, `Teammates' agents in ${where} can now push to it. You can go back to Harness.`)
  })
  // A machine's readings for all of its Swarms in one call, answered per Swarm (DB roadmap 2.5).
  app.post<{ Params: z.infer<typeof hostParams>; Body: z.infer<typeof readingsBody> }>('/api/super-tabs/hosts/:machineId/readings',
    { bodyLimit: READINGS_BODY_LIMIT, preHandler: [validateParams(hostParams), validateBody(readingsBody)] },
    (req, reply) => respond(reply, async () => ({ results: (await store.observeMachines(req.user!, req.params.machineId, req.body.readings))
      .map(({ tabId, error }) => error === undefined ? { tabId, ok: true as const } : { tabId, error: readingError(tabId, error) }) })))
  // Retire no earlier than Dec 4, 2026 and 30 days after the first v2 Desktop, phone and CLI releases.
  app.get<{ Params: z.infer<typeof machineParams> }>('/api/super-tabs/:tabId/machines/:machineId/removal', { preHandler: validateParams(machineParams) },
    (req, reply) => respond(reply, () => store.machineRemoval(req.user!, req.params.tabId, req.params.machineId)))
  app.get<{ Params: z.infer<typeof machineParams> }>('/api/super-tabs/:tabId/machines/:machineId/removal/v2', { preHandler: validateParams(machineParams) },
    (req, reply) => respond(reply, () => store.machineRemoval(req.user!, req.params.tabId, req.params.machineId, 'v2')))
  app.post<{ Params: z.infer<typeof machineParams>; Body: z.infer<typeof machineObservationSchema> }>('/api/super-tabs/:tabId/machines/:machineId',
    { preHandler: [validateParams(machineParams), validateBody(machineObservationSchema)] },
    (req, reply) => respond(reply, () => store.observeMachine(req.user!, req.params.tabId, req.params.machineId, req.body)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/routing-policy',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.tabPolicy(req.user!, req.params.tabId, req.query.asAgentId)))
  app.get<{ Querystring: z.infer<typeof listQuery> }>('/api/super-tabs/list', { preHandler: validateQuery(listQuery) },
    (req, reply) => respond(reply, () => reads.list(req.user!, req.query.after)))
  app.post<{ Body: z.infer<typeof create> }>('/api/super-tabs', { preHandler: validateBody(create) },
    (req, reply) => respond(reply, () => store.create(req.user!, req.body.operationId, req.body.name, req.body.projectVisibility)))
  // The owner's deleted Swarms they can still restore (superTabs/deletion.ts); restoring is the swarm.restore command.
  app.get('/api/super-tabs/deleted', (req, reply) => respond(reply, () => store.deletedList(req.user!)))
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
  app.post<{ Params: z.infer<typeof hostParams> }>('/api/super-tabs/hosts/:machineId/terminal', { preHandler: validateParams(hostParams) },
    (req, reply) => respond(reply, noting(req, () => store.hostTerminal(req.user!, req.params.machineId), picked => !picked.length)))
  // Long-polls about 20 seconds; a request still waiting then answers `pending` and is read again.
  app.get<{ Params: z.infer<typeof terminalParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/terminal/:requestId',
    { preHandler: [validateParams(terminalParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.terminalResult(req.user!, req.params.tabId, req.params.requestId, req.query.asAgentId, 20_000)))
  // The read API by parts (design section 4, superTabs/read/contract.ts).
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/parts',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => reads.firstLoad(req.user!, req.params.tabId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof changesQuery> }>('/api/super-tabs/:tabId/changes',
    { preHandler: [validateParams(tabParams), validateQuery(changesQuery)] },
    (req, reply) => respond(reply, noting(req, () => reads.changes(req.user!, req.params.tabId, req.query.cursor, req.query.asAgentId,
      { ...(req.query.machines === 'light' ? { lightMachines: true } : {}), ...(req.query.derivedEtag ? { derivedEtag: req.query.derivedEtag } : {}) }),
      nothingChanged)))
  // The whole readings on demand, for a client that takes lines in its changes (read/changes.ts).
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/machine-readings',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => reads.machineReadings(req.user!, req.params.tabId, req.query.asAgentId)))
  // The projects a person may pick a main project from (superTabs/projectList.ts, task #4540), read when Cmd-N or Join opens.
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof projectListQuery> }>('/api/super-tabs/:tabId/project-list',
    { preHandler: [validateParams(tabParams), validateQuery(projectListQuery)] },
    (req, reply) => respond(reply, () => store.projectList(req.user!, req.params.tabId, req.query.invitedTo)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof leaderboardQuery> }>('/api/super-tabs/:tabId/leaderboard',
    { preHandler: [validateParams(tabParams), validateQuery(leaderboardQuery)] },
    (req, reply) => respond(reply, () => reads.leaderboard(req.user!, req.params.tabId, req.query.projectId, req.query.week, req.query.period, req.query.scope === 'all')))
  // The v4 leaderboard (docs/plans/2026-11-09-swarm-v4-leaderboard.md): people ranked by how many of their agents ship, from what each
  // person's daemon reads of GitHub with their own gh. The daemon asks what to read, and reports counts for the agents it runs.
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof boardQuery> }>('/api/super-tabs/:tabId/shipping',
    { preHandler: [validateParams(tabParams), validateQuery(boardQuery)] },
    (req, reply) => respond(reply, () => shipping.board(req.user!, req.params.tabId, req.query)))
  app.get<{ Params: z.infer<typeof hostParams> }>('/api/super-tabs/hosts/:machineId/shipping', { preHandler: validateParams(hostParams) },
    (req, reply) => respond(reply, () => shipping.targets(req.user!, req.params.machineId)))
  app.post<{ Params: z.infer<typeof hostParams>; Body: z.infer<typeof reportBody> }>('/api/super-tabs/hosts/:machineId/shipping',
    { preHandler: [validateParams(hostParams), validateBody(reportBody)] },
    (req, reply) => respond(reply, () => shipping.report(req.user!, req.params.machineId, req.body)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof dormantQuery> }>('/api/super-tabs/:tabId/groups',
    { preHandler: [validateParams(tabParams), validateQuery(dormantQuery)] },
    (req, reply) => respond(reply, () => reads.dormant(req.user!, req.params.tabId, { projectId: req.query.projectId, before: req.query.before }, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof groupParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/groups/:conversationId',
    { preHandler: [validateParams(groupParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => reads.group(req.user!, req.params.tabId, req.params.conversationId, req.query.asAgentId)))
  // A one-hour installation token for the repository of the calling agent's task, for git and gh on its machine
  // (docs/swarm-github-app.md). Only that agent's host, on the machine running it, while the task is in its hands. Kept for
  // sessions started with the app until 2026-12-10 (above NO_APP).
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
      return { ...issued, ...attribution(grant) }
    }))
  app.post<{ Params: z.infer<typeof tabParams>; Body: z.infer<typeof operation> }>('/api/super-tabs/:tabId/commands',
    { preHandler: [validateParams(tabParams), validateBody(operation, { named: true })] },
    (req, reply) => respond(reply, () => store.execute(req.user!, req.params.tabId,
      { operationId: req.body.operationId, command: req.body.command }, req.body.asAgentId, undefined, declaredHttpClient(req.headers))))
  // A chat file comes straight from the client (the desktop's and the browser's account token, or the daemon's for
  // `post --attach`), never through a machine or the relay. Multipart is parsed in this scope alone, so no other
  // Super Tab route's body handling changes.
  await app.register(async scope => {
    // One byte over the limit, so the store sees an oversized file and refuses it rather than keeping a cut one.
    // The file may come gzipped, said by `contentEncoding: gzip` between the two (attachments.ts formFileBody): the limit
    // here is on what arrives, and the store's cap on what it unpacks to.
    await scope.register(multipart, { limits: { fileSize: MAX_FORM_ATTACHMENT_BYTES + 1, files: 1, fields: 2, parts: 3 } })
    scope.post<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/attachments',
      { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] }, (req, reply) => respond(reply, async () => {
        let conversationId: string | null = null, encoding: 'gzip' | null | undefined, uploaded: unknown = null, stored: unknown = null
        try {
          for await (const part of req.parts()) {
            if (part.type === 'field') {
              if (part.fieldname === 'conversationId' && conversationId === null && encoding === undefined && !uploaded) {
                conversationId = id.safeParse(part.value).data ?? fail('INVALID_ATTACHMENT', 'Name the conversation to attach the file to.', 400)
              } else if (part.fieldname === 'contentEncoding' && conversationId !== null && encoding === undefined && !uploaded) {
                encoding = part.value === 'gzip' ? 'gzip' : fail('INVALID_ATTACHMENT', 'Send the file gzipped or as it is.', 400)
              } else fail('INVALID_ATTACHMENT', 'Send conversationId, then one file.', 400)
            } else {
              if (!conversationId || uploaded) { part.file.resume(); fail('INVALID_ATTACHMENT', 'Send conversationId, then one file.', 400) }
              const body = formFileBody(part.file, encoding ?? null)
              try {
                uploaded = await store.upload(req.user!, req.params.tabId, conversationId,
                  { name: part.filename, mime: part.mimetype, body }, req.query.asAgentId)
              } catch (error) {
                stored = unpackFailed(body) ? new SuperTabError('INVALID_ATTACHMENT', 'The file was not valid gzip.', 400) : error
                throw stored
              } finally { stopUnpacking(part.file, body); part.file.resume() }
            }
          }
        } catch (error) {
          // Only the form itself is the client's fault; the store's own failures keep their status.
          const code = error && typeof error === 'object' && 'code' in error ? error.code : null
          if (code === 'FST_REQ_FILE_TOO_LARGE') fail('ATTACHMENT_TOO_LARGE', FORM_TOO_LARGE_MESSAGE, 413)
          if (error instanceof SuperTabError || (error === stored && !(code && String(code).startsWith('FST_')))) throw error
          fail('INVALID_ATTACHMENT', 'Send a multipart form with conversationId and one file.', 400)
        }
        return uploaded ?? fail('INVALID_ATTACHMENT', 'Attach one file.', 400)
      }))
  })
  // A file over the form's 10 MB goes straight to the bucket on a link this server signs, then is checked here before any
  // message can carry it (store.ts uploadLink, completeUpload). Neither request carries the file, so both stay small.
  app.post<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery>; Body: z.infer<typeof uploadLinkBody> }>('/api/super-tabs/:tabId/attachments/uploads',
    { bodyLimit: 4096, preHandler: [validateParams(tabParams), validateQuery(agentQuery), validateBody(uploadLinkBody)] },
    (req, reply) => respond(reply, () => store.uploadLink(req.user!, req.params.tabId, req.body.conversationId,
      { name: req.body.name, mime: req.body.mime, size: req.body.size }, req.query.asAgentId)))
  app.post<{ Params: z.infer<typeof uploadParams>; Querystring: z.infer<typeof agentQuery>; Body: z.infer<typeof emptyBody> }>('/api/super-tabs/:tabId/attachments/uploads/:uploadId/complete',
    { bodyLimit: 1024, preHandler: [validateParams(uploadParams), validateQuery(agentQuery), validateBody(emptyBody)] },
    (req, reply) => respond(reply, () => store.completeUpload(req.user!, req.params.tabId, req.params.uploadId, req.query.asAgentId)))
  // A voice message's file, uploaded either way above, is read once before it is sent: its length, waveform and words (store.ts
  // readVoice). Its answer carries no words; message.send makes them the message's text.
  app.post<{ Params: z.infer<typeof voiceParams>; Querystring: z.infer<typeof voiceQuery>; Body: z.infer<typeof emptyBody> }>('/api/super-tabs/:tabId/attachments/:attachmentId/voice',
    { bodyLimit: 1024, preHandler: [validateParams(voiceParams), validateQuery(voiceQuery), validateBody(emptyBody)] },
    (req, reply) => respond(reply, () => store.readVoice(req.user!, req.params.tabId, req.params.attachmentId, req.query.lang ?? 'en', req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof startParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/starts/:startId',
    { preHandler: [validateParams(startParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.start(req.user!, req.params.tabId, req.params.startId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof messageParams>; Querystring: z.infer<typeof messageQuery> }>('/api/super-tabs/:tabId/conversations/:conversationId/messages',
    { preHandler: [validateParams(messageParams), validateQuery(messageQuery)] },
    (req, reply) => respond(reply, noting(req, () => store.messages(req.user!, req.params.tabId, req.params.conversationId, req.query, req.query.asAgentId),
      page => req.query.after !== undefined && !page.messages.length)))
  // A fresh short-lived link to one file of one message, for whoever may read that message now (superTabs/fileLinks.ts).
  app.get<{ Params: z.infer<typeof fileParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/conversations/:conversationId/messages/:messageId/attachments/:attachmentId',
    { preHandler: [validateParams(fileParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.fileLink(req.user!, req.params.tabId, req.params.conversationId, req.params.messageId,
      req.params.attachmentId, req.query.asAgentId)))
  app.post<{ Params: z.infer<typeof messageParams>; Querystring: z.infer<typeof noQuery>; Body: z.infer<typeof readMarkBody> }>('/api/super-tabs/:tabId/conversations/:conversationId/read',
    { preHandler: [validateParams(messageParams), validateQuery(noQuery), validateBody(readMarkBody)] },
    (req, reply) => respond(reply, () => reads.markRead(req.user!, req.params.tabId, req.params.conversationId, req.body.sequence)))
  // A person's own Mark unread (superTabs/readMarks.ts lowerReadMark): the one write that moves their mark back.
  app.post<{ Params: z.infer<typeof messageParams>; Querystring: z.infer<typeof noQuery>; Body: z.infer<typeof unreadBody> }>('/api/super-tabs/:tabId/conversations/:conversationId/unread',
    { preHandler: [validateParams(messageParams), validateQuery(noQuery), validateBody(unreadBody)] },
    (req, reply) => respond(reply, () => reads.markUnread(req.user!, req.params.tabId, req.params.conversationId, req.body.sequence)))
  // A person's own thread mark (superTabs/readMarks.ts), as the conversation's above.
  app.post<{ Params: z.infer<typeof threadParams>; Querystring: z.infer<typeof noQuery>; Body: z.infer<typeof readMarkBody> }>('/api/super-tabs/:tabId/conversations/:conversationId/threads/:threadId/read',
    { preHandler: [validateParams(threadParams), validateQuery(noQuery), validateBody(readMarkBody)] },
    (req, reply) => respond(reply, () => reads.markThreadRead(req.user!, req.params.tabId, req.params.conversationId, req.params.threadId, req.body.sequence)))
  // A person's own notification setting for a chat (superTabs/chatSettings.ts): all, mentions or muted.
  app.post<{ Params: z.infer<typeof messageParams>; Querystring: z.infer<typeof noQuery>; Body: z.infer<typeof notifyBody> }>('/api/super-tabs/:tabId/conversations/:conversationId/notifications',
    { preHandler: [validateParams(messageParams), validateQuery(noQuery), validateBody(notifyBody)] },
    (req, reply) => respond(reply, () => reads.setChatNotify(req.user!, req.params.tabId, req.params.conversationId, req.body.notify)))
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
  // A project's rules record and its kept revisions (superTabs/policy.ts): shown to people, in no prompt.
  app.get<{ Params: z.infer<typeof projectParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/projects/:projectId/rules',
    { preHandler: [validateParams(projectParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.projectRules(req.user!, req.params.tabId, req.params.projectId, req.query.asAgentId)))
  // Its machine rules alone, from the newest revision: what the route applies (task #3964).
  app.get<{ Params: z.infer<typeof projectParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/projects/:projectId/machine-rules',
    { preHandler: [validateParams(projectParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.projectMachineRules(req.user!, req.params.tabId, req.params.projectId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof decisionParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/route-decisions/:decisionId',
    { preHandler: [validateParams(decisionParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.routeDecision(req.user!, req.params.tabId, req.params.decisionId, req.query.asAgentId)))
  app.get<{ Params: z.infer<typeof deliveryParams>; Querystring: z.infer<typeof deliveryListQuery> }>('/api/super-tabs/:tabId/agents/:agentId/deliveries',
    { preHandler: [validateParams(deliveryParams), validateQuery(deliveryListQuery)] },
    (req, reply) => respond(reply, noting(req, () => store.deliveries(req.user!, req.params.tabId, req.params.agentId), open => !open.length)))
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
