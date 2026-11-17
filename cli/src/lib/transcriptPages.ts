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
 * The rules are the engine's, handed in by its reader (`ThreadPages`). The core loads only the shared
 * incremental line index (`transcriptIndex.ts`); each reader process owns its pager.
 */
import { stat } from 'node:fs/promises'
import { TranscriptIndexes } from './transcriptIndex.js'
import { scanRecordsBackward, streamRecords } from './transcriptTail.js'

/** The most a page holds. A page used to be however long its turn was, and a turn can be gigabytes. */
export const PAGE_MAX_BYTES = 32 * 1024 * 1024

/** How a page is walked — swapped in tests for a walk the file shrinks under. */
export type Walk = typeof scanRecordsBackward

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
  private readonly indexes: TranscriptIndexes
  private readonly cursors = new Map<string, Map<string, number>>()

  constructor(
    private readonly options: {
      capacity?: number
      maxBytes?: number
      stride?: { lines: number; bytes: number }
      walk?: Walk
    } = {},
  ) { this.indexes = new TranscriptIndexes(options) }

  private get capacity(): number { return this.options.capacity ?? 256 }
  private get maxBytes(): number { return this.options.maxBytes ?? PAGE_MAX_BYTES }

  /** `tailFile(path, Infinity).length`, read once and then only as the file grows. A file that cannot
   *  be read has none, as it had to the whole-file reader. */
  async lineCount(filePath: string): Promise<number> {
    return this.indexes.lineCount(filePath)
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
    const index = await this.indexes.get(filePath)
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
