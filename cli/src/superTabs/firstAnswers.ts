/**
 * An agent's answer to its Swarm launch line, posted in its 1:1 chat as its first words there (anh Dee, 2026-11-10: "in the
 * terminal i can see that arlo has the first message but i didn't see it in the chat. my "hi" was the first message in the
 * chat"). New Agent and New Project start an agent with "You are <name>." and its person's request (Desktop
 * launch_prompt.dart), which the daemon types as it creates the agent, so no delivery owes that turn a reply: the host owes
 * replies only to what it types (agentReplies.ts). Swarm plan, step 1, item 2: every message arrives, or says it did not. A new
 * project's PM, started by Desktop's New Project with its brief or by the Swarm with its name alone (start.ts), has its answer
 * go in its chat the same way (anh Dee, 2026-11-12: Lou's "Lou here, I'm set up as PM" stayed in its terminal).
 *
 * That first turn's end is heard as every live turn's is (core.turns.onEnd) and known by its prompt's hash
 * (lib/promptIdentity.ts): "You are <name>." alone, or before its person's request, which the server keeps as their words in
 * the chat (backend agent.add `initialMessage`). Its answer is the core's, as it was said (core.turns.answerOf): a person who
 * writes while it runs has their message typed the moment it ends, and then the transcript's last turn is theirs
 * (core/turns/ends.ts), as anh Dee's "hi" was. A first turn this process did not hear end (it was down), or whose answer the
 * core cannot give, is read from the transcript once the terminal is idle: its newest turn, when that is its launch line.
 *
 * Each agent of this computer's person running here is looked at until then. Its answer is posted once, as the agent, under
 * `first-answer-<agent id>`, which the server takes once; a first turn that was something else (an agent attached as it ran)
 * or was interrupted posts nothing. Either way the agent is not looked at again, which the file keeps over a restart; one
 * that shows no ended turn in an hour is let go, said in the log. A post that fails for a moment is tried again at the next
 * pass, within that hour; one the server refuses for good is said in the log.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TurnEnd } from '../core/api.js'
import { MAX_FIRST_PROMPT_CHARS } from '../lib/engineLaunch.js'
import { promptHash } from '../lib/promptIdentity.js'
import { bounded, named, READ_WAIT_MS, REPLY_TEXT_MAX } from './agentReplies.js'
import { cut } from './deliveryContext.js'
import { permanentRefusal } from './retries.js'
import { identifier, object, SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>

/** How often the agents still to be looked at are looked at. */
export const FIRST_ANSWER_INTERVAL_MS = 5_000
/** How long an agent may show no ended turn before it is let go. */
export const FIRST_ANSWER_GIVE_UP_MS = 60 * 60_000
/** The most agents the file remembers as looked at; the oldest go first. */
const MAX_DONE = 1_000
/** The first turn ends kept of each terminal until its agent is looked at, and of how many terminals, the least recently heard
 *  going first: a quick engine's first turn ends before its agent has joined its Swarm, and a launch turn is its terminal's
 *  first. */
const ENDS_KEPT = 4
const TERMINALS_HEARD = 256

/** One of this computer's person's v4 agents running here: its Swarm, its member id, its terminal, its chat with its person and
 *  the names it is told it is. `lead` for a project's PM that is no Regular agent: Desktop's New Project or the Swarm started it. */
export interface FirstAnswerAgent { tabId: string; agentId: string; harnessId: string; chat: string; names: string[]; lead?: true }

/** What is kept between passes and restarts: the agents looked at, oldest first, and since when each other one is looked at. */
interface Memory { done: string[]; since: Record<string, number> }

/** Whether [prompt] is the launch line of an agent called one of [names]: "You are Pip.", alone or before its request. */
export const launchLine = (prompt: string, names: readonly string[]): boolean =>
  names.some(name => prompt === `You are ${name}.` || prompt.startsWith(`You are ${name}.\n`))

/** The hashes of the launch lines Desktop writes (launch_prompt.dart) for an agent called one of [names], whose person said
 *  [words] in its chat: "You are Pip." alone, and before each of those words as its request, whole and cut to what a first
 *  prompt may hold (MAX_FIRST_PROMPT_CHARS). */
export function launchHashes(names: readonly string[], words: readonly string[]): Set<string> {
  const hashes = new Set<string>()
  for (const name of names) {
    const head = `You are ${name}.`
    hashes.add(promptHash(head))
    const lead = `${head}\n\n`
    for (const said of words) {
      const request = said.trim()
      if (!request) continue
      hashes.add(promptHash(lead + request))
      hashes.add(promptHash(lead + request.slice(0, MAX_FIRST_PROMPT_CHARS - lead.length)))
    }
  }
  return hashes
}

/** A refusal the server makes of a post and would make again: by its code, never a status alone. */
const refusedForGood = (error: unknown): boolean => permanentRefusal(error)
  || error instanceof SuperTabHostError && error.status < 500 && ['VALIDATION_ERROR', 'FORBIDDEN', 'OPERATION_REUSED'].includes(error.code)

export class FirstAnswers {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private memory: Memory | null = null
  private stopEnds: (() => void) | null = null
  /** The first turn ends heard of each terminal, by its id. */
  private readonly heard = new Map<string, TurnEnd[]>()
  /** Each agent's launch lines, by its id, once its person's words were read. */
  private readonly launches = new Map<string, Set<string>>()
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: {
    /** This computer's signed-in person, whose agents these are. */
    me: () => Promise<string | null>
    /** Whether a terminal runs here now. */
    live: (harnessId: string) => boolean
    /** The Swarm's rows of this computer's agents, and one agent's read of its Swarm, as the host reads them. */
    roster: () => Promise<Json[]>
    read: (tabId: string, agentId: string) => Promise<Json>
    /** Hear each live turn's end; returns how to stop hearing. And what the turn that ended answered, as it was said. */
    onEnd: (listener: (end: TurnEnd) => void) => () => void
    answerOf: (end: TurnEnd) => Promise<string | null>
    /** What its person said in [agent]'s chat, as the server keeps it: the request they started it with among it. */
    words: (agent: FirstAnswerAgent) => Promise<string[]>
    /** Whether a terminal's turn is running; null when it cannot be said. */
    working: (harnessId: string) => Promise<boolean | null>
    /** A terminal's newest turn as its transcript has it, or null when it has none yet. */
    lastTurn: (harnessId: string) => Promise<{ userMessage: string; assistantText: string } | null>
    /** Posts [text] in [agent]'s chat with its person, as the agent. */
    post: (agent: FirstAnswerAgent, operationId: string, text: string) => Promise<unknown>
    file: string
    now?: () => number
    log?: (line: string) => void
    intervalMs?: number
  }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
  }

  start(): void {
    if (this.timer) return
    this.stopEnds = this.deps.onEnd(end => this.hear(end))
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? FIRST_ANSWER_INTERVAL_MS)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopEnds?.()
    this.stopEnds = null
    this.heard.clear()
    this.launches.clear()
  }

  /** One pass; one still running is not started twice. */
  tick(): Promise<void> {
    this.running ??= this.pass().catch(error => this.log(`[super-tab] first answers: ${named(error)}.`))
      .finally(() => { this.running = null })
    return this.running
  }

  /** A live turn ended: kept among its terminal's first, and looked at now. */
  private hear(end: TurnEnd): void {
    const ends = this.heard.get(end.agentId) ?? []
    this.heard.delete(end.agentId)
    this.heard.set(end.agentId, [...ends, end].slice(0, ENDS_KEPT))
    if (this.heard.size > TERMINALS_HEARD) this.heard.delete(this.heard.keys().next().value!)
    void this.tick()
  }

  private async pass(): Promise<void> {
    const me = await this.deps.me()
    if (!me) return
    const memory = this.memory ??= this.load()
    let changed = false
    const done = (agent: FirstAnswerAgent) => {
      memory.done.push(agent.agentId)
      if (memory.done.length > MAX_DONE) memory.done.splice(0, memory.done.length - MAX_DONE)
      delete memory.since[agent.agentId]
      this.heard.delete(agent.harnessId)
      this.launches.delete(agent.agentId)
      changed = true
    }
    try {
      for (const row of await this.deps.roster()) {
        const agent = await this.agentOf(row, me, memory)
        if (!agent) continue
        if (memory.since[agent.agentId] === undefined) { memory.since[agent.agentId] = this.now(); changed = true }
        if (this.now() - memory.since[agent.agentId]! >= FIRST_ANSWER_GIVE_UP_MS) {
          this.log(`[super-tab] no first answer posted for agent ${agent.agentId}: none was ready within an hour.`)
          done(agent)
          continue
        }
        const answer = await this.answer(agent)
        // Its person's words could not be read, or its first turn still runs, or nobody can say: looked at again next pass.
        if (answer === undefined) continue
        if (answer) {
          try { await this.deps.post(agent, `first-answer-${agent.agentId}`, cut(answer, REPLY_TEXT_MAX)) } catch (error) {
            if (!refusedForGood(error)) continue
            this.log(`[super-tab] first answer of agent ${agent.agentId} refused: ${(error as SuperTabHostError).code}.`)
          }
        }
        done(agent)
      }
    } finally {
      if (changed) this.save(memory)
    }
  }

  /** What [agent]'s first turn answered its launch line: its words; null when it posts nothing (that turn was something else, was
   *  interrupted or said nothing); undefined while that cannot be told yet. */
  private async answer(agent: FirstAnswerAgent): Promise<string | null | undefined> {
    const ends = this.heard.get(agent.harnessId)
    if (ends) {
      const launches = await this.launchesOf(agent)
      if (!launches) return undefined
      const first = ends.find(end => launches.has(end.prompt))
      if (first?.aborted) {
        this.log(`[super-tab] no first answer posted for agent ${agent.agentId}: its first turn was interrupted.`)
        return null
      }
      if (first) {
        const said = await bounded(this.deps.answerOf(first), READ_WAIT_MS).catch(error => {
          this.log(`[super-tab] could not read the first answer of agent ${agent.agentId}: ${named(error)}; read from its transcript.`)
          return null
        })
        if (said?.trim()) return said.trim()
      }
    }
    // Not heard, or not one the core can give: its transcript's newest turn, once its terminal is idle.
    if (await this.deps.working(agent.harnessId) !== false) return undefined
    const last = await this.deps.lastTurn(agent.harnessId)
    if (!last) return undefined
    // A PM's launch line is one of its own (launchHashes): "You are <name>.", alone or before the brief its person wrote in New
    // Project (Desktop launch.dart). Not one started in a former PM's place, typed that PM's handoff record after its name
    // (start.ts): its first turn answers the record, no greeting, and the record is no word of its person's.
    if (agent.lead) {
      const launches = await this.launchesOf(agent)
      if (!launches) return undefined
      return launches.has(promptHash(last.userMessage)) ? last.assistantText.trim() || null : null
    }
    return launchLine(last.userMessage, agent.names) ? last.assistantText.trim() || null : null
  }

  /** [agent]'s launch lines, once its person's words in its chat were read; null when they cannot be read now. */
  private async launchesOf(agent: FirstAnswerAgent): Promise<Set<string> | null> {
    const known = this.launches.get(agent.agentId)
    if (known) return known
    const launches = await this.deps.words(agent).then(words => launchHashes(agent.names, words), () => null)
    if (launches) this.launches.set(agent.agentId, launches)
    return launches
  }

  /** [row]'s agent when it is one to look at: a regular v4 agent or a project's PM of [me]'s, running here, in a Swarm that gives
   *  it a chat. Not a builder the PM started: nobody asked it anything in its chat (anh Dee, 2026-11-12: a new project's PM, Lou,
   *  answered in its terminal and its chat stayed empty). */
  private async agentOf(row: Json, me: string, memory: Memory): Promise<FirstAnswerAgent | null> {
    const agent = object(row.agent)
    if ((agent.regular !== true && row.lead !== true) || row.closeSession === true || row.stopRequested === true || !identifier(row.tabId) || !identifier(agent.id)) return null
    if (memory.done.includes(agent.id)) return null
    if (agent.contributorId !== me || agent.machineOwnerId !== me || typeof agent.harnessId !== 'string' || !this.deps.live(agent.harnessId)) return null
    const names = [...new Set([agent.displayName, agent.name].filter((n): n is string => typeof n === 'string' && !!n.trim()).map(n => n.trim()))]
    if (!names.length) return null
    const state = await this.deps.read(row.tabId, agent.id).catch(() => null)
    const chat = (Array.isArray(state?.conversations) ? state.conversations.map(object) : [])
      .find(c => c.kind === 'agent-chat' && Array.isArray(c.agentIds) && c.agentIds.includes(agent.id))
    if (!chat || !identifier(chat.id)) return null
    return { tabId: row.tabId, agentId: agent.id, harnessId: agent.harnessId, chat: chat.id, names, ...agent.regular !== true ? { lead: true as const } : {} }
  }

  private load(): Memory {
    try {
      const saved = object(JSON.parse(readFileSync(this.deps.file, 'utf8')))
      const done = Array.isArray(saved.done) ? saved.done.filter(identifier) : []
      const since = Object.fromEntries(Object.entries(object(saved.since)).filter(([id, at]) => identifier(id) && Number.isFinite(at))) as Record<string, number>
      return { done, since }
    } catch { return { done: [], since: {} } }
  }

  private save(memory: Memory): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const temporary = `${this.deps.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(memory), { mode: 0o600 })
      renameSync(temporary, this.deps.file)
    } catch (error) { this.log(`[super-tab] could not save the first answers: ${String(error)}`) }
  }
}
