/**
 * An agent's next thing, typed as its turn ends (Swarm plan, step 1, item 1, "Nothing stops unseen": "When an agent's turn
 * ends, Harness types its next thing at once"). v4 told agents "when you wait, end your turn: Harness wakes you" and asked
 * about a quiet task only after 4 hours (githubAssign.ts QUIET_ASK_MS), so an agent with work given to it slept until then;
 * six of lampOS's agents were gone eight days. lampOS's builders took their next task in the same minute ("never end your
 * turn", 24 Oct), their own work first: findings on their own pull requests, then rebases, then the next task
 * (docs/research/2026-11-10-swarm-study/README.md).
 *
 * This part gives the next task. When a turn of one of this computer's person's agents ends, and a few seconds on nothing
 * else has set it working (a message typed the moment it ended comes first), its project's repository is read as GitHub has
 * it now: its open tasks and pull requests labelled builder:<its name>, one read, a 304 when nothing changed. A task it took
 * (status:taken) with no pull request of its yet is its own work, and nothing is typed. Otherwise the oldest task given to it
 * and not taken is typed to it, as Harness, ending with the command that takes it, as every ask Harness types does. The same
 * task typed three times with no change goes to its person instead, once, and is not typed a fourth time; the counts outlive a
 * restart.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TurnEnd } from '../core/api.js'
import { named } from './agentReplies.js'
import { labelNames } from './githubAssign.js'
import type { WatchedAgent } from './githubMentions.js'
import { GitHubReads, GitHubStop, type GitHubGet } from './githubRest.js'
import { identifier, object } from './wire.js'

/** How long after a turn ends its agent is looked at: what was queued for it is typed the moment it ends, and comes first. */
export const NEXT_SETTLE_MS = 3_000
/** How many times the same next thing is typed with no change before it goes to the agent's person instead. */
export const NEXT_TIMES = 3
/** The most agents whose counts are kept; the least recent go first. */
const MAX_KEPT = 1_000

/** What was typed to an agent: the task, how many times, and whether its person was told. */
interface Kept { key: string; times: number; told: boolean }

export class NextThing {
  private stopEnds: (() => void) | null = null
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly looking = new Set<string>()
  private readonly reads: GitHubReads
  private memory: Record<string, Kept> | null = null
  private readonly log: (line: string) => void

  constructor(private readonly deps: {
    /** Hear each live turn's end; returns how to stop hearing. */
    onEnd: (listener: (end: TurnEnd) => void) => () => void
    /** This computer's person's v4 agents running here, with their builder labels and their projects' repositories. */
    watched: () => Promise<WatchedAgent[]>
    /** Whether a terminal's turn runs; null when it cannot be said. */
    working: (harnessId: string) => Promise<boolean | null>
    get: GitHubGet
    /** Types [text] into [agent], as Harness (an agent-only message in its chat, typed as GitHub news is). */
    tell: (agent: WatchedAgent, operationId: string, text: string) => Promise<unknown>
    /** Says [text] to [agent]'s person, in its chat. */
    say: (agent: WatchedAgent, operationId: string, text: string) => Promise<unknown>
    file: string
    log?: (line: string) => void
  }) {
    this.reads = new GitHubReads(deps.get)
    this.log = deps.log ?? (line => console.warn(line))
  }

  start(): void {
    if (this.stopEnds) return
    this.stopEnds = this.deps.onEnd(end => this.ended(end))
  }

  stop(): void {
    this.stopEnds?.()
    this.stopEnds = null
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** A turn ended: its agent is looked at once the turns close together have settled. One its person stopped is left: they are
   *  at its terminal. */
  private ended(end: TurnEnd): void {
    if (end.aborted) return
    clearTimeout(this.timers.get(end.agentId))
    const timer = setTimeout(() => {
      this.timers.delete(end.agentId)
      void this.look(end.agentId)
    }, NEXT_SETTLE_MS)
    timer.unref()
    this.timers.set(end.agentId, timer)
  }

  private async look(harnessId: string): Promise<void> {
    if (this.looking.has(harnessId)) return
    this.looking.add(harnessId)
    let agent: WatchedAgent | undefined
    try {
      agent = (await this.deps.watched()).find(watched => watched.harnessId === harnessId)
      // Something set it working since its turn ended, or nobody can say: that comes first.
      if (agent && await this.deps.working(harnessId) === false) await this.next(agent)
    } catch (error) {
      this.log(`[super-tab] next thing of agent ${agent?.agentId ?? harnessId}: ${error instanceof GitHubStop ? error.code : named(error)}.`)
    } finally {
      this.looking.delete(harnessId)
    }
  }

  private async next(agent: WatchedAgent): Promise<void> {
    for (const repo of agent.repos) {
      const items = await this.reads.current(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=100`, 1)
      const tasks = items.filter(it => !it.pull_request && Number.isSafeInteger(it.number))
      const pulls = items.filter(it => it.pull_request)
      // A task it took with no pull request of its yet is its own work to go on with.
      if (tasks.filter(task => labelNames(task).includes('status:taken')).length > pulls.length) return
      const next = tasks.filter(task => !labelNames(task).includes('status:taken')).sort((a, b) => Number(a.number) - Number(b.number))[0]
      if (next) return this.give(agent, `${repo}#${next.number}`, String(next.title ?? '').trim())
    }
  }

  /** Types [key] to [agent], or says it to its person once it was typed [NEXT_TIMES] times with no change. */
  private async give(agent: WatchedAgent, key: string, title: string): Promise<void> {
    const memory = this.memory ??= this.load()
    let kept = memory[agent.agentId]
    if (kept?.key !== key) kept = { key, times: 0, told: false }
    delete memory[agent.agentId]
    memory[agent.agentId] = kept
    if (kept.times >= NEXT_TIMES) {
      if (kept.told) return
      const name = agent.names[0]!
      await this.deps.say(agent, this.operation(agent, key, 'told'), `Harness gave ${name} ${title ? `${key} (${title})` : key} as its next task ${NEXT_TIMES} `
        + `times as its turns ended, and it has not taken it. Harness stops giving it: tell ${name} what to do.`)
      kept.told = true
    } else {
      await this.deps.tell(agent, this.operation(agent, key, String(kept.times)),
        `Next: ${title ? `${key} ${title}` : key}. It is given to you and nobody has taken it: harness super-tab take ${key}`)
      kept.times++
    }
    this.save(memory)
  }

  /** The same each time this agent is given this task this many times, so a post that failed is not made twice when tried again. */
  private operation(agent: WatchedAgent, key: string, nth: string): string {
    return `next-${createHash('sha256').update(`${agent.agentId}\n${key}\n${nth}`).digest('hex').slice(0, 40)}`
  }

  private load(): Record<string, Kept> {
    const kept: Record<string, Kept> = {}
    try {
      for (const [id, value] of Object.entries(object(JSON.parse(readFileSync(this.deps.file, 'utf8'))))) {
        const row = object(value)
        if (identifier(id) && typeof row.key === 'string' && Number.isSafeInteger(row.times) && typeof row.told === 'boolean') {
          kept[id] = { key: row.key, times: row.times as number, told: row.told }
        }
      }
    } catch { /* none kept yet, or unreadable: counted from now */ }
    return kept
  }

  private save(memory: Record<string, Kept>): void {
    for (const id of Object.keys(memory).slice(0, Math.max(0, Object.keys(memory).length - MAX_KEPT))) delete memory[id]
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const temporary = `${this.deps.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(memory), { mode: 0o600 })
      renameSync(temporary, this.deps.file)
    } catch (error) { this.log(`[super-tab] could not save the next things: ${String(error)}`) }
  }
}

