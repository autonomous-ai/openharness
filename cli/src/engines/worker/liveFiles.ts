import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { LiveStamp } from './liveProtocol.js'

/** Fingerprint a delivered prefix without rereading the conversation. At byte zero no content exists
 *  to preserve: an empty or missing transcript becoming a file is ordinary first-turn delivery. */
export async function stampAt(file: string, offset: number): Promise<LiveStamp | null> {
  if (offset === 0) return null
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size < offset) throw new Error('ENGINE_TRANSCRIPT_CHANGED')
    const bytes = Math.min(offset, 512)
    const first = Buffer.alloc(bytes), last = Buffer.alloc(bytes)
    const head = await handle.read(first, 0, bytes, 0)
    const tail = await handle.read(last, 0, bytes, offset - bytes)
    if (head.bytesRead !== bytes || tail.bytesRead !== bytes) throw new Error('ENGINE_TRANSCRIPT_CHANGED')
    return { device: stat.dev, inode: stat.ino, bytes, digest: createHash('sha256').update(first).update(last).digest('hex') }
  } finally { await handle.close() }
}

export function sameStamp(a: LiveStamp | null, b: LiveStamp | null): boolean {
  return a === null ? b === null : b !== null && a.device === b.device && a.inode === b.inode
    && a.bytes === b.bytes && a.digest === b.digest
}
