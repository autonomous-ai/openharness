/**
 * Tokens for a task, and the cost on a landed change (Swarm allocator, package 12, 2026-11-11): no saving can be claimed, and
 * no model or price chosen, without it. Each daemon already counts its conversations' tokens by model and kind
 * (lib/agentTokenUsage.ts); nothing tied a count to a task. The server's cost record went with v3 (#3908): it took every
 * session's totals in every machine report and found a task's ends itself, which it cannot since tasks are GitHub issues.
 * A task's ends are known where its builder runs, so they are counted here, on its person's own computer.
 *
 * One rule: every token a conversation uses is counted once, to the piece of work its next boundary shows. A turn's end
 * carries what the turn used. The look Harness makes as a turn ends (nextThing.ts), which has read what the agent holds on
 * GitHub, gives what is carried to the first of: a pull request of its own whose head moved (a push: a fix round when it was
 * up for reading, building still when it was a draft), a pull request of its own that is new (its pull request is up), the
 * task it holds with no pull request yet (taken). A verdict made by command takes what its turn used so far: an ask is typed
 * to its reader as a turn of its own, so that is the read from its ask to its verdict. A task taken by command is when the
 * building that follows began, for its minutes. Landing needs no mark: a change's rows are whole at its builder's last push.
 *
 * A row is keyed by the number the work is on (the task's issue until it has a pull request, the pull request after) and
 * goes to the Swarm's server when its work stops (backend superTabs/taskTokens.ts): counts and ids only, never a title or a
 * word. The server keeps the last write of a row to arrive, so a row's writes go one at a time (IN_FLIGHT_MS). The daemon
 * that lands a change on a private repository reads its builder's rows and says them in the comment it posts (costLine).
 *
 * The count is the core's last reading (CoreApi.usage), up to 15 seconds behind the transcript: what a mark misses, the next
 * one counts. One it does not know is unknown, never zero: no mark is made.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { usageModelName } from '../lib/agentUsageWire.js'
import { labelOf } from './assign/crew.js'
import { retryIn } from './githubRest.js'
import { identifier, object, SuperTabHostError } from './wire.js'

/** One model's tokens: uncached input, output, cache reads and cache writes. */
type Model = { input: number; output: number; cacheRead: number; cacheWrite: number }
/** A conversation's count, or a part of it, by the model that answered. */
export type Counts = Record<string, Model>
const PARTS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

const KINDS = ['build', 'fix', 'read'] as const
type TaskKind = typeof KINDS[number]
/** A row as the server keeps it: the totals so far of one agent's work of one kind on one issue or pull request. A build's
 *  start is when its builder took the task by command; any other row's, its first boundary. */
export interface TaskRow { repository: string; number: number; kind: TaskKind; tokens: Array<Model & { model: string }>; rounds: number; startedAt: number; endedAt: number }
/** A row as the server gives it back, with the name it has for the row's agent. */
export type ReadRow = Omit<TaskRow, 'repository'> & { name: string | null }

/** What a look at a turn's end found an agent with in one repository: the task it holds with no pull request yet, every open
 *  pull request of its own, and the head of each one the look read. */
export interface Hand { repo: string; held: number | null; pulls: number[]; heads: Array<{ number: number; head: string; draft: boolean }> }

/** Models a row counts apart, as the server takes them; past it the rest are counted together, as a session's are
 *  (lib/agentUsageWire.ts OTHER_MODELS). */
const MAX_MODELS = 16, OTHER = 'other'
/** The agents and the rows of each that are kept, the least lately marked going first: a row stays while its work may go on,
 *  as the server takes the totals so far. */
const MAX_AGENTS = 200, MAX_ROWS = 100
/** Issues and pull requests one read of the server asks about (backend MAX_TASK_NUMBERS), and the largest number it takes for
 *  one (2^31 - 1, as its routes check). */
export const COST_NUMBERS = 20, TASK_NUMBER_MAX = 2_147_483_647
/** How long a write that has not come back may still reach the server, which keeps the last write of a row to arrive (its
 *  review: a late write with earlier totals replaces later ones). The backend call gives up at 25 seconds (core/gatewayLink.ts),
 *  and the server may still finish a write it had read by then. So a row is written again only once the server took its last
 *  write, or this long after that write went, by this daemon or by one started meanwhile (anh Dee's call, 12 November: one
 *  write in flight for a row). */
const IN_FLIGHT_MS = 60_000

const all = (model: Model): number => PARTS.reduce((total, part) => total + model[part], 0)
const sum = (counts: Counts): number => Object.values(counts).reduce((total, model) => total + all(model), 0)

/** What a conversation used from the count [from] to the count [to]. A count that fell began again, as a new conversation's
 *  does: all of it is counted. */
function used(from: Counts, to: Counts): Counts {
  const grown: Counts = {}
  for (const [model, now] of Object.entries(to)) {
    const before = from[model]
    const delta = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const part of PARTS) delta[part] = before && now[part] >= before[part] ? now[part] - before[part] : now[part]
    if (PARTS.some(part => delta[part] > 0)) grown[model] = delta
  }
  return grown
}

/** Adds [more] to [into], a model at a time; past MAX_MODELS - 1 models a new one is counted with the others. */
function add(into: Counts, more: Counts): void {
  for (const [name, counts] of Object.entries(more)) {
    const model = into[name] || Object.keys(into).filter(known => known !== OTHER).length < MAX_MODELS - 1 ? name : OTHER
    const sums = into[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const part of PARTS) sums[part] += counts[part]
  }
}

/** One model's counts as they are kept and read back: four whole numbers, or null when they are not. */
function modelOf(value: unknown): Model | null {
  const row = object(value)
  return PARTS.every(part => Number.isSafeInteger(row[part]) && (row[part] as number) >= 0)
    ? { input: row.input as number, output: row.output as number, cacheRead: row.cacheRead as number, cacheWrite: row.cacheWrite as number } : null
}

/** A count as it is kept: each model's counts, or null when one is not. */
function countsOf(value: unknown): Counts | null {
  const counts: Counts = {}
  for (const [model, kept] of Object.entries(object(value))) {
    const of = modelOf(kept)
    if (!of) return null
    counts[model] = of
  }
  return counts
}

/** A row's models as a count, and back. */
const asCounts = (tokens: TaskRow['tokens']): Counts => Object.fromEntries(tokens.map(({ model, ...of }) => [model, of]))
const asTokens = (counts: Counts): TaskRow['tokens'] => Object.entries(counts).map(([model, of]) => ({ model, ...of }))

/** A row's models as they are read back from a file or the server: each named as an engine names one (lib/agentUsageWire.ts),
 *  with its counts; null when one is not. Another daemon wrote it, and the comment shows its name as code: no backtick or space
 *  in it can end the code. */
function tokensOf(value: unknown): TaskRow['tokens'] | null {
  if (!Array.isArray(value)) return null
  const tokens: TaskRow['tokens'] = []
  for (const kept of value) {
    const of = modelOf(kept), model = object(kept).model
    if (!of || typeof model !== 'string' || usageModelName(model) !== model) return null
    tokens.push({ model, ...of })
  }
  return tokens
}

/** [n] tokens in a few characters: 840, 340k, 1.2M. */
const compact = (n: number): string => n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)

/**
 * The sentence the comment of a landed change gains, from the server's [rows] for the pull request and the tasks it closes:
 * " Built by pip on `claude-sonnet-5-5`: 42 min, 1.2M tokens, 1 fix round." Its builder as the pull request names it
 * ([author]); the model that used the most, as its engine names it, as code: GitHub links and tags nothing in it (anh Dee's
 * call, 12 November); the minutes from when its builder's work on it began (it took the task) to [now], the landing; every
 * token its builder's conversation used building and fixing it, cache reads too, as an agent's total is shown; its rounds,
 * which only fixes have: the pushes after it was up for reading. Only the rows of the pull request's own builder count, by the
 * server's name for each row's agent: another agent's row says nothing here. Empty when there is none. Said on a private
 * repository only (githubMerge.ts).
 */
export function costLine(rows: readonly ReadRow[], author: string, now: number): string {
  const own = rows.filter(row => row.kind !== 'read' && row.name !== null && labelOf(row.name) === labelOf(author))
  const models: Counts = {}
  for (const row of own) add(models, asCounts(row.tokens))
  const total = sum(models)
  if (!total) return ''
  const model = Object.keys(models).sort((a, b) => all(models[b]!) - all(models[a]!) || a.localeCompare(b))[0]!
  const minutes = Math.max(1, Math.round((now - Math.min(...own.map(row => row.startedAt))) / 60_000))
  const rounds = own.reduce((count, row) => count + row.rounds, 0)
  return ` Built by ${author} on \`${model}\`: ${minutes} min, ${compact(total)} tokens, ${rounds} fix ${rounds === 1 ? 'round' : 'rounds'}.`
}

/** The server's rows for a project's issues and pull requests [numbers] (at most COST_NUMBERS), read as the project's PM
 *  through [ask], the backend's GET. A row that is not counts and ids as this reads them is left out: another daemon wrote it. */
export const readTaskTokens = (ask: (path: string) => Promise<unknown>) =>
  async (project: { tabId: string; repo: string; pmAgentId: string }, numbers: readonly number[]): Promise<ReadRow[]> => {
    const answer = object(await ask(`/api/super-tabs/${project.tabId}/task-tokens?repository=${encodeURIComponent(project.repo)}`
      + `&numbers=${numbers.join(',')}&asAgentId=${project.pmAgentId}`))
    return (Array.isArray(answer.rows) ? answer.rows : []).flatMap(row => {
      const read = rowOf(row)
      return read ? [{ ...read, name: typeof object(row).name === 'string' ? object(row).name as string : null }] : []
    })
  }

/** A row's numbers as they are read back from a file or the server, or null when they are not a row's. */
function rowOf(value: unknown): Omit<TaskRow, 'repository'> | null {
  const row = object(value), tokens = tokensOf(row.tokens)
  if (!tokens || !Number.isSafeInteger(row.number) || !KINDS.includes(row.kind as TaskKind) || !Number.isSafeInteger(row.rounds)
    || !Number.isSafeInteger(row.startedAt) || !Number.isSafeInteger(row.endedAt)) return null
  return { number: row.number as number, kind: row.kind as TaskKind, tokens, rounds: row.rounds as number, startedAt: row.startedAt as number, endedAt: row.endedAt as number }
}

/** What is kept of one agent between marks and restarts. */
interface Kept {
  /** Its Swarm and its id there, to write its rows as it. */
  tabId: string; agentId: string
  /** When it was last marked, and its conversation's count then: null until the core knows one. */
  at: number; from: Counts | null
  /** What it used since the last look that gave it to a piece of work. */
  carried: Counts
  /** When it last took a task by command: the start of the building that follows. */
  began: number | null
  /** Its open pull requests as each repository last listed them, each with its head once a look read it. A repository that
   *  is not here was never listed: its pull requests are not new the first time. */
  pulls: Record<string, Record<string, { head: string; draft: boolean } | null>>
  /** Its rows, by `<repository>#<number> <kind>`: the totals so far, whether the server has them, and when a write of them went
   *  that the server has not taken. */
  rows: Record<string, { row: TaskRow; sent: boolean; sending?: number }>
}

export class TaskTokens {
  private stopEnds: (() => void) | null = null
  /** What is kept of each agent, by the terminal it runs in; of one whose terminal another agent took over, by
   *  `<tabId>/<agentId>` until it is seen in another (agent). */
  private memory: Record<string, Kept> | null = null
  /** Each terminal's marks, one after another: a turn's end is counted before the look that follows it. */
  private readonly queues = new Map<string, Promise<void>>()
  /** The writes the server did not take in a row, and when the next may go: 30 seconds, doubling to 15 minutes. */
  private misses = 0
  private againAt = 0
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: {
    /** Hear each live turn's end; returns how to stop hearing. */
    onEnd: (listener: (end: { agentId: string }) => void) => () => void
    /** The count by model of the conversation in terminal [harnessId], as the core last read it; null when it knows none. */
    count: (harnessId: string) => Promise<Counts | null>
    /** Writes [row], an agent's totals so far, to its Swarm's server as that agent. */
    send: (agent: { tabId: string; agentId: string }, row: TaskRow) => Promise<unknown>
    file: string
    now?: () => number
    log?: (line: string) => void
  }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
  }

  start(): void {
    this.stopEnds ??= this.deps.onEnd(end => { void this.ended(end.agentId) })
  }

  stop(): void {
    this.stopEnds?.()
    this.stopEnds = null
  }

  /** A turn in terminal [harnessId] ended: what it used is carried until a look says what it was for. Only an agent a look
   *  or a command has shown to be one of this person's in a project: any other terminal's turns cost nothing here. Nothing is
   *  saved: its count and what it carries move together, so a daemon that stops before the next look counts the same tokens
   *  there, from the count saved before. A turn's end is the most frequent mark, and the file holds every agent's rows. */
  ended(harnessId: string): Promise<void> {
    return this.queued(harnessId, async memory => {
      const agent = memory[harnessId]
      if (agent) add(agent.carried, await this.mark(harnessId, agent))
      return false
    })
  }

  /** The agent in terminal [harnessId] took a task by command: the building that follows began now. */
  took(agent: { tabId: string; agentId: string; harnessId: string }): Promise<void> {
    return this.queued(agent.harnessId, async memory => {
      this.agent(memory, agent).began = this.now()
      return true
    })
  }

  /** [agent] made a verdict on pull request [number] of [repo] by command: what its turn used so far was that read. */
  read(agent: { tabId: string; agentId: string; harnessId: string }, repo: string, number: number): Promise<void> {
    return this.queued(agent.harnessId, async memory => {
      const kept = this.agent(memory, agent)
      this.give(kept, await this.mark(agent.harnessId, kept), repo, number, 'read', true)
      await this.flush(memory, kept, key => key === `${repo}#${number} read`)
      return true
    })
  }

  /** [agent] was looked at as a turn ended, and held [hands]: what it carries goes to the piece of work they show. */
  looked(agent: { tabId: string; agentId: string; harnessId: string }, hands: readonly Hand[]): Promise<void> {
    return this.queued(agent.harnessId, async memory => {
      const kept = this.agent(memory, agent)
      // A look with no turn's end before it (as Harness starts) is the first mark: counted from here.
      add(kept.carried, await this.mark(agent.harnessId, kept))
      let work: { repo: string; number: number; kind: TaskKind; round: boolean } | null = null, opened = false
      for (const hand of hands) {
        const before = kept.pulls[hand.repo], listed: Kept['pulls'][string] = {}
        for (const number of hand.pulls) {
          const was = before?.[number], read = hand.heads.find(head => head.number === number)
          listed[number] = read ? { head: read.head, draft: read.draft } : was ?? null
          // One not listed before is new, but in a repository listed for the first time.
          const isNew = before !== undefined && was === undefined
          opened ||= isNew
          // A push to one that was up for reading is a fix round; to a draft, building still.
          if (!work && was && read && was.head !== read.head) work = { repo: hand.repo, number, kind: was.draft ? 'build' : 'fix', round: !was.draft }
          else if (!work && isNew) work = { repo: hand.repo, number, kind: 'build', round: false }
        }
        kept.pulls[hand.repo] = listed
      }
      const holding = hands.find(hand => hand.held !== null)
      if (!work && holding) work = { repo: holding.repo, number: holding.held!, kind: 'build', round: false }
      if (work) {
        this.give(kept, kept.carried, work.repo, work.number, work.kind, work.round)
        kept.carried = {}
      }
      // Its pull request is up: the building its last take began is done, and a later one begins at its own.
      if (opened) kept.began = null
      // The task it still holds is still growing: its row goes once its pull request is up, or it is given back.
      const growing = new Set(hands.filter(hand => hand.held !== null).map(hand => `${hand.repo}#${hand.held} build`))
      await this.flush(memory, kept, key => !growing.has(key))
      return true
    })
  }

  /** The agent's entry, by the terminal it runs in, made at its first look or command there. One that moved to a new terminal
   *  (Change agent: replacements.ts, the backend's agent.rebind) takes its entry along, counted from that terminal's first
   *  reading: left with its old terminal, its rows were stranded there and its next write took the server's totals down
   *  (review of #4143). A terminal another agent took over starts afresh from the count it read last, and what the first
   *  agent kept waits for it under `<tabId>/<agentId>`, which no terminal's id can be: never written as the new one's. */
  private agent(memory: Record<string, Kept>, agent: { tabId: string; agentId: string; harnessId: string }): Kept {
    const theirs = (kept: Kept): boolean => kept.tabId === agent.tabId && kept.agentId === agent.agentId
    const here: Kept | undefined = memory[agent.harnessId]
    if (here && theirs(here)) return here
    if (here) memory[`${here.tabId}/${here.agentId}`] = here
    const moved = Object.keys(memory).find(id => theirs(memory[id]!))
    // Moved into a terminal it used before, it counts from that terminal's last count; into a new one (Change agent), from its
    // first reading.
    const kept: Kept = moved ? { ...memory[moved]!, from: here?.from ?? null }
      : { tabId: agent.tabId, agentId: agent.agentId, at: this.now(), from: here?.from ?? null, carried: {}, began: null, pulls: {}, rows: {} }
    if (moved) delete memory[moved]
    memory[agent.harnessId] = kept
    return kept
  }

  /** What [agent]'s conversation used since its last mark, and the count is its mark from now. Nothing while the core knows no
   *  count, and nothing at its first: the count before it was read is not this work's. */
  private async mark(harnessId: string, agent: Kept): Promise<Counts> {
    const now = await this.deps.count(harnessId).catch(() => null)
    if (!now) return {}
    const grown = agent.from ? used(agent.from, now) : {}
    agent.from = now
    agent.at = this.now()
    return grown
  }

  /** Adds [tokens] to [agent]'s row of [kind] on [number], and a round when [round]. Nothing for no tokens: a count that is
   *  not known is no row. */
  private give(agent: Kept, tokens: Counts, repo: string, number: number, kind: TaskKind, round: boolean): void {
    if (!sum(tokens)) return
    const key = `${repo}#${number} ${kind}`, now = this.now()
    const kept = agent.rows[key] ?? { row: { repository: repo, number, kind, tokens: [], rounds: 0, startedAt: kind === 'build' ? agent.began ?? now : now, endedAt: now }, sent: false }
    const counts = asCounts(kept.row.tokens)
    add(counts, tokens)
    // Moved to the end: the rows touched least lately go first when there are too many. It keeps when its last write went, while
    // the server has not taken that one.
    delete agent.rows[key]
    agent.rows[key] = { ...kept, row: { ...kept.row, tokens: asTokens(counts), rounds: kept.row.rounds + (round ? 1 : 0), endedAt: now }, sent: false }
    const keys = Object.keys(agent.rows)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ROWS))) delete agent.rows[old]
  }

  /** Writes to the server each row of [agent] it does not have yet, of those [due], but one whose last write may still be on
   *  its way (IN_FLIGHT_MS): that write is kept in [memory]'s file as it goes. One the server refuses for good (it is not a row
   *  it takes, or this agent may not write it) is let go, as the same write would be refused again; any other failure keeps
   *  the rows for the agent's next look, no sooner than the wait, and is said once. */
  private async flush(memory: Record<string, Kept>, agent: Kept, due: (key: string) => boolean): Promise<void> {
    if (this.now() < this.againAt) return
    for (const [key, kept] of Object.entries(agent.rows)) {
      if (kept.sent || !due(key) || (kept.sending !== undefined && this.now() < kept.sending + IN_FLIGHT_MS)) continue
      kept.sending = this.now()
      this.save(memory)
      try {
        await this.deps.send({ tabId: agent.tabId, agentId: agent.agentId }, kept.row)
        kept.sent = true
        delete kept.sending
        if (this.misses) this.log('[super-tab] tasks\' tokens are kept by the server again')
        this.misses = 0
      } catch (error) {
        const code = error instanceof SuperTabHostError ? error.code : 'FAILED'
        if (error instanceof SuperTabHostError && [400, 403, 422].includes(error.status)) {
          delete agent.rows[key]
          this.log(`[super-tab] a task's tokens were refused by the server, and are let go · ${code} ${kept.row.repository}#${kept.row.number}`)
          continue
        }
        // A server from before it kept them answers 404, and is asked again as any that is down.
        if (!this.misses) this.log(`[super-tab] tasks' tokens are not kept by the server: they wait here · TOKENS_UNSENT ${code}`)
        this.againAt = this.now() + retryIn(++this.misses)
        return
      }
    }
  }

  /** Runs [mark] after the agent's marks before it, on what is kept, and saves it when [mark] says it changed: a turn's end
   *  in a terminal that is no agent of a project writes no file. A mark never rejects: what fails is said. */
  private queued(harnessId: string, mark: (memory: Record<string, Kept>) => Promise<boolean>): Promise<void> {
    const next = (this.queues.get(harnessId) ?? Promise.resolve()).then(async () => {
      const memory = this.memory ??= this.load()
      if (await mark(memory)) this.save(memory)
    }).catch(error => this.log(`[super-tab] tasks' tokens: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (this.queues.get(harnessId) === next) this.queues.delete(harnessId) })
    this.queues.set(harnessId, next)
    return next
  }

  private load(): Record<string, Kept> {
    const kept: Record<string, Kept> = {}
    try {
      for (const [id, value] of Object.entries(object(JSON.parse(readFileSync(this.deps.file, 'utf8'))))) {
        const agent = object(value), from = agent.from === null ? null : countsOf(agent.from), carried = countsOf(agent.carried)
        if (!identifier(agent.tabId) || !identifier(agent.agentId) || typeof agent.at !== 'number' || (agent.from !== null && !from) || !carried) continue
        // A pull request or a row that does not read as one is left out: its head is read again, its tokens counted from here.
        const pulls: Kept['pulls'] = {}, rows: Kept['rows'] = {}
        for (const [repo, open] of Object.entries(object(agent.pulls))) {
          pulls[repo] = Object.fromEntries(Object.entries(object(open)).map(([number, seen]) =>
            [number, typeof object(seen).head === 'string' ? { head: object(seen).head as string, draft: object(seen).draft === true } : null]))
        }
        for (const [key, saved] of Object.entries(object(agent.rows))) {
          const row = rowOf(object(saved).row), repository = object(object(saved).row).repository, sending = object(saved).sending
          if (row && typeof repository === 'string') {
            rows[key] = { row: { repository, ...row }, sent: object(saved).sent === true, ...typeof sending === 'number' ? { sending } : {} }
          }
        }
        kept[id] = { tabId: agent.tabId, agentId: agent.agentId, at: agent.at, from, carried, began: typeof agent.began === 'number' ? agent.began : null, pulls, rows }
      }
    } catch { /* none kept yet, or unreadable: counted from now */ }
    return kept
  }

  private save(memory: Record<string, Kept>): void {
    const ids = Object.keys(memory).sort((a, b) => memory[a]!.at - memory[b]!.at)
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_AGENTS))) delete memory[id]
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const temporary = `${this.deps.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(memory), { mode: 0o600 })
      renameSync(temporary, this.deps.file)
    } catch (error) { this.log(`[super-tab] could not save the tasks' tokens: ${String(error)}`) }
  }
}
