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
 * given to it and not taken, with the branches to build it on when it comes after tasks whose pull requests of its are up
 * (the allocator's design, package 3). What it is typed ends with the command that answers it, as every ask Harness types
 * does. The same thing typed three times with no change (a push changes a pull request's head) goes to its person instead,
 * once, and is not typed a fourth time; the counts outlive a restart, and so does the watch on a task it sits idle holding.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TurnEnd } from '../core/api.js'
import { named } from './agentReplies.js'
import { builtOn, dependsOn, openPieces, readerKey, tasksOf } from './assign/crew.js'
import { backLine, giveBack, labelNames } from './githubAssign.js'
import type { WatchedAgent } from './githubMentions.js'
import { FailingHeads, headChecks, isHeld, pullPeople, pullTalk, verdicts } from './githubMerge.js'
import { GitHubReads, GitHubStop, type GitHubGet, type GitHubSend } from './githubRest.js'
import { hhmm } from './githubVerdict.js'
import { identifier, object, SuperTabHostError } from './wire.js'

/** How long after a turn ends its agent is looked at: what was queued for it is typed the moment it ends, and comes first. */
export const NEXT_SETTLE_MS = 3_000
/** How long after a turn's end what it was told is read again before its person is told nothing changed: GitHub shows a push
 *  some seconds after it. */
export const TELL_SETTLE_MS = 60_000
/** How many times the same next thing is typed with no change before it goes to the agent's person instead: once. An agent that
 *  heard it and ended its turn with nothing changed is blocked or has chosen, and typing it again each turn spent its turns and
 *  tokens on the same line (Finn, 2026-11-11: "fix and push" on a pull request it could not fix, every minute; anh Dee: "why are
 *  we spamming agents?"). */
export const NEXT_TIMES = 1
/** How long an agent may sit idle holding a task it took, with no pull request yet, before it is asked once; and before its person
 *  is told and the task goes back for another builder (Swarm plan, step 1, item 1: "An agent with work that is idle 20 minutes is
 *  asked once; at an hour its person is told and its work is free to take"). The assigner's own watch, by GitHub's quiet alone,
 *  asks at 4 hours and moves at 8 (githubAssign.ts): it cannot see a session, and one that works for hours pushes nothing. */
export const IDLE_ASK_MS = 20 * 60_000
export const IDLE_BACK_MS = 60 * 60_000
/** How long after it starts each of its agents is looked at as though its turn had just ended (Swarm plan, step 1, item 2: "Harness
 *  types it once after a restart"): a turn that ended while the daemon was down, for an update or a restart, was never heard, and
 *  its agent slept with its next thing until something else woke it. Time for the core to attach its agents and say which are idle. */
export const START_LOOK_MS = 30_000
/** The most agents whose counts are kept; the least recent go first. */
const MAX_KEPT = 1_000
/** The most lines `harness super-tab inbox` lists: lampOS's builders had a few things each at most, and each line may cost a few
 *  reads of GitHub, which the command waits on. */
export const INBOX_MAX = 10

/** A thing that waits for an agent, in the order Harness types them: what it is typed, by a key that changes when the thing does,
 *  and what Harness did, for its person; or a task it holds with no pull request yet, which it goes on with. */
type Waiting = { key: string; typed: string; did: string } | { held: Record<string, unknown>; repo: string }

/** The task an agent's open labelled tasks and pull requests ([items]) show it holding with no pull request of its yet, the oldest
 *  such: one it took that no pull request of its closes, past as many as its pull requests that name no task may be for. With two
 *  taken and one pull request, the oldest was watched as idle while its pull request was open (review of #4003). Not a task that
 *  waits on pieces cut off it (githubSplit.ts): its builder is asked nothing about it, and is typed its next task meanwhile. */
function heldTask(items: Record<string, unknown>[]): Record<string, unknown> | null {
  const named = items.filter(it => it.pull_request).map(tasksOf), closed = new Set(named.flat())
  const open = items.filter(it => !it.pull_request && labelNames(it).includes('status:taken') && !closed.has(Number(it.number)) && !openPieces(it))
    .sort((a, b) => Number(a.number) - Number(b.number))
  return open.length > named.filter(tasks => !tasks.length).length ? open[0]! : null
}

/** The watch a row of the file keeps, or none for a value no watch here could have saved. A start ahead of [now], or a give-back
 *  further off than an hour (a clock set back, or a bad file), held an ask or a give-back off by that much, or past a timer's reach,
 *  which fires at once (review of #4129). */
function keptIdle(value: unknown, now: number): Idle | undefined {
  const { terminal, task, since, back } = object(value)
  const time = (at: unknown, from: number, to: number): at is number => Number.isSafeInteger(at) && (at as number) >= from && (at as number) <= to
  if (typeof terminal !== 'string' || typeof task !== 'string' || !time(since, 0, now)) return undefined
  if (back === undefined) return { terminal, task, since }
  return time(back, since, now + IDLE_BACK_MS) ? { terminal, task, since, back } : undefined
}

/** A task by its key and its title, as an agent and its person are told of it: `acme/app#14 (Add the export)`. */
function titled(repo: string, task: Record<string, unknown>): string {
  const title = String(task.title ?? '').trim()
  return title ? `${repo}#${task.number} (${title})` : `${repo}#${task.number}`
}

/** What an agent was typed last ([key], how many times, whether its person was told), and the things its person was told of
 *  ([done], the last [DONE_KEPT]): each waits for them, and what comes after it is typed. And the task it sits idle holding
 *  ([idle]), so a restart (every release) does not ask it again (#4125). A row kept for that alone has typed nothing yet: its key
 *  is empty. */
interface Kept { key: string; times: number; told: boolean; done?: string[]; idle?: Idle }
/** A watch on an agent idle with a task it took: in which terminal, which task (`acme/app#14`), since when, and once it was asked,
 *  when the task goes back ([back]). */
interface Idle { terminal: string; task: string; since: number; back?: number }
const DONE_KEPT = 20

export class NextThing {
  private stopEnds: (() => void) | null = null
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** The look at every agent as it starts, and the terminals whose turns ended before it, which their own looks look at. */
  private startLook: NodeJS.Timeout | null = null
  private heard: Set<string> | null = null
  /** The terminals whose context was compacted, by the turn that said so, until a look finds them idle and types them what waits. */
  private readonly compacted = new Map<string, string>()
  /** Each terminal idle with a task of its own in hand, by its id: the next look at it, and what it holds. */
  private readonly idle = new Map<string, { timer: NodeJS.Timeout; agent: WatchedAgent; repo: string; task: Record<string, unknown> }>()
  private readonly looking = new Set<string>()
  /** When each terminal's last turn ended, by its id: what it is told it did not do is read a while after (give). */
  private readonly endedAt = new Map<string, number>()
  private readonly reads: GitHubReads
  private readonly failing: FailingHeads
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
    /** Writes to GitHub with this person's gh: a task given back. */
    send: GitHubSend
    /** Types [text] into [agent], as Harness (an agent-only message in its chat, typed as GitHub news is). */
    tell: (agent: WatchedAgent, operationId: string, text: string) => Promise<unknown>
    /** Says [text] to [agent]'s person, in its chat. */
    say: (agent: WatchedAgent, operationId: string, text: string) => Promise<unknown>
    /** The builder labels of [agent]'s team: a verdict signed from the login that opened its pull request, which every agent of
     *  that person posts as, names its reader only when it names one of them (githubMerge.ts verdicts). */
    team: (agent: WatchedAgent) => Promise<ReadonlySet<string>>
    /** [comments] with the agent the backend recorded as each verdict's writer (githubMerge.ts VerdictRecords.named), asked as
     *  [agent]; null while the records cannot be read. Only a READ-OK made by command is a read. */
    named: (agent: WatchedAgent, repo: string, comments: Record<string, unknown>[]) => Promise<Record<string, unknown>[] | null>
    file: string
    log?: (line: string) => void
  }) {
    this.reads = new GitHubReads(deps.get)
    this.failing = new FailingHeads(this.reads, Date.now, line => this.log(line))
    this.log = deps.log ?? (line => console.warn(line))
  }

  start(): void {
    if (this.stopEnds) return
    this.stopEnds = this.deps.onEnd(end => this.ended(end))
    const heard = this.heard = new Set()
    this.startLook = setTimeout(() => {
      this.startLook = this.heard = null
      void this.lookAll(heard)
    }, START_LOOK_MS)
    this.startLook.unref()
  }

  stop(): void {
    this.stopEnds?.()
    this.stopEnds = null
    if (this.startLook) clearTimeout(this.startLook)
    this.startLook = this.heard = null
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const watched of this.idle.values()) clearTimeout(watched.timer)
    this.idle.clear()
    this.endedAt.clear()
  }

  /** A turn ended: its agent is looked at once the turns close together have settled. One its person stopped is left: they are
   *  at its terminal. */
  private ended(end: TurnEnd): void {
    this.heard?.add(end.agentId)
    if (end.compacted) this.compacted.set(end.agentId, `${end.sessionId}:${end.turnId}`)
    // A turn of its, its person's or its own, is no idle time, and what its file keeps of the watch goes with it. One its person
    // stopped starts its idle time over, as the look its other turns get is not made: they are at its terminal.
    const watched = this.idle.get(end.agentId)
    this.unwatch(end.agentId)
    this.forgetIdle(end.agentId)
    if (end.aborted) {
      if (watched) this.watch(watched.agent, watched.repo, watched.task, Date.now())
      return
    }
    this.endedAt.set(end.agentId, Date.now())
    this.lookIn(end.agentId, NEXT_SETTLE_MS)
  }

  /** Looks at terminal [harnessId] in [ms]; a later call moves the look. */
  private lookIn(harnessId: string, ms: number): void {
    clearTimeout(this.timers.get(harnessId))
    const timer = setTimeout(() => {
      this.timers.delete(harnessId)
      void this.look(harnessId)
    }, ms)
    timer.unref()
    this.timers.set(harnessId, timer)
  }

  /** Each of its agents once, as it starts, but those a turn's end since has looked at. */
  private async lookAll(heard: ReadonlySet<string>): Promise<void> {
    try {
      for (const agent of await this.deps.watched()) if (!heard.has(agent.harnessId)) await this.look(agent.harnessId)
    } catch (error) {
      this.log(`[super-tab] next things as Harness started: ${named(error)}.`)
    }
  }

  private async look(harnessId: string): Promise<void> {
    if (this.looking.has(harnessId)) return
    this.looking.add(harnessId)
    let agent: WatchedAgent | undefined
    try {
      agent = (await this.deps.watched()).find(watched => watched.harnessId === harnessId)
      // A paused agent is typed nothing until it is resumed (backend agent.pause); its next turn's end after looks again. Its time
      // paused is no idle time: a watch kept from before is not gone on with by a restart after it is resumed (review of #4129).
      if (!agent || agent.paused) {
        this.compacted.delete(harnessId)
        this.endedAt.delete(harnessId)
        if (agent) this.keepIdle(agent, null)
      }
      // Something set it working since its turn ended, or nobody can say: that comes first.
      else if (await this.deps.working(harnessId) === false) {
        const compacted = this.compacted.get(harnessId)
        this.compacted.delete(harnessId)
        await (compacted ? this.typeAll(agent, compacted) : this.next(agent))
      }
    } catch (error) {
      this.log(`[super-tab] next thing of agent ${agent?.agentId ?? harnessId}: ${error instanceof GitHubStop ? error.code : named(error)}.`)
    } finally {
      this.looking.delete(harnessId)
    }
  }

  /** Everything that waits for the agent in terminal [harnessId], a line each, in the order its turns' ends type them, read as GitHub
   *  has it now (`harness super-tab inbox`; Swarm plan, step 1, item 2: "One command lists what waits for an agent"): at most
   *  [INBOX_MAX]. None for a terminal that is not one of this computer's person's agents in a project. Nothing is typed or counted. */
  async inbox(harnessId: string): Promise<string[]> {
    const agent = (await this.deps.watched()).find(watched => watched.harnessId === harnessId)
    return agent ? this.listed(agent) : []
  }

  /** Types [agent] all that waits for it, once its context was compacted in [turn]: what it was told before is a summary now (Swarm
   *  plan, step 1, item 2: "Harness types it once after a compaction"). Nothing when nothing waits; its next end types its next thing. */
  private async typeAll(agent: WatchedAgent, turn: string): Promise<void> {
    const lines = await this.listed(agent)
    if (!lines.length) return
    await this.deps.tell(agent, this.operation(agent, 'compacted', turn), 'Your context was compacted. What waits for you, as Harness reads '
      + `it now (harness super-tab inbox lists it again):\n${lines.map(line => `- ${line}`).join('\n')}`)
  }

  /** What waits for [agent], a line each, at most [INBOX_MAX]. */
  private async listed(agent: WatchedAgent): Promise<string[]> {
    const lines: string[] = []
    for await (const thing of this.waiting(agent)) {
      lines.push('held' in thing ? `You hold ${titled(thing.repo, thing.held)}: go on with it: gh issue view ${thing.held.number} --repo ${thing.repo}` : thing.typed)
      if (lines.length >= INBOX_MAX) break
    }
    return lines
  }

  /** Its next thing: the first that waits, typed; or the task it holds, watched while it sits idle with it. */
  private async next(agent: WatchedAgent): Promise<void> {
    for await (const thing of this.waiting(agent)) {
      if ('held' in thing) {
        // The watch its file keeps of this task in this terminal goes on: no turn of its ended since, or that end dropped it. Started
        // over, a restart (every release) asked it again 20 minutes on, under a new operation (#4125).
        const idle = (this.memory ??= this.load())[agent.agentId]?.idle
        const kept = idle?.terminal === agent.harnessId && idle.task === `${thing.repo}#${thing.held.number}` ? idle : undefined
        // Asked, it is not asked again, but its task goes back only after an hour idle seen from now. Only the look as Harness starts
        // finds a watch asked (a turn's end drops it first), and a turn that ended while nothing heard it was never heard: a builder
        // that worked on it then lost it "with nothing done on it for an hour", said on GitHub and to its person (review of #4129).
        const back = kept?.back === undefined ? undefined : Date.now() + IDLE_BACK_MS
        return this.watch(agent, thing.repo, thing.held, kept?.since ?? Date.now(), back)
      }
      // One its person has waits for them: the next is typed, or the task it holds watched.
      if (await this.give(agent, thing.key, thing.typed, thing.did)) return this.keepIdle(agent, null)
    }
    // It holds no task now: a watch kept would go on, at its old start, once it held this one again (review of #4129).
    this.keepIdle(agent, null)
  }

  /** What waits for [agent], in lampOS's order, read a thing at a time, so its next thing reads no further than itself. */
  private async *waiting(agent: WatchedAgent): AsyncGenerator<Waiting> {
    for (const repo of agent.repos) {
      const items = await this.reads.current(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=100`, 1)
      const tasks = items.filter(it => !it.pull_request && Number.isSafeInteger(it.number))
      const pulls = items.filter(it => it.pull_request && Number.isSafeInteger(it.number)).sort((a, b) => Number(a.number) - Number(b.number))
      // Each as GitHub details it, read once for its own work and kept for the branch its next task may be built on.
      const details: Record<string, unknown>[] = []
      for (const pull of pulls) {
        details.push(await this.reads.one(repo, `/repos/${repo}/pulls/${pull.number}`))
        const work = await this.ownWork(agent, repo, Number(pull.number), details.at(-1)!)
        if (work) yield { key: `${repo}#${pull.number} ${work.kind} ${work.head}`, typed: work.typed, did: `told me that my pull request ${repo}#${pull.number} ${work.what}` }
      }
      // A read it was asked for and has not made, before its next task as the plan's order has it (no pull request waits 30
      // minutes for a first read): typed even while it holds a task of its own, as a read is short.
      const asks = this.deps.owed(agent, repo)
      const owed = new Set(asks.map(ask => this.askKey(agent, repo, ask)))
      for (const key of this.answered) if (key.startsWith(`${agent.agentId}:${repo}#`) && !owed.has(key)) this.answered.delete(key)
      for (const ask of asks) {
        const short = await this.owedRead(agent, repo, ask)
        if (short) {
          yield { key: `${repo}#${ask.number} read ${short}`, typed: `Read ${repo}#${ask.number} at ${short}, as Harness asked you: `
            + `harness super-tab read ok ${repo}#${ask.number} ${short} 'what you found' (or read hold, with the file, line and fix)`,
          did: `asked me to read ${repo}#${ask.number} at ${short}` }
        }
      }
      // A task it took with no pull request of its yet is its own work to go on with, before another: one task at a time.
      const held = heldTask(items)
      if (held) {
        yield { held, repo }
        continue
      }
      const next = tasks.filter(task => !labelNames(task).includes('status:taken')).sort((a, b) => Number(a.number) - Number(b.number))[0]
      if (!next) continue
      const key = `${repo}#${next.number}`, title = String(next.title ?? '').trim()
      // What it comes after, with its own pull requests up for those: the code it is built on (assign/crew.ts readProblem).
      const after = dependsOn(next.body)
      const bases = details.filter(pull => pull.draft !== true && tasksOf(pull).some(task => after.includes(task)))
        .map(pull => ({ pull: Number(pull.number), branch: String(object(pull.head).ref ?? '') }))
      yield { key, typed: `Next: ${title ? `${key} ${title}` : key}. It is given to you and nobody has taken it${bases.length ? `. ${builtOn(bases)}` : ''}: harness super-tab take ${key}`,
        did: `gave me ${titled(repo, next)} as my next task` }
    }
  }

  /** What stands in the way of [number], a pull request of the agent's as GitHub details it ([pull]), that it fixes itself, the
   *  first of: a reader's HOLD on its head (one on an earlier head waits for its reader to read the push), its checks failed at its
   *  head, its branch behind or conflicting with its base. Null for a draft, which is work going on, and for one with none of
   *  them, or none known yet. */
  private async ownWork(agent: WatchedAgent, repo: string, number: number, pull: Record<string, unknown>): Promise<{ kind: string; head: string; typed: string; what: string } | null> {
    const head = String(object(pull.head).sha ?? ''), short = head.slice(0, 7), base = String(object(pull.base).ref ?? '')
    // One on hold waits for a person: nothing of it is the agent's to fix now.
    if (pull.draft === true || isHeld(pull) || !head || !base) return null
    // A HOLD stands made by command or typed, so one whose records cannot be read is still said, its reader as the comment shows it.
    const talk = await pullTalk(this.reads, repo, number)
    const { readers } = verdicts(await this.deps.named(agent, repo, talk) ?? talk, String(pull.body ?? ''), pullPeople(pull, await this.deps.team(agent)))
    const hold = [...readers.values()].find(reader => reader.verdict === 'HOLD' && head.startsWith(reader.sha))
    if (hold) {
      return { kind: 'hold', head: short, what: `has a HOLD from ${hold.name} at ${short}`,
        typed: `Your ${repo}#${number} has a HOLD from ${hold.name} at ${short}: fix what it asks and push, and it is read again. Read it: gh pr view ${number} --repo ${repo} --comments` }
    }
    const checks = await headChecks(this.reads, repo, head)
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

  /** Looks again at [agent], idle since [since] with [task] of its own in hand: at [IDLE_ASK_MS] it is asked once, and once asked,
   *  at [back] its person is told and the task goes back for another builder. Any turn of its ends this. Kept in its file, for the
   *  look as Harness starts again to go on with. */
  private watch(agent: WatchedAgent, repo: string, task: Record<string, unknown>, since: number, back?: number): void {
    this.unwatch(agent.harnessId)
    // A time gone by while Harness was down comes at once, at 0: Node 24 warns of a negative delay (TimeoutNegativeWarning).
    const timer = setTimeout(() => {
      this.idle.delete(agent.harnessId)
      void this.idleWith(agent, repo, Number(task.number), String(task.title ?? '').trim(), since, back)
    }, Math.max(0, (back ?? since + IDLE_ASK_MS) - Date.now()))
    timer.unref()
    this.idle.set(agent.harnessId, { timer, agent, repo, task })
    this.keepIdle(agent, { terminal: agent.harnessId, task: `${repo}#${task.number}`, since, ...back === undefined ? {} : { back } })
  }

  private unwatch(harnessId: string): void {
    clearTimeout(this.idle.get(harnessId)?.timer)
    this.idle.delete(harnessId)
  }

  /** Keeps [idle] in [agent]'s row of its file as the watch on it, or drops the watch (null), and a row kept for it alone. */
  private keepIdle(agent: WatchedAgent, idle: Idle | null): void {
    const memory = this.memory ??= this.load()
    const row = memory[agent.agentId]
    if (!idle && !row?.idle) return
    const kept: Kept = { ...row ?? { key: '', times: 0, told: false } }
    delete kept.idle
    delete memory[agent.agentId]
    if (idle) memory[agent.agentId] = { ...kept, idle }
    else if (kept.key) memory[agent.agentId] = kept
    this.save(memory)
  }

  /** Drops what its file keeps of a watch on terminal [harnessId], and a row kept for it alone: a turn of its ended. */
  private forgetIdle(harnessId: string): void {
    const memory = this.memory ??= this.load()
    const ids = Object.keys(memory).filter(id => memory[id]!.idle?.terminal === harnessId)
    for (const id of ids) {
      delete memory[id]!.idle
      if (!memory[id]!.key) delete memory[id]
    }
    if (ids.length) this.save(memory)
  }

  private async idleWith(agent: WatchedAgent, repo: string, number: number, title: string, since: number, back?: number): Promise<void> {
    const key = `${repo}#${number}`, what = titled(repo, { number, title }), name = agent.names[0]!
    // Whether this watch is the one its file keeps: a turn of its that ends while this awaits drops it, and its end's look starts the
    // next. Asked or re-armed after, it went on with the old start: the task went back 40 minutes on (review of #4129).
    const ours = () => this.memory![agent.agentId]?.idle?.since === since
    try {
      // Working, or nobody can say: its turn's end looks again.
      if (await this.deps.working(agent.harnessId) !== false) return
      // Paused since it was watched: nothing is asked of it, and its task goes to others as the assigner's take-back says (crew.ts).
      // Its time paused is no idle time, so the watch kept goes too.
      if ((await this.deps.watched()).find(watched => watched.harnessId === agent.harnessId)?.paused) return this.keepIdle(agent, null)
      // Still its own, taken, with no pull request of its yet.
      const items = await this.reads.current(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=100`, 1)
      if (Number(heldTask(items)?.number) !== number) return this.keepIdle(agent, null)
      if (!ours()) return
      if (back === undefined) {
        // Under the operation of the watch's start: one asked again after a restart that came before this was kept reaches it once,
        // and one the server has in a release's other words was asked.
        await this.once('tell', agent, this.operation(agent, key, `idle ${since}`), `You hold ${what} and have done nothing on it for 20 minutes: `
          + `go on with it, or say on it what holds it: gh issue view ${number} --repo ${repo}`)
        if (ours()) this.watch(agent, repo, { number, title }, since, Date.now() + IDLE_BACK_MS - IDLE_ASK_MS)
        return
      }
      const given = await giveBack(this.deps.send, repo, number, agent.label, true)
      if ('refused' in given) return this.log(`[super-tab] next thing of agent ${agent.agentId}: ${key} not given back: GitHub answered ${given.refused}.`)
      this.keepIdle(agent, null)
      if (given.takenKept !== null) this.log(`[super-tab] next thing of agent ${agent.agentId}: ${key} kept status:taken: GitHub answered ${given.takenKept}.`)
      const said = await this.deps.send('POST', `/repos/${repo}/issues/${number}/comments`, { body: backLine(`${name} held it with nothing done for an hour`, hhmm(Date.now())) })
      // Given back all the same: the labels say so. Its line held or refused is said here (githubWrites.ts holds a line said too often).
      if (said.status >= 300) this.log(`[super-tab] next thing of agent ${agent.agentId}: ${key}'s line not written: GitHub answered ${said.status}.`)
      // Posted as the agent, in its chat with its person, so said as it says it: "Pip held …" under Pip's own name read as no
      // person writes (anh Dee, 2026-11-11: "we want agents to talk like human").
      await this.deps.say(agent, this.operation(agent, key, `back ${since}`), `I held ${what} with nothing done on it for an hour, so Harness `
        + 'gave it back for the builder who can start it next.')
    } catch (error) {
      this.log(`[super-tab] next thing of agent ${agent.agentId}: ${error instanceof GitHubStop ? error.code : named(error)}.`)
    }
  }

  /** The head [ask] still waits on [agent]'s read of, short, or null when it does not: the pull request is gone, its head moved on
   *  (Harness asks again on the new one), or the agent's verdict is on its head. One found so is not read again. */
  private async owedRead(agent: WatchedAgent, repo: string, ask: { number: number; sha: string }): Promise<string | null> {
    const key = this.askKey(agent, repo, ask)
    if (this.answered.has(key)) return null
    const pull = await this.reads.one(repo, `/repos/${repo}/pulls/${ask.number}`)
    const head = String(object(pull.head).sha ?? '')
    if (pull.state === 'open' && head.startsWith(ask.sha)) {
      // On hold, it waits for a person, and so does its read (Harness asks no reader for it either, githubAssign.ts).
      if (isHeld(pull)) return null
      // Whether it read is not known while the records cannot be read: it is not asked now, nor taken as answered.
      const talk = await this.deps.named(agent, repo, await pullTalk(this.reads, repo, ask.number))
      if (!talk) return null
      const { readers } = verdicts(talk, String(pull.body ?? ''), pullPeople(pull, await this.deps.team(agent)))
      const read = agent.names.some(name => head.startsWith(readers.get(readerKey(name))?.sha ?? '\n'))
      // Failing its checks, it waits for its builder's fix, a new head, read again.
      if (!read) return await this.failing.failing(repo, head) ? null : head.slice(0, 7)
    }
    this.answered.add(key)
    return null
  }

  /** Posts [text] in [agent]'s chat with its person (say), or types it into [agent] (tell). One the server already has under this
   *  id, in a release's other words with its answer lost, is posted (OPERATION_REUSED): refused, it held the agent's next thing back
   *  at every turn (review of #4102), and an ask asked again after a restart kept its task from going back (review of #4129). */
  private async once(post: 'say' | 'tell', agent: WatchedAgent, operationId: string, text: string): Promise<void> {
    try {
      await this.deps[post](agent, operationId, text)
    } catch (error) {
      if (!(error instanceof SuperTabHostError && error.code === 'OPERATION_REUSED')) throw error
    }
  }

  private askKey(agent: WatchedAgent, repo: string, ask: { number: number; sha: string }): string {
    return `${agent.agentId}:${repo}#${ask.number}@${ask.sha}`
  }

  /** Types [typed] to [agent] for [key], or, once that was typed [NEXT_TIMES] times with no change, says to its person, once, what
   *  Harness [did] that many times. True while the agent has it to act on (typed, or read again soon); false once its person has it. */
  private async give(agent: WatchedAgent, key: string, typed: string, did: string): Promise<boolean> {
    const memory = this.memory ??= this.load()
    let kept = memory[agent.agentId]
    const done = kept?.done ?? []
    // Its person has it: what comes after it is typed (code review of #4060: a pull request of its own it could not fix kept every
    // read it owed others from it).
    if (done.includes(key)) return false
    if (kept?.key !== key) kept = { key, times: 0, told: false, ...done.length ? { done } : {} }
    delete memory[agent.agentId]
    memory[agent.agentId] = kept
    if (kept.times >= NEXT_TIMES) {
      // Told only after a turn of its ended here: one typed before this daemon started (under an older build, typed three times
      // over) has had no turn since to say nothing changed. And GitHub shows a push some seconds after it, so a turn that pushed as
      // it ended can read as nothing changed: what is still the same a while after its turn ended is told (code review of #4060).
      const ended = this.endedAt.get(agent.harnessId)
      if (ended === undefined) return true
      const wait = ended + TELL_SETTLE_MS - Date.now()
      if (wait > 0) { this.lookIn(agent.harnessId, wait); return true }
      // As the agent says it, in its chat with its person, as the give-back line in idleWith is. Said, not asked: the agent never
      // hears what is posted in its name and is typed its next thing at once, so an answer would reach it bare, about something
      // else (review of #4102; pmNumbers.ts toldLine).
      await this.once('say', agent, this.operation(agent, key, 'told'), `When my turn ended, Harness ${did}, and my next turn changed nothing.`)
      kept.told = true
      kept.done = [...done, key].slice(-DONE_KEPT)
      this.save(memory)
      return false
    } else {
      await this.deps.tell(agent, this.operation(agent, key, String(kept.times)), typed)
      kept.times++
    }
    this.save(memory)
    return true
  }

  /** The same each time this agent is given this task this many times, so a post that failed is not made twice when tried again. */
  private operation(agent: WatchedAgent, key: string, nth: string): string {
    return `next-${createHash('sha256').update(`${agent.agentId}\n${key}\n${nth}`).digest('hex').slice(0, 40)}`
  }

  private load(): Record<string, Kept> {
    const kept: Record<string, Kept> = {}, now = Date.now()
    try {
      for (const [id, value] of Object.entries(object(JSON.parse(readFileSync(this.deps.file, 'utf8'))))) {
        const row = object(value)
        if (identifier(id) && typeof row.key === 'string' && Number.isSafeInteger(row.times) && typeof row.told === 'boolean') {
          // What its person was told of is read back, and the thing a row says it told: a row saved before the list was read back
          // (v0.6.33, v0.6.34) or kept (older builds) says that one only so. Left out, a restart (every release) gave each again
          // under the id it was first given with, which the server answers as given: nothing reached the agent, and it slept.
          const listed = Array.isArray(row.done) ? row.done.filter((key): key is string => typeof key === 'string') : []
          const done = (row.told && !listed.includes(row.key) ? [...listed, row.key] : listed).slice(-DONE_KEPT)
          const idle = keptIdle(row.idle, now)
          kept[id] = { key: row.key, times: row.times as number, told: row.told, ...done.length ? { done } : {}, ...idle ? { idle } : {} }
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

