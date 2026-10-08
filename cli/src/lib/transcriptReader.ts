/**
 * Reading a transcript for search and session discovery: line by line from a byte offset, through the same
 * incremental normalizer each engine uses for its live view.
 *
 * Transcripts are large (a long Codex rollout runs to gigabytes) and nearly all of it is tool output.
 * The reader looks at the first bytes of each line and drops the output records before they are
 * decoded or parsed, and never holds more than one line in memory — a 200 MB command dump costs a
 * seek, not a parse.
 */

import type { LiveEvent } from './normalize.js'
import { lineToEvents, newTurnState } from './normalize.js'
import { AgyNormalizer } from '../engines/agy/normalizer.js'
import { AmpNormalizer } from '../engines/amp/normalizer.js'
import { CodexNormalizer } from '../engines/codex/normalizer.js'
import { epochMs } from './sessionSearch/externals/support.js'
import { CommandCodeNormalizer } from '../engines/commandcode/normalizer.js'
import { CopilotNormalizer } from '../engines/copilot/normalizer.js'
import { CursorNormalizer } from '../engines/cursor/normalizer.js'
import { GrokNormalizer } from '../engines/grok/normalizer.js'
import { MuseNormalizer } from '../engines/muse/normalizer.js'
import { PiNormalizer } from '../engines/pi/normalizer.js'

export type LineNormalizer = (line: string) => LiveEvent[]

/**
 * A fresh normalizer for one pass over one transcript, or null for an engine whose history is not a
 * JSONL file (OpenCode, Kilo, Hermes and Devin keep theirs in a database; a terminal has none).
 * Fresh on every pass: a pass starts at a turn boundary, where no earlier state is needed.
 */
export function lineNormalizer(engine: string, sessionId: string): LineNormalizer | null {
  switch (engine) {
    case 'claude': {
      const state = newTurnState()
      return (line) => {
        const events = lineToEvents(line, state)
        const asked = claudeSideAsk(line)
        return asked ? [{ type: 'user_message', payload: { content: asked } }, ...events] : events
      }
    }
    case 'codex': {
      // Sub-agent threads are resolved for the live view's cards; search only needs the text.
      const normalizer = new CodexNormalizer('live', () => null)
      return (line) => normalizer.ingest(line)
    }
    case 'cursor': {
      const normalizer = new CursorNormalizer('live', sessionId)
      return (line) => normalizer.ingest(line)
    }
    // A Muse session log mirrors its sub-agents' and reminders' streams: only its own is the conversation.
    case 'muse': return kept(ingestWith(new MuseNormalizer()), (line) => museOwnStream(line, sessionId))
    case 'amp': return ingestWith(new AmpNormalizer())
    case 'grok': return ingestWith(new GrokNormalizer())
    case 'agy': return ingestWith(new AgyNormalizer())
    // A Copilot session file holds its sub-agents' events too, and prompts nobody typed.
    case 'copilot': return kept(ingestWith(new CopilotNormalizer()), copilotOwnLine)
    case 'pi': return ingestWith(new PiNormalizer('live'))
    case 'commandcode': return ingestWith(new CommandCodeNormalizer('live'))
    default: return null
  }
}

/**
 * The person's words that Claude Code writes outside its prompt records. The live view leaves them out
 * on purpose, since neither opens a turn there, but both are things a person remembers asking:
 *  - a message typed while the agent was working, delivered mid-turn as a `queued_command` attachment
 *    (sub-agent hand-backs arrive the same way and are filed under the agent by `askKind`; task
 *    notifications are not prompts and are left out);
 *  - a `/goal`, whose text is recorded only in the bookkeeping line that turns its Stop hook on.
 */
export function claudeSideAsk(line: string): string | null {
  const queued = line.includes('"queued_command"')
  if (!queued && !(line.includes('"isMeta":true') && line.includes(GOAL_HEAD))) return null
  let raw: {
    type?: unknown; isMeta?: unknown; message?: { content?: unknown }
    attachment?: { type?: unknown; commandMode?: unknown; prompt?: unknown; origin?: { kind?: unknown } }
  }
  try { raw = JSON.parse(line) } catch { return null }
  if (queued) {
    const attachment = raw.attachment
    if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') return null
    // "Goal set: …", which Claude queues for itself: the goal's own line below already holds it.
    if (attachment.origin?.kind === 'auto-continuation') return null
    return promptText(attachment.prompt)
  }
  if (raw.type !== 'user' || raw.isMeta !== true) return null
  const goal = GOAL_SET.exec(promptText(raw.message?.content) ?? '')
  return goal ? goal[1].trim() || null : null
}

const GOAL_HEAD = 'A session-scoped Stop hook is now active with condition: '
const GOAL_SET = /^A session-scoped Stop hook is now active with condition: "([\s\S]*)"\. Briefly acknowledge/

/** A prompt's text: a string, or the text blocks of a content array. */
function promptText(prompt: unknown): string | null {
  if (typeof prompt === 'string') return prompt.trim() ? prompt : null
  if (!Array.isArray(prompt)) return null
  const text = prompt
    .map((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? (block as { text?: unknown }).text : null)
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n')
  return text || null
}

function ingestWith(normalizer: { ingest(line: string): LiveEvent[] }): LineNormalizer {
  return (line) => normalizer.ingest(line)
}

/** [normalize], for the lines [keep] accepts only. */
function kept(normalize: LineNormalizer, keep: (line: string) => boolean): LineNormalizer {
  return (line) => keep(line) ? normalize(line) : []
}

const MUSE_STREAM = /"stream"\s*:\s*\{[^{}]*"id"\s*:\s*"([^"]+)"/

/** Whether a Muse record belongs to [sessionId]'s own stream (a record naming none is kept). */
export function museOwnStream(line: string, sessionId: string): boolean {
  const stream = MUSE_STREAM.exec(line)?.[1]
  return !stream || stream === sessionId
}

/**
 * Whether a Copilot event is the conversation's own: not a sub-agent's (those carry `agentId`), and not
 * a prompt nobody typed (a skill's or another agent's, whose `source` is `skill-…` or `agent-…`, or
 * an autopilot continuation).
 */
export function copilotOwnLine(line: string): boolean {
  if (!line.includes('"agentId"') && !line.includes('"source"') && !line.includes('isAutopilotContinuation')) return true
  let event: { agentId?: unknown; type?: unknown; data?: { source?: unknown; isAutopilotContinuation?: unknown } }
  try { event = JSON.parse(line) } catch { return true }
  if (typeof event.agentId === 'string' && event.agentId) return false
  if (event.type !== 'user.message') return true
  const source = typeof event.data?.source === 'string' ? event.data.source : ''
  return !/^(?:skill|agent)-/.test(source) && event.data?.isAutopilotContinuation !== true
}

/**
 * Records that carry only tool output, reasoning or accounting, told apart by their opening bytes.
 * Skipping them is safe because the turn collector reads prompts, answer text and tool calls only;
 * `transcript.spec.ts` checks the turns come out the same with and without the skip.
 */
const SKIP_HEAD: Record<string, RegExp> = {
  codex: /"type":"(?:function_call_output|custom_tool_call_output|reasoning|token_count|local_shell_call_output|web_search_call_output)"|^\{"timestamp":"[^"]*","type":"token_usage_record"/,
  // A user record whose content is a tool result. A prompt can never open with one.
  claude: /^\{[^]*?"type":"user"[^]*?"content":\[\{"tool_use_id"|^\{[^]*?"type":"user"[^]*?"content":\[\{"type":"tool_result"/,
}


export function skipPredicate(engine: string): ((head: string) => boolean) | null {
  const pattern = SKIP_HEAD[engine]
  return pattern ? (head) => pattern.test(head) : null
}

const TIMESTAMP = /"timestamp"\s*:\s*"([^"]{10,40})"/
/** The fields other engines date their lines with: Grok's epoch seconds, Muse's microseconds,
 *  Antigravity's ISO `created_at`. */
const OTHER_TIMES = [
  /"timestamp"\s*:\s*(\d{9,19}(?:\.\d+)?)[,}]/,
  /"recorded_at"\s*:\s*(\d{9,19})[,}]/,
  /"created_at"\s*:\s*"([^"]{10,40})"/,
]

/** When a transcript line was written, from its own time field; null when it has none. */
export function lineTime(line: string): number | null {
  const iso = TIMESTAMP.exec(line)
  if (iso) {
    const at = Date.parse(iso[1])
    return Number.isFinite(at) ? at : null
  }
  for (const pattern of OTHER_TIMES) {
    const match = pattern.exec(line)
    if (match) return epochMs(match[1])
  }
  return null
}

export { forEachLine, type LineVisit } from './transcriptLines.js'
