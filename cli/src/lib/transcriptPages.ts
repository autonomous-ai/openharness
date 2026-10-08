/**
 * A transcript's history a page at a time — what a client scrolling a thread asks for (`session_get`)
 * and how long the thread is (`sessions_list`) — without reading the whole file. Attach's rule
 * (lib/attachTranscript.ts) holds here too: the work a request costs grows with the page, never with the
 * history. Both requests used to read every line into memory first, so a phone opening the thread of a
 * long Codex session asked the daemon for as much memory as the crash of 2026-10-03 took.
 *
 * Lines are `tailFile(path, Infinity)`'s, the reader every page came from: LF, CR and CRLF end a line,
 * a line that is only whitespace is no line, and a last line with no ending yet is one. Pages are the
 * windows an engine's whole-file windower cuts from those lines (Claude Code's `windowRawLines`, Codex's
 * `windowCodexLines`), with the same cursors, except:
 *  - a page holds at most `PAGE_MAX_BYTES` (see `pageBefore`), and a line longer than that is counted
 *    but left out — the old window held whatever its turn did, a whole file at worst;
 *  - a cursor a record names is the newest line with that id, where the old window took the oldest. Ids are
 *    unique in practice, and finding the oldest would mean reading back to the start every time.
 *
 * The rules are the engine's, handed in by its reader (`ThreadPages`): this file knows no engine, so the pager
 * the core keeps for line counts loads none of their code.
 */
import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { scanRecordsBackward, streamRecords } from './transcriptTail.js'

/** The most a page holds. A page used to be however long its turn was, and a turn can be gigabytes. */
export const PAGE_MAX_BYTES = 32 * 1024 * 1024

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
/** How a page is walked — swapped in tests for a walk the file shrinks under. */
export type Walk = typeof scanRecordsBackward

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

/** What the pager asks of an engine's lines. */
export interface PageRules {
  /** A page may start at this line — a turn's first, so a turn is never split. */
  startsPage(line: string): boolean
}

/**
 * How an engine's thread is paged, as its reader declares it. `record`: a cursor is the id a line's record
 * carries (`line` says which, and whether a page may start there), the page before names the newest line with
 * that id. `line`: a cursor is `<prefix>:<n>`, the number of lines before it, kept in an index as the file grows.
 */
export type ThreadPages =
  | { cursor: 'record'; line(line: string): { cursor: string | null; startsPage: boolean } }
  | { cursor: 'line'; prefix: string; startsPage(line: string): boolean }

export interface Page {
  /** Oldest first. */
  lines: string[]
  /** Lines in the page, those too long to hold included. */
  count: number
  /** Where the page's first line starts. */
  start: number
  /** Lines remain before the page. */
  hasMore: boolean
  /** The page starts inside a turn: that one turn held more than a page may. */
  clipped: boolean
}

/**
 * The page that ends just before byte `end`: the `limit` lines before it, and as many more as reach
 * back to a line a page may start at — the window `windowRawLines` and `windowCodexLines` cut. Null when
 * the file shrank under the walk.
 *
 * Bounded at `maxBytes`, which the old window was not: a page that would hold more ends at the oldest
 * start that fits, short of `limit`, so a turn is still never split. Only a turn too long to fit at all
 * is cut at a line inside it (`clipped`), its older part left for the next page. A single line over
 * `maxBytes` is never held: it is counted where it stands and left out. A file that cannot be read is an
 * empty one, as it was to the whole-file reader.
 */
export async function pageBefore(
  filePath: string,
  end: number,
  limit: number,
  rules: PageRules,
  maxBytes = PAGE_MAX_BYTES,
  walk: Walk = scanRecordsBackward,
): Promise<Page | null> {
  const lines: string[] = []
  let count = 0
  let bytes = 0
  let start = end
  // The page up to its oldest start that fits: where a page that runs out of room ends.
  let fits: { lines: number; count: number; start: number } | null = null
  let reached = false
  let hasMore = false
  let clipped = false
  const stop = (): true => { hasMore = true; return true }
  const walking = end <= 0 ? Promise.resolve(true) : walk(filePath, end, (record, offset) => {
    if (reached) return stop()
    if (lines.length && bytes + record.length > maxBytes) {
      if (fits) {
        lines.length = fits.lines
        count = fits.count
        start = fits.start
      } else clipped = true
      return stop()
    }
    const line = record.toString('utf8')
    lines.push(line)
    count++
    bytes += record.length
    start = offset
    if (rules.startsPage(line)) {
      fits = { lines: lines.length, count, start }
      if (count >= limit) reached = true
    }
  }, maxBytes, (offset) => {
    if (reached) return stop()
    count++
    start = offset
  })
  const whole = await walking.catch(() => 'unreadable' as const)
  if (whole === 'unreadable') return { lines: [], count: 0, start: 0, hasMore: false, clipped: false }
  if (!whole) return null
  lines.reverse()
  return { lines, count, start, hasMore, clipped }
}

/** One page of a thread, and the cursor that asks for the page before it. */
export interface HistoryPage {
  lines: string[]
  hasMore: boolean
  oldestCursor: string | null
  /** The cursor named nothing in the file: the client reloads the thread. */
  staleCursor?: true
  clipped: boolean
}

const STALE: HistoryPage = { lines: [], hasMore: false, oldestCursor: null, staleCursor: true, clipped: false }
/** An id that is written into its record exactly as it reads, so its bytes can be searched for. */
const PLAIN_ID = /^[A-Za-z0-9_.:-]+$/

/**
 * Pages for the threads clients read. Holds an index per transcript (for Codex's line cursors and line
 * counts) and the byte each recently served Claude cursor names, so scrolling back one page after
 * another does not walk the file again from its end.
 */
export class TranscriptPager {
  private readonly indexes = new Map<string, LineIndex>()
  private readonly cursors = new Map<string, Map<string, number>>()

  constructor(
    private readonly options: {
      capacity?: number
      maxBytes?: number
      stride?: { lines: number; bytes: number }
      walk?: Walk
    } = {},
  ) {}

  private get capacity(): number { return this.options.capacity ?? 256 }
  private get maxBytes(): number { return this.options.maxBytes ?? PAGE_MAX_BYTES }

  /** `tailFile(path, Infinity).length`, read once and then only as the file grows. A file that cannot
   *  be read has none, as it had to the whole-file reader. */
  async lineCount(filePath: string): Promise<number> {
    try { return (await this.index(filePath)).count() } catch { return 0 }
  }

  /** The page of a thread before `opts.before` (else its end), as `rules` page it: the engine's whole-file window,
   *  without the whole file. No `limit` asks for every line, as far as fits. */
  page(filePath: string, rules: ThreadPages, opts: { limit?: number; before?: string }): Promise<HistoryPage> {
    return rules.cursor === 'record' ? this.byRecord(filePath, rules, opts) : this.byLine(filePath, rules, opts)
  }

  private async byRecord(filePath: string, rules: Extract<ThreadPages, { cursor: 'record' }>, opts: { limit?: number; before?: string }): Promise<HistoryPage> {
    let end = await length(filePath)
    if (opts.before !== undefined) {
      const at = await this.findRecord(filePath, end, opts.before, rules)
      if (at === null) return STALE
      end = at
    }
    const page = await pageBefore(filePath, end, opts.limit ?? Infinity, { startsPage: (line) => rules.line(line).startsPage }, this.maxBytes, this.options.walk)
    if (!page) return STALE
    // An empty window before a cursor still names that cursor's line, as the old one did.
    const oldestCursor = page.lines.length ? rules.line(page.lines[0]).cursor : opts.before ?? null
    if (page.lines.length && oldestCursor !== null) this.remember(filePath, oldestCursor, page.start)
    return { lines: page.lines, hasMore: page.hasMore, oldestCursor, clipped: page.clipped }
  }

  /** A file that cannot be read is an empty one, as it was to the whole-file reader: its only cursor is the
   *  start, `<prefix>:0`, and any other is stale. */
  private async byLine(filePath: string, rules: Extract<ThreadPages, { cursor: 'line' }>, opts: { limit?: number; before?: string }): Promise<HistoryPage> {
    try { return await this.linePage(filePath, rules, opts) } catch {
      const at = opts.before === undefined ? 0 : lineCursor(rules.prefix, opts.before)
      return at === 0 ? { lines: [], hasMore: false, oldestCursor: `${rules.prefix}:0`, clipped: false } : STALE
    }
  }

  private async linePage(filePath: string, rules: Extract<ThreadPages, { cursor: 'line' }>, opts: { limit?: number; before?: string }): Promise<HistoryPage> {
    const index = await this.index(filePath)
    const count = index.count()
    let endIndex = count
    if (opts.before !== undefined) {
      const at = lineCursor(rules.prefix, opts.before)
      if (at === null || at > count) return STALE
      endIndex = at
    }
    const page = await pageBefore(filePath, await index.endOf(endIndex), opts.limit ?? Infinity, { startsPage: rules.startsPage }, this.maxBytes, this.options.walk)
    if (!page) return STALE
    return { lines: page.lines, hasMore: page.hasMore, oldestCursor: `${rules.prefix}:${endIndex - page.count}`, clipped: page.clipped }
  }

  private async index(filePath: string): Promise<LineIndex> {
    let index = this.indexes.get(filePath)
    if (index) this.indexes.delete(filePath)
    index ??= new LineIndex(filePath, this.options.stride)
    this.indexes.set(filePath, index)
    while (this.indexes.size > this.capacity) this.indexes.delete(this.indexes.keys().next().value!)
    await index.update()
    return index
  }

  private remember(filePath: string, cursor: string, offset: number): void {
    let known = this.cursors.get(filePath)
    if (known) this.cursors.delete(filePath)
    else known = new Map()
    this.cursors.set(filePath, known)
    known.delete(cursor)
    known.set(cursor, offset)
    while (known.size > 64) known.delete(known.keys().next().value!)
    while (this.cursors.size > this.capacity) this.cursors.delete(this.cursors.keys().next().value!)
  }

  /** Where the newest line with this cursor starts, or null. A remembered byte is checked first. */
  private async findRecord(filePath: string, end: number, cursor: string, rules: Extract<ThreadPages, { cursor: 'record' }>): Promise<number | null> {
    const names = (line: string): boolean => rules.line(line).cursor === cursor
    const known = this.cursors.get(filePath)?.get(cursor)
    if (known !== undefined && known < end) {
      let line: string | null = null
      const read = await streamRecords(filePath, known, end, (record) => { line = record; return true }, () => true, this.maxBytes)
      if (read && line !== null && names(line)) return known
      this.cursors.get(filePath)?.delete(cursor)
    }
    if (end <= 0) return null
    const needle = PLAIN_ID.test(cursor) ? Buffer.from(`"${cursor}"`) : null
    let found: number | null = null
    const whole = await scanRecordsBackward(filePath, end, (record, offset) => {
      if (needle && record.indexOf(needle) < 0) return false
      if (!names(record.toString('utf8'))) return false
      found = offset
      return true
    }, this.maxBytes).catch(() => false)
    return whole ? found : null
  }
}

async function length(filePath: string): Promise<number> {
  try { return (await stat(filePath)).size } catch { return 0 }
}

/** The line a `<prefix>:<n>` cursor names, or null for one that names none. */
function lineCursor(prefix: string, cursor: string): number | null {
  if (!cursor.startsWith(`${prefix}:`)) return null
  const digits = cursor.slice(prefix.length + 1)
  const at = /^\d+$/.test(digits) ? Number(digits) : NaN
  return Number.isSafeInteger(at) && at >= 0 ? at : null
}
