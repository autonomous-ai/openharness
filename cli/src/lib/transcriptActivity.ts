import { open, stat } from 'node:fs/promises'

const CHUNK_BYTES = 64 * 1024
const MAX_TAIL_BYTES = 2 * 1024 * 1024
const cache = new Map<string, { signature: string; value: Promise<number | null> }>()
let reading = 0
const waiting: Array<() => void> = []

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

const codexEvents = new Set([
  'user_message', 'UserMessage', 'agent_message', 'AgentMessage',
  'task_started', 'task_complete', 'turn_aborted', 'context_compacted',
])
const codexResponses = new Set([
  'reasoning', 'function_call', 'custom_tool_call', 'tool_search_call',
  'function_call_output', 'custom_tool_call_output', 'tool_search_output',
])

/** Metadata can be rewritten when an idle harness is discovered or resumed. Only conversation
 * records count; a fresh file mtime, title, context snapshot, or rate-limit reading does not. */
function activity(line: string, engine: string): number | null {
  let row: Record<string, unknown> | null
  try { row = object(JSON.parse(line)) } catch { return null }
  if (!row || typeof row.timestamp !== 'string') return null
  const at = Date.parse(row.timestamp)
  if (!Number.isFinite(at)) return null
  if (engine === 'claude') {
    return row.type === 'user' || row.type === 'assistant'
      || row.type === 'system' && ['turn_duration', 'stop_hook_summary', 'compact_boundary'].includes(String(row.subtype))
      ? at : null
  }
  const direct = object(row.payload)
  const item = object(direct?.item) ?? direct
  if (row.type === 'event_msg' && codexEvents.has(String(item?.type))) return at
  if (row.type === 'response_item' && item) {
    if (codexResponses.has(String(item.type))) return at
    if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) return at
  }
  return row.type === 'compacted' ? at : null
}

async function readActivity(path: string, size: number, engine: string): Promise<number | null> {
  if (reading >= 4) await new Promise<void>(resolve => waiting.push(resolve))
  else reading++
  try {
    const file = await open(path, 'r')
    try {
      let end = size
      let remaining = MAX_TAIL_BYTES
      let prefix = Buffer.alloc(0)
      while (end > 0 && remaining > 0) {
        const length = Math.min(CHUNK_BYTES, end, remaining)
        const start = end - length
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await file.read(buffer, 0, length, start)
        // The file was truncated while being read. Let the next frame retry its new signature.
        if (bytesRead !== length) return null
        const chunk = Buffer.concat([buffer, prefix])
        const newline = start === 0 ? -1 : chunk.indexOf(10)
        if (start === 0 || newline !== -1) {
          const complete = start === 0 ? chunk : chunk.subarray(newline + 1)
          let latest: number | null = null
          for (const line of complete.toString('utf8').split('\n')) {
            const at = activity(line, engine)
            if (at !== null) latest = Math.max(latest ?? at, at)
          }
          if (latest !== null) return latest
          prefix = start === 0 ? Buffer.alloc(0) : chunk.subarray(0, newline + 1)
        } else {
          // Keep a partial large record until the preceding chunk completes it.
          prefix = chunk
        }
        end = start
        remaining -= length
      }
      return null
    } finally {
      await file.close()
    }
  } catch {
    return null
  } finally {
    const next = waiting.shift()
    if (next) next()
    else reading--
  }
}

/** Read the latest dated work from known JSONL formats. Bounded tail reads are shared by list/push
 * frames and cached until the file changes; no transcript text is retained. Other engines use the
 * caller's last hook instead of pretending their database/file modification time is activity. */
export async function transcriptActivityAt(path: string | null, engine: string): Promise<number | null> {
  if (!path || (engine !== 'claude' && engine !== 'codex')) return null
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || !info.size) return null
  const key = `${engine}:${path}`
  const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const found = cache.get(key)
  if (found?.signature === signature) return found.value
  if (cache.size >= 512) cache.delete(cache.keys().next().value!)
  const value = readActivity(path, info.size, engine)
  cache.set(key, { signature, value })
  return value
}
