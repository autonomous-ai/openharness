import { unsigned } from './signature.js'
import { quotaOf, readCapabilities } from './capacity.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CoreApi, ServiceRequests, SuperTabsPort } from '../core/api.js'
import { swarmListedFor, swarmRoleFor, hostJournalFile, SuperTabHost, type SuperTabHostOptions, type SwarmSources } from './host.js'
import { HostFeed } from './hostFeed.js'
import { SwarmReads, type SwarmRead } from './swarmReads.js'
import { backend, identifier, object, SuperTabHostError, within } from './wire.js'
import { isCoordinator, isStep } from './agentContext.js'
import { swarmBasics, wireRole } from '../lib/swarmSkills.js'
import { CapacityReservations, type ReservationBook } from './reservations.js'
import { engineExit } from './engineExit.js'
import { ContributionPreparations, ownerRequest, prepareContribution } from './contribution.js'
import { ClaudeSignIns } from './claudeSignIn.js'
import { answerFirstRun } from '../engines/launchPrep.js'
import { messageIdOf } from './attach.js'
import { cardId, SwarmCards, type CardChat } from './cards.js'
import { GitHubTokenRefresher, githubToken } from './github.js'
import { FirstAnswers } from './firstAnswers.js'
import { NextThing } from './nextThing.js'
import { GitHubMentions, projectRepositorySlug, watchedAgents, type WatchedAgent } from './githubMentions.js'
import { ShippingReporter } from './shipping.js'
import { currentNames, GitHubStop, githubRest, type GitHubGet, type GitHubSend } from './githubRest.js'
import { gatedWrites } from './githubWrites.js'
import { claimAsked, takeTask } from './githubClaim.js'
import { Cuts, sameCut, splitAsked, splitTask } from './githubSplit.js'
import { postVerdict, verdictAsked } from './githubVerdict.js'
import { GitHubAssign, swarmRepositories } from './githubAssign.js'
import { GitHubMerge, ledProjects, pmRunsHere, recordedAuthors, VerdictRecords, type LedProject } from './githubMerge.js'
import { numbersSender, PmNumbers } from './pmNumbers.js'
import { readTaskTokens, TaskTokens } from './taskTokens.js'
import { crewOf, labelOf } from './assign/crew.js'
import { agentOffers, answerOffer, noSuchRoute, OfferAnswers, offerTask, projectOffers, type Ask } from './taskOffers.js'
import { named as codeOf } from './agentReplies.js'
import { openDaemon } from '../agentClient/daemon.js'

import { peopleNamed } from './personName.js'

const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
/** [page] of a task with its [steps]' newest rows merged in by time, each tagged `step: <name>`; a step whose read fails is
 *  named in `stepsMissing`, and the task's rows still come back. */
async function withSteps(page: unknown, steps: Array<Record<string, unknown>>, read: (step: Record<string, unknown>) => Promise<unknown>): Promise<Record<string, unknown>> {
  const answers = await Promise.all(steps.map(step => read(step).then(answer => ({ step, rows: list(object(answer).messages) }), () => ({ step, rows: null }))))
  const at = (row: Record<string, unknown>) => String(row.createdAt ?? '')
  const rows: Array<Record<string, unknown>> = [...list(object(page).messages),
    ...answers.flatMap(({ step, rows }) => (rows ?? []).map(row => ({ ...row, step: step.step } as Record<string, unknown>)))]
  rows.sort((a, b) => at(a) === at(b) ? String(a.id).localeCompare(String(b.id)) : at(a) < at(b) ? -1 : 1)
  const missing = answers.filter(a => !a.rows).map(a => String(a.step.step))
  return { ...object(page), messages: rows, ...(missing.length ? { stepsMissing: missing } : {}) }
}

/** A Swarm read as `GET /api/super-tabs/:id` answered it, `lastChangedAt` in place of `revision` (design 2026-10-26 5.3). */
const answerOf = (read: SwarmRead) => ({ lastChangedAt: read.lastChangedAt, state: read.state })
const OFF_ROSTER = 'This agent is not on this machine\'s Swarm roster right now. That can mean this machine has no access to it, or its billing does not allow it. Check how this machine is shared.'
const NOT_IN_SWARM = 'This agent is not in a Swarm on this machine\'s roster. If it should be, this machine may have no access to it, or its billing does not allow it: check how this machine is shared.'
const OTHER_WORK_FIELDS = ['conversationId', 'projectName', 'title', 'owns', 'status', 'agentName', 'pr'] as const

/** Leads see each other's work (spec 2026-10-23): a Lead reads other projects' active work in the backend's fields alone;
 *  any other agent reads none of it. Nobody reads the Leads conversation, removed on 10-31, even from an older server
 *  that still sends it. */
function statusView(answer: Record<string, unknown>, agentId: string): Record<string, unknown> {
  const { otherProjectsWork, leadsConversationId, ...state } = object(answer.state)
  const shown = list(state.conversations).filter(c => c.kind !== 'leads' && (leadsConversationId == null || c.id !== leadsConversationId))
  // A task's steps are printed under it, not as rows of their own (task steps design); one whose task is not here stays a row.
  const ids = new Set(shown.map(c => c.id))
  const nested = (c: Record<string, unknown>) => isStep(c) && ids.has(c.reviewOf)
  const conversations = shown.filter(c => !nested(c)).map(c => {
    const steps = shown.filter(s => nested(s) && s.reviewOf === c.id)
    return steps.length ? { ...c, steps } : c
  })
  if (isCoordinator(state, agentId)) {
    return { ...answer, state: { ...state, conversations,
      ...(Array.isArray(otherProjectsWork) ? { otherProjectsWork: list(otherProjectsWork).map(work =>
        Object.fromEntries(OTHER_WORK_FIELDS.filter(key => key in work).map(key => [key, work[key]]))) } : {}) } }
  }
  return { ...answer, state: { ...state, conversations } }
}

/** A post's mentions name people by id, username or display name, or (older callers) email (personName.ts peopleNamed); the
 *  backend takes person ids. A name that is nobody in the Swarm, or that two people go by, is refused here, before anything is
 *  sent. Whether this agent may tag them in this conversation is the backend's to judge. Only such a post reads the Swarm,
 *  for its people. */
async function mentionCommand(command: Record<string, unknown>, swarm: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (command.type !== 'message.send' || !Array.isArray(command.mentions)) return command
  const people = list((await swarm()).people)
  const ids = command.mentions.map(name => {
    const named = typeof name === 'string' ? peopleNamed(people, name) : []
    if (!named.length) throw new SuperTabHostError('MENTION_UNKNOWN', `${String(name)} is not a person in this Swarm. Tag a person by the username or id shown in status.`, 400)
    if (named.length > 1) {
      const usernames = named.map(p => String(p.username ?? p.id)).join(', ')
      throw new SuperTabHostError('MENTION_AMBIGUOUS', `${String(name)} is the name of more than one person here (${usernames}). Tag them by username or id.`, 400)
    }
    return named[0]!.id
  })
  return { ...command, mentions: [...new Set(ids)] }
}

/** Tell the agent which messages sent to it it has already answered, so it posts once (a Lead answered one question twice on
 * 2026-10-20). A message is answered when a later message of the agent's own replies to it. */
function markAnswered(page: unknown, later: unknown[], agentId: string): unknown {
  const body = object(page)
  if (!Array.isArray(body.messages)) return page
  const mine = new Set([...body.messages, ...later].map(object).filter(m => object(m.author).id === agentId && typeof m.replyTo === 'string').map(m => m.replyTo))
  // An answer right below a message has no replyTo (task #2929): the caller's delivery of the message says it was answered.
  const settled = (m: Record<string, unknown>) => Array.isArray(m.deliveries) && m.deliveries.map(object).some(d => d.agentId === agentId && d.status === 'answered')
  return { ...body, messages: body.messages.map(object).map(row => {
    // `thread` is named on a thread reply only: a top-level message is its own thread's root, and an older row has none.
    const { thread, ...m } = row
    const reply = typeof thread === 'string' && thread !== m.id ? { ...m, thread } : m
    const asked = Array.isArray(m.recipientIds) && m.recipientIds.includes(agentId) && object(m.author).id !== agentId
    return asked ? { ...reply, answered: mine.has(m.id) || settled(m) } : reply
  }) }
}

export interface SuperTabServiceOptions {
  prepareContribution?: typeof prepareContribution
  capacity?: typeof readCapabilities
  host?: (core: CoreApi, machineId: string, options: SuperTabHostOptions) => SuperTabHost
  reservations?: (core: CoreApi, machineId: string) => ReservationBook
  /** The Swarm cards' reader (superTabs/cards.ts), for a spec. */
  cards?: (core: CoreApi, machineId: string) => SwarmCards
  /** What keeps Swarm sessions' GitHub tokens fresh (superTabs/github.ts), for a spec. */
  githubTokens?: (core: CoreApi) => Pick<GitHubTokenRefresher, 'start' | 'stop'> & Partial<Pick<GitHubTokenRefresher, 'assigned'>>

  /** What reads GitHub for this computer's person's v4 agents (superTabs/githubMentions.ts), for a spec. */
  githubMentions?: (core: CoreApi, sources: () => SwarmSources) => Pick<GitHubMentions, 'start' | 'stop' | 'owed'>
  /** What merges by rule the pull requests of the projects whose PM runs here (superTabs/githubMerge.ts), for a spec. */
  githubMerge?: (core: CoreApi, sources: () => SwarmSources) => Pick<GitHubMerge, 'start' | 'stop'>
  /** What gives the tasks of the projects whose PM runs here to their builders (superTabs/githubAssign.ts), for a spec. */
  githubAssign?: (core: CoreApi, sources: () => SwarmSources) => Pick<GitHubAssign, 'start' | 'stop'>
  /** GitHub as this computer's own gh login (superTabs/githubRest.ts), for a spec. */
  github?: () => { get: GitHubGet; send: GitHubSend }
  /** What reports what this computer's person's agents shipped to the Swarm's leaderboard (superTabs/shipping.ts), for a spec. */
  shipping?: (core: CoreApi) => Pick<ShippingReporter, 'start' | 'stop'>
  /** What posts an agent's answer to its launch line in its chat (superTabs/firstAnswers.ts), for a spec. */
  firstAnswers?: (core: CoreApi, sources: () => SwarmSources) => Pick<FirstAnswers, 'start' | 'stop'>
  /** What types an agent its next thing as its turn ends (superTabs/nextThing.ts), for a spec. */
  nextThings?: (core: CoreApi, sources: () => SwarmSources) => Pick<NextThing, 'start' | 'stop' | 'inbox' | 'offered'>
  /** What answers the offers made to this computer's person's agents (superTabs/taskOffers.ts), for a spec. */
  offerAnswers?: (core: CoreApi, sources: () => SwarmSources) => Pick<OfferAnswers, 'start' | 'stop'>
  /** What counts the tokens each agent's conversation uses on each task (superTabs/taskTokens.ts), for a spec. */
  taskTokens?: (core: CoreApi) => Pick<TaskTokens, 'start' | 'stop' | 'looked' | 'read' | 'took'>
}
const LOCAL_ONLY = 'An agent speaks to the Swarm through its own computer\'s Harness only, not through another machine.'
/** What an agent's commands send as the agent: a post or an answer, and a read of another agent's terminal or typing into it.
 *  Nothing else of the old manual (assign, start, react, propose, release, ...) goes out through here, whatever a process
 *  writes to the daemon's socket. */
const AGENT_COMMANDS: ReadonlySet<string> = new Set(['message.send', 'agent.screen', 'agent.input'])

export function superTabService(core: CoreApi, options: SuperTabServiceOptions = {}): { requests: ServiceRequests; port: SuperTabsPort } {
  const preparations = new ContributionPreparations(input => (options.prepareContribution ?? prepareContribution)(core, input))
  const claudeSignIns = new ClaudeSignIns()
  /** The sign-in this machine's reading was last told of. */
  let reported: string | null = null
  // One host form and one set of Swarm reads per machine, shared by the host and every action here (design 2026-10-26 5.3).
  let held: SwarmSources | null = null
  const sources = (): SwarmSources => {
    const machine = core.daemon.machineId()
    if (held?.feed.machineId !== machine) {
      held = { feed: new HostFeed(core, machine), reads: new SwarmReads(core) }
      // A task's GitHub token is fetched as the host first sees the task, not at the refresher's next minute (github.ts).
      held.feed.watch(read => tokens.assigned?.(read))
    }
    return held
  }
  let host: SuperTabHost | null = null
  let book: ReservationBook | null = null, bookMachine: string | null = null

  const reservations = () => {
    const machine = core.daemon.machineId()
    if (bookMachine !== machine) { book?.stop(); book = null; bookMachine = machine }
    book ??= (options.reservations ?? ((api, id) => new CapacityReservations(api, id)))(core, machine)
    return book
  }
  // GitHub as this computer's own gh login, for the news to its person's v4 agents and the merges of their PM's projects:
  // read and merged while the host runs (no host, no Swarm agents here to read or merge for).
  // Every write passes the gate: nothing of Harness's said twice in a day, and none past its hourly limits (githubWrites.ts).
  const github = gatedWrites((options.github ?? githubRest)())
  // What GitHub names a project's repository now: a take, a read or a cut may name it either way (githubVerdict.ts ProjectRepositories).
  const currentName = currentNames(github.get)
  // The verdicts, claims and cuts being made by command now, by agent and what was asked: as many as there are commands running.
  const commands = new Map<string, Promise<unknown>>()
  // Each agent's cuts here, one after another and no more than an hour holds (githubSplit.ts Cuts).
  const cuts = new Cuts()
  // This computer's GitHub login, asked once: a verdict or a claim made by command looks for its own earlier comment by it
  // (githubVerdict.ts, githubClaim.ts).
  let githubLogin: Promise<string> | null = null
  const loginOf = () => githubLogin ??= github.get('/user', null).then(reply => {
    const login = object(reply.body).login
    if (reply.status !== 200 || typeof login !== 'string' || !login) throw new Error(`GitHub answered ${reply.status} for this computer's login.`)
    return login
  }).catch(error => { githubLogin = null; throw error })
  // GitHub for this computer's person's v4 agents (githubMentions.ts).
  // As the agent, to itself only, in its chat with its person: as the host tells a skill notice (host.ts tellSkill).
  const tellAgent = (api: CoreApi) => (agent: WatchedAgent, operationId: string, text: string) => backend(api, 'POST', `/api/super-tabs/${agent.tabId}/commands`,
    { operationId, asAgentId: agent.agentId, command: { type: 'message.send', conversationId: agent.chat, replyTo: null, recipientIds: [agent.agentId], text, agentOnly: true } })
  // In its chat, for its person to read and not typed to it: as the host posts an agent's first answer (firstAnswers.ts).
  const sayToPerson = (api: CoreApi) => (agent: WatchedAgent, operationId: string, text: string) => backend(api, 'POST', `/api/super-tabs/${agent.tabId}/commands`,
    { operationId, asAgentId: agent.agentId, command: { type: 'message.send', conversationId: agent.chat, replyTo: null, recipientIds: [], text } })
  // The Swarm's server as this computer, for the offers of tasks (taskOffers.ts).
  const ask: Ask = (method, path, body) => backend(core, method, path, body)
  // This computer's person's v4 agents running here (githubMentions.ts).
  const watched = (api: CoreApi, held: () => SwarmSources) => async () => watchedAgents({ me: (await api.account.identity().catch(() => null))?.accountId ?? null,
    live: id => !!api.agents.byAgent(id), roster: async () => (await held().feed.current(60_000)).roster, read: async (tabId, agentId) => (await held().reads.read(tabId, agentId)).state })
  const mentions = (options.githubMentions ?? ((api, held) => new GitHubMentions({
    watched: watched(api, held),
    get: github.get,
    relay: (tabId, operationId, command) => backend(api, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId, command }),
    tell: tellAgent(api),
    say: sayToPerson(api),
    file: join(api.dataDir, 'super-tab-github-news.json'),
  })))(core, sources)
  // The projects whose PM is this person's agent here, running or stopped, which the merger and the assigner work for. The
  // work needs its person's gh, not its session: while Juno, the swarm-sandbox's PM, was stopped, its #17 waited six hours
  // with a READ-OK and green checks (2026-11-09). A closed PM's row is gone, and leads nothing.
  const led = (api: CoreApi, held: () => SwarmSources) => async () => ledProjects({ me: (await api.account.identity().catch(() => null))?.accountId ?? null,
    live: async id => !!api.agents.byAgent(id) || await api.agents.stopped?.(id) === true, roster: async () => (await held().feed.current(60_000)).roster,
    read: async (tabId, agentId) => (await held().reads.read(tabId, agentId)).state })
  // Merges by rule the pull requests of those projects (githubMerge.ts).
  // The crew of a project its PM leads, as the PM reads the Swarm.
  const crewOfProject = (held: () => SwarmSources) => async (project: LedProject) =>
    crewOf((await held().reads.read(project.tabId, project.pmAgentId)).state, project)
  // Who made each verdict by command, read once for the merger and the assigner alike.
  const records = new VerdictRecords(recordedAuthors(path => backend(core, 'GET', path)), Date.now, line => console.warn(line))
  // A project's numbers, and what its PM says of its offers, sent as its PM into the Swarm as the PM reads it (pmNumbers.ts
  // messageOf). They keep the files most of its landings touch, from its day's scoreboard, which the merger uses too (the
  // allocator's design, package 8).
  const sendAsPm = numbersSender(async project => (await sources().reads.read(project.tabId, project.pmAgentId)).state, (path, body) => backend(core, 'POST', path, body))
  const numbers = new PmNumbers({ file: join(core.dataDir, 'super-tab-numbers.json'), send: sendAsPm })
  // What a landed change cost its builder is read of the server as the project's PM, for the comment that says it landed
  // (taskTokens.ts).
  const merges = (options.githubMerge ?? ((api, held) => new GitHubMerge({ projects: led(api, held), crew: crewOfProject(held), get: github.get,
    send: github.send, records, costs: readTaskTokens(path => backend(api, 'GET', path)), hot: project => numbers.hot(project) })))(core, sources)
  // Gives their tasks to their builders (githubAssign.ts), from the crew as the PM reads the Swarm.
  const assigns = (options.githubAssign ?? ((api, held) => new GitHubAssign({ projects: led(api, held), crew: crewOfProject(held),
    // The Swarm's projects as its PM's person reads it, read by what changed, as every Swarm read is: the PM reads only its own.
    repositories: async project => swarmRepositories((await held().reads.read(project.tabId)).state),
    get: github.get, send: github.send, records, numbers,
    say: (project, operationId, text) => sendAsPm('say', project, operationId, text),
    pmRunning: async project => pmRunsHere((await held().feed.current(60_000)).roster, project, id => !!api.agents.byAgent(id)),
    offers: { offer: (project, number, agentId) => offerTask(ask, project.tabId, project.pmAgentId, { repository: project.repo, number, agentId }),
      listed: (project, numbers) => projectOffers(ask, project.tabId, project.pmAgentId, project.repo, numbers) } })))(core, sources)
  // What this computer's person's agents shipped, read from GitHub with their own gh and told to the leaderboard (shipping.ts).
  const shipping = (options.shipping ?? (api => new ShippingReporter(api)))(core)
  // An agent's answer to the launch line the daemon typed as it made it, in its chat with its person (firstAnswers.ts): as
  // the agent, as the host posts a reply (agentReplies.ts).
  const firstAnswers = (options.firstAnswers ?? ((api, held) => new FirstAnswers({
    me: async () => (await api.account.identity().catch(() => null))?.accountId ?? null, live: id => !!api.agents.byAgent(id),
    roster: async () => (await held().feed.current(60_000)).roster, read: async (tabId, agentId) => (await held().reads.read(tabId, agentId)).state,
    working: async id => { const now = (await api.agents.activity([id]))[id]; return now === 'working' ? true : now === 'idle' ? false : null },
    lastTurn: async id => { const session = api.agents.byAgent(id)?.sessionId; return session ? api.transcripts.lastTurn(session) : null },
    onEnd: listener => api.turns.onEnd(listener), answerOf: end => api.turns.answerOf(end),
    // Its person's words in its chat, read as it reads them: the request they started it with is the first (backend agent.add).
    words: async agent => {
      const page = object(await backend(api, 'GET', `/api/super-tabs/${agent.tabId}/conversations/${encodeURIComponent(agent.chat)}/messages?asAgentId=${agent.agentId}`))
      return (Array.isArray(page.messages) ? page.messages.map(object) : [])
        .filter(m => object(m.author).kind === 'person' && typeof m.text === 'string').map(m => m.text as string)
    },
    post: (agent, operationId, text) => backend(api, 'POST', `/api/super-tabs/${agent.tabId}/commands`, { operationId, asAgentId: agent.agentId,
      command: { type: 'message.send', conversationId: agent.chat, text, replyTo: null, recipientIds: [] } }),
    file: join(api.dataDir, 'super-tab-first-answers.json'),
  })))(core, sources)
  // What each of this person's agents' conversations used on each task (taskTokens.ts), counted here, where a task's boundaries
  // are seen, and kept by the Swarm's server for the project's members. The count is the core's last reading of the agent's
  // conversation (memory only); a row goes to the server as the agent it is of, as its verdicts' records do.
  const taskTokens = (options.taskTokens ?? (api => new TaskTokens({
    onEnd: listener => api.turns.onEnd(listener),
    count: async harnessId => {
      const session = api.agents.byAgent(harnessId)
      return (session ? await api.usage?.(session) : null)?.models ?? null
    },
    send: (agent, row) => backend(api, 'POST', `/api/super-tabs/${agent.tabId}/task-tokens?asAgentId=${agent.agentId}`, row),
    file: join(api.dataDir, 'super-tab-task-tokens.json'),
  })))(core)
  // An agent's next thing, typed as its turn ends (nextThing.ts): its next task while it holds none of its own, read from its
  // project's repository with this person's gh, typed as Harness tells it GitHub news, and said to its person once it was given
  // the same three times.
  const nextThings = (options.nextThings ?? ((api, held) => new NextThing({
    onEnd: listener => api.turns.onEnd(listener),
    watched: watched(api, held),
    offers: agent => agentOffers(ask, agent.tabId, agent.agentId),
    // The asks to read GitHub news keeps for each agent as it hands on what GitHub says (githubMentions.ts).
    owed: (agent, repo) => mentions.owed(agent.agentId, repo),
    working: async id => { const now = (await api.agents.activity([id]))[id]; return now === 'working' ? true : now === 'idle' ? false : null },
    get: github.get, send: github.send,
    tell: tellAgent(api),
    say: sayToPerson(api),
    file: join(api.dataDir, 'super-tab-next-things.json'),
    // Verdicts read as the merger reads them (githubMerge.ts verdicts): every agent of a person posts as that person's login, so a
    // signature names its reader only when it names one of the team, and only a READ-OK the backend recorded is a read.
    team: async agent => new Set(list((await held().reads.read(agent.tabId, agent.agentId)).state.agents)
      .map(a => labelOf(String(a.displayName ?? a.name ?? a.id)))),
    named: (agent, repo, comments) => records.named({ repo, pm: '', tabId: agent.tabId, pmAgentId: agent.agentId, projectId: '' }, comments),
    // What each look found the agent with says which task its turns' tokens were for.
    looked: (agent, hands) => { void taskTokens.looked(agent, hands) },
  })))(core, sources)
  // The offers made to this computer's person's agents, checked against this machine and the agent's subscription here and
  // answered (taskOffers.ts): the subscription's percentages are read here and never leave this computer.
  const offerAnswers = (options.offerAnswers ?? ((api, held) => new OfferAnswers({
    watched: watched(api, held), ask, get: github.get,
    session: harnessId => { const session = api.agents.byAgent(harnessId); return session ? { cwd: session.cwd, engine: session.engine } : null },
    machine: async (cwd, tools) => readCapabilities({ cwd: cwd ?? api.dataDir, tools }),
    windows: async engine => {
      const local = await openDaemon({ dataDir: api.dataDir, port: api.daemon.port, machineId: api.daemon.machineId() })
      try { return quotaOf(object(await local.request('usage_read', {}, 20_000)), engine, false) } finally { local.close() }
    },
    onNotice: listener => api.account.onNotice(listener), say: sayToPerson(api),
    accepted: agent => nextThings.offered(agent.harnessId),
    file: join(api.dataDir, 'super-tab-offers-told.json'),
  })))(core, sources)
  const wake = () => {
    const machine = core.daemon.machineId()
    if (host?.machineId !== machine) { host?.stop(); host = null }
    host ??= (options.host ?? ((api, id, given) => new SuperTabHost(api, id, given)))(core, machine,
      { startReceipt: harnessId => reservations().creationOf(harnessId), sources: sources() })
    host.start()
    mentions.start()
    merges.start()
    assigns.start()
    shipping.start()
    firstAnswers.start()
    taskTokens.start()
    nextThings.start()
    offerAnswers.start()
    return host
  }
  // The Swarm cards for a Harness Pro (superTabs/cards.ts), read while a device that shows them is attached and told to the core.
  let swarmCards: SwarmCards | null = null, cardsMachine: string | null = null
  const cards = () => {
    const machine = core.daemon.machineId()
    if (cardsMachine !== machine) { swarmCards?.want(false); swarmCards = null; cardsMachine = machine }
    if (!swarmCards) {
      swarmCards = (options.cards ?? ((api, id) => new SwarmCards(api, id, { reads: sources().reads })))(core, machine)
      swarmCards.onCards = items => core.superTabs?.cards(items)
      swarmCards.onRecap = recap => core.superTabs?.cardRecap(recap)
    }
    return swarmCards
  }
  // Sessions doing another person's project work keep a live GitHub App token while their task lasts, and none after.
  const tokens = (options.githubTokens ?? (api => new GitHubTokenRefresher(api, sources)))(core)
  // The server's word that one of this machine's Swarms changed, heard while no host runs (Amon, #3215).
  let hostWake: (() => void) | null = null
  const disconnect = () => { hostWake?.(); hostWake = null; preparations.clear(); claudeSignIns.stop(); host?.stop(); host = null; mentions.stop(); merges.stop(); assigns.stop(); shipping.stop(); firstAnswers.stop(); nextThings.stop(); taskTokens.stop(); offerAnswers.stop(); held = null; book?.stop(); book = null; bookMachine = null; swarmCards?.want(false); swarmCards = null; cardsMachine = null; tokens.stop() }
  const port = {
    connected: () => {
      tokens.start()
      if (identifier(core.daemon.machineId()) && existsSync(hostJournalFile(core.dataDir, core.daemon.machineId()))) wake()
      // A machine can be in a Swarm without this daemon ever adding it (Amon, #3215: the server moved his computer's entry to his
      // account, backend computerMoves.ts), so it keeps no host record and the check above never starts its host. The server says
      // when one of this machine's Swarms changes, naming it: that starts the host. Its word that it pushes names none.
      hostWake?.()
      hostWake = core.account.onNotice(notice => {
        if (!host && notice.type === 'swarm_host_changed' && identifier(notice.tabId) && identifier(core.daemon.machineId())) wake()
      })
    },
    disconnected: disconnect,
    stop: disconnect,
    swarmRole: async (harnessId: string) => (await within(swarmRoleFor(sources(), harnessId).then(grant => ({ grant }))))?.grant,
  }
  const requests: ServiceRequests = {
    super_tabs: async (payload, asker, closed) => {
      try {
        // Existing machine access routes the frame. Waking reads this host's own
        // registered contributions only, and grants the caller no account access.
        if (payload.action === 'wake') { wake(); return { ok: true } }
        if (payload.action === 'capacity') return (options.capacity ?? readCapabilities)(payload)
        // Machine access also authorizes native creation. These actions expose
        // only that host's admission/receipt, never its account or private roster.
        if (payload.action === 'reserveCapacity') return await reservations().reserve(payload, closed)
        // A receipt whose agent ended says how its engine left the pane this machine kept, in fixed words (engineExit.ts): its
        // status, and whether it refused an option. None of the pane's words leave this machine.
        if (payload.action === 'observeCapacity') {
          const observed = await reservations().observe(payload.creationId, closed)
          const exit = observed.released === true && identifier(observed.harnessId) ? await engineExit(core, observed.harnessId) : null
          return exit ? { ...observed, engineExit: exit } : observed
        }
        if (payload.action === 'returnCapacity') return await reservations().giveBack(payload.creationId, closed)
        // Only this machine's own host, which read the Swarm's verdict for its start (machines.ts): a relayed caller could
        // otherwise free memory a start still holds (issue #2989).
        if (payload.action === 'endCapacity') return asker.local ? await reservations().ended(payload.creationId, closed) : { error: 'OWNER_REQUIRED' }
        if (!asker.owner || (!asker.local && asker.accountOwner !== true)) return { error: 'OWNER_REQUIRED' }
        // `harness git-credential` in a local agent's shell (superTabs/gitCredential.ts): the token of that agent's task,
        // which goes to this computer's own processes alone, never to another machine through the relay.
        if (payload.action === 'githubToken') {
          if (!asker.local) return { error: 'OWNER_REQUIRED' }
          return await githubToken(core, String(payload.harnessId ?? ''), sources())
        }
        // A Desktop from before team machines went asks why its Mac's Harness Team account has not joined, and sends Retry
        // (machines.dart, until its own removal; delete on or after 2026-12-10). No Team account joins any more: nothing to say.
        if (payload.action === 'teamJoinStatus' || payload.action === 'teamJoinRetry') return asker.local ? { ok: true } : { error: 'OWNER_REQUIRED' }
        if (payload.action === 'swarmRole') {
          const grant = await port.swarmRole(String(payload.harnessId ?? ''))
          // In the wire's values, which the core reads in either set (inCore/role.ts) and a core from before role kinds in
          // these alone; a Reviewer's keeps its kind.
          return { ok: true, role: grant ? wireRole(grant) : grant }
        }
        // What Harness adds to an agent's instructions at every start, for its person to read in Desktop's Instructions beside the
        // rest (anh Dee, 2026-11-11: "show users what goes into the agent"): the Swarm's basics for its role, as this release gives
        // them (lib/swarmSkills.ts). Its own agents/<name>.md, which comes after them, is read apart. No role, or an unreadable
        // roster, answers no `text`.
        if (payload.action === 'basics') {
          const grant = await port.swarmRole(String(payload.harnessId ?? ''))
          return grant ? { ok: true, text: swarmBasics(grant.role === 'coordinator').text } : { ok: true }
        }
        // Import agent (Desktop): whether any Swarm lists this harness here. An unreadable roster answers no `listed`, on which
        // Desktop refuses rather than share.
        if (payload.action === 'swarmListed') {
          const listed = await within(swarmListedFor(sources(), String(payload.harnessId ?? '')))
          return listed === null ? { ok: true } : { ok: true, listed }
        }

        if (payload.action === 'prepareContribution') return preparations.read(payload)
        // The phone signing Claude Code, or Codex (`engineSignIn` {engine}), in here as it sets this computer up (claudeSignIn.ts):
        // its owner's, as the setup is.
        if (payload.action === 'claudeSignIn' || payload.action === 'engineSignIn') {
          const answer = await claudeSignIns.read(payload)
          // Once per sign-in: the Swarm reads it signed in now, before the next start asks.
          if (answer.state === 'done' && reported !== payload.operationId) {
            reported = String(payload.operationId)
            wake().engineSignedIn()
          }
          return answer
        }
        // The phone's answers to Claude Code's first-run questions here, asked as it sets this computer up
        // (engines/launchPrep.ts answerFirstRun): its owner's, as the setup is.
        if (payload.action === 'claudeFirstRun') {
          // Its theme and first-run screens only: no Swarm agent starts in full mode (task #4215), so a phone's
          // `acceptFullMode` from before is read as nothing.
          if (typeof payload.theme !== 'string') return { error: 'INVALID_REQUEST' }
          return answerFirstRun('claude', { theme: payload.theme }) ? { ok: true } : { error: 'FIRST_RUN_UNANSWERED' }
        }
        // The devices' (core/devicesLink.ts): a Harness Pro that shows the Swarm cards is attached or gone, wants a Lead's recap, or
        // has one open. They read the account's Swarms as the person, and need no agent.
        // Only this computer's own devices ask: an account owner on another machine does not make this one read the Swarms.
        if (payload.action === 'cardsWanted' || payload.action === 'cardRecap' || payload.action === 'cardOpen' || payload.action === 'cardSay' || payload.action === 'cardWorker') {
          if (!asker.local) return { error: 'OWNER_REQUIRED' }
          // A round dial that speaks swarmChat asks for the chat on its face (design 2026-10-28-round-dial-swarm-chat), and one
          // that speaks swarmBuddy for the face on the side it keeps ('buddy', spec 2026-10-29-round-dial-pm-buddy).
          const chat: CardChat = payload.chat === 'buddy' ? 'buddy' : payload.chat === true
          if (payload.action === 'cardsWanted') {
            const include = Array.isArray(payload.include) ? payload.include.filter(cardId) : []
            const asked = payload.focus && typeof payload.focus === 'object' ? payload.focus as Record<string, unknown> : {}
            const focus = cardId(asked.tabId) && cardId(asked.conversationId)
              ? { tabId: asked.tabId, conversationId: asked.conversationId } : null
            cards().want(payload.on === true, include, focus)
            return { ok: true }
          }
          if (payload.action === 'cardRecap' && cardId(payload.tabId) && cardId(payload.leadId)) return { ok: true, ...await cards().recap(payload.tabId, payload.leadId, chat) }
          if (payload.action === 'cardSay' && cardId(payload.harnessId) && typeof payload.text === 'string' && payload.text.trim() && payload.text.length <= 32_000) {
            const pinned: [chatId?: string, reviewed?: boolean] = !cardId(payload.chatId) ? []
              : payload.reviewed === true ? [payload.chatId, true] : [payload.chatId]
            const result = await cards().say(payload.harnessId, payload.text.trim(), chat, ...pinned)
            // A refusal travels with its code and message, which the dial shows instead of typing the words anywhere.
            return { ok: true, said: result.said, ...(!result.said && result.refused ? { refused: result.refused } : {}) }
          }
          // A card's failure from another computer: whether its agent is a Swarm's Builder or Reviewer, from the Swarms read last.
          if (payload.action === 'cardWorker' && identifier(payload.machineId) && identifier(payload.harnessId)) {
            return { ok: true, worker: cards().worker(payload.machineId, payload.harnessId) }
          }
          if (payload.action === 'cardOpen' && cardId(payload.session) && cardId(payload.tabId) && (payload.leadId === null || cardId(payload.leadId))) {
            cards().open(payload.session, payload.tabId, payload.leadId, chat)
            return { ok: true }
          }
          return { error: 'INVALID_REQUEST' }
        }
        if (payload.action === 'backend') {
          const { method, path } = payload
          if (!['GET', 'POST'].includes(String(method)) || typeof path !== 'string'
            || !/^\/api\/super-tabs(?:\/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9_=&%-]+)?$/.test(path)) {
            return { error: 'INVALID_REQUEST', detail: 'Choose a Super Tab endpoint.' }
          }
          return { ok: true, value: (await ownerRequest(core, method as string, path, payload.body)).value }
        }
        const named = identifier(payload.agentId) ? payload.agentId : null
        const hashed = identifier(payload.harnessId) ? createHash('sha256').update(JSON.stringify([core.daemon.machineId(), payload.harnessId])).digest('hex').slice(0, 24) : null
        // An agent speaks through its own computer's Harness alone: the second review of #2087 sent an agent's request with
        // --machine to the owner's other Mac, which knew no pane there and served the agent it named. Delivered instructions
        // always name this computer.
        if (!asker.local) return { error: 'AGENT_LOCAL_ONLY', detail: LOCAL_ONLY }
        // An agent in its own pane may leave its Swarm out: the one Swarm its harness is in on this machine is meant. Swarm v4
        // (2026-11-09): an agent its person only talks to in their 1:1 chat is typed their words alone (#3627) and never told
        // its Swarm's id, and the basics tell it to post in its project's channel (lib/swarmSkills.ts). In two, it names one.
        if (!identifier(payload.tabId) && identifier(payload.harnessId) && !named) {
          const tabs = [...new Set((await sources().feed.refresh()).roster.filter(row => object(row.agent).harnessId === payload.harnessId
            && object(row.agent).machineId === core.daemon.machineId() && row.closeSession !== true).map(row => row.tabId).filter(identifier))]
          if (tabs.length > 1) return { error: 'SWARM_AMBIGUOUS', detail: `This agent is in ${tabs.length} Swarms: name one with --tab (${tabs.join(', ')}).` }
          // In none on this machine's roster no id would help it; the server also leaves off one this machine has no access or
          // billing for, so that is said too.
          if (tabs.length === 1) payload.tabId = tabs[0]
          else return { error: 'NOT_IN_SWARM', detail: NOT_IN_SWARM }
        }
        if (!identifier(payload.tabId)) return { error: 'INVALID_REQUEST', detail: 'Name the Swarm with --tab ID.' }
        if (!(named ?? hashed)) return { error: 'INVALID_REQUEST' }
        // The caller is one of this machine's running agents, as the host roster lists it now: no Swarm is read to know that
        // (design 2026-10-26 5.3), and the roster is read again for every call, as the whole Swarm once was, by its changes
        // since the host's last read. A replacement terminal is still its original member, found by its harness.
        const { feed, reads } = sources()
        const callerIn = (roster: Record<string, unknown>[]) => {
          const rows = roster.filter(row => row.tabId === payload.tabId && row.closeSession !== true && object(row.agent).machineId === core.daemon.machineId())
          const member = rows.find(row => object(row.agent).harnessId === payload.harnessId && row.stopRequested !== true)
          const id = named ?? (identifier(object(member?.agent).id) ? object(member?.agent).id : hashed)
          return rows.find(row => object(row.agent).id === id)
        }
        const caller = callerIn((await feed.refresh()).roster)
        const agent = object(caller?.agent)
        // The server leaves an agent off the roster when this machine has no access or billing for it; it gives no reason,
        // and the server enforces the grant anyway, so the text says where to look (Lead's ruling, #1726 G5).
        if (!caller || !identifier(agent.id)) return { error: 'AGENT_UNAVAILABLE', detail: OFF_ROSTER }
        // A harness speaks as its own agent alone (security review of #2087: one named another agent with --agent).
        if (named && identifier(payload.harnessId) && agent.harnessId !== payload.harnessId) {
          return { error: 'AGENT_MISMATCH', detail: 'This harness may speak only as its own Swarm agent. Run the command without --agent, or with its own id.' }
        }
        if (typeof agent.harnessId !== 'string' || identifier(payload.harnessId) && agent.harnessId !== payload.harnessId || !core.agents.byAgent(agent.harnessId)) {
          return { error: 'AGENT_UNAVAILABLE', detail: 'This agent is not a running contribution on this machine.' }
        }
        const agentId = agent.id
        const path = `/api/super-tabs/${payload.tabId}`
        const identity = `asAgentId=${agentId}`
        const swarm = () => reads.read(String(payload.tabId), agentId)
        wake()
        if (payload.action === 'status') {
          return { ok: true, value: statusView(answerOf(await swarm()), agentId) }
        }
        // What waits for this agent, a line each, as its turns' ends type it (`harness super-tab inbox`, nextThing.ts); GitHub's
        // refusal by its code, as GitHub news and the assigner say it (githubRest.ts).
        if (payload.action === 'inbox') {
          try { return { ok: true, value: { waiting: await nextThings.inbox(agent.harnessId) } } } catch (error) {
            if (error instanceof GitHubStop) return { error: error.code, detail: error.message }
            throw error
          }
        }
        // A reader's verdict on a pull request (`read ok|hold`, githubVerdict.ts), a builder's claim on a task (`take`,
        // githubClaim.ts) and a piece it cuts off one (`split`, githubSplit.ts): made with this computer's gh under the calling
        // agent's name, on a repository of a project it reads, and its comment recorded with the backend as that agent's.
        if (payload.action === 'read' || payload.action === 'take' || payload.action === 'split') {
          const verdict = payload.action === 'read' ? verdictAsked(payload) : null, claim = payload.action === 'take' ? claimAsked(payload) : null
          const piece = payload.action === 'split' ? splitAsked(payload) : null
          if (!verdict && !claim && !piece) return { error: 'INVALID_REQUEST' }
          // This computer's gh login is its person's: only that person's own agent here posts with it, as GitHub news and the
          // merger read with it only for such an agent (githubMentions.ts watchedAgents, githubMerge.ts ledProjects).
          const me = (await core.account.identity().catch(() => null))?.accountId ?? null
          if (!me || agent.contributorId !== me || agent.machineOwnerId !== me) {
            return { error: 'AGENT_UNAVAILABLE', detail: verdict ? 'A verdict is posted with its person\'s own GitHub login, on that person\'s computer.'
              : claim ? 'A task is taken with its person\'s own GitHub login, on that person\'s computer.'
              : 'A task is cut with its person\'s own GitHub login, on that person\'s computer.' }
          }
          const slugs = list((await swarm()).state.projects).map(projectRepositorySlug).filter(slug => slug !== null)
          const name = [agent.displayName, agent.name].find((given): given is string => typeof given === 'string' && !!given.trim()) ?? ''
          // Each project's repository by its project's name and by what GitHub names it now, for one renamed since
          // (githubVerdict.ts ProjectRepositories), and a name asked that is neither by what GitHub names it now (renamed twice).
          // A project's own name is never another's; GitHub's answers are kept, so a command refused once it runs (a cut past its
          // limit) asks GitHub again for none of them.
          const asked = (verdict ?? claim ?? piece!).repository.toLowerCase()
          const currents = await Promise.all(slugs.map(slug => currentName(slug)))
          const repositories = new Map<string, { project: string; github: string }>(slugs.map((slug, i) => [slug, { project: slug, github: currents[i]! }]))
          slugs.forEach((slug, i) => { if (!repositories.has(currents[i]!)) repositories.set(currents[i]!, { project: slug, github: currents[i]! }) })
          if (!repositories.has(asked)) {
            const now = await currentName(asked)
            const found = [...repositories.values()].find(repository => repository.github === now)
            if (found) repositories.set(asked, found)
          }
          const builder = { name, repositories }, resolved = repositories.get(asked)?.github ?? asked
          const record = async (repository: string, commentId: string) => { await backend(core, 'POST', `${path}/github-comments?${identity}`, { repository, kind: 'issue', commentId }) }
          // The CLI gives up after 30 seconds and says "Try again" while this works on: the same command from the same agent
          // joins the one still running, or both would find no comment yet and each post its own. By either name of its repository.
          // A cut is the same cut whatever its words or size: sent again with other words, it joins the one that runs.
          const same = JSON.stringify([agentId, verdict ? { ...verdict, repository: resolved } : claim ? { ...claim, repository: resolved } : sameCut({ ...piece!, repository: resolved })])
          const deps = { get: github.get, send: github.send, login: loginOf, record }
          // What the server holds of this agent's offers, for a task not given by label (taskOffers.ts): a server without the routes
          // holds none.
          const offers = {
            left: async (repository: string, number: number) => {
              const mine = await agentOffers(ask, String(payload.tabId), agentId).catch(error => { if (noSuchRoute(error)) return null; throw error })
              const offer = mine?.offers.find(o => o.state === 'accepted' && o.repository === repository.toLowerCase() && o.number === number)
              return offer ? offer.expiresAt - mine!.serverTime : null
            },
            decline: async (repository: string, number: number, reason: string) => {
              await answerOffer(ask, String(payload.tabId), agentId, { repository, number }, reason).catch(error => console.warn(`[super-tab] Task offers: ${repository}#${number} not declined: ${codeOf(error)}`))
            },
          }
          const running = commands.get(same)
          const made = running ?? (verdict ? postVerdict(deps, builder, verdict)
            : claim ? takeTask(deps, builder, claim, offers)
            : cuts.run(agentId, () => splitTask(deps, builder, piece!)))
            .finally(() => commands.delete(same))
          commands.set(same, made)
          const value = await made
          // A verdict it posted is a boundary of its reader's work, and a task it took the start of its builder's: its tokens are
          // counted by them (taskTokens.ts). Told once, by the call that made it, and never for a command that found it made already.
          if (!running) {
            const counted = { tabId: String(payload.tabId), agentId, harnessId: agent.harnessId }
            if (verdict && object(value).posted === true) void taskTokens.read(counted, repositories.get(asked)!.project, verdict.number)
            if (claim && object(value).taken === true) void taskTokens.took(counted)
          }
          return { ok: true, value }
        }
        // A Lead's terminal read or typing (`screen`, `type`): the backend answers only the agent that asked.
        if (payload.action === 'terminalResult') {
          if (!identifier(payload.terminalRequestId)) return { error: 'INVALID_REQUEST' }
          return { ok: true, value: await backend(core, 'GET', `${path}/terminal/${payload.terminalRequestId}?${identity}`) }
        }
        if (payload.action === 'messages' && identifier(payload.conversationId)) {
          // An older page's cursor is its sequence and message id together, or it is refused: never read as the newest page.
          const paged = payload.before !== undefined || payload.beforeId !== undefined
          if (paged && !(Number.isSafeInteger(payload.before) && Number(payload.before) >= 0 && identifier(payload.beforeId))) return { error: 'INVALID_REQUEST' }
          const before = paged ? `&before=${payload.before}&beforeId=${payload.beforeId}` : ''
          if (payload.thread !== undefined && !identifier(payload.thread)) return { error: 'INVALID_REQUEST' }
          const thread = payload.thread !== undefined ? `&thread=${payload.thread}` : ''
          const page = await backend(core, 'GET', `${path}/conversations/${encodeURIComponent(String(payload.conversationId))}/messages?${identity}${before}${thread}`)
          // A task's newest page shows its steps' rows by time, each tagged with its step (task steps design): the step's own
          // conversation keeps its brief and work rows, and the talk is in the task. Older pages and threads are the task's.
          if (!paged && !thread) {
            const read = await swarm().catch(() => null)
            // An archived task keeps the steps archived with it, and their rows (final review, minor 6).
            const task = read ? list(read.state.conversations).find(c => c.id === payload.conversationId) : undefined
            const steps = read ? list(read.state.conversations).filter(c => isStep(c) && c.reviewOf === payload.conversationId
              && (task?.archived === true || c.archived !== true)) : []
            if (steps.length) return { ok: true, value: markAnswered(await withSteps(page, steps, step =>
              backend(core, 'GET', `${path}/conversations/${encodeURIComponent(String(step.id))}/messages?${identity}`)), [], agentId) }
          }
          return { ok: true, value: markAnswered(page, [], agentId) }
        }
        if (payload.action === 'message' && identifier(payload.conversationId) && identifier(payload.messageId)) {
          const page = await backend(core, 'GET', `${path}/conversations/${encodeURIComponent(String(payload.conversationId))}/messages?${identity}&messageId=${payload.messageId}`)
          // One exact message cannot show its own answer, so what came after it is read, but only for a question put to
          // this agent. If that read fails the message is still returned, just without a verdict.
          const sent = object(list(object(page).messages)[0])
          const asked = Array.isArray(sent.recipientIds) && sent.recipientIds.includes(agentId) && object(sent.author).id !== agentId
          if (!asked || !Number.isInteger(Number(sent.sequence))) return { ok: true, value: markAnswered(page, [], agentId) }
          try {
            const later = object(await backend(core, 'GET', `${path}/conversations/${encodeURIComponent(String(payload.conversationId))}/messages?${identity}&after=${sent.sequence}`)).messages
            return { ok: true, value: markAnswered(page, list(later), agentId) }
          } catch { return { ok: true, value: page } }
        }
        if (payload.action === 'command' && identifier(payload.operationId) && payload.command && typeof payload.command === 'object' && !Array.isArray(payload.command)) {
          if (!AGENT_COMMANDS.has(String(object(payload.command).type))) return { error: 'INVALID_REQUEST' }
          const tagged = await mentionCommand(object(payload.command), async () => (await swarm()).state)
          // A post it sends by command, as the channel and its person's chat show it: who wrote it, and when, are beside it
          // (signature.ts).
          const command = tagged.type === 'message.send' && typeof tagged.text === 'string'
            ? { ...tagged, text: unsigned(tagged.text, [agent.displayName as string | undefined, agent.name as string | undefined]) } : tagged
          const send = (command: Record<string, unknown>) => backend(core, 'POST', `${path}/commands`,
            { operationId: payload.operationId, command, asAgentId: agentId })
          try { return { ok: true, operationId: payload.operationId, value: await send(command) } } catch (error) {
            // A backend from before answers below (task #2929) refuses the field: the answer goes as a reply, which settles it there.
            if (command.answers && command.type === 'message.send' && error instanceof SuperTabHostError && error.status === 400
              && error.code === 'VALIDATION_ERROR' && /Unrecognized key[^"']*["']answers["']/.test(error.message)) {
              const { answers, ...reply } = command
              return { ok: true, operationId: payload.operationId, value: await send({ ...reply, replyTo: answers }) }
            }
            if (command.mentions && error instanceof SuperTabHostError && error.status === 400 && error.code === 'VALIDATION_ERROR'
              && /Unrecognized (?:key: "mentions"|key\(s\) in object: 'mentions')/.test(error.message)) {
              return { error: 'MENTIONS_UNSUPPORTED', detail: 'This Swarm\'s server does not support tagging people yet.' }
            }
            throw error
          }
        }
        // `post --attach` asks first whether this post already went out with its files.
        if (payload.action === 'attachment' && identifier(payload.conversationId) && payload.step === 'sent' && identifier(payload.operationId)) {
          const sent = object(await backend(core, 'GET', `${path}/conversations/${encodeURIComponent(String(payload.conversationId))}/messages?${identity}&messageId=${messageIdOf(payload.tabId, agentId, payload.operationId)}`))
          const earlier = object(list(sent.messages)[0])
          // The agent's id goes back too: the files are uploaded as this agent, through the daemon's local upload route.
          return { ok: true, value: { agentId, attachmentIds: Array.isArray(earlier.attachments) ? list(earlier.attachments).map(a => String(a.id)) : null } }
        }
        return { error: 'INVALID_REQUEST' }
      } catch (error) {
        return error instanceof SuperTabHostError
          ? { error: error.code, detail: error.message, status: error.status }
          : { error: 'SUPER_TAB_UNAVAILABLE', detail: error instanceof Error ? error.message : 'This Super Tab is unavailable.' }
      }
    },
  }
  return { requests, port }
}
