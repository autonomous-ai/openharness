/**
 * A conversation continued in another file, as an engine's session store declares it (`continuation`). Moved
 * from lib/sessionRepair.ts (claudeContinuation), whose every answer this reproduces
 * (engines/sessionStore.golden.spec.ts). Cheap and bounded: it runs on every reconciler pass, so a continuation
 * that is real binds on the pass after its first turn lands.
 */
import { open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionStoreContract } from '../facets/sessionStore.js'

type Continuation = NonNullable<SessionStoreContract['continuation']>

/** The last `maxBytes` of a file, as text. */
async function tailBytes(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - maxBytes)
    const length = info.size - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf-8')
  } finally {
    await handle.close()
  }
}

/** The first `maxBytes` of a file. */
export async function headBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const length = Math.min((await handle.stat()).size, maxBytes)
    if (length <= 0) return Buffer.alloc(0)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, read)
      if (!bytesRead) break
      read += bytesRead
    }
    return buffer.subarray(0, read)
  } finally {
    await handle.close()
  }
}

/**
 * Whether a transcript holds a conversation, rather than being the file opened for a session nobody has spoken
 * in yet: a record of the declared turn types in its head, or more file than the head (a continuation can open
 * on a bookkeeping record large enough to push the first turn past the bound, and what is ruled out is two
 * short lines). The bytes read are counted, not decoded characters.
 */
async function hasConversationTurn(rule: Continuation, path: string): Promise<boolean> {
  let head: Buffer
  try {
    head = await headBytes(path, rule.headBytes)
  } catch {
    return false
  }
  const quoted = rule.turns.map((type) => `"${type}"`)
  for (const line of head.toString('utf-8').split('\n')) {
    if (!line.trim() || !quoted.some((type) => line.includes(type))) continue
    try {
      const record = JSON.parse(line) as { type?: unknown }
      if (typeof record.type === 'string' && rule.turns.includes(record.type)) return true
    } catch { /* a line cut by the read bound, or one this version does not know */ }
  }
  return head.length >= rule.headBytes
}

/** The session a transcript's last record says the conversation continued in, once that file holds a turn. */
export async function continuedIn(rule: Continuation, transcriptPath: string): Promise<{ sessionId: string; transcriptPath: string } | null> {
  let tail: string
  try {
    tail = await tailBytes(transcriptPath, rule.tailBytes)
  } catch {
    return null
  }
  const lines = tail.split('\n').map((line) => line.trim()).filter(Boolean)
  const lastLine = lines[lines.length - 1]
  if (!lastLine) return null
  let record: Record<string, unknown>
  try {
    record = JSON.parse(lastLine) as Record<string, unknown>
  } catch {
    return null
  }
  const nextId = record.type === rule.type && typeof record[rule.field] === 'string' ? record[rule.field] as string : ''
  if (!nextId) return null
  const nextPath = join(dirname(transcriptPath), `${nextId}${rule.suffix}`)
  try {
    if (!(await stat(nextPath)).isFile()) return null
  } catch {
    return null
  }
  if (!await hasConversationTurn(rule, nextPath)) return null
  return { sessionId: nextId, transcriptPath: nextPath }
}
