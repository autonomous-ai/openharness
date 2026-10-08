import { open, stat } from 'node:fs/promises'
import type { ActivityMatch, SessionStoreContract } from '../engines/facets/sessionStore.js'
import { sessionStoreOf } from '../engines/sessionStoreContracts.js'

type Activity = NonNullable<SessionStoreContract['activity']>

const CHUNK_BYTES = 64 * 1024
const MAX_TAIL_BYTES = 2 * 1024 * 1024
const cache = new Map<string, { signature: string; value: Promise<number | null> }>()
let reading = 0
const waiting: Array<() => void> = []

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

/** The first object at one of `paths` in `row`. */
function itemOf(row: Record<string, unknown>, paths: readonly (readonly string[])[]): Record<string, unknown> | null {
  for (const path of paths) {
    let at: unknown = row
    for (const key of path) at = object(at)?.[key]
    const found = object(at)
    if (found) return found
  }
  return null
}

function matches(value: unknown, match: ActivityMatch): boolean {
  return 'in' in match ? match.in.includes(String(value)) : match.is.some((one) => value === one)
}

/** Metadata can be rewritten when an idle harness is discovered or resumed. Only conversation
 * records count, as the engine's session store declares them (`activity`); a fresh file mtime, title,
 * context snapshot, or rate-limit reading does not. */
function activity(line: string, rule: Activity): number | null {
  let row: Record<string, unknown> | null
  try { row = object(JSON.parse(line)) } catch { return null }
  if (!row || typeof row[rule.at] !== 'string') return null
  const at = Date.parse(row[rule.at] as string)
  if (!Number.isFinite(at)) return null
  const item = rule.item ? itemOf(row, rule.item) : null
  const counted = rule.records.some((kind) => row!.type === kind.type
    && Object.entries(kind.fields ?? {}).every(([field, match]) => matches(row![field], match))
    && (!kind.item || (!!item && Object.entries(kind.item).every(([field, match]) => matches(item[field], match)))))
  return counted ? at : null
}

async function readActivity(path: string, size: number, rule: Activity): Promise<number | null> {
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
            const at = activity(line, rule)
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

/** Read the latest dated work from the JSONL formats whose engines declare it (their session store's
 * `activity`). Bounded tail reads are shared by list/push frames and cached until the file changes; no
 * transcript text is retained. Other engines use the caller's last hook instead of pretending their
 * database/file modification time is activity. */
export async function transcriptActivityAt(path: string | null, engine: string): Promise<number | null> {
  const rule = sessionStoreOf(engine)?.activity
  if (!path || !rule) return null
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || !info.size) return null
  const key = `${engine}:${path}`
  const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const found = cache.get(key)
  if (found?.signature === signature) return found.value
  if (cache.size >= 512) cache.delete(cache.keys().next().value!)
  const value = readActivity(path, info.size, rule)
  cache.set(key, { signature, value })
  return value
}
