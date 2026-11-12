/**
 * A task offered to one agent, as the daemons speak it (the allocator's package 16: backend superTabs/taskOffers.ts,
 * docs/design/2026-11-11-swarm-allocator/offers.md). GitHub cannot set a label "only if unset", so two writers could each give
 * one task, and a builder's own computer was never asked whether it had room. Now the PM's daemon offers a task to one builder
 * through the Swarm's server, which keeps one live offer for a task (githubAssign.ts give); the builder's own computer checks its
 * machine and its subscription's window here and accepts or declines; and its `take` puts the builder's labels on in its
 * person's name (githubClaim.ts). Nothing here writes on GitHub, and nothing of the subscription's window leaves this computer.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildingIn, DISK_KEPT, machineHas, OTHER_PROJECTS, RESERVE, SIZES } from './assign/crew.js'
import type { WatchedAgent } from './githubMentions.js'
import { GitHubReads, GitHubStop, type GitHubGet } from './githubRest.js'
import { named } from './agentReplies.js'
import { object, SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
/** An offer as the server tells it (backend taskOffers.ts TaskOffer), its times on the server's clock. */
export interface TaskOffer { repository: string; number: number; agentId: string; state: 'offered' | 'accepted' | 'declined' | 'lapsed'
  offeredAt: number; expiresAt: number; acceptedAt?: number; declined?: string }
/** The Swarm's server, as this computer asks it (wire.ts backend). */
export type Ask = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>
/** What this computer reads of a subscription's windows (capacity.ts quotaOf): the percentages stay here. */
export interface Windows { known: boolean; windows: Array<{ usedPercent: number; name: string }> }

/** How much of an accepted offer's hold a take needs left by the server's clock: each GitHub call ends within ten seconds and a
 *  take makes at most five, so its labels land while the hold stands, and no other agent is offered the task meanwhile. */
export const TAKE_MARGIN_MS = 2 * 60_000
/** How long a server without the routes (one from before them, or rolled back) is not asked again. */
export const NO_ROUTE_MS = 10 * 60_000
/** The soonest a Swarm's offers are read again after a read: a push comes with every change of the Swarm, not only an offer. */
export const ANSWER_GAP_MS = 20_000
/** How often a Swarm read no sooner than [ANSWER_GAP_MS] ago is read again with no push heard for it: a push lost on the way, or
 *  a server that does not push, leaves an offer unanswered at most about this long, inside the two minutes the server gives it
 *  (backend taskOffers.ts OFFER_ANSWER_MS). */
export const ANSWER_QUIET_MS = 60_000
/** How long this computer's agents, once read, are taken as they are: they change as one starts or stops, and githubMentions.ts
 *  reads them as seldom (review of #4153: read every pass, a busy Swarm's pushes read them three times a minute). */
export const AGENTS_MS = 60_000
/** Tasks one read of a project's offers asks about at most, as the server takes them (backend taskOffers.ts OFFER_NUMBERS_MAX). */
export const OFFER_NUMBERS_MAX = 100
/** The answers remembered, so an offer is answered once, and the failures said: far more than a day's offers to one computer's
 *  agents. And what each agent's person was told, kept across restarts. */
const ANSWERS_KEPT = 500, TOLD_KEPT = 500

/** A server without the routes: a 404 that is not the Swarm's own refusal (NOT_FOUND, a Swarm this computer cannot reach). */
export const noSuchRoute = (error: unknown): boolean => error instanceof SuperTabHostError && error.status === 404 && error.code !== 'NOT_FOUND'

const path = (tabId: string) => `/api/super-tabs/${tabId}/task-offers`
const offersIn = (answer: unknown): TaskOffer[] => (Array.isArray(object(answer).offers) ? object(answer).offers as unknown[] : []).map(object) as unknown as TaskOffer[]

/** Offers [task] to its agent, as the project's PM [pmAgentId]. */
export async function offerTask(ask: Ask, tabId: string, pmAgentId: string, task: { repository: string; number: number; agentId: string }): Promise<void> {
  await ask('POST', `${path(tabId)}?asAgentId=${pmAgentId}`, task)
}

/** The offers of [repository]'s tasks [numbers], live or ended in the last ten minutes, as its PM [pmAgentId] reads them: a read
 *  for each [OFFER_NUMBERS_MAX] of them. */
export async function projectOffers(ask: Ask, tabId: string, pmAgentId: string, repository: string, numbers: readonly number[]): Promise<TaskOffer[]> {
  const offers: TaskOffer[] = []
  for (let at = 0; at < numbers.length; at += OFFER_NUMBERS_MAX) {
    const asked = numbers.slice(at, at + OFFER_NUMBERS_MAX).join(',')
    offers.push(...offersIn(await ask('GET', `${path(tabId)}?repository=${encodeURIComponent(repository)}&numbers=${asked}&asAgentId=${pmAgentId}`)))
  }
  return offers
}

/** [agentId]'s live offers, and the server's time as it read them. */
export async function agentOffers(ask: Ask, tabId: string, agentId: string): Promise<{ offers: TaskOffer[]; serverTime: number }> {
  const answer = await ask('GET', `${path(tabId)}/mine?asAgentId=${agentId}`)
  return { offers: offersIn(answer), serverTime: Number(object(answer).serverTime) }
}

/** [agentId]'s acceptance of the offer of [task], or with [reason] its decline. */
export async function answerOffer(ask: Ask, tabId: string, agentId: string, task: { repository: string; number: number }, reason: string | null): Promise<void> {
  const { repository, number } = task
  await ask('POST', `${path(tabId)}/${reason ? 'decline' : 'accept'}?asAgentId=${agentId}`, reason ? { repository, number, reason } : { repository, number })
}

/** What a decline says to its agent's person, by its reason: no number, path or account. */
const WHY: Record<string, string> = { tools: 'it lacks a tool the task needs', memory: 'not enough free memory',
  disk: 'not enough free disk', quota: 'its subscription\'s window has too little left above what you keep' }

const labelsOf = (issue: Json): string[] => (Array.isArray(issue.labels) ? issue.labels.map(object) : []).map(label => String(label.name ?? '').toLowerCase())
const sizeOf = (labels: string[]) => {
  const size = (labels.find(label => /^size:[sml]$/.test(label))?.slice(5) ?? 'm') as 's' | 'm' | 'l'
  return SIZES[size]
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Why this computer takes no task [issue] (as GitHub has it) for the agent labelled [label], or null when it does: the task is
 * closed, a pull request, another builder's or taken by someone (`gone`); or this machine lacks a tool its `needs:` labels name
 * (`tools`), the free memory it holds or is under critical pressure (`memory`), or the disk it holds above what its person keeps
 * (`disk`); or a
 * known window of the agent's subscription has less room than the task spends above its person's reserve (`quota`). What cannot
 * be read is no reason: the plan gave the task on the machine's last report, and an unknown window is neither unused nor full
 * (services/usage.ts). Cores are not counted, as the plan counts none: each agent gets its share of them as it starts, and a task
 * held back for them cost more than it saved (package 7, docs/research/2026-11-11-agents-share-cpu.md section 9).
 */
export function noRoom(input: { issue: Json; label: string; machine: Json; windows: Windows }): string | null {
  const { issue, machine } = input, labels = labelsOf(issue)
  if (issue.state !== 'open' || issue.pull_request || labels.some(label => label.startsWith('builder:') && label !== input.label)
    || (labels.includes('status:taken') && !labels.includes(input.label))) return 'gone'
  const size = sizeOf(labels), resources = object(machine.resources)
  const gpus = Array.isArray(resources.gpus) ? resources.gpus : []
  const seen = { tools: machine.tools, resources: { os: resources.os, ...gpus.length ? { gpuPercent: 0 } : {} } }
  if (labels.some(label => label.startsWith('needs:') && !machineHas(seen, label.slice('needs:'.length)))) return 'tools'
  if (resources.memoryPressure === 'critical' || (finite(resources.memoryTotalBytes) && finite(resources.memoryUsedBytes)
    && resources.memoryTotalBytes - resources.memoryUsedBytes < size.ram)) return 'memory'
  if (finite(resources.projectDiskFreeBytes) && resources.projectDiskFreeBytes - DISK_KEPT < size.disk) return 'disk'
  // A weekly window is spent a fifth as fast as a 5-hour one (assign/crew.ts readProblem).
  if (input.windows.known && input.windows.windows.some(w => 100 - w.usedPercent - RESERVE < (/week/i.test(w.name) ? size.spend / 5 : size.spend))) return 'quota'
  return null
}

/**
 * Answers the offers made to this computer's person's agents here (watchedAgents: their own agents, on their own computer), as
 * the server pushes that one of their Swarms changed: at most once in [ANSWER_GAP_MS] for a Swarm, once as it starts for an offer
 * made while it was away, and once a minute for a Swarm no push named ([ANSWER_QUIET_MS]). Each offer is checked (noRoom) and
 * accepted or declined, and is remembered once the server took its answer; one agent's or one offer's failure is said and passes
 * over it alone. Accepted, its agent's next thing is looked at (nextThing.ts), which types it the task while it is idle. Declined for
 * a want of room, its person is told once for each reason until it accepts again, across restarts. A server without the routes is
 * asked again after [NO_ROUTE_MS].
 */
export class OfferAnswers {
  private stopNotices: (() => void) | null = null
  private quiet: NodeJS.Timeout | null = null
  private readonly reads: GitHubReads
  /** Each Swarm's last read, and its next one while it waits for the gap. */
  private readonly swarms = new Map<string, { at: number; timer: NodeJS.Timeout | null }>()
  private chain: Promise<void> = Promise.resolve()
  private agents: { at: number; list: WatchedAgent[] } | null = null
  private readonly answered = new Set<string>()
  /** What each agent's person was told, by agent and reason; read from [file] as it is first needed. */
  private told: Set<string> | null = null
  /** The failure last said of each thing that failed (the agents' read, an agent's offers, an offer), until it passes or changes. */
  private readonly failed = new Map<string, string>()
  private offUntil = 0
  /** Stopped: a pass asked for before the stop reads nothing once it comes. */
  private stopped = false
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: {
    watched: () => Promise<WatchedAgent[]>
    ask: Ask
    /** GitHub as this computer's person's gh: the task, and what its agents here build. */
    get: GitHubGet
    /** The session of [harnessId] here: its folder, and its engine, whose subscription it spends. */
    session: (harnessId: string) => { cwd: string | null; engine: string } | null
    /** This machine as it is now, for a task in [cwd] that needs [tools] (capacity.ts readCapabilities). */
    machine: (cwd: string | null, tools: string[]) => Promise<Json>
    windows: (engine: string) => Promise<Windows>
    /** Hears the server's notices; returns how to stop hearing them. */
    onNotice: (listener: (notice: { type: string; tabId?: string }) => void) => () => void
    /** Says [text] to [agent]'s person, in its chat. */
    say: (agent: WatchedAgent, operationId: string, text: string) => Promise<unknown>
    /** [agent] accepted a task: its next thing is looked at. */
    accepted: (agent: WatchedAgent) => void
    /** Where what each person was told is kept. */
    file: string
    now?: () => number
    log?: (line: string) => void
  }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
    this.reads = new GitHubReads(deps.get, this.now)
  }

  start(): void {
    if (this.stopNotices) return
    this.stopped = false
    this.stopNotices = this.deps.onNotice(notice => {
      if (notice.type === 'swarm_host_changed' && typeof notice.tabId === 'string') this.soon(notice.tabId)
    })
    this.quiet = setInterval(() => { void this.answer(null) }, ANSWER_QUIET_MS)
    this.quiet.unref()
    void this.answer(null)
  }

  stop(): void {
    this.stopped = true
    this.stopNotices?.()
    this.stopNotices = null
    if (this.quiet) clearInterval(this.quiet)
    this.quiet = null
    for (const swarm of this.swarms.values()) if (swarm.timer) clearTimeout(swarm.timer)
    this.swarms.clear()
  }

  /** Reads [tabId]'s offers once the gap since its last read has passed; one asked for meanwhile is that one. */
  private soon(tabId: string): void {
    const swarm = this.swarm(tabId)
    if (swarm.timer) return
    // The gap is measured from when the read is asked for, not from when its pass begins: pushes heard while a slow pass ran each
    // made one more pass (review of #4153: 16 reads where 7 were due).
    swarm.timer = setTimeout(() => {
      swarm.timer = null
      swarm.at = this.now()
      void this.answer(tabId)
    }, Math.max(0, swarm.at + ANSWER_GAP_MS - this.now()))
    swarm.timer.unref()
  }

  private swarm(tabId: string): { at: number; timer: NodeJS.Timeout | null } {
    const swarm = this.swarms.get(tabId) ?? { at: -Infinity, timer: null }
    this.swarms.set(tabId, swarm)
    return swarm
  }

  /** Answers [tabId]'s offers, or those of every Swarm not read in the last [ANSWER_GAP_MS] and with no read waiting for a push,
   *  after any answer still being made: one offer is never answered twice at once. */
  answer(tabId: string | null): Promise<void> {
    this.chain = this.chain.then(() => this.pass(tabId))
    return this.chain
  }

  private async pass(tabId: string | null): Promise<void> {
    if (this.stopped || this.now() < this.offUntil) return
    const agents = await this.agentsHere()
    if (!agents) return
    const now = this.now()
    const due = (tab: string) => { const swarm = this.swarm(tab); return !swarm.timer && now - swarm.at >= ANSWER_GAP_MS }
    const tabs = new Set(agents.map(agent => agent.tabId).filter(tab => tabId === null ? due(tab) : tab === tabId))
    // The minute's read keeps its own gap; a push's was kept as it was asked for (soon).
    if (tabId === null) for (const tab of tabs) this.swarm(tab).at = now
    for (const agent of agents.filter(a => tabs.has(a.tabId))) {
      let offers: TaskOffer[]
      try { offers = (await agentOffers(this.deps.ask, agent.tabId, agent.agentId)).offers } catch (error) {
        if (!noSuchRoute(error)) { this.failure(agent.agentId, error); continue }
        this.offUntil = this.now() + NO_ROUTE_MS
        return this.failure('offers', error)
      }
      this.failure(agent.agentId, null)
      this.failure('offers', null)
      // What it accepted, as the server holds it (a restart forgets nothing); one accepted in this pass joins them.
      const accepted = offers.filter(o => o.state === 'accepted')
      for (const offer of offers.filter(o => o.state === 'offered')) {
        const key = `${agent.agentId}|${offer.repository}#${offer.number}@${offer.offeredAt}`
        try {
          if (await this.decide(agent, offer, accepted, key)) accepted.push(offer)
          this.failure(key, null)
        } catch (error) { this.failure(key, error) }
      }
    }
  }

  /** This computer's agents read now, which the next passes take as they are. */
  private async agentsAgain(): Promise<WatchedAgent[]> {
    this.agents = { at: this.now(), list: await this.deps.watched() }
    return this.agents.list
  }

  /** This computer's agents, read again once [AGENTS_MS] old; null while they cannot be read. */
  private async agentsHere(): Promise<WatchedAgent[] | null> {
    if (!this.agents || this.now() - this.agents.at >= AGENTS_MS) {
      try { this.agents = { at: this.now(), list: await this.deps.watched() } } catch (error) {
        this.failure('agents', error)
        return null
      }
      this.failure('agents', null)
    }
    return this.agents.list
  }

  /** Says the failure of [what] once until it passes ([error] null) or changes. */
  private failure(what: string, error: unknown): void {
    this.once(what, error === null ? null
      : `[super-tab] Task offers: ${noSuchRoute(error) ? 'this Swarm\'s server takes no offers yet' : error instanceof GitHubStop ? error.code : named(error)}`)
  }

  /** Says [line] of [what] once until it is over ([line] null) or changes. */
  private once(what: string, line: string | null): void {
    if (line === null) { this.failed.delete(what); return }
    if (this.failed.get(what) === line) return
    this.failed.set(what, line)
    if (this.failed.size > ANSWERS_KEPT) this.failed.delete(this.failed.keys().next().value!)
    this.log(line)
  }

  /** Answers [offer] to [agent], beside what it [accepted]; true when it accepted it. */
  private async decide(agent: WatchedAgent, offer: TaskOffer, accepted: TaskOffer[], key: string): Promise<boolean> {
    if (this.answered.has(key)) return false
    const task = `${offer.repository}#${offer.number}`
    const reason = await this.check(agent, offer, accepted)
    await answerOffer(this.deps.ask, agent.tabId, agent.agentId, offer, reason)
    // Remembered once the server took it, so an answer that failed is made again (review of #4153); a repeat is safe there.
    this.answered.add(key)
    if (this.answered.size > ANSWERS_KEPT) this.answered.delete(this.answered.values().next().value!)
    this.log(`[super-tab] ${agent.names[0]} ${reason ? `declined ${task}: ${reason}` : `accepted ${task}`}`)
    const told = this.toldOnce()
    if (!reason) {
      const ended = [...told].filter(line => line.startsWith(`${agent.agentId}|`))
      for (const line of ended) told.delete(line)
      if (ended.length) this.keep()
      this.deps.accepted(agent)
      return true
    }
    const line = `${agent.agentId}|${reason}`
    if (!WHY[reason] || told.has(line)) return false
    // As the agent says it, in its chat with its person (nextThing.ts idleWith), under an id the server takes: the key's hash.
    await this.deps.say(agent, `offer-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`,
      `I was offered ${task}, and this computer has no room for it: ${WHY[reason]}.`)
    told.add(line)
    this.keep()
    return false
  }

  /** Why [agent] declines [offer] (noRoom, busy), read here: the task as GitHub has it, this machine, the agent's subscription, and
   *  what it builds in its other projects or [accepted]. A task of no project of the agent's is gone. */
  private async check(agent: WatchedAgent, offer: TaskOffer, accepted: TaskOffer[]): Promise<string | null> {
    const repo = offer.repository.toLowerCase()
    // Its agents are read once a minute: one that joined a project since has its repository read again before its offer is
    // declined as gone (review of #4153).
    const projects = agent.repos.includes(repo) ? agent.repos : (await this.agentsAgain()).find(again => again.agentId === agent.agentId)?.repos ?? []
    const issue = projects.includes(repo) ? await this.reads.ifThere(repo, `/repos/${repo}/issues/${offer.number}`) : null
    if (!issue) return 'gone'
    const session = this.deps.session(agent.harnessId)
    const labels = labelsOf(issue), needs = labels.filter(label => label.startsWith('needs:')).map(label => label.slice('needs:'.length))
    const reason = noRoom({ issue, label: agent.label, machine: await this.deps.machine(session?.cwd ?? null, needs),
      windows: session ? await this.deps.windows(session.engine) : { known: false, windows: [] } })
    return reason !== 'gone' && await this.busy(agent, repo, accepted) ? 'busy' : reason
  }

  /**
   * Whether [agent] has a task in hand: one given or taken to it in another of its Swarm's projects than [own] with no pull request
   * of its up, as that project's plan counts one (assign/crew.ts buildingIn), or one it [accepted] that is given to it nowhere yet.
   * A second project's plan reads only labels, so between an accept and its give it saw this agent free and could offer it a
   * second task (the merge of #4144 and #4153). [own]'s labels count no task of its: its plan counts its own by their pull
   * requests' branches (githubAssign.ts), and labels could say busy where it says free; they are read only for what is given there.
   * The others are read as that plan reads them (buildsElsewhere): of projects not archived, the first [OTHER_PROJECTS], one that
   * cannot be read counting nothing, each said once. Declined `busy`, its person is told nothing (WHY).
   */
  private async busy(agent: WatchedAgent, own: string, accepted: TaskOffer[]): Promise<boolean> {
    const others = agent.active.filter(repo => repo !== own)
    this.once(`others|${agent.agentId}`, others.length > OTHER_PROJECTS
      ? `[super-tab] Task offers: OTHER_PROJECTS ${agent.names[0]}: of its ${others.length} other projects, the first ${OTHER_PROJECTS} are read for what it builds` : null)
    const lists = await this.labelled(agent, [own, ...others.slice(0, OTHER_PROJECTS)])
    if (buildingIn(lists.filter(([repo]) => repo !== own).map(([, items]) => items), { id: agent.agentId, label: agent.label }).tasks > 0) return true
    const given = new Set(lists.flatMap(([repo, items]) => items.filter(item => !item.pull_request).map(item => `${repo}#${item.number}`)))
    return accepted.some(held => !given.has(`${held.repository.toLowerCase()}#${held.number}`))
  }

  /** [agent]'s open issues and pull requests its label is on, in each of [repos] at once; one that cannot be read gives none, said
   *  once until it can. A stop for every repository (a rate limit, gh signed out) fails the answer, as the task's own read does. */
  private async labelled(agent: WatchedAgent, repos: string[]): Promise<Array<[string, Json[]]>> {
    const lists = await Promise.all(repos.map(async (repo): Promise<[string, Json[]] | null> => {
      const what = `${agent.agentId}|${repo}`
      try {
        const items = await this.reads.current(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=100`, 1)
        this.once(what, null)
        return [repo, items]
      } catch (error) {
        if (!(error instanceof GitHubStop) || error.everywhere) throw error
        this.once(what, `[super-tab] Task offers: ${error.code} ${repo}: ${error.message} ${agent.names[0]} counts as building nothing there.`)
        return null
      }
    }))
    return lists.filter((list): list is [string, Json[]] => list !== null)
  }

  /** What each person was told, read from its file as it is first needed: told once for each reason, a restart says it again
   *  no more (review of #4153). None kept yet, or unreadable: from now. */
  private toldOnce(): Set<string> {
    if (this.told) return this.told
    try {
      const kept = object(JSON.parse(readFileSync(this.deps.file, 'utf8'))).told
      this.told = new Set(Array.isArray(kept) ? kept.filter((line): line is string => typeof line === 'string') : [])
    } catch { this.told = new Set() }
    return this.told
  }

  private keep(): void {
    const told = [...this.toldOnce()].slice(-TOLD_KEPT)
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const temporary = `${this.deps.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ told }), { mode: 0o600 })
      renameSync(temporary, this.deps.file)
    } catch (error) { this.log(`[super-tab] Task offers: what each person was told could not be kept: ${named(error)}`) }
  }
}
