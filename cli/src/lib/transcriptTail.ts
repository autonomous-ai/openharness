import { open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/** Read selected JSONL records backward, then return them in chronological order.
 * `stop` includes the boundary record; `skip` discards an irrelevant record immediately.
 * Only complete records are decoded, so UTF-8 may cross any read boundary. The file length is
 * captured at open: later appends belong to the next read. A missing boundary reads back to BOF. */
export async function tailFileUntil(filePath: string, select: (line: string) => 'keep' | 'skip' | 'stop'): Promise<string[]> {
  try {
    const handle = await open(filePath, 'r')
    try {
      let position = (await handle.stat()).size
      const lines: string[] = []
      // Fragments of one record, newest first; never concatenate the whole conversation.
      let fragments: Buffer[] = []
      const take = (head: Buffer): boolean => {
        const bytes = fragments.length ? Buffer.concat([head, ...fragments.reverse()]) : head
        fragments = []
        const line = bytes.toString('utf8')
        if (!line.trim()) return false
        const action = select(line)
        if (action !== 'skip') lines.push(line)
        return action === 'stop'
      }
      while (position > 0) {
        const length = Math.min(position, 64 * 1024)
        position -= length
        const chunk = Buffer.allocUnsafe(length)
        let read = 0
        while (read < length) {
          const { bytesRead } = await handle.read(chunk, read, length - read, position + read)
          if (!bytesRead) return [] // Truncated during the read; don't recap a mixed snapshot.
          read += bytesRead
        }
        let end = length
        // Each native search advances independently: CR-free files must not rescan the
        // remaining chunk for CR once per LF. No per-byte JavaScript loop is needed.
        let lf = chunk.lastIndexOf(10), cr = chunk.lastIndexOf(13)
        while (lf >= 0 || cr >= 0) {
          const i = Math.max(lf, cr)
          // Match readline's LF, CRLF and bare-CR handling. The empty CRLF half is ignored.
          if (take(chunk.subarray(i + 1, end))) return lines.reverse()
          end = i
          if (lf === i) lf = i > 0 ? chunk.lastIndexOf(10, i - 1) : -1
          if (cr === i) cr = i > 0 ? chunk.lastIndexOf(13, i - 1) : -1
        }
        if (end) fragments.push(chunk.subarray(0, end))
      }
      if (fragments.length) take(Buffer.alloc(0))
      return lines.reverse()
    } finally { await handle.close() }
  } catch {
    return []
  }
}

/** Return the last `n` non-empty raw lines of a specific transcript file. Prefer this over
 *  `tailLines` when the caller already holds a trusted, registered `transcriptPath` — it takes no
 *  request-controlled id, so there is no path to traverse. */
export async function tailFile(filePath: string, n = 200): Promise<string[]> {
  try {
    if (n === Infinity) {
      // A long-running session can exceed V8's maximum single-string length.
      // Keep the full-history contract, without decoding the entire file at once.
      const lines: string[] = []
      const input = createReadStream(filePath, { encoding: 'utf8' })
      const reader = createInterface({ input, crlfDelay: Infinity })
      try {
        for await (const line of reader) if (line.trim()) lines.push(line)
      } finally { reader.close(); input.destroy() }
      return lines
    }
    if (!Number.isFinite(n)) return []
    n = Math.floor(n)
    if (n <= 0) return []
    const handle = await open(filePath, 'r')
    try {
      let position = (await handle.stat()).size
      const chunks: Buffer[] = []
      let newlines = 0
      while (position > 0) {
        const size = Math.min(position, 64 * 1024)
        position -= size
        const chunk = Buffer.allocUnsafe(size)
        const { bytesRead } = await handle.read(chunk, 0, size, position)
        const read = chunk.subarray(0, bytesRead)
        chunks.unshift(read)
        for (const byte of read) if (byte === 10) newlines++
        if (newlines > n || position === 0) {
          let text = Buffer.concat(chunks).toString('utf8')
          if (position > 0) text = text.slice(text.indexOf('\n') + 1)
          const lines = text.split('\n').filter(line => line.trim())
          if (lines.length >= n || position === 0) return lines.slice(-n)
        }
      }
      return []
    } finally { await handle.close() }
  } catch {
    return []
  }
}
