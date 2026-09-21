/**
 * When did this harness last actually do something?
 *
 * The obvious answers are all wrong, and each one is wrong in a way that would pause the fleet's living
 * agents or keep its dead ones running:
 *
 *   the registry's `updatedAt`  the daemon reconciles every five seconds, so every row reads "now"
 *   the transcript's mtime      a running engine appends bookkeeping — task notifications, away
 *                               summaries, queue operations — to conversations nobody has touched in
 *                               days; on this machine that made 34 of 85 harnesses look an hour old
 *   the pane's tmux activity    a spinner redraw is activity, and an engine that exited hours ago
 *                               leaves its last frame on screen forever
 *
 * What a person means by "nobody has touched this since Tuesday" is the last TURN: a message from them
 * or from the agent. That is in the transcript, and it is at the end of it, so the tail is enough — a
 * bounded read from the back of the file, newest line first, stopping at the first real turn.
 *
 * Every engine that writes JSONL is handled by naming the line types that are turns; the others fall
 * back to the hook timestamps the daemon records, which is exactly what this module tells its caller by
 * returning null rather than guessing.
 */

import { open, stat } from 'node:fs/promises'

/** How far back to read. A turn line is rarely over a few KB, and bookkeeping lines between turns are
 *  small; 256 KB reaches past dozens of them without ever loading a long conversation into memory. */
const TAIL_BYTES = 256 * 1024

/**
 * Line types that mean "a turn happened", per engine family.
 *
 * Claude Code writes `user` and `assistant` rows, and a lot else besides (`system`, `summary`,
 * `queue-operation`, `file-history-snapshot`) — those are the lines that made mtime useless, so they
 * are named here as NOT turns rather than filtered by guesswork. Codex rollouts wrap everything in
 * `response_item`/`event_msg` with a `payload.type`, where the turn is a `message`.
 */
const TURN_TYPES = new Set(['user', 'assistant', 'message', 'response_item'])
const NOT_TURNS = new Set(['system', 'summary', 'queue-operation', 'file-history-snapshot', 'progress', 'turn_context', 'session_meta', 'compact_boundary', 'event_msg'])

/** A timestamp from whichever field this engine's writer used. */
function timeOf(record) {
  for (const key of ['timestamp', 'ts', 'created_at', 'createdAt', 'time']) {
    const raw = record?.[key]
    if (typeof raw === 'number' && raw > 1e12) return raw
    if (typeof raw === 'number' && raw > 1e9) return raw * 1000
    if (typeof raw === 'string') { const parsed = Date.parse(raw); if (Number.isFinite(parsed)) return parsed }
  }
  return null
}

function isTurn(record) {
  const type = record?.type
  if (typeof type !== 'string') return false
  if (NOT_TURNS.has(type) && type !== 'response_item') return false
  if (type === 'response_item' || type === 'event_msg') {
    const inner = record.payload?.type
    return inner === 'message' || inner === 'agent_message' || inner === 'user_message'
  }
  return TURN_TYPES.has(type)
}

/**
 * The last turn in a JSONL transcript, in epoch ms — or null when the file cannot answer.
 *
 * `cache` keys on path + size + mtime, so a refresh that changes nothing re-reads nothing: the viewer
 * polls every few seconds over a fleet of eighty, and eighty unchanged files must cost eighty `stat`s,
 * not eighty reads.
 */
export async function lastTurnAt(path, { cache = new Map() } = {}) {
  if (typeof path !== 'string' || !path) return null
  let info
  try { info = await stat(path) } catch { return null }
  const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}`
  if (cache.has(key)) return cache.get(key)

  let answer = null
  let handle
  try {
    handle = await open(path, 'r')
    const length = Math.min(TAIL_BYTES, info.size)
    const buffer = Buffer.allocUnsafe(length)
    await handle.read(buffer, 0, length, Math.max(0, info.size - length))
    const text = buffer.toString('utf8')
    // Drop the first line when the window started mid-file: it is a fragment, and a fragment that
    // happens to parse is worse than one that does not.
    const lines = text.split('\n')
    if (info.size > length) lines.shift()
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim()
      if (!line || line[0] !== '{') continue
      let record; try { record = JSON.parse(line) } catch { continue }
      if (!isTurn(record)) continue
      const when = timeOf(record)
      if (when) { answer = when; break }
    }
    // A transcript with no turn in its whole tail still has a floor: the file exists and was written,
    // so its own mtime is not evidence of a turn but it IS evidence the session is not ancient. Left
    // as null on purpose — the caller has better fallbacks (the daemon's hook timestamps) than a
    // number this module would be inventing.
  } catch { answer = null }
  finally { await handle?.close().catch(() => {}) }

  if (cache.size > 512) cache.clear()
  cache.set(key, answer)
  return answer
}

/**
 * The activity signal for a whole fleet: `{ [agentId]: lastTurnMs }`, read in parallel with a bounded
 * concurrency so a fleet of a hundred does not open a hundred files at once.
 */
export async function lastTurns(entries, { cache = new Map(), concurrency = 16 } = {}) {
  const out = new Map()
  const queue = [...entries]
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      const when = await lastTurnAt(next.transcriptPath, { cache })
      if (when) out.set(next.id, when)
    }
  })
  await Promise.all(workers)
  return out
}
