/**
 * The host's side of a Lead reading and typing into a worker's terminal (spec/2026-10-23-lead-sees-agent-terminal.md).
 * Workers got stuck on what only their terminal showed (a permission prompt, a usage-limit screen, a model picker) and
 * only a person at that machine could see and clear it. The backend relays the Lead's request to the host of the agent's
 * machine; the host reads or types with the core's own capture and input (core/superTabTerminal.ts) and answers as that
 * agent. It also tells the Lead, once per episode, when a worker has sat on a prompt for 3 minutes or its screen shows
 * a usage limit. The same reads tell the machine report when each agent's screen last changed: the backend renews the
 * agent's lease on its task from that (docs: swarm-never-stops, v1 liveness).
 */
import { createHash } from 'node:crypto'
import type { CoreApi } from '../core/api.js'
import type { MessageHold } from '../engines/facets/screen.js'
import { backend } from './host.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>
interface Own { tabId: string; agentId: string; harnessId: string }

/** Every host of every Swarm asks, so not every second (Lead, 2026-10-23); the backend gives up on a pickup after 10 s. */
const SERVE_EVERY_MS = 3_000
/** A screen read per agent; the 3-minute prompt wait does not need it finer. */
const WATCH_EVERY_MS = 15_000
const PROMPT_WAIT_MS = 3 * 60_000
/** The spec's cap on what a screen read returns. */
const MAX_SCREEN_BYTES = 64 * 1024
/** What the screen reader says a prompt or a question is waiting on; a popup or a hidden prompt is not one. */
const WAITING: ReadonlySet<MessageHold> = new Set(['permission_open', 'question_open', 'menu_open', 'trust_open', 'update_prompt_open', 'model_prompt_open', 'sign_in_open'])
/** The spec's named keys, in any case: the name the Lead's request carries, and the terminal's own (core/superTabTerminal.ts).
 *  Ctrl-D and the like are left out: one closes an engine. */
const KEYS: Record<string, [string, string]> = { enter: ['Enter', 'Enter'], esc: ['Esc', 'Escape'], escape: ['Esc', 'Escape'], tab: ['Tab', 'Tab'],
  up: ['Up', 'Up'], down: ['Down', 'Down'], left: ['Left', 'Left'], right: ['Right', 'Right'], 'ctrl-c': ['Ctrl-C', 'C-c'],
  ...Object.fromEntries([...'0123456789'].map(digit => [digit, [digit, digit]])) }
/** A key as the Lead's request names it, or null for one it may not type. */
export const keyName = (key: string): string | null => KEYS[key.toLowerCase()]?.[0] ?? null
const CHANGED = 'This agent\'s terminal on this machine changed. Ask again.'
const NOT_RUNNING = 'This agent is not running on this machine.'

/** The end of the screen, at most 64 KB of UTF-8, cut on a character boundary: the prompt is at the bottom. */
export function capScreen(text: string): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_SCREEN_BYTES) return text
  let start = bytes.length - MAX_SCREEN_BYTES
  while ((bytes[start]! & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString()
}

/** The terminal's key names for the Lead's, or why one is not allowed. */
export function typedKeys(keys: unknown[]): string[] | string {
  const out: string[] = []
  for (const key of keys) {
    const name = typeof key === 'string' ? KEYS[key.toLowerCase()]?.[1] : undefined
    if (!name) return `Unknown key: ${String(key)}.`
    out.push(name)
  }
  return out
}

/** The engines' own limit lines, at the start of a line: Claude Code's "5-hour limit reached ∙ resets 3pm", "Claude usage
 *  limit reached. Your limit will reset at 3pm", "You've hit your limit · resets 3pm" and "API Error: Usage limit
 *  reached", and Codex's "You've hit your usage limit. … try again in 2 hours". Claude Code 2.1 names the limit it hit
 *  ("You've hit your session limit", "… weekly limit", "… Opus limit", "You've reached your Fable limit"), and Codex 0.154
 *  one for a model or a workspace ("You've hit your usage limit for gpt-5.5-codex", "You've reached your workspace credit
 *  limit"): none of those alerted until 2026-10-26. Only near the prompt, so an agent writing about limits in its own
 *  words, or an old banner far up the screen, is not one. */
const LIMIT_LINE = /^[^A-Za-z]*(?:api error:\s*)?(?:claude\s+)?(?:(?:usage|5-hour|weekly|session|opus|sonnet|fable)\s+limit reached|you['’]ve (?:hit|reached) your (?:[\w-]+ ){0,2}limit)/i
const LIMIT_NEAR_LINES = 15
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** An engine retrying a model that does not answer: Claude Code's "Waiting for API response · will retry in 2m 38s · check
 *  your network" and its "API Error: 503 …", "Request timed out" or "Connection error", and Codex's "stream disconnected -
 *  retrying" and "Reconnecting…". 2026-10-24: a Builder on a small local model retried for an hour, the relay giving up on
 *  every answer, while its Lead waited on it. Only near the prompt, as a limit is. */
const MODEL_LINE = /waiting for api response|api error:\s*(?:5\d\d|overloaded|request timed out|connection)|stream (?:error|disconnected)[^\n]*retrying|^\W*reconnecting\b/i
/** Retries come and go on a busy model; ten minutes of them is a model the work cannot get answers from. */
const MODEL_WAIT_MS = 10 * 60_000
/** How long a screen must stay clear of retries before its model counts as answering again. Between retries the engine
 *  shows a plain spinner for the minutes a new attempt takes: 2026-10-24, a Builder on Qwen3.6 35B, whose every answer the
 *  relay had already dropped, read as answering on each attempt, so its ten minutes never ran out. */
const MODEL_CLEAR_MS = 10 * 60_000

/** Whether the screen shows its engine retrying its model. */
export function modelFailing(text: string): boolean {
  return text.split('\n').slice(-LIMIT_NEAR_LINES).some(line => MODEL_LINE.test(line))
}

/** A usage limit on screen, with when it resets if the screen says; null for none. */
export function limitOf(text: string, now: number): { resetAt?: string } | null {
  const lines = text.split('\n')
  const tail = lines.slice(-LIMIT_NEAR_LINES)
  const at = tail.findIndex(line => LIMIT_LINE.test(line))
  if (at < 0) return null
  const said = tail.slice(at, at + 3).join(' ')
  const reset = resetOf(said, now)
  return reset === null ? {} : { resetAt: new Date(reset).toISOString() }
}

function resetOf(said: string, now: number): number | null {
  const span = /try again in\s+([^.]*)/i.exec(said)
  if (span) {
    let ms = 0
    for (const [, n, unit] of span[1]!.matchAll(/(\d+)\s*(day|hour|minute|min|h|m)/gi)) {
      ms += Number(n) * ({ day: 86_400_000, hour: 3_600_000, h: 3_600_000 } as Record<string, number>)[unit!.toLowerCase()]! || Number(n) * 60_000
    }
    if (ms) return now + ms
  }
  // The engines say a local time ("3pm", "4:05 PM"), with a date when it is not today ("Oct 25, 9am"; Codex's
  // "Oct 27th, 2026 3:05 PM").
  const time = /(?:resets?(?: at)?|try again at)\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(said)
  if (!time) return null
  const [, month, day, year, hour, minute, half] = time
  // "3pm" and "12am" are 12-hour; "15:00" and "0:30", with no am or pm, are 24-hour.
  const h = half ? Number(hour) % 12 + (half.toLowerCase() === 'pm' ? 12 : 0) : Number(hour)
  const date = new Date(now)
  if (month && MONTHS.includes(month.toLowerCase())) date.setFullYear(year ? Number(year) : date.getFullYear(), MONTHS.indexOf(month.toLowerCase()), Number(day))
  date.setHours(h, Number(minute ?? 0), 0, 0)
  // A time already past today is tomorrow's; a date already past is next year's, unless the engine named the year.
  if (date.getTime() <= now && !year) month ? date.setFullYear(date.getFullYear() + 1) : date.setDate(date.getDate() + 1)
  return date.getTime()
}

/** What Claude Code and Codex redraw every second while they work, whether or not the work moves: the spinner line with
 *  its elapsed time and token counter ("✻ Pondering… (2m 14s · ↓ 3.1k tokens · esc to interrupt)", "• Working (1m 05s •
 *  esc to interrupt)"), Claude Code's rotating tip under it, and a retry's countdown. A stuck agent's screen changes all
 *  the time through them (Lead, 2026-10-26), so they are left out of what counts as progress. */
const STATUS_LINE = /esc to (?:interrupt|cancel)|^\W*[A-Za-z][\w ]*…\s*\(|^\s*⎿\s+tip:|will retry in/i

/** A short digest of the screen without its status lines: two screens with the same one show the same work. */
function screenDigest(text: string): string {
  const lines = text.split('\n').filter(line => !STATUS_LINE.test(line)).map(line => line.trimEnd())
  return createHash('sha256').update(lines.join('\n')).digest('base64url')
}

type Episode = { since: number; alerted: boolean } | null
interface Watched { prompt: Episode; limit: Episode; model: Episode; retried?: number }

export class TerminalHost {
  private nextServeAt = 0
  private nextWatchAt = 0
  private serving: Promise<void> | null = null
  private watching: Promise<void> | null = null
  private readonly watched = new Map<string, Watched>()
  /** Per running harness here, its last screen's digest and when that last changed. */
  private readonly progress = new Map<string, { digest: string; at: number }>()
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly core: CoreApi, private readonly machineId: string, options: { now?: () => number; log?: (message: string) => void } = {}) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? (message => console.warn(`[super-tabs] ${message}`))
  }

  /** Each host roster read. Serving and watching run on their own cadence, and the returned promise is only for specs:
   *  the host never waits on it, so a slow screen read never delays deliveries. */
  tick(rows: unknown[]): Promise<void> {
    const here = this.here(rows)
    if (!here.length) { this.watched.clear(); this.progress.clear(); return Promise.resolve() }
    const own = here.filter(agent => agent.running)
    const now = this.now()
    if (!this.serving && now >= this.nextServeAt) {
      this.nextServeAt = now + SERVE_EVERY_MS
      this.serving = this.serve(here).catch(error => this.log(error instanceof Error ? error.message : String(error))).finally(() => { this.serving = null })
    }
    if (!this.watching && now >= this.nextWatchAt) {
      this.nextWatchAt = now + WATCH_EVERY_MS
      this.watching = this.watch(own).catch(error => this.log(error instanceof Error ? error.message : String(error))).finally(() => { this.watching = null })
    }
    return Promise.all([this.serving, this.watching]).then(() => {})
  }

  /** When each of these harnesses' screens last changed, epoch ms, for those running here that the watch has read. An
   *  agent's first read counts as a change: the host cannot know what its screen showed before. */
  progressOf(harnessIds: readonly string[]): Record<string, number> {
    return Object.fromEntries(harnessIds.flatMap(id => {
      const seen = this.progress.get(id)
      return seen ? [[id, seen.at]] : []
    }))
  }

  /** This machine's Swarm agents, as the roster names them, and whether each runs here: a stopping one, or one whose
   *  session is gone, is no longer anyone's to drive, but its requests are still this host's to answer. */
  private here(rows: unknown[]): Array<Own & { running: boolean }> {
    return rows.map(object).flatMap(row => {
      const agent = object(row.agent)
      return identifier(row.tabId) && identifier(agent.id) && identifier(agent.harnessId) && agent.machineId === this.machineId
        ? [{ tabId: row.tabId, agentId: agent.id, harnessId: agent.harnessId, running: row.stopRequested !== true && !!this.core.agents.byAgent(agent.harnessId) }] : []
    })
  }

  private async serve(here: Array<Own & { running: boolean }>): Promise<void> {
    const rows = await backend(this.core, 'POST', `/api/super-tabs/hosts/${this.machineId}/terminal`)
    if (!Array.isArray(rows)) throw new Error('Invalid Super Tab terminal requests.')
    await Promise.all(rows.map(object).map(async row => {
      const request = object(row.request)
      const kind = request.kind
      if (!identifier(request.id) || (kind !== 'screen' && kind !== 'input')) return
      const agent = here.find(a => a.tabId === row.tabId && a.agentId === row.agentId)
      // Not an agent of this machine: the host may not answer as it.
      if (!agent) return this.log(`terminal request ${request.id} names no agent of this machine`)
      // Answered at once, so the Lead is not left waiting out the backend's 30 s (review of #1646).
      const answer = !agent.running ? { ok: false, error: NOT_RUNNING }
        // After a restart the agent may run in another terminal: never read or type into one the Lead did not ask about.
        : row.harnessId !== agent.harnessId ? { ok: false, error: CHANGED }
        : kind === 'screen' ? this.screen(agent, request) : this.input(agent, request)
      await this.command(agent, `terminal-${request.id}`, { type: kind === 'screen' ? 'agent.screenResult' : 'agent.inputResult', requestId: request.id, ...await answer })
    }))
  }

  private async screen(agent: Own, request: Json): Promise<Json> {
    const scrollback = typeof request.scrollback === 'number' ? request.scrollback : 0
    const read = await this.core.superTabs!.screen(agent.harnessId, scrollback)
    // The backend keeps a reason to 500 characters.
    return read.ok ? { ok: true, text: capScreen(read.text) } : { ok: false, error: read.error.slice(0, 500) }
  }

  private async input(agent: Own, request: Json): Promise<Json> {
    const keys = typedKeys(Array.isArray(request.keys) ? request.keys : [])
    if (typeof keys === 'string') return { ok: false, error: keys }
    const text = typeof request.text === 'string' ? request.text : ''
    // The text is typed literally, so a newline or an escape in it would act as a key the Lead never named (the backend
    // refuses them too).
    if (/[\x00-\x1f\x7f]/.test(text)) return { ok: false, error: 'Send Enter and other keys as named keys, not in the text.' }
    return { ...await this.core.superTabs!.input(agent.harnessId, text, keys) }
  }

  private async command(agent: Own, operationId: string, command: Json): Promise<void> {
    await backend(this.core, 'POST', `/api/super-tabs/${agent.tabId}/commands`, { operationId, asAgentId: agent.agentId, command })
  }

  /** One alert per episode: a prompt waiting 3 minutes, a usage limit on screen, or its model failing for 10 minutes; each
   *  ended once it is gone. An alert
   *  the backend did not take is tried again on the next read. */
  private async watch(own: Own[]): Promise<void> {
    const keys = new Set(own.map(a => `${a.tabId}:${a.agentId}`))
    for (const key of this.watched.keys()) if (!keys.has(key)) this.watched.delete(key)
    const harnesses = new Set(own.map(a => a.harnessId))
    for (const id of this.progress.keys()) if (!harnesses.has(id)) this.progress.delete(id)
    for (const agent of own) {
      const key = `${agent.tabId}:${agent.agentId}`
      const state = this.watched.get(key) ?? { prompt: null, limit: null, model: null }
      this.watched.set(key, state)
      // A screen that could not be read says nothing either way.
      const read = await this.core.superTabs!.screen(agent.harnessId, 0).catch(() => null)
      if (!read?.ok) continue
      const now = this.now()
      const digest = screenDigest(read.text), seen = this.progress.get(agent.harnessId)
      // A model being retried is not the agent's work moving, whatever else the screen shows meanwhile.
      if (!seen || (seen.digest !== digest && !modelFailing(read.text))) this.progress.set(agent.harnessId, { digest, at: now })
      state.prompt = await this.episode(agent, 'prompt', state.prompt, read.hold !== null && WAITING.has(read.hold), now, since => now - since >= PROMPT_WAIT_MS, {})
      const limit = limitOf(read.text, now)
      state.limit = await this.episode(agent, 'limit', state.limit, limit !== null, now, () => true, limit ?? {})
      if (modelFailing(read.text)) state.retried = now
      const retrying = state.retried !== undefined && now - state.retried < MODEL_CLEAR_MS
      state.model = await this.episode(agent, 'model', state.model, retrying, now, since => now - since >= MODEL_WAIT_MS, {})
    }
  }

  private async episode(agent: Own, alert: 'prompt' | 'limit' | 'model', current: Episode, seen: boolean, now: number,
    due: (since: number) => boolean, extra: Json): Promise<Episode> {
    const episode = seen ? current ?? { since: now, alerted: false } : current
    if (!episode) return null
    if (seen === episode.alerted || (seen && !due(episode.since))) return seen ? episode : null
    try {
      await this.command(agent, `terminal-alert-${agent.agentId}-${alert}-${episode.since}-${seen ? 'on' : 'off'}`,
        { type: 'agent.alert', agentId: agent.agentId, alert, active: seen, ...(seen ? extra : {}) })
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error))
      return episode
    }
    return seen ? { ...episode, alerted: true } : null
  }
}
