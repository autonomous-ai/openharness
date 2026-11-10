/**
 * An agent's answer to its Swarm launch line, posted in its 1:1 chat as its first words there (anh Dee, 2026-11-10: "in the
 * terminal i can see that arlo has the first message but i didn't see it in the chat. my "hi" was the first message in the
 * chat"). New Agent and New Project start an agent with "You are <name>." and its person's request (Desktop
 * launch_prompt.dart), which the daemon types as it creates the agent, so no delivery owes that turn a reply: the host owes
 * replies only to what it types (agentReplies.ts). Swarm plan, step 1, item 2: every message arrives, or says it did not.
 *
 * Each agent of this computer's person running here is looked at until its newest turn has ended. That turn was its launch
 * line: its answer is posted once, as the agent, under `first-answer-<agent id>`, which the server takes once. It was
 * something else (an agent attached as it ran, or its person spoke since): nothing is posted. Either way the agent is not looked
 * at again, which the file keeps over a restart; one that shows no ended turn in an hour is let go, said in the log. A post
 * that fails for a moment is tried again at the next pass, within that hour; one the server refuses for good is said in the log.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { REPLY_TEXT_MAX } from './agentReplies.js'
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

/** One of this computer's person's v4 agents running here: its Swarm, its member id, its terminal, its chat with its person and
 *  the names it is told it is. */
export interface FirstAnswerAgent { tabId: string; agentId: string; harnessId: string; chat: string; names: string[] }

/** What is kept between passes and restarts: the agents looked at, oldest first, and since when each other one is looked at. */
interface Memory { done: string[]; since: Record<string, number> }

/** Whether [prompt] is the launch line of an agent called one of [names]: "You are Pip.", alone or before its request. */
export const launchLine = (prompt: string, names: readonly string[]): boolean =>
  names.some(name => prompt === `You are ${name}.` || prompt.startsWith(`You are ${name}.\n`))

/** A refusal the server makes of a post and would make again: by its code, never a status alone. */
const refusedForGood = (error: unknown): boolean => error instanceof SuperTabHostError && error.status < 500
  && (permanentRefusal(error) || ['VALIDATION_ERROR', 'FORBIDDEN', 'NOT_FOUND', 'OPERATION_REUSED'].includes(error.code))

export class FirstAnswers {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private memory: Memory | null = null
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
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? FIRST_ANSWER_INTERVAL_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass; one still running is not started twice. */
  tick(): Promise<void> {
    this.running ??= this.pass().catch(error => this.log(`[super-tab] first answers: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.running = null })
    return this.running
  }

  private async pass(): Promise<void> {
    const me = await this.deps.me()
    if (!me) return
    const memory = this.memory ??= this.load()
    let changed = false
    const done = (agentId: string) => {
      memory.done.push(agentId)
      if (memory.done.length > MAX_DONE) memory.done.splice(0, memory.done.length - MAX_DONE)
      delete memory.since[agentId]
      changed = true
    }
    try {
      for (const row of await this.deps.roster()) {
        const agent = await this.agentOf(row, me, memory)
        if (!agent) continue
        if (memory.since[agent.agentId] === undefined) { memory.since[agent.agentId] = this.now(); changed = true }
        if (this.now() - memory.since[agent.agentId]! >= FIRST_ANSWER_GIVE_UP_MS) {
          this.log(`[super-tab] no first answer posted for agent ${agent.agentId}: no turn of it ended in an hour.`)
          done(agent.agentId)
          continue
        }
        // Its first turn still runs, or nobody can say: looked at again next pass.
        if (await this.deps.working(agent.harnessId) !== false) continue
        const last = await this.deps.lastTurn(agent.harnessId)
        if (!last) continue
        if (!launchLine(last.userMessage, agent.names)) { done(agent.agentId); continue }
        const text = last.assistantText.trim()
        if (text) {
          try { await this.deps.post(agent, `first-answer-${agent.agentId}`, cut(text, REPLY_TEXT_MAX)) } catch (error) {
            if (!refusedForGood(error)) continue
            this.log(`[super-tab] first answer of agent ${agent.agentId} refused: ${(error as SuperTabHostError).code}.`)
          }
        }
        done(agent.agentId)
      }
    } finally {
      if (changed) this.save(memory)
    }
  }

  /** [row]'s agent when it is one to look at: a regular v4 agent of [me]'s, running here, in a Swarm that gives it a chat. */
  private async agentOf(row: Json, me: string, memory: Memory): Promise<FirstAnswerAgent | null> {
    const agent = object(row.agent)
    if (agent.regular !== true || row.closeSession === true || row.stopRequested === true || !identifier(row.tabId) || !identifier(agent.id)) return null
    if (memory.done.includes(agent.id)) return null
    if (agent.contributorId !== me || agent.machineOwnerId !== me || typeof agent.harnessId !== 'string' || !this.deps.live(agent.harnessId)) return null
    const names = [...new Set([agent.displayName, agent.name].filter((n): n is string => typeof n === 'string' && !!n.trim()).map(n => n.trim()))]
    if (!names.length) return null
    const state = await this.deps.read(row.tabId, agent.id).catch(() => null)
    const chat = (Array.isArray(state?.conversations) ? state.conversations.map(object) : [])
      .find(c => c.kind === 'agent-chat' && Array.isArray(c.agentIds) && c.agentIds.includes(agent.id))
    if (!chat || !identifier(chat.id)) return null
    return { tabId: row.tabId, agentId: agent.id, harnessId: agent.harnessId, chat: chat.id, names }
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
    } catch (error) { this.log(`[super-tab] could not save the first answers: ${error instanceof Error ? error.message : String(error)}`) }
  }
}
