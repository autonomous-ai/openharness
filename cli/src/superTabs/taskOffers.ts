/**
 * A task offered to one agent, as the daemons speak it (the allocator's package 16: backend superTabs/taskOffers.ts,
 * docs/design/2026-11-11-swarm-allocator/offers.md). GitHub cannot set a label "only if unset", so two writers could each give
 * one task, and a builder's own computer was never asked whether it had room. Now the PM's daemon offers a task to one builder
 * through the Swarm's server, which keeps one live offer for a task (githubAssign.ts give); the builder's own computer checks its
 * machine and its subscription's window here and accepts or declines; and its `take` puts the builder's labels on in its
 * person's name (githubClaim.ts). Nothing here writes on GitHub, and nothing of the subscription's window leaves this computer.
 */
import { DISK_KEPT, machineHas, RESERVE, SIZES, tasksOf } from './assign/crew.js'
import type { WatchedAgent } from './githubMentions.js'
import { GitHubReads, type GitHubGet } from './githubRest.js'
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
/** The answers remembered, so an offer is answered once: far more than a day's offers to one computer's agents. */
const ANSWERS_KEPT = 500

/** A server without the routes: a 404 that is not the Swarm's own refusal (NOT_FOUND, a Swarm this computer cannot reach). */
export const noSuchRoute = (error: unknown): boolean => error instanceof SuperTabHostError && error.status === 404 && error.code !== 'NOT_FOUND'

const path = (tabId: string) => `/api/super-tabs/${tabId}/task-offers`
const offersIn = (answer: unknown): TaskOffer[] => (Array.isArray(object(answer).offers) ? object(answer).offers as unknown[] : []).map(object) as unknown as TaskOffer[]

/** Offers [task] to its agent, as the project's PM [pmAgentId]. */
export async function offerTask(ask: Ask, tabId: string, pmAgentId: string, task: { repository: string; number: number; agentId: string }): Promise<void> {
  await ask('POST', `${path(tabId)}?asAgentId=${pmAgentId}`, task)
}

/** The offers of [repository]'s tasks, live or ended in the last ten minutes, as its PM [pmAgentId] reads them. */
export async function projectOffers(ask: Ask, tabId: string, pmAgentId: string, repository: string): Promise<TaskOffer[]> {
  return offersIn(await ask('GET', `${path(tabId)}?repository=${encodeURIComponent(repository)}&asAgentId=${pmAgentId}`))
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
const WHY: Record<string, string> = { tools: 'it lacks a tool the task needs', cores: 'not enough free cores', memory: 'not enough free memory',
  disk: 'not enough free disk', quota: 'its subscription\'s window has too little left above what you keep' }

const labelsOf = (issue: Json): string[] => (Array.isArray(issue.labels) ? issue.labels.map(object) : []).map(label => String(label.name ?? '').toLowerCase())
const sizeOf = (labels: string[]) => SIZES[(labels.find(label => /^size:[sml]$/.test(label))?.slice(5) ?? 'm') as 's' | 'm' | 'l']
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Why this computer takes no task [issue] (as GitHub has it) for the agent labelled [label], or null when it does: the task is
 * closed, a pull request, another builder's or taken by someone (`gone`); or this machine lacks a tool its `needs:` labels name
 * (`tools`), the cores its size holds beside the [held] ones of the tasks its agents here build (`cores`), the free memory it
 * holds or is under critical pressure (`memory`), or the disk it holds above what its person keeps (`disk`); or a known window
 * of the agent's subscription has less room than the task spends above its person's reserve (`quota`). What cannot be read is
 * no reason: the plan gave the task on the machine's last report, and an unknown window is neither unused nor full
 * (services/usage.ts). The cores are counted, never read as a load: a momentary reading once refused every start (capacity.ts).
 */
export function noRoom(input: { issue: Json; label: string; machine: Json; cores: number; held: number; windows: Windows }): string | null {
  const { issue, machine } = input, labels = labelsOf(issue)
  if (issue.state !== 'open' || issue.pull_request || labels.some(label => label.startsWith('builder:') && label !== input.label)
    || (labels.includes('status:taken') && !labels.includes(input.label))) return 'gone'
  const size = sizeOf(labels), resources = object(machine.resources)
  const gpus = Array.isArray(resources.gpus) ? resources.gpus : []
  const seen = { tools: machine.tools, resources: { os: resources.os, ...gpus.length ? { gpuPercent: 0 } : {} } }
  if (labels.some(label => label.startsWith('needs:') && !machineHas(seen, label.slice('needs:'.length)))) return 'tools'
  if (input.held + size.cpu > input.cores) return 'cores'
  if (resources.memoryPressure === 'critical' || (finite(resources.memoryTotalBytes) && finite(resources.memoryUsedBytes)
    && resources.memoryTotalBytes - resources.memoryUsedBytes < size.ram)) return 'memory'
  if (finite(resources.projectDiskFreeBytes) && resources.projectDiskFreeBytes - DISK_KEPT < size.disk) return 'disk'
  // A weekly window is spent a fifth as fast as a 5-hour one (assign/crew.ts readProblem).
  if (input.windows.known && input.windows.windows.some(w => 100 - w.usedPercent - RESERVE < (/week/i.test(w.name) ? size.spend / 5 : size.spend))) return 'quota'
  return null
}

/**
 * Answers the offers made to this computer's person's agents here (watchedAgents: their own agents, on their own computer), as
 * the server pushes that one of their Swarms changed: at most once in [ANSWER_GAP_MS] for a Swarm, and once as it starts, for an
 * offer made while it was away. Each offer is checked (noRoom) and accepted or declined once. Accepted, its agent's next thing is
 * looked at (nextThing.ts), which types it the task while it is idle. Declined for a want of room, its person is told once for each
 * reason, until it accepts again. A server without the routes is asked again after [NO_ROUTE_MS].
 */
export class OfferAnswers {
  private stopNotices: (() => void) | null = null
  private readonly reads: GitHubReads
  /** Each Swarm's last read, and its next one while it waits for the gap. */
  private readonly swarms = new Map<string, { at: number; timer: NodeJS.Timeout | null }>()
  private chain: Promise<void> = Promise.resolve()
  private readonly answered = new Set<string>()
  private readonly told = new Set<string>()
  private offUntil = 0
  private failed = ''
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
    cores: () => number
    /** Hears the server's notices; returns how to stop hearing them. */
    onNotice: (listener: (notice: { type: string; tabId?: string }) => void) => () => void
    /** Says [text] to [agent]'s person, in its chat. */
    say: (agent: WatchedAgent, operationId: string, text: string) => Promise<unknown>
    /** [agent] accepted a task: its next thing is looked at. */
    accepted: (agent: WatchedAgent) => void
    now?: () => number
    log?: (line: string) => void
  }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
    this.reads = new GitHubReads(deps.get, this.now)
  }

  start(): void {
    if (this.stopNotices) return
    this.stopNotices = this.deps.onNotice(notice => {
      if (notice.type === 'swarm_host_changed' && typeof notice.tabId === 'string') this.soon(notice.tabId)
    })
    this.answer(null)
  }

  stop(): void {
    this.stopNotices?.()
    this.stopNotices = null
    for (const swarm of this.swarms.values()) if (swarm.timer) clearTimeout(swarm.timer)
    this.swarms.clear()
  }

  /** Reads [tabId]'s offers once the gap since its last read has passed; one asked for meanwhile is that one. */
  private soon(tabId: string): void {
    const swarm = this.swarms.get(tabId) ?? { at: 0, timer: null }
    this.swarms.set(tabId, swarm)
    if (swarm.timer) return
    swarm.timer = setTimeout(() => {
      swarm.timer = null
      swarm.at = this.now()
      this.answer(tabId)
    }, Math.max(0, swarm.at + ANSWER_GAP_MS - this.now()))
    swarm.timer.unref()
  }

  /** Answers [tabId]'s offers, or every Swarm's, after any answer still being made: one offer is never answered twice at once. */
  answer(tabId: string | null): Promise<void> {
    this.chain = this.chain.then(() => this.pass(tabId))
    return this.chain
  }

  private async pass(tabId: string | null): Promise<void> {
    if (this.now() < this.offUntil) return
    try {
      const agents = await this.deps.watched()
      for (const agent of agents.filter(a => tabId === null || a.tabId === tabId)) {
        for (const offer of (await agentOffers(this.deps.ask, agent.tabId, agent.agentId)).offers) {
          if (offer.state === 'offered') await this.decide(agent, offer, agents)
        }
      }
      this.failed = ''
    } catch (error) {
      if (noSuchRoute(error)) this.offUntil = this.now() + NO_ROUTE_MS
      // Said once until it changes: a server that is down is not a line a minute.
      const line = `[super-tab] Task offers: ${noSuchRoute(error) ? 'this Swarm\'s server takes no offers yet' : named(error)}`
      if (line !== this.failed) this.log(line)
      this.failed = line
    }
  }

  private async decide(agent: WatchedAgent, offer: TaskOffer, agents: WatchedAgent[]): Promise<void> {
    const key = `${agent.agentId}|${offer.repository}#${offer.number}@${offer.offeredAt}`
    if (this.answered.has(key)) return
    this.answered.add(key)
    if (this.answered.size > ANSWERS_KEPT) this.answered.delete(this.answered.values().next().value!)
    const reason = await this.reason(agent, offer, agents)
    await answerOffer(this.deps.ask, agent.tabId, agent.agentId, offer, reason)
    const task = `${offer.repository}#${offer.number}`
    this.log(`[super-tab] ${agent.names[0]} ${reason ? `declined ${task}: ${reason}` : `accepted ${task}`}`)
    if (!reason) {
      for (const told of [...this.told]) if (told.startsWith(`${agent.agentId}|`)) this.told.delete(told)
      return this.deps.accepted(agent)
    }
    const told = `${agent.agentId}|${reason}`
    if (!WHY[reason] || this.told.has(told)) return
    this.told.add(told)
    // As the agent says it, in its chat with its person (nextThing.ts idleWith).
    await this.deps.say(agent, `offer-${key}`, `I was offered ${task}, and this computer has no room for it: ${WHY[reason]}.`)
  }

  /** Why [agent] declines [offer] (noRoom), read here: the task as GitHub has it, the tasks this computer's agents build, this
   *  machine, and the agent's subscription. A task of no project of the agent's is gone. */
  private async reason(agent: WatchedAgent, offer: TaskOffer, agents: WatchedAgent[]): Promise<string | null> {
    const repo = offer.repository.toLowerCase()
    const issue = agent.repos.includes(repo) ? await this.reads.ifThere(repo, `/repos/${repo}/issues/${offer.number}`) : null
    if (!issue) return 'gone'
    const session = this.deps.session(agent.harnessId)
    const needs = labelsOf(issue).filter(label => label.startsWith('needs:')).map(label => label.slice('needs:'.length))
    return noRoom({ issue, label: agent.label, machine: await this.deps.machine(session?.cwd ?? null, needs), cores: this.deps.cores(),
      held: await this.held(agents.filter(other => other.agentId !== agent.agentId)),
      windows: session ? await this.deps.windows(session.engine) : { known: false, windows: [] } })
  }

  /** The cores the tasks [agents] build hold: each task one of them took (status:taken) with no pull request of its yet, at its
   *  size's cores. The plan holds a machine's cores only for what it plans, not for what was taken, so this is where a machine
   *  is kept within them (the allocator's design: "nothing checks cores when a task is taken"). */
  private async held(agents: WatchedAgent[]): Promise<number> {
    let cores = 0
    for (const agent of agents) {
      for (const repo of agent.repos) {
        const items = await this.reads.current(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=100`, 1)
        const pulled = new Set(items.filter(item => item.pull_request).flatMap(tasksOf))
        for (const item of items) {
          if (!item.pull_request && labelsOf(item).includes('status:taken') && !pulled.has(Number(item.number))) cores += sizeOf(labelsOf(item)).cpu
        }
      }
    }
    return cores
  }
}
