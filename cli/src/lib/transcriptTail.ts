import { open, stat, type FileHandle } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const CHUNK_BYTES = 64 * 1024

/** A record longer than this is passed over unread by the walks below. No engine writes one — Codex's
 *  compaction snapshots, the largest, are tens of MB — and one over V8's string limit (~512 MiB) could
 *  not be decoded anyway. Holding one while looking for its end is the only thing either walk keeps. */
export const MAX_RECORD_BYTES = 256 * 1024 * 1024

/** `line.trim()` is empty — decided without decoding a record that has a visible ASCII character in it,
 *  which is every JSONL record (they open with `{`). */
function isBlank(bytes: Buffer): boolean {
  for (const byte of bytes) if (byte > 0x20 && byte < 0x7f) return false
  return !bytes.toString('utf8').trim()
}

async function readFully(handle: FileHandle, chunk: Buffer, position: number): Promise<boolean> {
  let read = 0
  while (read < chunk.length) {
    const { bytesRead } = await handle.read(chunk, read, chunk.length - read, position + read)
    if (!bytesRead) return false
    read += bytesRead
  }
  return true
}

/**
 * Walk a transcript's records from byte `end` back to byte 0, newest first, holding one at a time.
 *
 * `visit` gets each non-blank record's bytes — valid only during the call — and the offset it starts
 * at; returning true stops the walk. LF, CR and CRLF each end a record, readline's rule. A record over
 * `maxRecordBytes` is passed over unvisited, and only told to `passed` (its offset), if given; returning
 * true from that stops the walk too. Resolves false when the file shrank under the walk: what was
 * visited may then mix two versions of it.
 */
export async function scanRecordsBackward(
  filePath: string,
  end: number,
  visit: (record: Buffer, offset: number) => boolean | void,
  maxRecordBytes = MAX_RECORD_BYTES,
  passed?: (offset: number) => boolean | void,
): Promise<boolean> {
  const handle = await open(filePath, 'r')
  try {
    let position = end
    // Pieces of the record being assembled, newest first; only ever one record's worth.
    let fragments: Buffer[] = []
    let fragmentBytes = 0
    let oversized = false
    const take = (head: Buffer, offset: number): boolean => {
      const skip = oversized || head.length + fragmentBytes > maxRecordBytes
      const bytes = skip || !fragments.length ? head : Buffer.concat([head, ...fragments.reverse()])
      fragments = []
      fragmentBytes = 0
      oversized = false
      if (skip) return passed?.(offset) === true
      if (isBlank(bytes)) return false
      return visit(bytes, offset) === true
    }
    while (position > 0) {
      const length = Math.min(position, CHUNK_BYTES)
      position -= length
      const chunk = Buffer.allocUnsafe(length)
      if (!await readFully(handle, chunk, position)) return false
      let segmentEnd = length
      // Each native search advances independently: CR-free files must not rescan the
      // remaining chunk for CR once per LF. No per-byte JavaScript loop is needed.
      let lf = chunk.lastIndexOf(10), cr = chunk.lastIndexOf(13)
      while (lf >= 0 || cr >= 0) {
        const i = Math.max(lf, cr)
        // Match readline's LF, CRLF and bare-CR handling. The empty CRLF half is blank and skipped.
        if (take(chunk.subarray(i + 1, segmentEnd), position + i + 1)) return true
        segmentEnd = i
        if (lf === i) lf = i > 0 ? chunk.lastIndexOf(10, i - 1) : -1
        if (cr === i) cr = i > 0 ? chunk.lastIndexOf(13, i - 1) : -1
      }
      if (segmentEnd && !oversized) {
        fragmentBytes += segmentEnd
        if (fragmentBytes > maxRecordBytes) { oversized = true; fragments = [] }
        else fragments.push(chunk.subarray(0, segmentEnd))
      }
    }
    if (fragments.length || oversized) take(Buffer.alloc(0), 0)
    return true
  } finally { await handle.close() }
}

/**
 * Feed every non-blank record in [start, end) to `onRecord` with the offset it starts at, oldest first,
 * holding one at a time — the forward half of `scanRecordsBackward`, with the same record rules.
 * Returning true from `onRecord` stops after that record.
 *
 * A final record with no line ending yet is fed only when `complete` accepts it: an engine caught
 * mid-write leaves half a record there, and it belongs to whoever reads the file next (`partial`). `next`
 * is the offset just past the last record fed — exactly where a tail picks up. Null when the file shrank.
 */
export async function streamRecords(
  filePath: string,
  start: number,
  end: number,
  onRecord: (line: string, offset: number) => boolean | void,
  complete: (line: string) => boolean,
  maxRecordBytes = MAX_RECORD_BYTES,
): Promise<{ next: number; records: number; partial: boolean } | null> {
  const handle = await open(filePath, 'r')
  try {
    let position = start
    let next = start
    let records = 0
    let partial = false
    let pending: Buffer[] = []
    let pendingBytes = 0
    let oversized = false
    const emit = (bytes: Buffer): boolean => {
      if (isBlank(bytes)) return false
      records++
      return onRecord(bytes.toString('utf8'), next) === true
    }
    while (position < end) {
      const length = Math.min(end - position, CHUNK_BYTES)
      const chunk = Buffer.allocUnsafe(length)
      if (!await readFully(handle, chunk, position)) return null
      let segmentStart = 0
      let lf = chunk.indexOf(10), cr = chunk.indexOf(13)
      while (lf >= 0 || cr >= 0) {
        const i = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr)
        const piece = chunk.subarray(segmentStart, i)
        const stop = !oversized && pendingBytes + piece.length <= maxRecordBytes
          && emit(pending.length ? Buffer.concat([...pending, piece]) : piece)
        pending = []
        pendingBytes = 0
        oversized = false
        segmentStart = i + 1
        next = position + i + 1
        if (stop) return { next, records, partial }
        if (lf === i) lf = chunk.indexOf(10, i + 1)
        if (cr === i) cr = chunk.indexOf(13, i + 1)
      }
      if (segmentStart < length && !oversized) {
        pendingBytes += length - segmentStart
        if (pendingBytes > maxRecordBytes) { oversized = true; pending = [] }
        else pending.push(chunk.subarray(segmentStart))
      }
      position += length
    }
    if (pending.length) {
      const bytes = Buffer.concat(pending)
      const line = bytes.toString('utf8')
      if (!isBlank(bytes)) {
        if (complete(line)) {
          records++
          onRecord(line, next)
          next = end
        } else partial = true
      }
    }
    return { next, records, partial }
  } finally { await handle.close() }
}

/** Read selected JSONL records backward, then return them in chronological order.
 * `stop` includes the boundary record; `skip` discards an irrelevant record immediately.
 * Only complete records are decoded, so UTF-8 may cross any read boundary. The file length is
 * captured at open: later appends belong to the next read. A missing boundary reads back to BOF. */
export async function tailFileUntil(filePath: string, select: (line: string) => 'keep' | 'skip' | 'stop'): Promise<string[]> {
  try {
    const { size } = await stat(filePath)
    const lines: string[] = []
    const whole = await scanRecordsBackward(filePath, size, (record) => {
      const line = record.toString('utf8')
      const action = select(line)
      if (action !== 'skip') lines.push(line)
      return action === 'stop'
    })
    // Truncated during the read; don't recap a mixed snapshot.
    return whole ? lines.reverse() : []
  } catch {
    return []
  }
}

/** The most of a transcript read at once by a reader that has no pages of its own: its newest records
 *  up to this many bytes. The October 3 crash was an 803 MB transcript read whole: past what the heap
 *  holds, one conversation's read takes every agent's daemon down with it. Claude Code and Codex read
 *  pages instead (lib/transcriptPages.ts); this is the floor under every other engine until they do. */
export const WHOLE_READ_CAP_BYTES = 64 * 1024 * 1024

/**
 * A transcript's newest records, up to `maxBytes` of them, in order: what `tailFile(path, Infinity)`
 * returns for a file under the cap, with `truncated` saying older records were left unread. A record
 * that alone is bigger than what is left of the cap ends the read there. Empty for a file that cannot
 * be read.
 */
export async function tailFileCapped(filePath: string, maxBytes = WHOLE_READ_CAP_BYTES): Promise<{ lines: string[]; truncated: boolean }> {
  try {
    const { size } = await stat(filePath)
    const lines: string[] = []
    let bytes = 0
    let truncated = false
    await scanRecordsBackward(filePath, size, (record) => {
      if (bytes + record.length > maxBytes) { truncated = true; return true }
      bytes += record.length
      lines.push(record.toString('utf8'))
    })
    return { lines: lines.reverse(), truncated }
  } catch {
    return { lines: [], truncated: false }
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
