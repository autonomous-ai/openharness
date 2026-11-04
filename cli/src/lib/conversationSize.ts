/**
 * How long a Claude Code conversation is now, in tokens: what its next turn would send. A Buddy moved onto a shared
 * model starts fresh when its conversation does not fit that model's window (docs/plans/2026-11-03-buddy-model-switch-design.md).
 *
 * The newest assistant entry's usage already counts the whole conversation it answered (input, cached and new) plus
 * its own answer, so only the transcript's tail is read: a long transcript costs no more than a short one.
 */
import { open } from 'node:fs/promises'

const TAIL_BYTES = 256 * 1024

const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** The newest assistant entry's tokens in the last 256 KB of a transcript; null when there is none or it cannot be read. */
export async function conversationTokens(transcriptPath: string): Promise<number | null> {
  let text: string
  let partial: boolean
  try {
    const file = await open(transcriptPath, 'r')
    try {
      const { size } = await file.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const buffer = Buffer.alloc(size - start)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
      text = buffer.subarray(0, bytesRead).toString('utf8')
      partial = start > 0
    } finally { await file.close() }
  } catch { return null }
  const lines = text.split('\n')
  // Read from the middle of the file, the first line is the end of one that started before the tail.
  if (partial) lines.shift()
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; message?: { usage?: unknown } }
    try { entry = JSON.parse(lines[i]) } catch { continue }
    const usage = entry?.type === 'assistant' ? entry.message?.usage : undefined
    if (!usage || typeof usage !== 'object') continue
    const u = usage as Record<string, unknown>
    return count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens) + count(u.output_tokens)
  }
  return null
}
