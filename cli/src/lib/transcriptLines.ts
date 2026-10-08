/**
 * A transcript read line by line from a byte offset, never more than one line in memory, the lines a caller
 * names by their first bytes dropped before they are decoded. Engine-neutral: moved out of lib/transcriptReader.ts,
 * which re-exports it, so the adoption readers that only stream lines load none of the engines' normalizers that
 * file holds for search.
 */
import { open } from 'node:fs/promises'

/** How much of a line is read before deciding whether to skip it. */
const HEAD_BYTES = 1024
/** A longer line is not a prompt or an answer anyone wrote; it is dropped unread. */
const MAX_LINE_BYTES = 16 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024

export interface LineVisit {
  text: string
  /** Byte offset of the line's first byte. */
  offset: number
}

/**
 * Calls `visit` for every complete line from `start`, and resolves with the offset just past the last
 * complete line. A final line without its newline is left for the next pass: the engine may still be
 * writing it. `visit` may return a promise to pace the reader.
 */
export async function forEachLine(
  path: string,
  start: number,
  visit: (line: LineVisit) => void | Promise<void>,
  options: { skip?: ((head: string) => boolean) | null; shouldStop?: () => boolean } = {},
): Promise<{ end: number }> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    let position = start
    let lineStart = start
    let parts: Buffer[] = []
    let length = 0
    let decided = false
    let dropping = false
    for (;;) {
      if (options.shouldStop?.()) return { end: lineStart }
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position)
      if (bytesRead === 0) return { end: lineStart }
      let cursor = 0
      while (cursor < bytesRead) {
        const newline = buffer.indexOf(10, cursor)
        const stop = newline === -1 || newline >= bytesRead ? bytesRead : newline
        if (!dropping) {
          const piece = buffer.subarray(cursor, stop)
          if (length + piece.length > MAX_LINE_BYTES) {
            dropping = true
            parts = []
            length = 0
          } else {
            parts.push(Buffer.from(piece))
            length += piece.length
            if (!decided && options.skip && (length >= HEAD_BYTES || stop < bytesRead)) {
              decided = true
              const head = Buffer.concat(parts, length).subarray(0, HEAD_BYTES).toString('utf8')
              if (options.skip(head)) {
                dropping = true
                parts = []
                length = 0
              }
            }
          }
        }
        if (stop === bytesRead) break
        // A complete line.
        if (!dropping && length > 0) {
          const text = Buffer.concat(parts, length).toString('utf8')
          await visit({ text, offset: lineStart })
        }
        lineStart = position + stop + 1
        parts = []
        length = 0
        decided = false
        dropping = false
        cursor = stop + 1
      }
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
}
