/**
 * An agent's next thing, typed as its turn ends (Swarm plan, step 1, item 1, "Nothing stops unseen": "When an agent's turn
 * ends, Harness types its next thing at once"). v4 told agents "when you wait, end your turn: Harness wakes you" and asked
 * about a quiet task only after 4 hours (githubAssign.ts QUIET_ASK_MS), so an agent with work given to it slept until then;
 * six of lampOS's agents were gone eight days. lampOS's builders took their next task in the same minute ("never end your
 * turn", 24 Oct), their own work first: findings on their own pull requests, then rebases, then the next task
 * (docs/research/2026-11-10-swarm-study/README.md).
 *
 * When a turn of one of this computer's person's agents ends, and a few seconds on nothing else has set it working (a message
 * typed the moment it ended comes first), its project's repository is read as GitHub has it now: its open tasks and pull
 * requests labelled builder:<its name>, one read, a 304 when nothing changed. Its own work comes first, as lampOS's order has it:
 * for each pull request of its that is not a draft, a reader's HOLD on its head, then its checks failed at its head, then its
 * branch behind or conflicting with its base, as the merger reads them (githubMerge.ts verdicts, checksOf, mergeable_state),
 * which the merger has said on the pull request once and GitHub news brought it, and it slept on. Then a task it took
 * (status:taken) with no pull request of its yet, which is its own work to go on with: nothing is typed. Then the oldest task
 * given to it and not taken. What it is typed ends with the command that answers it, as every ask Harness types does. The same
 * thing typed three times with no change (a push changes a pull request's head) goes to its person instead, once, and is not
 * typed a fourth time; the counts outlive a restart.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TurnEnd } from '../core/api.js'
import { named } from './agentReplies.js'
import { readerKey } from './assign/crew.js'
import { labelNames } from './githubAssign.js'
import type { WatchedAgent } from './githubMentions.js'
import { checksOf, pullPeople, pullTalk, verdicts } from './githubMerge.js'
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
  /** The asks to read found made, gone or moved on (`agent:repo#N@sha`), so they are not read again while they are owed: each
   *  goes once GitHub news no longer keeps its ask, so it holds no more than those do. */
  private readonly answered = new Set<string>()
  private readonly log: (line: string) => void

  constructor(private readonly deps: {
    /** Hear each live turn's end; returns how to stop hearing. */
    onEnd: (listener: (end: TurnEnd) => void) => () => void
    /** This computer's person's v4 agents running here, with their builder labels and their projects' repositories. */
    watched: () => Promise<WatchedAgent[]>
    /** The reads [agent] was asked for in [repo] (githubMentions.ts keeps Harness's asks), the newest last. */
    owed: (agent: WatchedAgent, repo: string) => Array<{ number: number; sha: string }>
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
    const name = agent.names[0]!
    for (const repo of agent.repos) {
      const items = await this.reads.current(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=100`, 1)
      const tasks = items.filter(it => !it.pull_request && Number.isSafeInteger(it.number))
      const pulls = items.filter(it => it.pull_request && Number.isSafeInteger(it.number)).sort((a, b) => Number(a.number) - Number(b.number))
      for (const pull of pulls) {
        const work = await this.ownWork(repo, Number(pull.number))
        if (work) return this.give(agent, `${repo}#${pull.number} ${work.kind} ${work.head}`, work.typed,
          `told ${name} that its ${repo}#${pull.number} ${work.what}`)
      }
      // A read it was asked for and has not made, before its next task as the plan's order has it (no pull request waits 30
      // minutes for a first read): typed even while it holds a task of its own, as a read is short.
      const asks = this.deps.owed(agent, repo)
      const owed = new Set(asks.map(ask => this.askKey(agent, repo, ask)))
      for (const key of this.answered) if (key.startsWith(`${agent.agentId}:${repo}#`) && !owed.has(key)) this.answered.delete(key)
      for (const ask of asks) {
        const short = await this.owedRead(agent, repo, ask)
        if (short) {
          return this.give(agent, `${repo}#${ask.number} read ${short}`, `Read ${repo}#${ask.number} at ${short}, as Harness asked you: `
            + `harness super-tab read ok ${repo}#${ask.number} ${short} 'what you found' (or read hold, with the file, line and fix)`,
          `asked ${name} to read ${repo}#${ask.number} at ${short}`)
        }
      }
      // A task it took with no pull request of its yet is its own work to go on with.
      if (tasks.filter(task => labelNames(task).includes('status:taken')).length > pulls.length) return
      const next = tasks.filter(task => !labelNames(task).includes('status:taken')).sort((a, b) => Number(a.number) - Number(b.number))[0]
      if (!next) continue
      const key = `${repo}#${next.number}`, title = String(next.title ?? '').trim()
      return this.give(agent, key, `Next: ${title ? `${key} ${title}` : key}. It is given to you and nobody has taken it: harness super-tab take ${key}`,
        `gave ${name} ${title ? `${key} (${title})` : key} as its next task`)
    }
  }

  /** What stands in the way of [number], a pull request of the agent's, that it fixes itself, the first of: a reader's HOLD on its
   *  head (one on an earlier head waits for its reader to read the push), its checks failed at its head, its branch behind or
   *  conflicting with its base. Null for a draft, which is work going on, and for one with none of them, or none known yet. */
  private async ownWork(repo: string, number: number): Promise<{ kind: string; head: string; typed: string; what: string } | null> {
    const pull = await this.reads.one(repo, `/repos/${repo}/pulls/${number}`)
    const head = String(object(pull.head).sha ?? ''), short = head.slice(0, 7), base = String(object(pull.base).ref ?? '')
    if (pull.draft === true || !head || !base) return null
    const { readers } = verdicts(await pullTalk(this.reads, repo, number), String(pull.body ?? ''), pullPeople(pull, new Set()))
    const hold = [...readers.values()].find(reader => reader.verdict === 'HOLD' && head.startsWith(reader.sha))
    if (hold) {
      return { kind: 'hold', head: short, what: `has a HOLD from ${hold.name} at ${short}`,
        typed: `Your ${repo}#${number} has a HOLD from ${hold.name} at ${short}: fix what it asks and push, and it is read again. Read it: gh pr view ${number} --repo ${repo} --comments` }
    }
    const runs = (await this.reads.one(repo, `/repos/${repo}/commits/${head}/check-runs?per_page=100`)).check_runs
    const checks = checksOf(Array.isArray(runs) ? runs.map(object) : [], await this.reads.one(repo, `/repos/${repo}/commits/${head}/status`))
    if (checks.state === 'failed') {
      return { kind: 'checks', head: short, what: `failed its checks at ${short}`,
        typed: `Your ${repo}#${number} failed its checks at ${short}: ${checks.failed.slice(0, 3).join(', ')}. Fix them and push: gh pr checks ${number} --repo ${repo}` }
    }
    const state = String(pull.mergeable_state ?? '')
    if (state === 'behind') {
      return { kind: 'behind', head: short, what: `is behind ${base}`,
        typed: `Your ${repo}#${number} is behind ${base}: merge ${base} into it and push: git fetch origin ${base} && git merge origin/${base} && git push` }
    }
    if (state === 'dirty') {
      return { kind: 'dirty', head: short, what: `conflicts with ${base}`,
        typed: `Your ${repo}#${number} conflicts with ${base}: merge ${base} into it, fix the conflicts and push: git fetch origin ${base} && git merge origin/${base}` }
    }
    return null
  }

  /** The head [ask] still waits on [agent]'s read of, short, or null when it does not: the pull request is gone, its head moved on
   *  (Harness asks again on the new one), or the agent's verdict is on its head. One found so is not read again. */
  private async owedRead(agent: WatchedAgent, repo: string, ask: { number: number; sha: string }): Promise<string | null> {
    const key = this.askKey(agent, repo, ask)
    if (this.answered.has(key)) return null
    const pull = await this.reads.one(repo, `/repos/${repo}/pulls/${ask.number}`)
    const head = String(object(pull.head).sha ?? '')
    if (pull.state === 'open' && head.startsWith(ask.sha)) {
      const { readers } = verdicts(await pullTalk(this.reads, repo, ask.number), String(pull.body ?? ''), pullPeople(pull, new Set()))
      const read = agent.names.some(name => head.startsWith(readers.get(readerKey(name))?.sha ?? '\n'))
      if (!read) return head.slice(0, 7)
    }
    this.answered.add(key)
    return null
  }

  private askKey(agent: WatchedAgent, repo: string, ask: { number: number; sha: string }): string {
    return `${agent.agentId}:${repo}#${ask.number}@${ask.sha}`
  }

  /** Types [typed] to [agent] for [key], or, once that was typed [NEXT_TIMES] times with no change, says to its person, once, what
   *  Harness [did] that many times. */
  private async give(agent: WatchedAgent, key: string, typed: string, did: string): Promise<void> {
    const memory = this.memory ??= this.load()
    let kept = memory[agent.agentId]
    if (kept?.key !== key) kept = { key, times: 0, told: false }
    delete memory[agent.agentId]
    memory[agent.agentId] = kept
    if (kept.times >= NEXT_TIMES) {
      if (kept.told) return
      const name = agent.names[0]!
      await this.deps.say(agent, this.operation(agent, key, 'told'), `Harness ${did} ${NEXT_TIMES} times as its turns ended, and nothing `
        + `changed. Harness stops: tell ${name} what to do.`)
      kept.told = true
    } else {
      await this.deps.tell(agent, this.operation(agent, key, String(kept.times)), typed)
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

