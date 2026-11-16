/** Incremental transcript line counts, without history paging or engine rules. */
import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

/** A line index notes where a line ends at least every this many lines and this many bytes, so finding
 *  any line reads no more than that. */
export const INDEX_STRIDE_LINES = 4096
export const INDEX_STRIDE_BYTES = 4 * 1024 * 1024

const CHUNK_BYTES = 1024 * 1024
const HEAD_BYTES = 64
const NOT_WHITESPACE = /\S/
const EMPTY = Buffer.alloc(0)

type Handle = Awaited<ReturnType<typeof open>>
/** How a file is opened for reading — swapped in tests for one that is cut short as it is read. */
export type OpenFile = (filePath: string) => Promise<Handle>
const openForReading: OpenFile = (filePath) => open(filePath, 'r')

/** `isBlank`'s rule (lib/transcriptTail.ts) — `line.trim()` is empty — fed a line a chunk at a time. */
class BlankTest {
  private found = false
  private decoder: StringDecoder | null = null

  get seen(): boolean { return this.found }

  feed(bytes: Buffer): void {
    if (this.found || !bytes.length) return
    for (const byte of bytes) if (byte > 0x20 && byte < 0x7f) { this.found = true; this.decoder = null; return }
    this.decoder ??= new StringDecoder('utf8')
    if (NOT_WHITESPACE.test(this.decoder.write(bytes))) { this.found = true; this.decoder = null }
  }

  /** Whether the line held anything but whitespace. Resets for the next line. */
  end(): boolean {
    const line = this.found || (this.decoder !== null && NOT_WHITESPACE.test(this.decoder.end()))
    this.found = false
    this.decoder = null
    return line
  }
}

async function readAt(handle: Handle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, length))
  let read = 0
  while (read < buffer.length) {
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, position + read)
    if (!bytesRead) break
    read += bytesRead
  }
  return buffer.subarray(0, read)
}

/**
 * Walk `[from, to)` — `from` just past a line ending, or 0 — calling `onLine` with the byte just past
 * each line's ending and `onEnding` past every ending, a blank line's included. Returning true from
 * `onLine` stops the walk. What follows the last ending is left unread.
 */
async function walkLines(
  handle: Handle,
  from: number,
  to: number,
  onLine: (lineEnd: number) => boolean,
  onEnding: (end: number) => void = () => {},
): Promise<void> {
  const test = new BlankTest()
  for (let position = from; position < to;) {
    const chunk = await readAt(handle, position, Math.min(CHUNK_BYTES, to - position))
    if (!chunk.length) return
    let lineStart = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10 && chunk[i] !== 13) continue
      test.feed(chunk.subarray(lineStart, i))
      lineStart = i + 1
      const end = position + i + 1
      if (test.end() && onLine(end)) return
      onEnding(end)
    }
    if (lineStart < chunk.length) test.feed(chunk.subarray(lineStart))
    position += chunk.length
  }
}

/**
 * How many lines a transcript holds and where any of them ends, kept up to date as the file grows:
 * each look reads only what was appended since the last. A file rewritten in place — it shrank, its
 * first bytes changed, or a line ending is no longer where one was — is indexed again from the start.
 * Looks and lookups queue, so neither sees the other half done.
 */
export class LineIndex {
  /** Indexed up to here: just past a line ending, or 0. */
  private bytes = 0
  /** Lines that end before `bytes`. */
  private lines = 0
  /** Bytes with a known number of lines before them, ascending: `marks[k]` lines before `at[k]`. */
  private marks: number[] = [0]
  private at: number[] = [0]
  private head: Buffer = EMPTY
  /** The bytes after the last line ending are a line still being written. */
  private trailing = false
  private size = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly stride: { lines: number; bytes: number } = { lines: INDEX_STRIDE_LINES, bytes: INDEX_STRIDE_BYTES },
    private readonly openFile: OpenFile = openForReading,
  ) {}

  /** Bring the index up to the file as it is now. */
  update(): Promise<void> {
    return this.serial(() => this.look())
  }

  /** The file's lines, one still being written included: `tailFile(path, Infinity).length`. */
  count(): number {
    return this.lines + (this.trailing ? 1 : 0)
  }

  /** The file's length at the last look. */
  length(): number {
    return this.size
  }

  /** A byte with exactly `n` lines before it — where a page that ends before line `n` ends. */
  endOf(n: number): Promise<number> {
    return this.serial(() => this.find(n))
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {})
    return run
  }

  private reset(): void {
    this.bytes = 0
    this.lines = 0
    this.marks = [0]
    this.at = [0]
    this.head = EMPTY
    this.trailing = false
    this.size = 0
  }

  /** A file that is not there is an empty one; any other failure to read it is the caller's to hear. */
  private async look(): Promise<void> {
    let handle: Handle
    try { handle = await this.openFile(this.filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.reset()
      return
    }
    try {
      const { size } = await handle.stat()
      if (size < this.bytes || !await this.unchanged(handle)) this.reset()
      if (this.head.length < HEAD_BYTES && size > this.head.length) this.head = await readAt(handle, 0, Math.min(size, HEAD_BYTES))
      await walkLines(handle, this.bytes, size, (lineEnd) => {
        this.lines++
        const last = this.marks.length - 1
        if (this.lines - this.marks[last] >= this.stride.lines || lineEnd - this.at[last] >= this.stride.bytes) {
          this.marks.push(this.lines)
          this.at.push(lineEnd)
        }
        return false
      }, (end) => { this.bytes = end })
      this.trailing = await this.trailingLine(handle, size)
      this.size = size
    } finally { await handle.close() }
  }

  private async unchanged(handle: Handle): Promise<boolean> {
    if (this.head.length && !(await readAt(handle, 0, this.head.length)).equals(this.head)) return false
    if (!this.bytes) return true
    const [ending] = await readAt(handle, this.bytes - 1, 1)
    return ending === 10 || ending === 13
  }

  /** Whether the bytes after the last line ending hold a line: read only until they show they do. */
  private async trailingLine(handle: Handle, size: number): Promise<boolean> {
    const test = new BlankTest()
    for (let position = this.bytes; position < size && !test.seen;) {
      const chunk = await readAt(handle, position, Math.min(CHUNK_BYTES, size - position))
      if (!chunk.length) break
      test.feed(chunk)
      position += chunk.length
    }
    return test.end()
  }

  private async find(n: number): Promise<number> {
    if (n >= this.count()) return this.size
    if (n <= 0) return 0
    // The last mark at or before line n.
    let low = 0
    for (let high = this.marks.length - 1; low < high;) {
      const middle = (low + high + 1) >> 1
      if (this.marks[middle] <= n) low = middle
      else high = middle - 1
    }
    let found = this.at[low]
    let seen = this.marks[low]
    if (seen === n) return found
    const handle = await this.openFile(this.filePath)
    try {
      await walkLines(handle, found, this.bytes, (lineEnd) => {
        found = lineEnd
        return ++seen === n
      })
    } finally { await handle.close() }
    return found
  }
}

/** The same bounded incremental indexes serve core line counts and each worker's pager. */
export class TranscriptIndexes {
  private readonly indexes = new Map<string, LineIndex>()

  constructor(private readonly options: { capacity?: number; stride?: { lines: number; bytes: number } } = {}) {}

  private get capacity(): number { return this.options.capacity ?? 256 }

  /** `tailFile(path, Infinity).length`, read once and then only as the file grows. A file that cannot
   *  be read has none, as it had to the whole-file reader. */
  async lineCount(filePath: string): Promise<number> {
    try { return (await this.get(filePath)).count() } catch { return 0 }
  }

  async get(filePath: string): Promise<LineIndex> {
    let index = this.indexes.get(filePath)
    if (index) this.indexes.delete(filePath)
    index ??= new LineIndex(filePath, this.options.stride)
    this.indexes.set(filePath, index)
    while (this.indexes.size > this.capacity) this.indexes.delete(this.indexes.keys().next().value!)
    await index.update()
    return index
  }
}
