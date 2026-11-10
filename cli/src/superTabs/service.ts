import { readCapabilities } from './capacity.js'
import { existsSync } from 'node:fs'
import { readAuthSession } from '../lib/authSession.js'
import { createHash } from 'node:crypto'
import type { CoreApi, ServiceRequests, SuperTabsPort } from '../core/api.js'
import { swarmListedFor, swarmRoleFor, hostJournalFile, SuperTabHost, type SuperTabHostOptions, type SwarmSources } from './host.js'
import { HostFeed } from './hostFeed.js'
import { SwarmReads, type SwarmRead } from './swarmReads.js'
import { backend, identifier, object, SuperTabHostError, within } from './wire.js'
import { isCoordinator, isStep } from './agentContext.js'
import { wireRole } from '../lib/swarmSkills.js'
import { CapacityReservations, type ReservationBook } from './reservations.js'
import { ContributionPreparations, ownerRequest, prepareContribution } from './contribution.js'
import { ClaudeSignIns } from './claudeSignIn.js'
import { answerFirstRun } from '../engines/launchPrep.js'
import { messageIdOf } from './attach.js'
import { cardId, SwarmCards, type CardChat } from './cards.js'
import { GitHubTokenRefresher, githubToken } from './github.js'
import { GitHubMentions, watchedAgents } from './githubMentions.js'
import { ShippingReporter } from './shipping.js'
import { githubRest } from './githubRest.js'
import { GitHubAssign } from './githubAssign.js'
import { GitHubMerge, ledProjects, type LedProject } from './githubMerge.js'
import { crewOf } from './assign/crew.js'
import { teamEngineReporter, type TeamEngineReporter } from '../team/engines.js'
import { readTeamConfig } from '../team/config.js'
import { ensureTeamTmux, TMUX_MANIFEST_URL, tmuxRunsAt, untarGz, type TeamTmuxDeps, type TeamTmuxOutcome } from '../team/tmux.js'
import { downloadVerified } from '../lib/selfUpdate.js'
import { managedTmuxPath, tmuxInstallDirectories } from '../lib/tmuxOnPath.js'
import { ensureTeamGh, ghRunsAt, unzipArchive, type TeamGhDeps, type TeamGhOutcome } from '../team/gh.js'
import { managedNodePath } from '../lib/nodeRuntime.js'
import { linkTeamNodeTools, type TeamNodeToolsDeps } from '../team/nodeTools.js'
import { env as appEnv } from '../config/env.js'
import { homedir, userInfo } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { createPullRequestsStatusReader } from '../lib/pullRequestsStatus.js'
import { buddyArchived, buddyStatus, isBuddyIn, isSwarmBuddyIn, projectNamed, type BuddyStatusDeps } from './buddyStatus.js'
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
const answerOf = (read: SwarmRead) => ({ lastChangedAt: read.lastChangedAt, state: read.state, ...(read.githubApp ? { githubApp: true } : {}) })
const OFF_ROSTER = 'This agent is not on this machine\'s Swarm roster right now. That can mean this machine has no access to it, or its billing does not allow it. Check how this machine is shared.'
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
  /** What reports the Harness Team account's own engines to its owner (team/engines.ts), for a spec. */
  teamEngines?: () => Pick<TeamEngineReporter, 'start' | 'stop'>
  /** Whether this daemon runs team work only (a Harness Team account, `harness team on`), for a spec. */
  team?: () => boolean
  /** The Harness Team account's own tmux (team/tmux.ts), for a spec. */
  teamTmux?: () => Promise<TeamTmuxOutcome>
  /** What installs the Harness Team account's own gh (team/gh.ts), for a spec. */
  teamGh?: () => Promise<TeamGhOutcome>
  /** What links the Harness Team account's npm and npx (team/nodeTools.ts), for a spec. */
  teamNodeTools?: () => unknown
  /** What reads a Buddy's pull requests with this machine's own GitHub (lib/pullRequestsStatus.ts), for a spec. */
  pullRequests?: BuddyStatusDeps['pullRequests']
  /** What reads GitHub for this computer's person's v4 agents (superTabs/githubMentions.ts), for a spec. */
  githubMentions?: (core: CoreApi, sources: () => SwarmSources) => Pick<GitHubMentions, 'start' | 'stop'>
  /** What merges by rule the pull requests of the projects whose PM runs here (superTabs/githubMerge.ts), for a spec. */
  githubMerge?: (core: CoreApi, sources: () => SwarmSources) => Pick<GitHubMerge, 'start' | 'stop'>
  /** What gives the tasks of the projects whose PM runs here to their builders (superTabs/githubAssign.ts), for a spec. */
  githubAssign?: (core: CoreApi, sources: () => SwarmSources) => Pick<GitHubAssign, 'start' | 'stop'>
  /** What reports what this computer's person's agents shipped to the Swarm's leaderboard (superTabs/shipping.ts), for a spec. */
  shipping?: (core: CoreApi) => Pick<ShippingReporter, 'start' | 'stop'>
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
  // A Buddy runs only on its person's own machine (backend buddy.create), so this machine's GitHub is its person's. Read once
  // per daemon, cached 30 seconds a pull request. Each Buddy's last summary, by tab and agent, marks what changed since.
  let pullRequests: BuddyStatusDeps['pullRequests'] | null = null
  const buddySince = new Map<string, number | null>()
  const reservations = () => {
    const machine = core.daemon.machineId()
    if (bookMachine !== machine) { book?.stop(); book = null; bookMachine = machine }
    book ??= (options.reservations ?? ((api, id) => new CapacityReservations(api, id)))(core, machine)
    return book
  }
  // GitHub as this computer's own gh login, for the news to its person's v4 agents and the merges of their PM's projects:
  // read and merged while the host runs (no host, no Swarm agents here to read or merge for).
  const github = githubRest()
  // GitHub for this computer's person's v4 agents (githubMentions.ts).
  const mentions = (options.githubMentions ?? ((api, held) => new GitHubMentions({
    watched: async () => watchedAgents({ me: (await api.account.identity().catch(() => null))?.accountId ?? null, live: id => !!api.agents.byAgent(id),
      roster: async () => (await held().feed.current(60_000)).roster, read: async (tabId, agentId) => (await held().reads.read(tabId, agentId)).state }),
    get: github.get,
    relay: (tabId, operationId, command) => backend(api, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId, command }),
    // As the agent, to itself only, in its chat with its person: as the host tells a skill notice (host.ts tellSkill).
    tell: (agent, operationId, text) => backend(api, 'POST', `/api/super-tabs/${agent.tabId}/commands`, { operationId, asAgentId: agent.agentId,
      command: { type: 'message.send', conversationId: agent.chat, replyTo: null, recipientIds: [agent.agentId], text, agentOnly: true } }),
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
  const merges = (options.githubMerge ?? ((api, held) => new GitHubMerge({ projects: led(api, held), crew: crewOfProject(held), get: github.get,
    send: github.send })))(core, sources)
  // Gives their tasks to their builders (githubAssign.ts), from the crew as the PM reads the Swarm.
  const assigns = (options.githubAssign ?? ((api, held) => new GitHubAssign({ projects: led(api, held), crew: crewOfProject(held),
    get: github.get, send: github.send })))(core, sources)
  // What this computer's person's agents shipped, read from GitHub with their own gh and told to the leaderboard (shipping.ts).
  const shipping = (options.shipping ?? (api => new ShippingReporter(api)))(core)
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
  // In the Harness Team account: a tmux and a gh of its own when it has none it can run (team/tmux.ts, team/gh.ts). Looked
  // at as it connects, and a failed install again half an hour later.
  const settled = (outcome: string) => outcome === 'present' || outcome === 'installed' || outcome === 'not-team'
  let tmuxCheckedAt = -Infinity, ghCheckedAt = -Infinity
  const ensureTmux = options.teamTmux ?? (() => ensureTeamTmux(realTeamTmuxDeps()))
  const ensureGh = options.teamGh ?? (() => ensureTeamGh(realTeamGhDeps()))
  const checkTmux = () => {
    if (Date.now() - tmuxCheckedAt >= 30 * 60_000) {
      tmuxCheckedAt = Date.now()
      void ensureTmux().then(outcome => { if (settled(outcome)) tmuxCheckedAt = Infinity })
    }
    if (Date.now() - ghCheckedAt >= 30 * 60_000) {
      ghCheckedAt = Date.now()
      void ensureGh().then(outcome => { if (settled(outcome)) ghCheckedAt = Infinity })
      ;(options.teamNodeTools ?? (() => linkTeamNodeTools(realTeamNodeToolsDeps())))()
    }
  }
  // The server's word that one of this machine's Swarms changed, heard while no host runs (Amon, #3215).
  let hostWake: (() => void) | null = null
  const disconnect = () => { hostWake?.(); hostWake = null; preparations.clear(); claudeSignIns.stop(); host?.stop(); host = null; mentions.stop(); merges.stop(); assigns.stop(); shipping.stop(); held = null; book?.stop(); book = null; bookMachine = null; swarmCards?.want(false); swarmCards = null; cardsMachine = null; tokens.stop(); engines.stop() }
  const port = {
    connected: () => {
      tokens.start()
      engines.start()
      checkTmux()
      // A daemon that runs team work only is there for its Swarms: its host runs from its first connection. Its Mac's daemon adds
      // a Harness Team account to a Swarm without waking it (host.ts joinTeams), and a host that never ran reports no privacy
      // check, so the Swarm read the account as offline and never sent it a teammate's work (third VM run).
      if (identifier(core.daemon.machineId()) && (existsSync(hostJournalFile(core.dataDir, core.daemon.machineId()))
        || (options.team ?? (() => readAuthSession()?.kind === 'team'))())) wake()
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
        if (payload.action === 'observeCapacity') return await reservations().observe(payload.creationId, closed)
        if (payload.action === 'returnCapacity') return await reservations().giveBack(payload.creationId, closed)
        // Only this machine's own host, which read the Swarm's verdict for its start (machines.ts): a relayed caller could
        // otherwise free memory a start still holds (issue #2989).
        if (payload.action === 'endCapacity') return asker.local ? await reservations().ended(payload.creationId, closed) : { error: 'OWNER_REQUIRED' }
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
        // Why this Mac's Harness Team account has not joined a Swarm, while adding it fails (host.ts joinTeams), and Retry on the
        // row (Amon, #3215: "joining" for good, the reason only in the log). Only a client on this computer asks.
        // The status starts nothing; Retry starts the host if it never ran, which then reads its roster as any start does.
        if (payload.action === 'teamJoinStatus' || payload.action === 'teamJoinRetry') {
          if (!asker.local) return { error: 'OWNER_REQUIRED' }
          // Retry starts a host that never ran (Amon, #3215): it then reads its Swarms in full, the Team account's join among them.
          if (payload.action === 'teamJoinRetry') { wake().retryTeamJoins(); return { ok: true } }
          return { ok: true, failure: host?.teamJoinFailure() ?? null, hostRunning: !!host }
        }
        if (payload.action === 'swarmRole') {
          const grant = await port.swarmRole(String(payload.harnessId ?? ''))
          // In the wire's values, which the core reads in either set (inCore/role.ts) and a core from before role kinds in
          // these alone; a Reviewer's keeps its swarm-review file.
          return { ok: true, role: grant ? wireRole(grant) : grant, ...(grant ? { mode: grant.mode } : {}) }
        }
        // Import agent (Desktop): whether any Swarm lists this harness here. An unreadable roster answers no `listed`, on which
        // Desktop refuses rather than share.
        if (payload.action === 'swarmListed') {
          const listed = await within(swarmListedFor(sources(), String(payload.harnessId ?? '')))
          return listed === null ? { ok: true } : { ok: true, listed }
        }
        // `harness send`, `new`, `tell` and `close` from a pane (buddyPane.ts): whether its harness is a Buddy, from this computer's
        // own launch record (start.ts starts one with the Swarm role buddy; core/agents/create.ts saves it on the session). The
        // second review of #2087 found the server read alone missed its deadline 2 times in 3 under load: it is asked only about a
        // harness an agent started with no Swarm record, and only as one more reason to refuse. Without a harness: whether this
        // computer runs a Buddy at all, which Windows refuses on as it cannot check a pane.
        if (payload.action === 'buddyCheck') {
          if (!asker.local) return { error: 'OWNER_REQUIRED' }
          if (payload.harnessId === undefined) return { ok: true, buddiesHere: core.agents.live().some(session => session.swarmSkill?.role === 'buddy') }
          const session = identifier(payload.harnessId) ? core.agents.byAgent(payload.harnessId) : undefined
          if (!session || session.startedBy !== 'agent' && !session.swarmSkill) return { ok: true, buddy: false }
          if (session.swarmSkill) return { ok: true, buddy: session.swarmSkill.role === 'buddy' }
          const grant = await port.swarmRole(session.agentId).catch(() => undefined)
          return { ok: true, buddy: grant?.role === 'buddy' }
        }
        if (payload.action === 'prepareContribution') return preparations.read(payload)
        // The phone signing Claude Code, or Codex (`engineSignIn` {engine}), in here for the Buddy it starts (claudeSignIn.ts):
        // its owner's, as the setup is.
        if (payload.action === 'claudeSignIn' || payload.action === 'engineSignIn') {
          const answer = await claudeSignIns.read(payload)
          // Once per sign-in: the Swarm reads it signed in now, before the Buddy that phone starts next asks.
          if (answer.state === 'done' && reported !== payload.operationId) {
            reported = String(payload.operationId)
            wake().engineSignedIn()
          }
          return answer
        }
        // The phone's answers to Claude Code's first-run questions here, asked as it set this computer up for its Buddy
        // (engines/launchPrep.ts answerFirstRun): its owner's, as the setup is.
        if (payload.action === 'claudeFirstRun') {
          // Its theme and first-run screens only: the Buddy runs in its owner's own permission mode (task #4215), so a phone's
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
        // An agent speaks through its own computer's Harness alone: the second review of #2087 sent a Buddy's request with
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
          if (tabs.length === 1) payload.tabId = tabs[0]
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
        // A harness speaks as its own agent alone (security review of #2087: a Buddy named its Builder with --agent).
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
          const read = await swarm()
          if (!isBuddyIn(read.state, agentId)) return { ok: true, value: statusView(answerOf(read), agentId) }
          pullRequests ??= options.pullRequests ?? createPullRequestsStatusReader()
          const deps: BuddyStatusDeps = { pullRequests: pullRequests!,
            decisions: () => backend(core, 'GET', `${path}/decisions?state=open&${identity}`) }
          const project = typeof payload.project === 'string' ? payload.project : undefined
          if (payload.archived === true) {
            // A person's one Buddy names the project whose archive it reads (status --project NAME --archived).
            const named = project ? projectNamed(read.state, project) : undefined
            if (isSwarmBuddyIn(read.state, agentId) && !named) return { ok: true, value: { lastChangedAt: read.lastChangedAt, summary: { error: 'Name the project: status --project NAME --archived.' } } }
            const projectId = String(named?.id ?? list(read.state.agents).find(a => a.id === agentId)?.projectId ?? 'lead')
            const before = typeof payload.before === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(payload.before) ? `&before=${payload.before}` : ''
            const page = await backend(core, 'GET', `${path}/groups?dormant=1&projectId=${encodeURIComponent(projectId)}${before}&${identity}`)
            return { ok: true, value: { lastChangedAt: read.lastChangedAt, summary: await buddyArchived(page, read.state, agentId, deps) } }
          }
          const key = `${payload.tabId}:${agentId}`
          const summary = await buddyStatus({ state: read.state, lastChangedAt: read.lastChangedAt, groupChangedAt: read.groupChangedAt, agentId,
            since: buddySince.get(key) ?? null, ...(project ? { project } : {}) }, deps)
          // One project's read leaves the index's "changed since" where it was.
          if (!project) {
            buddySince.delete(key)
            buddySince.set(key, read.lastChangedAt)
          }
          // One per Buddy on this machine; a machine runs a few at most, so a small cap only guards against a leak.
          for (const oldest of buddySince.keys()) { if (buddySince.size <= 64) break; buddySince.delete(oldest) }
          return { ok: true, value: { lastChangedAt: read.lastChangedAt, summary } }
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
          const command = await mentionCommand(object(payload.command), async () => (await swarm()).state)
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

/** The team daemon's own: its account, its PATH and Homebrew's places, the published manifest (team/tmux.ts). */
function realTeamTmuxDeps(): TeamTmuxDeps {
  return {
    team: () => { try { return readTeamConfig()?.user === userInfo().username } catch { return false } },
    platform: process.platform,
    arch: process.arch,
    candidates: () => {
      const managed = managedTmuxPath()
      const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute), ...tmuxInstallDirectories()]
      return [...(managed ? [managed] : []), ...dirs.map(dir => join(dir, 'tmux'))].filter(path => existsSync(path))
    },
    runs: tmuxRunsAt,
    manifest: async () => {
      const reply = await fetch(process.env.HARNESS_TMUX_METADATA_URL || TMUX_MANIFEST_URL, { signal: AbortSignal.timeout(30_000) })
      if (!reply.ok) throw new Error(`the tmux manifest answered HTTP ${reply.status}`)
      return reply.json()
    },
    download: (build) => downloadVerified({ url: build.url, sha256: build.sha256, ...(build.size ? { size: build.size } : {}) }),
    untar: untarGz,
    runtimeDir: appEnv.ADAPTER_RUNTIME_DIR,
    binDir: join(homedir(), '.local', 'bin'),
    log: (line) => console.log(`[team] ${line}`),
  }
}

/** The team daemon's own Node and bin folder (team/nodeTools.ts). */
function realTeamNodeToolsDeps(): TeamNodeToolsDeps {
  return {
    team: () => { try { return readTeamConfig()?.user === userInfo().username } catch { return false } },
    node: managedNodePath,
    binDir: join(homedir(), '.local', 'bin'),
    log: (line) => console.log(`[team] ${line}`),
  }
}

/** The team daemon's own, as for its tmux: its account, its PATH and Homebrew's places (team/gh.ts). */
function realTeamGhDeps(): TeamGhDeps {
  const binDir = join(homedir(), '.local', 'bin')
  return {
    team: () => { try { return readTeamConfig()?.user === userInfo().username } catch { return false } },
    platform: process.platform,
    arch: process.arch,
    candidates: () => [binDir, ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute), '/opt/homebrew/bin', '/usr/local/bin']
      .map(dir => join(dir, 'gh')).filter(path => existsSync(path)),
    runs: ghRunsAt,
    download: (build) => downloadVerified({ url: build.url, sha256: build.sha256, size: build.size }),
    unzip: unzipArchive,
    runtimeDir: appEnv.ADAPTER_RUNTIME_DIR,
    binDir,
    log: (line) => console.log(`[team] ${line}`),
  }
}
