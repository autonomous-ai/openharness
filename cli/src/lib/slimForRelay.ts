/**
 * Transcript events as apps away from this computer get them: what their readers read, and nothing the engine wrote
 * for itself (docs/plans/2026-10-31-live-events-relay-design.md, change 4).
 *
 * A transcript event carries a tool's whole input, its output's head, thinking text and pasted images, and every one
 * crossed the relay: the backend parses it, publishes it to Redis and writes it again to each socket, and the phone,
 * the browser and the terminal app read little of it (one Desktop's day of 2026-10-30: about 31,900 such frames,
 * 19% of all it received). No app away from here reads `tool_end.output`, `.summary`, `.subagent`,
 * `.durationSeconds`, `thinking_delta.content`, `context_compact`, `subagent_finished.summary` or
 * `user_message.images`. A tool's input stays, bounded: the terminal app draws a plan, a command, a path or a query
 * from it. `subagent_finished` is not sealed (lib/e2ee/core.ts, pinned with other repositories' clients), so its
 * summary, a sub-agent's own words, no longer crosses in the clear.
 *
 * Only the remote path uses it (backendSocket.ts `toRemoteApps`): windows on this computer and everything inside the
 * daemon keep the full event. Pure; never changes what it is given.
 */
type Frame = Record<string, unknown>

/** In every payload: what every app reads to place an event (its agent, its session, a replayed history) and the
 *  activity it shows. */
const ALWAYS = ['activity', 'agentId', 'sessionId', 'replay'] as const

/** The payload fields each transcript event keeps. An event not listed (turn_started, turn_ended, everything else)
 *  goes whole. */
const KEEP: Record<string, readonly string[]> = {
  user_message: ['content'],
  text_delta: ['content'],
  thinking_delta: [],
  thinking_title: ['title', 'thinkingId'],
  tool_start: ['id', 'tool', 'parentToolUseId', 'input'],
  tool_end: ['id', 'tool', 'parentToolUseId', 'isError'],
  subagent_finished: ['id', 'status'],
  done: ['result'],
  context_compact: [],
}

/** A tool input's bounds: a 2 MB Write goes as a path and 200 characters. */
const INPUT_STRING = 200
const INPUT_ITEMS = 50
const INPUT_DEPTH = 4
const DONE_RESULT = 500

/** `text` cut to `max` UTF-16 units, never between the two halves of a character. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]!) ? max - 1 : max
  return text.slice(0, end)
}

/** A tool input within its bounds: strings cut, lists and objects to their first 50 entries, and nothing nested past
 *  four levels (`input` itself is the first). */
function bounded(value: unknown, depth = 1): unknown {
  if (typeof value === 'string') return cut(value, INPUT_STRING)
  if (value === null || typeof value !== 'object') return value
  if (depth > INPUT_DEPTH) return undefined
  if (Array.isArray(value)) return value.slice(0, INPUT_ITEMS).map((item) => bounded(item, depth + 1)).filter((item) => item !== undefined)
  const kept: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, INPUT_ITEMS)) {
    const inner = bounded(item, depth + 1)
    if (inner !== undefined) kept[key] = inner
  }
  return kept
}

export function slimForRelay(frame: Frame): Frame {
  const keep = typeof frame.type === 'string' ? KEEP[frame.type] : undefined
  const payload = frame.payload
  if (!keep || !payload || typeof payload !== 'object' || Array.isArray(payload)) return frame
  const given = payload as Record<string, unknown>
  const slim: Record<string, unknown> = {}
  for (const key of [...keep, ...ALWAYS]) if (key in given) slim[key] = given[key]
  if ('input' in slim) slim.input = bounded(slim.input)
  if (frame.type === 'done' && typeof slim.result === 'string') slim.result = cut(slim.result, DONE_RESULT)
  return { ...frame, payload: slim }
}
