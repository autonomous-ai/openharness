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
import { openPieces, readerKey, tasksOf } from './assign/crew.js'
import { backLine, giveBack, labelNames } from './githubAssign.js'
import type { WatchedAgent } from './githubMentions.js'
import { checksOf, pullPeople, pullTalk, verdicts } from './githubMerge.js'
import { GitHubReads, GitHubStop, type GitHubGet, type GitHubSend } from './githubRest.js'
import { hhmm } from './githubVerdict.js'
import { identifier, object } from './wire.js'

/** How long after a turn ends its agent is looked at: what was queued for it is typed the moment it ends, and comes first. */
export const NEXT_SETTLE_MS = 3_000
/** How many times the same next thing is typed with no change before it goes to the agent's person instead. */
export const NEXT_TIMES = 3
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

/** A task by its key and its title, as an agent and its person are told of it: `acme/app#14 (Add the export)`. */
function titled(repo: string, task: Record<string, unknown>): string {
  const title = String(task.title ?? '').trim()
  return title ? `${repo}#${task.number} (${title})` : `${repo}#${task.number}`
}

/** What was typed to an agent: the task, how many times, and whether its person was told. */
interface Kept { key: string; times: number; told: boolean }

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
  }

  /** A turn ended: its agent is looked at once the turns close together have settled. One its person stopped is left: they are
   *  at its terminal. */
  private ended(end: TurnEnd): void {
    this.heard?.add(end.agentId)
    if (end.compacted) this.compacted.set(end.agentId, `${end.sessionId}:${end.turnId}`)
    // A turn of its, its person's or its own, is no idle time. One its person stopped starts its idle time over, as the look its
    // other turns get is not made: they are at its terminal.
    const watched = this.idle.get(end.agentId)
    this.unwatch(end.agentId)
    if (end.aborted) {
      if (watched) this.watch(watched.agent, watched.repo, watched.task, Date.now(), false)
      return
    }
    clearTimeout(this.timers.get(end.agentId))
    const timer = setTimeout(() => {
      this.timers.delete(end.agentId)
      void this.look(end.agentId)
    }, NEXT_SETTLE_MS)
    timer.unref()
    this.timers.set(end.agentId, timer)
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
      if (!agent) this.compacted.delete(harnessId)
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
      if ('held' in thing) return this.watch(agent, thing.repo, thing.held, Date.now(), false)
      return this.give(agent, thing.key, thing.typed, thing.did)
    }
  }

  /** What waits for [agent], in lampOS's order, read a thing at a time, so its next thing reads no further than itself. */
  private async *waiting(agent: WatchedAgent): AsyncGenerator<Waiting> {
    const name = agent.names[0]!
    for (const repo of agent.repos) {
      const items = await this.reads.current(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=100`, 1)
      const tasks = items.filter(it => !it.pull_request && Number.isSafeInteger(it.number))
      const pulls = items.filter(it => it.pull_request && Number.isSafeInteger(it.number)).sort((a, b) => Number(a.number) - Number(b.number))
      for (const pull of pulls) {
        const work = await this.ownWork(agent, repo, Number(pull.number))
        if (work) yield { key: `${repo}#${pull.number} ${work.kind} ${work.head}`, typed: work.typed, did: `told ${name} that its ${repo}#${pull.number} ${work.what}` }
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
          did: `asked ${name} to read ${repo}#${ask.number} at ${short}` }
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
      yield { key, typed: `Next: ${title ? `${key} ${title}` : key}. It is given to you and nobody has taken it: harness super-tab take ${key}`,
        did: `gave ${name} ${titled(repo, next)} as its next task` }
    }
  }

  /** What stands in the way of [number], a pull request of the agent's, that it fixes itself, the first of: a reader's HOLD on its
   *  head (one on an earlier head waits for its reader to read the push), its checks failed at its head, its branch behind or
   *  conflicting with its base. Null for a draft, which is work going on, and for one with none of them, or none known yet. */
  private async ownWork(agent: WatchedAgent, repo: string, number: number): Promise<{ kind: string; head: string; typed: string; what: string } | null> {
    const pull = await this.reads.one(repo, `/repos/${repo}/pulls/${number}`)
    const head = String(object(pull.head).sha ?? ''), short = head.slice(0, 7), base = String(object(pull.base).ref ?? '')
    if (pull.draft === true || !head || !base) return null
    // A HOLD stands made by command or typed, so one whose records cannot be read is still said, its reader as the comment shows it.
    const talk = await pullTalk(this.reads, repo, number)
    const { readers } = verdicts(await this.deps.named(agent, repo, talk) ?? talk, String(pull.body ?? ''), pullPeople(pull, await this.deps.team(agent)))
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

  /** Looks again at [agent], idle since [since] with [task] of its own in hand: at [IDLE_ASK_MS] it is asked once, and at
   *  [IDLE_BACK_MS] (once [asked]) its person is told and the task goes back for another builder. Any turn of its ends this. */
  private watch(agent: WatchedAgent, repo: string, task: Record<string, unknown>, since: number, asked: boolean): void {
    this.unwatch(agent.harnessId)
    const timer = setTimeout(() => {
      this.idle.delete(agent.harnessId)
      void this.idleWith(agent, repo, Number(task.number), String(task.title ?? '').trim(), since, asked)
    }, asked ? IDLE_BACK_MS - IDLE_ASK_MS : IDLE_ASK_MS)
    timer.unref()
    this.idle.set(agent.harnessId, { timer, agent, repo, task })
  }

  private unwatch(harnessId: string): void {
    clearTimeout(this.idle.get(harnessId)?.timer)
    this.idle.delete(harnessId)
  }

  private async idleWith(agent: WatchedAgent, repo: string, number: number, title: string, since: number, asked: boolean): Promise<void> {
    const key = `${repo}#${number}`, what = titled(repo, { number, title }), name = agent.names[0]!
    try {
      // Working, or nobody can say: its turn's end looks again.
      if (await this.deps.working(agent.harnessId) !== false) return
      // Still its own, taken, with no pull request of its yet.
      const items = await this.reads.current(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=100`, 1)
      if (Number(heldTask(items)?.number) !== number) return
      if (!asked) {
        await this.deps.tell(agent, this.operation(agent, key, `idle ${since}`), `You hold ${what} and have done nothing on it for 20 minutes: `
          + `go on with it, or say on it what holds it: gh issue view ${number} --repo ${repo}`)
        return this.watch(agent, repo, { number, title }, since, true)
      }
      const given = await giveBack(this.deps.send, repo, number, agent.label, true)
      if ('refused' in given) return this.log(`[super-tab] next thing of agent ${agent.agentId}: ${key} not given back: GitHub answered ${given.refused}.`)
      if (given.takenKept !== null) this.log(`[super-tab] next thing of agent ${agent.agentId}: ${key} kept status:taken: GitHub answered ${given.takenKept}.`)
      const said = await this.deps.send('POST', `/repos/${repo}/issues/${number}/comments`, { body: backLine(`${name} held it with nothing done for an hour`, hhmm(Date.now())) })
      // Given back all the same: the labels say so. Its line held or refused is said here (githubWrites.ts holds a line said too often).
      if (said.status >= 300) this.log(`[super-tab] next thing of agent ${agent.agentId}: ${key}'s line not written: GitHub answered ${said.status}.`)
      await this.deps.say(agent, this.operation(agent, key, `back ${since}`), `${name} held ${what} with nothing done on it for an hour, so Harness `
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
      // Whether it read is not known while the records cannot be read: it is not asked now, nor taken as answered.
      const talk = await this.deps.named(agent, repo, await pullTalk(this.reads, repo, ask.number))
      if (!talk) return null
      const { readers } = verdicts(talk, String(pull.body ?? ''), pullPeople(pull, await this.deps.team(agent)))
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

