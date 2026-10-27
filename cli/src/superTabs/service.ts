import { readCapabilities } from './capacity.js'
import { existsSync } from 'node:fs'
import { readAuthSession } from '../lib/authSession.js'
import { createHash } from 'node:crypto'
import type { CoreApi, ServiceRequests, SuperTabsPort } from '../core/api.js'
import { backend, swarmRoleFor, hostJournalFile, identifier, object, SuperTabHost, SuperTabHostError, type SuperTabHostOptions, type SwarmSources } from './host.js'
import { HostFeed } from './hostFeed.js'
import { SwarmReads, type SwarmRead } from './swarmReads.js'
import { within } from './wire.js'
import { machineChoices } from '../lib/newCommand.js'
import { START_REQUIREMENTS } from './capacity.js'
import { CapacityReservations, type ReservationBook } from './reservations.js'
import { ContributionPreparations, prepareContribution } from './contribution.js'
import { messageIdOf } from './attach.js'
import { cardId, SwarmCards } from './cards.js'
import { GitHubTokenRefresher, githubToken } from './github.js'
import { teamEngineReporter, type TeamEngineReporter } from '../team/engines.js'
import { AUTO_SETUP_REASONS, realTeamAutoSetup, type AutoSetupReason, type TeamAutoSetup } from '../team/autoSetup.js'

const POST_HELP = 'reply in that conversation. Use a unique ID per message and reuse it after an interrupted request. Answer a message once, with --reply-to its ID. --attach sends a file (a screenshot, a log; up to 10 files of 10 MB each), and TEXT may then be empty.'
const HELP = {
  status: 'Read the shared tab roster and work. Its rules are the project owners\' routing rules, each in the owner\'s own words; each binds only the agents of its projectId. A Lead\'s status also lists otherProjectsWork: the active work of the Swarm\'s other projects (group, project, title, owned code, status, Engineer, PR), read only. A project on Custom skills lists its roles (id, name, kind) in status.',
  leads: 'The Leads conversation (leadsConversationId in a Lead\'s status) is one conversation for the whole Swarm, outside every project. Only Leads and people post there, and only Leads among agents receive it. Before assigning, look at otherProjectsWork; if your task touches the same code, say so there and agree an order first, then tell your own project. The Swarm posts there by itself when two projects\' active tasks own the same code.',
  // Help without --tab cannot tell who asks, so it does not list a Lead's own options; this tells a Lead where they are.
  leadOptions: 'Leads: run help with --tab ID for options only a Lead has.',
  messages: 'messages GROUP: read recent messages in a conversation.',
  message: 'message GROUP MESSAGE_ID: read one exact message, including an earlier question or result referenced by a reply.',
  decisions: 'decisions [--answered]: the decisions you asked of people, still open, or with --answered those answered (each with its choice and note). A Lead also sees those asked in its project. When your work needs a person to decide, ask through work.status needs_human with ask: the question as its result, 2 to 5 options, the one you recommend and what the answer unblocks. Keep working on your recommendation, marked provisional, until a notice in that conversation says it was answered; then read the answer here with --answered. The notice carries none of the answer. A decision is not a private channel: anything private goes through Chat with PM.',
  post: `post GROUP TEXT OPERATION_ID [--reply-to MESSAGE_ID] [--attach PATH]...: ${POST_HELP}`,
  start: 'start OPERATION_ID JSON: create one agent in a conversation on a machine in this Swarm\'s Machines list; to use another machine, a person adds it to the Swarm first. Repeat exactly after an interruption; it follows the same native creation receipt. It does not assign work. With worktree true, the agent starts from the repository\'s default branch, fetched first, unless you set branchRef (refs/heads/BRANCH, or refs/remotes/origin/BRANCH to fetch it first) to start from another branch, such as the one this work builds on. Set role "reviewer" to start a Reviewer; leave role out for a Builder. The role is kept for the session. On Custom skills, add "roleId" to the start request to start the agent in that role of its kind (a builder or reviewer role from status); without it the agent takes the first role of its kind. A Reviewer runs on claude or codex and is assigned only review groups (conversation.create with reviewOf naming the group it reviews); a review group is assigned only to a Reviewer. Add the Reviewer to the reviewed group with conversation.agent so it is told when that work is ready for review and can pass its independent check. Start one with a routeDecisionId like any agent.',
  release: 'When a Builder finishes, decide reuse, keep or stop; prefer stop unless more work is coming soon. Reuse assigns new work; agent.release records keep or requests stop. Wait for the execution host to confirm a stop. A person can withdraw a stuck stop; the session cannot receive new work in that Swarm. Its native capacity stays reserved until its host confirms stopping. Other Swarms wait up to two minutes for an in-flight close, then may reuse it.',
  resume: 'resume START_ID: finish a pending start without creating another agent.',
  route: 'route GROUP JSON: before you start an agent or assign work to another agent, choose who does it. Work you do yourself is not routed. JSON: {"difficulty":"low|medium|high","risk":"low|medium|high","size":"small|medium|large","why":"one sentence","kind":"optional word such as ui or docs","local":"optional true, only when a person asked for a local model","model":"optional: the model a person named, in their words; only it is offered","needs":{"tools":[],"devices":[],"cwd":"/absolute/repo"}}. size is how long the work runs: small about 20 minutes, medium about an hour, large about three hours. Candidates that break the owner\'s hard rules are left out, and so are machines that cannot take a teammate\'s project: it runs only on Team machines (a Mac\'s Harness Team account whose privacy check passed, or a machine used only for agents), and the route says why the others were left out. Soft rules (a preferred engine for the kind, idle agents first) rank the rest. A pick on a model served on the Swarm\'s grid starts with gridModel and gridName in place of model and effort. Start or assign the pick with its routeDecisionId; to choose otherwise, pass overrideReason. An agent\'s start or work.assign without a routeDecisionId is refused, so route first; a person can still start and assign by hand.',
  screen: 'screen AGENT [--scrollback N]: read a worker\'s terminal as plain text, with up to 200 lines of scrollback. Only its project\'s Lead may. Use it when a worker seems stuck.',
  type: 'type AGENT [TEXT] [--key K]...: type text, then keys (Enter, Esc, Tab, Up, Down, Left, Right, Ctrl-C, 0-9), into a worker\'s terminal. Answer prompts within its task; ask the owner before approving anything risky.',
  capacity: 'capacity MACHINE_ID JSON: inspect machine, engine and quota headroom. JSON uses the start request fields below. Unknown allowances are not reported as free tokens.',
  startRequest: { conversationId: 'GROUP', machineId: 'MACHINE', engine: 'codex', name: 'Builder', cwd: '/absolute/repo/on/that/machine', worktree: true, branchRef: 'refs/remotes/origin/BASE_BRANCH', requirements: START_REQUIREMENTS,
    model: 'opus', effort: 'high', routeDecisionId: 'DECISION' },
  command: 'command OPERATION_ID JSON: send one of the commands below. Reuse exactly the same ID and JSON after an interrupted request. On Custom skills, work.assign takes "roleId" too, a role of the agent\'s kind. When your assignment needs a person to decide, set work.status needs_human; when you cannot go on, blocked. Set working again once it moves. rule.set and rule.remove change one project\'s routing rules: only the project owner does (naming projectId), or that project\'s Lead passing on the project owner\'s request, with askedIn naming the project owner\'s message in that project\'s chat. project.skills switches a project between the Default, Harness orchestration and Custom skills (Custom once its owner has made the project\'s roles): only its project owner does, or its Lead passing on that owner\'s own chat message, with askedIn naming it. A start, assignment or route that breaks a hard rule (forbidModel, machines, minEffort) is refused for agents; preferEngine and preferIdle only rank.',
  commands: [
    { type: 'project.report', projectId: 'PROJECT', through: { GROUP: 214031 }, text: 'What changed, what is blocked, and what comes next. Use null when nothing merits repeating.' },
    { type: 'project.repository', projectId: 'PROJECT', repositoryUrl: 'https://github.com/OWNER/REPOSITORY' },
    { type: 'project.skills', projectId: 'PROJECT', mode: 'default|orchestration|custom', askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } },
    { type: 'message.send', conversationId: 'GROUP', text: 'A message addressed to an agent', replyTo: null, recipientIds: ['AGENT'] },
    { type: 'conversation.create', title: 'Outcome', task: { goal: 'An independently assignable result', changes: 'What changes', constraints: 'What must stay true', owns: ['Paths or code areas'] }, checks: [{ description: 'Observable acceptance evidence', independent: false }] },
    { type: 'conversation.create', title: 'Review: Outcome', reviewOf: 'GROUP', task: { goal: 'An independent verdict on the Builder\'s revision', changes: 'None: read only', constraints: 'The reviewed group\'s constraints', owns: ['The reviewed group\'s owned code, read only'] }, checks: [{ description: 'Verdict with the reviewed revision', independent: false }] },
    { type: 'conversation.agent', conversationId: 'GROUP', agentId: 'AGENT', present: true, lead: false },
    { type: 'work.define', conversationId: 'GROUP', task: { goal: 'What to deliver', changes: 'What changes', constraints: 'What must stay true', owns: ['Paths or code areas'] }, checks: [{ description: 'Observable acceptance evidence', independent: false }] },
    { type: 'work.cancel', conversationId: 'GROUP', assignmentId: 'ATTEMPT', reason: 'Lead or tab owner only: why the task is cancelled, in one short sentence' },
    { type: 'agent.release', agentId: 'AGENT', decision: 'keep|stop' },
    { type: 'rule.set', rule: { kind: 'forbidModel', model: 'haiku' }, text: 'The owner\'s words: No Haiku.', askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } },
    { type: 'rule.set', rule: { kind: 'minEffort', effort: 'high' }, text: 'At least high effort.', askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } },
    { type: 'rule.set', rule: { kind: 'machines', machineIds: ['MACHINE'] }, text: 'Only these machines.', askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } },
    { type: 'rule.set', rule: { kind: 'preferEngine', taskKind: 'ui', engine: 'codex' }, text: 'Codex for UI work.', askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } },
    { type: 'rule.set', rule: { kind: 'preferIdle' }, text: 'Reuse idle agents first.', askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } },
    { type: 'rule.remove', ruleId: 'RULE', askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } },
    { type: 'work.assign', conversationId: 'GROUP', agentId: 'AGENT', routeDecisionId: 'DECISION' },
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'working', result: null },
    // Both reach the Lead and alert the Harness Pro on the machine running the agent until the status moves on.
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'needs_human', result: 'The decision you need from a person, asked as one short question' },
    // The same, opened as a decision for one person in the conversation (decisions in help).
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'needs_human', result: 'The question, in one sentence',
      ask: { personId: 'PERSON', options: ['Option A', 'Option B'], recommended: 0, unblocks: 'What the answer unblocks' } },
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'blocked', result: 'Why you are stuck and what would unblock you, in one or two sentences' },
    { type: 'work.check', conversationId: 'GROUP', assignmentId: 'ATTEMPT', checkId: 'CHECK', passed: true, evidence: 'Exact test command, revision and observed result' },
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'done', result: 'Exact revision, evidence and deliverable links' },
  ],
}

const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
/** A Swarm read as `GET /api/super-tabs/:id` answered it, `lastChangedAt` in place of `revision` (design 2026-10-26 5.3). */
const answerOf = (read: SwarmRead) => ({ lastChangedAt: read.lastChangedAt, state: read.state, ...(read.githubApp ? { githubApp: true } : {}) })
const OFF_ROSTER = 'This agent is not on this machine\'s Swarm roster right now. That can mean this machine has no access to it, or its billing does not allow it. Check how this machine is shared.'
/** Only a project's Lead may tag people (spec 2026-10-24-lead-mentions), so only a Lead's help offers it. */
const LEAD_HELP = { ...HELP, post: `post GROUP TEXT OPERATION_ID [--reply-to MESSAGE_ID] [--attach PATH]... [--mention PERSON]...: ${POST_HELP} --mention tags a person, by the id or email shown in status (up to 5), when you need them to act or decide; it shows in their notifications.`,
  // Advisory (docs/plans/2026-10-27-swarm-scheduler.md): a plan for every open group at once, which the route still decides.
  plan: 'plan [JSON]: the best plan for all your open groups at once, from the scheduler on this machine (Python 3 and OR-Tools; without them it says how to install, and routing works as before). Per group: the machine, engine, model and effort, start order and expected finish, with the finish time and cost against routing one group at a time. JSON (optional): {"groups":{"GROUP":{"difficulty":"low|medium|high","risk":"low|medium|high","size":"small|medium|large","kind":"optional word","after":["GROUP"]}}}; a group you do not assess is planned at medium and listed as an estimate. It keeps the owner\'s hard rules and a review\'s other model family, and records nothing: follow it in order by routing each group and starting the plan\'s pick with overrideReason "scheduler plan".',
  // Only a project's Lead asks a batch: up to 10 questions for one person, in one of its project's conversations.
  commands: [...HELP.commands, { type: 'decision.ask', conversationId: 'GROUP', personId: 'PERSON', questions: [{ question: 'One question a person decides',
    options: ['Option A', 'Option B'], recommended: 0, unblocks: 'What the answer unblocks' }] }] }
const OTHER_WORK_FIELDS = ['conversationId', 'projectName', 'title', 'owns', 'status', 'agentName', 'pr'] as const
/** How old a host form a one-off question about this machine's Swarms may take: the host reads one every second. */
const POOLS_FRESH_MS = 5_000

/** A project's Lead is its Lead conversation's, as the backend reads it; a Swarm from before projects has one, 'lead'. */
function isLead(state: Record<string, unknown>, agentId: string): boolean {
  const leads = Array.isArray(state.projects) ? list(state.projects).map(p => p.leadConversationId) : ['lead']
  return list(state.conversations).some(c => leads.includes(c.id) && c.leadId === agentId)
}

/** Leads see each other's work and talk (spec 2026-10-23): a Lead reads other projects' active work in the backend's
 *  fields alone; any other agent reads neither it nor the Leads conversation, even from a server that sent it. */
function statusView(answer: Record<string, unknown>, agentId: string): Record<string, unknown> {
  const { otherProjectsWork, leadsConversationId, ...state } = object(answer.state)
  if (isLead(state, agentId)) {
    return { ...answer, state: { ...state, ...(leadsConversationId !== undefined ? { leadsConversationId } : {}),
      ...(Array.isArray(otherProjectsWork) ? { otherProjectsWork: list(otherProjectsWork).map(work =>
        Object.fromEntries(OTHER_WORK_FIELDS.filter(key => key in work).map(key => [key, work[key]]))) } : {}) } }
  }
  return { ...answer, state: { ...state, conversations: list(state.conversations).filter(c => c.kind !== 'leads' && c.id !== leadsConversationId) } }
}

/** A post's mentions name people by id or email; the backend takes person ids. A name that is nobody in the Swarm is refused
 *  here, before anything is sent. Whether this agent may tag them in this conversation is the backend's to judge. Only such
 *  a post reads the Swarm, for its people. */
async function mentionCommand(command: Record<string, unknown>, swarm: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (command.type !== 'message.send' || !Array.isArray(command.mentions)) return command
  const people = list((await swarm()).people)
  const ids = command.mentions.map(name => {
    const person = people.find(p => p.id === name || typeof name === 'string' && typeof p.email === 'string' && p.email.toLowerCase() === name.toLowerCase())
    if (!person) throw new SuperTabHostError('MENTION_UNKNOWN', `${String(name)} is not a person in this Swarm. Tag a person by the id or email shown in status.`, 400)
    return person.id
  })
  return { ...command, mentions: [...new Set(ids)] }
}

function taskCommand(command: Record<string, unknown>): Record<string, unknown> {
  if (command.type !== 'conversation.create' && command.type !== 'work.define') return command
  const task = object(command.task), missing: string[] = []
  for (const part of ['goal', 'changes', 'constraints']) {
    if (typeof task[part] !== 'string' || !task[part].trim()) missing.push(part)
  }
  if (!Array.isArray(task.owns) || !task.owns.length || task.owns.some(area => typeof area !== 'string' || !area.trim())) missing.push('owns')
  if (!Array.isArray(command.checks) || !command.checks.length || command.checks.some(check => typeof object(check).description !== 'string' || !String(object(check).description).trim())) missing.push('acceptance checks')
  if (missing.length) throw new SuperTabHostError('TASK_REQUIRED', `Complete the task: ${missing.join(', ')}.`, 400)
  const trimmed = { ...task, goal: (task.goal as string).trim(), changes: (task.changes as string).trim(),
    constraints: (task.constraints as string).trim(), owns: (task.owns as string[]).map(area => area.trim()) }
  if ([trimmed.goal, trimmed.changes, trimmed.constraints].some(part => part.length > 8000) || trimmed.owns.length > 40 || trimmed.owns.some(area => area.length > 4096)) {
    throw new SuperTabHostError('INVALID_TASK', 'Task sections may have up to 8,000 characters; owns needs 1–40 paths or areas of up to 4,096 characters each.', 400)
  }
  const brief = `Goal:\n${trimmed.goal}\n\nChanges:\n${trimmed.changes}\n\nConstraints:\n${trimmed.constraints}\n\nOwns:\n${trimmed.owns.map(area => `- ${area}`).join('\n')}`
  const limit = command.type === 'conversation.create' ? 8000 : 32_000
  if (brief.length > limit) throw new SuperTabHostError('INVALID_TASK', `Keep the rendered task within ${limit.toLocaleString('en-US')} characters.`, 400)
  return { ...command, task: trimmed, brief }
}

/** Tell the agent which messages sent to it it has already answered, so it posts once (a Lead answered one question twice on
 * 2026-10-20). A message is answered when a later message of the agent's own replies to it. */
function markAnswered(page: unknown, later: unknown[], agentId: string): unknown {
  const body = object(page)
  if (!Array.isArray(body.messages)) return page
  const mine = new Set([...body.messages, ...later].map(object).filter(m => object(m.author).id === agentId && typeof m.replyTo === 'string').map(m => m.replyTo))
  return { ...body, messages: body.messages.map(object).map(m => {
    const asked = Array.isArray(m.recipientIds) && m.recipientIds.includes(agentId) && object(m.author).id !== agentId
    return asked ? { ...m, answered: mine.has(m.id) } : m
  }) }
}

/** Whether this machine is in a Swarm with other people in it: a contribution of its own to a tab whose people are more
 *  than its owner. False when that cannot be read. */
export async function sharedSwarm(sources: SwarmSources): Promise<boolean> {
  if (!identifier(sources.feed.machineId)) return false
  const pools = await sources.feed.current(POOLS_FRESH_MS).then(read => read.pools, () => [])
  for (const row of pools) {
    if (!identifier(row.tabId)) continue
    const people = await sources.reads.read(row.tabId).then(read => read.state.people, () => null)
    if (Array.isArray(people) && people.length > 1) return true
  }
  return false
}

export interface SuperTabServiceOptions {
  prepareContribution?: typeof prepareContribution
  capacity?: typeof readCapabilities
  host?: (core: CoreApi, machineId: string, options: SuperTabHostOptions) => SuperTabHost
  reservations?: (core: CoreApi, machineId: string) => ReservationBook
  /** The Swarm cards' reader (superTabs/cards.ts), for a spec. */
  cards?: (core: CoreApi, machineId: string) => SwarmCards
  /** What keeps Swarm sessions' GitHub tokens fresh (superTabs/github.ts), for a spec. */
  githubTokens?: (core: CoreApi) => Pick<GitHubTokenRefresher, 'start' | 'stop'>
  /** What reports the Harness Team account's own engines to its owner (team/engines.ts), for a spec. */
  teamEngines?: () => Pick<TeamEngineReporter, 'start' | 'stop'>
  /** What sets up the Harness Team account when Desktop asks (team/autoSetup.ts), for a spec. */
  teamSetup?: () => Promise<Pick<TeamAutoSetup, 'offer'>>
  /** Whether this daemon runs team work only (a Harness Team account, `harness team on`), for a spec. */
  team?: () => boolean
}
export function superTabService(core: CoreApi, options: SuperTabServiceOptions = {}): { requests: ServiceRequests; port: SuperTabsPort } {
  const preparations = new ContributionPreparations(input => (options.prepareContribution ?? prepareContribution)(core, input))
  // One host form and one set of Swarm reads per machine, shared by the host and every action here (design 2026-10-26 5.3).
  let held: SwarmSources | null = null
  const sources = (): SwarmSources => {
    const machine = core.daemon.machineId()
    if (held?.feed.machineId !== machine) held = { feed: new HostFeed(core, machine), reads: new SwarmReads(core) }
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
  const wake = () => {
    const machine = core.daemon.machineId()
    if (host?.machineId !== machine) { host?.stop(); host = null }
    host ??= (options.host ?? ((api, id, given) => new SuperTabHost(api, id, given)))(core, machine,
      { startReceipt: harnessId => reservations().creationOf(harnessId), sources: sources() })
    host.start()
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
  // In the Harness Team account only: whether its Claude Code and Codex are installed and signed in, for its owner to read.
  const engines = (options.teamEngines ?? teamEngineReporter)()
  let autoSetup: Promise<Pick<TeamAutoSetup, 'offer'>> | null = null
  const disconnect = () => { preparations.clear(); host?.stop(); host = null; held = null; book?.stop(); book = null; bookMachine = null; swarmCards?.want(false); swarmCards = null; cardsMachine = null; tokens.stop(); engines.stop() }
  const port = {
    connected: () => {
      tokens.start()
      engines.start()
      // A daemon that runs team work only is there for its Swarms: its host runs from its first connection. Its Mac's daemon adds
      // a Harness Team account to a Swarm without waking it (host.ts joinTeams), and a host that never ran reports no privacy
      // check, so the Swarm read the account as offline and never sent it a teammate's work (third VM run).
      if (identifier(core.daemon.machineId()) && (existsSync(hostJournalFile(core.dataDir, core.daemon.machineId()))
        || (options.team ?? (() => readAuthSession()?.kind === 'team'))())) wake()
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
        if (payload.action === 'observeCapacity') return await reservations().observe(payload.creationId, closed)
        // A backend-issued context scopes provenance only. Existing machine
        // control is still required to open/write the native terminal itself.
        if (payload.action === 'prepareNative' || payload.action === 'renewNative') {
          return await wake().prepareNative(payload.tabId, payload.contextId, payload.action === 'renewNative', closed)
        }
        if (!asker.owner || (!asker.local && asker.accountOwner !== true)) return { error: 'OWNER_REQUIRED' }
        // `harness git-credential` in a local agent's shell (superTabs/gitCredential.ts): the token of that agent's task,
        // which goes to this computer's own processes alone, never to another machine through the relay.
        if (payload.action === 'githubToken') {
          if (!asker.local) return { error: 'OWNER_REQUIRED' }
          return await githubToken(core, String(payload.harnessId ?? ''), sources())
        }
        // Desktop on this Mac, as the person joins a Swarm, adds this Mac to one, or opens the app (team/autoSetup.ts): the
        // Harness Team account, behind macOS's own administrator prompt. Never through the relay, with nobody at this Mac.
        if (payload.action === 'teamSetup') {
          if (!asker.local) return { error: 'OWNER_REQUIRED' }
          if (!AUTO_SETUP_REASONS.includes(payload.reason as AutoSetupReason)) return { error: 'INVALID_REQUEST' }
          // Desktop asks at every launch. A Mac that hosts no Swarm work, as no regular user's does, answers at once:
          // nothing read, run or asked of the backend.
          if (payload.reason === 'startup' && !(identifier(core.daemon.machineId()) && existsSync(hostJournalFile(core.dataDir, core.daemon.machineId())))) {
            return { ok: true, state: 'not-shared' }
          }
          autoSetup ??= (options.teamSetup ?? (() => realTeamAutoSetup(core.dataDir, line => console.log(`[team] ${line}`))))()
            .catch(error => { autoSetup = null; throw error })
          return { ok: true, ...await (await autoSetup).offer(payload.reason as AutoSetupReason, () => sharedSwarm(sources())) }
        }
        if (payload.action === 'swarmRole') {
          const grant = await port.swarmRole(String(payload.harnessId ?? ''))
          return { ok: true, role: grant ? grant.role : grant, ...(grant ? { mode: grant.mode } : {}) }
        }
        if (payload.action === 'prepareContribution') return preparations.read(payload)
        // The devices' (core/devicesLink.ts): a Harness Pro that shows the Swarm cards is attached or gone, wants a Lead's recap, or
        // has one open. They read the account's Swarms as the person, and need no agent.
        // Only this computer's own devices ask: an account owner on another machine does not make this one read the Swarms.
        if (payload.action === 'cardsWanted' || payload.action === 'cardRecap' || payload.action === 'cardOpen' || payload.action === 'cardSay') {
          if (!asker.local) return { error: 'OWNER_REQUIRED' }
          if (payload.action === 'cardsWanted') {
            const include = Array.isArray(payload.include) ? payload.include.filter(cardId) : []
            cards().want(payload.on === true, include)
            return { ok: true }
          }
          if (payload.action === 'cardRecap' && cardId(payload.tabId) && cardId(payload.leadId)) return { ok: true, ...await cards().recap(payload.tabId, payload.leadId) }
          if (payload.action === 'cardSay' && cardId(payload.harnessId) && typeof payload.text === 'string' && payload.text.trim() && payload.text.length <= 32_000) {
            return { ok: true, said: await cards().say(payload.harnessId, payload.text.trim()) }
          }
          if (payload.action === 'cardOpen' && cardId(payload.session) && cardId(payload.tabId) && (payload.leadId === null || cardId(payload.leadId))) {
            cards().open(payload.session, payload.tabId, payload.leadId)
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
          const value = await backend(core, method as string, path, payload.body)
          return { ok: true, value }
        }
        const named = identifier(payload.agentId) ? payload.agentId : null
        const hashed = identifier(payload.harnessId) ? createHash('sha256').update(JSON.stringify([core.daemon.machineId(), payload.harnessId])).digest('hex').slice(0, 24) : null
        if (payload.action === 'help' && (!identifier(payload.tabId) || !(named ?? hashed))) return { ok: true, help: HELP }
        if (!identifier(payload.tabId) || !(named ?? hashed)) return { error: 'INVALID_REQUEST' }
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
        if (payload.action === 'help' && (!caller || !identifier(agent.id))) return { ok: true, help: HELP }
        // The server leaves an agent off the roster when this machine has no access or billing for it; it gives no reason,
        // and the server enforces the grant anyway, so the text says where to look (Lead's ruling, #1726 G5).
        if (!caller || !identifier(agent.id)) return { error: 'AGENT_UNAVAILABLE', detail: OFF_ROSTER }
        if (typeof agent.harnessId !== 'string' || identifier(payload.harnessId) && agent.harnessId !== payload.harnessId || !core.agents.byAgent(agent.harnessId)) {
          return payload.action === 'help' ? { ok: true, help: HELP } : { error: 'AGENT_UNAVAILABLE', detail: 'This agent is not a running contribution on this machine.' }
        }
        const agentId = agent.id
        const path = `/api/super-tabs/${payload.tabId}`
        const identity = `asAgentId=${agentId}`
        const swarm = () => reads.read(String(payload.tabId), agentId)
        if (payload.action === 'help') return { ok: true, help: caller.lead === true ? LEAD_HELP : HELP }
        wake()
        if (payload.action === 'startStatus' && identifier(payload.startId)) {
          return { ok: true, value: await backend(core, 'GET', `${path}/starts/${payload.startId}?${identity}`) }
        }
        if (payload.action === 'status') return { ok: true, value: statusView(answerOf(await swarm()), agentId) }
        // A Lead's terminal read or typing (`screen`, `type`): the backend answers only the agent that asked.
        if (payload.action === 'terminalResult') {
          if (!identifier(payload.terminalRequestId)) return { error: 'INVALID_REQUEST' }
          return { ok: true, value: await backend(core, 'GET', `${path}/terminal/${payload.terminalRequestId}?${identity}`) }
        }
        if (payload.action === 'routeContext') {
          const [read, policy, machines] = await Promise.all([
            swarm(),
            backend(core, 'GET', `${path}/routing-policy?${identity}`),
            core.account.machines().catch(() => null),
          ])
          // A list that could not be read is not an empty one: the Lead's route says so.
          const readable = machines?.status === 200
          // Machines shared with the account but not yet added refuse it, so they are not offered.
          return { ok: true, value: { tab: answerOf(read), policy, agentId,
            machines: readable ? machineChoices(object(object(machines.body).data), null).filter(m => !m.toAdd).map(m => ({ machineId: m.machineId, name: m.label, status: m.status })) : [],
            ...(readable ? {} : { machinesUnreadable: true }) } }
        }
        // The route log and the group's attempts, for the quota open picks hold and what members did before. Apart from
        // `routeContext` so the Lead reads it while it probes the machines; the group's Lead only, like the route itself.
        if (payload.action === 'routeHistory') {
          // The one group by id, active or dormant (design 4.5): a group that left the active set still has its history, and
          // a group this agent cannot read answers 404, refused like one it does not lead (review round 1).
          const group = identifier(payload.conversationId) ? object(object(await backend(core, 'GET', `${path}/groups/${payload.conversationId}?${identity}`)
            .catch(error => { if (error instanceof SuperTabHostError && [403, 404].includes(error.status)) return null; throw error })).group).data : null
          if (!group || object(group).leadId !== agentId) return { error: 'LEAD_REQUIRED', detail: 'The coordinating Lead of this group owns routing.', status: 403 }
          const [logged, tried] = await Promise.all([
            within(backend(core, 'GET', `${path}/route-decisions?${identity}`)),
            // An older backend has no such route: its 404 is unreadable like any other failure.
            within(backend(core, 'GET', `${path}/conversations/${payload.conversationId}/attempts?${identity}`)),
          ])
          // The log's records carry every candidate's line; the route needs only who was picked and how it went, and the account and expected spend of what actually runs, which an open pick still holds: after an override
          // that is the person's chosen candidate, and a Lead's own choice outside the list has no known account.
          const decisions = Array.isArray(logged) ? logged.slice(0, 50).map(object).map(d => {
            const record = object(d.record), final = object(d.final), candidates = list(record.candidates), pick = candidates.find(c => c.id === record.pick)
            const runs = d.override ? candidates.find(c => c.id === object(d.override).candidateId) : pick, fit = object(runs?.fit)
            return { id: d.id, conversationId: d.conversationId, title: String(pick?.title ?? 'unknown pick'),
              ...(typeof fit.account === 'string' ? { account: fit.account, spend: object(fit.spend), size: object(record.assessment).size ?? 'medium' } : {}),
              ...(typeof record.via === 'string' ? { via: record.via } : {}), outcome: d.outcome ?? null, assignmentId: d.assignmentId ?? null, createdAt: d.createdAt,
              final: final.kind === 'member' ? { kind: 'member', agentId: final.agentId } : final.kind === 'new' ? { kind: 'new', engine: final.engine, model: final.model } : null }
          }) : null
          // Every attempt the group had, also the ones `work.define` took out of the state; the server already cut the results.
          const attempts = Array.isArray(tried) ? tried.slice(0, 50).map(object).map(a => ({ id: a.id, agentId: a.agentId, status: a.status, result: typeof a.result === 'string' ? a.result.slice(0, 500) : null, createdAt: a.createdAt ?? null })) : null
          return { ok: true, value: { ...(decisions ? { decisions } : { decisionsUnreadable: true }), ...(attempts ? { attempts } : { attemptsUnreadable: true }) } }
        }
        if (payload.action === 'decisions' && (payload.state === 'open' || payload.state === 'answered')) {
          return { ok: true, value: await backend(core, 'GET', `${path}/decisions?state=${payload.state}&${identity}`) }
        }
        if (payload.action === 'messages' && identifier(payload.conversationId)) {
          const page = await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}`)
          return { ok: true, value: markAnswered(page, [], agentId) }
        }
        if (payload.action === 'message' && identifier(payload.conversationId) && identifier(payload.messageId)) {
          const page = await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}&messageId=${payload.messageId}`)
          // One exact message cannot show its own answer, so what came after it is read, but only for a question put to
          // this agent. If that read fails the message is still returned, just without a verdict.
          const sent = object(list(object(page).messages)[0])
          const asked = Array.isArray(sent.recipientIds) && sent.recipientIds.includes(agentId) && object(sent.author).id !== agentId
          if (!asked || !Number.isInteger(Number(sent.sequence))) return { ok: true, value: page }
          try {
            const later = object(await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}&after=${sent.sequence}`)).messages
            return { ok: true, value: markAnswered(page, list(later), agentId) }
          } catch { return { ok: true, value: page } }
        }
        if (payload.action === 'command' && identifier(payload.operationId) && payload.command && typeof payload.command === 'object' && !Array.isArray(payload.command)) {
          const command = await mentionCommand(taskCommand(object(payload.command)), async () => (await swarm()).state)
          const send = (command: Record<string, unknown>) => backend(core, 'POST', `${path}/commands`,
            { operationId: payload.operationId, command, asAgentId: agentId })
          let value: unknown
          try { value = await send(command) } catch (error) {
            if (command.type === 'agent.release' && error instanceof SuperTabHostError && error.status === 400 && ['VALIDATION_ERROR', 'INVALID_REQUEST'].includes(error.code)) {
              return { error: 'RELEASE_UNSUPPORTED', detail: 'This backend does not support releasing Builders yet. Update the backend and try again.' }
            }
            // A backend from before rules does not know the command type at all; a malformed rule is the Lead's to fix.
            if (['rule.set', 'rule.remove'].includes(String(command.type)) && error instanceof SuperTabHostError && error.status === 400 && /discriminator/i.test(error.message)) {
              return { error: 'RULES_UNSUPPORTED', detail: 'This Swarm\'s server does not support rules yet.' }
            }
            if (command.mentions && error instanceof SuperTabHostError && error.status === 400 && error.code === 'VALIDATION_ERROR'
              && /Unrecognized (?:key: "mentions"|key\(s\) in object: 'mentions')/.test(error.message)) {
              return { error: 'MENTIONS_UNSUPPORTED', detail: 'This Swarm\'s server does not support tagging people yet.' }
            }
            if (!['conversation.create', 'work.define'].includes(String(command.type)) || !command.task || !(error instanceof SuperTabHostError)) throw error
            const oldSchema = error.status === 400 && error.code === 'VALIDATION_ERROR'
              && /^(?:command: )?Unrecognized (?:key: "task"|key\(s\) in object: 'task')$/.test(error.message)
            // A legacy write may commit before its reply is lost and the backend upgrades. Its receipt checks the exact
            // legacy content before returning success, so checking that form cannot create a second operation.
            const legacyReceipt = error.status === 409 && error.code === 'OPERATION_REUSED'
            if (!oldSchema && !legacyReceipt) throw error
            const { task: _task, ...legacy } = command
            value = await send(legacy)
          }
          return { ok: true, operationId: payload.operationId, value }
        }
        // `post --attach` asks first whether this post already went out with its files.
        if (payload.action === 'attachment' && identifier(payload.conversationId) && payload.step === 'sent' && identifier(payload.operationId)) {
          const sent = object(await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}&messageId=${messageIdOf(payload.tabId, agentId, payload.operationId)}`))
          const earlier = object(list(sent.messages)[0])
          // The agent's id goes back too: the files are uploaded as this agent, through the daemon's local upload route.
          return { ok: true, value: { agentId, attachmentIds: Array.isArray(earlier.attachments) ? list(earlier.attachments).map(a => String(a.id)) : null } }
        }
        return { error: 'INVALID_REQUEST' }
      } catch (error) {
        // Help never fails for an unreadable caller: it is then the plain help.
        if (payload.action === 'help') return { ok: true, help: HELP }
        return error instanceof SuperTabHostError
          ? { error: error.code, detail: error.message, status: error.status }
          : { error: 'SUPER_TAB_UNAVAILABLE', detail: error instanceof Error ? error.message : 'This Super Tab is unavailable.' }
      }
    },
  }
  return { requests, port }
}
