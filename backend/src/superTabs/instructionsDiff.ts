/**
 * What an instructions save really changed, for the line it posts in the project chat (task #3021, Ken 11-05): the items it
 * removed and added against the revision it replaced, so a PM's "I wrote it into the instructions" can be checked.
 * Computed once per save from the two texts the save already holds (commands.ts saveInstructions); nothing is stored or
 * read for it.
 *
 * Instructions are hard-wrapped, so one bullet spans several lines and a one-word edit rewraps it. They are compared by
 * item instead: a bullet, a numbered step, a paragraph or a fenced block, its wrapped lines joined, its list marker
 * dropped (so renumbered steps are no change), and each heading. A change is written in words, "Added:" or "Removed:"
 * under the section it sits in ("In Routing › Models:"), which reads the same in every client with no colouring (Ken's
 * review; River chose words).
 */

/** Changed items the chat line shows; the rest are counted. */
export const CHANGE_ITEMS = 12
/** Characters of one shown item; a longer one is cut, never left out. */
export const ITEM_CHARS = 400
/** Edits compared item by item. Past this a 64 KB rewrite would cost (N+M)·D steps, so the region between the common head
 *  and tail is shown as removed and added whole: still the real items, only not the fewest changes. */
const MAX_EDITS = 1000

/** One item of a document: its words on one line, the section path it sits under, and whether it is a heading. */
interface Item { key: string; text: string; path: string; heading: boolean }
interface Edit { added: boolean; item: Item }

/** The words under the summary of a save from [before] to [after]: each changed item on its own line, starting "Added:" or
 *  "Removed:", grouped under its section, then how many more changes there are. Every line starts with one of those words,
 *  so a saved item's Markdown never opens a heading, list, quote, code block or table in the chat. [before] null is an
 *  earlier revision the store could not read: said, never shown as no change. */
export function instructionsChange(before: string | null, after: string): string {
  if (before === null) return 'The earlier revision could not be read, so the change is not shown.'
  const edits = itemEdits(items(before), items(after))
  if (!edits.length) return 'Only spacing and line breaks changed.'
  const lines: string[] = []
  let section: string | undefined
  for (const { added, item } of edits.slice(0, CHANGE_ITEMS)) {
    if (item.path !== section) {
      if (lines.length) lines.push('')
      if (item.path) lines.push(`In ${item.path}:`)
      section = item.path
    }
    lines.push(`${added ? 'Added' : 'Removed'}${item.heading ? ' section' : ''}: ${cut(item.text)}`)
  }
  const more = edits.length - CHANGE_ITEMS
  if (more > 0) lines.push('', `and ${more} more change${more === 1 ? '' : 's'}.`)
  return lines.join('\n')
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const FENCE = /^ {0,3}(?:```|~~~)/

/** [text]'s items in document order. A section's path is its headings below the document's title (level 1), or the title
 *  alone when it has no others. */
function items(text: string): Item[] {
  const found: Item[] = []
  const headings: (string | undefined)[] = []
  const pathOf = (levels: (string | undefined)[]) => {
    const below = levels.slice(1).filter((h): h is string => !!h)
    return (below.length ? below : levels.slice(0, 1).filter((h): h is string => !!h)).join(' › ')
  }
  let open: string[] | null = null
  let fenced = false
  const close = () => {
    if (open) found.push(item(open.join(' '), pathOf(headings), false))
    open = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (fenced) {
      open!.push(line)
      if (FENCE.test(raw)) { fenced = false; close() }
      continue
    }
    if (!line) { close(); continue }
    if (FENCE.test(raw)) { close(); open = [line]; fenced = true; continue }
    const heading = HEADING.exec(raw)
    if (heading) {
      close()
      const level = heading[1]!.length
      headings.length = level - 1
      found.push(item(heading[2]!, pathOf(headings), true))
      headings[level - 1] = heading[2]!.trim()
      continue
    }
    const listed = LIST_ITEM.exec(raw)
    if (listed) { close(); open = [listed[1]!] } else if (open) (open as string[]).push(line)
    else open = [line]
  }
  close()
  return found.filter(i => i.text)
}

function item(words: string, path: string, heading: boolean): Item {
  const text = words.replace(/\s+/g, ' ').trim()
  return { key: `${heading ? '#' : '-'}${text}`, text, path, heading }
}

function cut(text: string): string {
  if (text.length <= ITEM_CHARS) return text
  let end = ITEM_CHARS - 1
  // Never half of a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1
  return `${text.slice(0, end)}…`
}

/** The removals and additions from [a] to [b] in document order, a removal before the addition that replaces it. */
function itemEdits(a: Item[], b: Item[]): Edit[] {
  let head = 0
  while (head < a.length && head < b.length && a[head]!.key === b[head]!.key) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail]!.key === b[b.length - 1 - tail]!.key) tail++
  const from = a.slice(head, a.length - tail), to = b.slice(head, b.length - tail)
  return myers(from, to) ?? [...from.map(item => ({ added: false, item })), ...to.map(item => ({ added: true, item }))]
}

/** Myers' shortest edit script (1986), or null past MAX_EDITS. Each step keeps only its own diagonals -d..d. */
function myers(a: Item[], b: Item[]): Edit[] | null {
  const n = a.length, m = b.length
  if (!n || !m) return [...a.map(item => ({ added: false, item })), ...b.map(item => ({ added: true, item }))]
  const offset = n + m + 1
  const v = new Int32Array(2 * offset + 1)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x]!.key === b[y]!.key) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = d; break }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  if (found < 0) return null
  const at = (d: number, k: number) => trace[d]![k + d]!
  const edits: Edit[] = []
  let x = n, y = m
  for (let d = found; d > 0; d--) {
    const k = x - y
    const down = k === -d || (k !== d && at(d - 1, k - 1) < at(d - 1, k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(d - 1, prevK), prevY = prevX - prevK
    while (x > prevX && y > prevY) { x--; y-- }
    edits.push(down ? { added: true, item: b[prevY]! } : { added: false, item: a[prevX]! })
    x = prevX
    y = prevY
  }
  return edits.reverse()
}

/**
 * The rules people gave, and the ones a save drops (task #3151, Ken 11-05, from lamp): a PM's tidy dropped Leo's rule, judging
 * it impossible, and the "(0xken15, 4 Nov)" of a rule it kept, and nothing checked the save. A rule is an item (as above)
 * carrying a person and a date in parentheses, as these documents write who gave it: "(Ken, 2026-11-02)", "(0xken15, 4 Nov)",
 * "(Scholes, 11-04)", "(Ken and Dee, 11-03)", "(Ken, 11-02; Dee, 11-03)", "(Ken, 2026-11-04: why)". An item with one such
 * attribution is one rule, whatever side of it the words are on; one with several is split after each, the words after the
 * last going with it. Nothing is stored: commands.ts checks a save against the revision it replaces.
 */
export interface AttributedRule {
  /** Its words as the document has them, attribution included. */
  text: string
  /** Who gave it, as written ("anh Dee", "0xken15"). */
  people: string[]
}
/** How a save lost a rule: gone, kept without who gave it, or changed so its meaning may differ (a negation, a number, a
 *  condition, more than a rewording). The last is "can't tell", refused like the others. */
export interface DroppedRule extends AttributedRule { why: 'removed' | 'unattributed' | 'changed' }

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
const DATE = `(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[-/]\\d{1,2}(?:[-/]\\d{2,4})?|\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?|${MONTH}\\s+\\d{1,2}(?:,?\\s+\\d{4})?)`
/** One attribution: names, a comma, a date, and optionally a note after it ("Ken, 2026-11-04: ad hoc reads..."). */
const CLAUSE = new RegExp(`^\\s*(.+?)\\s*,\\s*${DATE}(?![\\p{L}\\p{N}])\\s*(?:[:;,.\\u2013\\u2014-].*)?$`, 'isu')
/** A person's name or username: up to three words. */
const NAME = /^@?[\p{L}\p{N}][\p{L}\p{N}._'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}._'’-]*){0,2}$/u
const NAME_SEPARATOR = /\s*(?:,|&|\+|\/|\band\b|\bvà\b)\s*/iu
/** Words said before a name, as "anh Dee" is Dee. */
const HONORIFIC = /^(?:anh|chị|chi|em|cô|chú|bác|mr\.?|mrs\.?|ms\.?|dr\.?)\s+/iu

/** The people of one parenthesized text, or none when it is not an attribution. */
function attribution(inside: string): { people: string[]; clauses: number } | null {
  const people: string[] = []
  let clauses = 0
  for (const clause of inside.split(';')) {
    const names = CLAUSE.exec(clause)?.[1]?.split(NAME_SEPARATOR).map(n => n.trim().replace(/^@/, '')).filter(Boolean)
    if (!names?.length || !names.every(n => NAME.test(n) && [...n].length <= 40)) continue
    clauses++
    people.push(...names)
  }
  return clauses ? { people, clauses } : null
}

/** A name as one person: case, width, spaces, a leading "@", an honorific and a possessive aside ("Dee's daily check" is
 *  Dee's). */
export const personKey = (name: string): string => name.normalize('NFKC').trim().replace(/^@/, '').replace(HONORIFIC, '')
  .replace(/['\u2019]s\b.*$/su, '').toLowerCase().replace(/[\s\p{Zs}]+/gu, '')

/** One rule's or plain item's words, for comparing two revisions. */
interface Segment {
  text: string
  people: string[]
  clauses: number
  /** Its content words (stemmed), negations and limits ("never", "only"), and numbers, attributions left out. */
  words: Set<string>
  polarity: Set<string>
  numbers: Set<string>
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'is', 'are', 'be', 'it', 'its', 'that', 'this', 'by', 'with',
  'as', 'at', 'from', 'into', 'than', 'then', 'so', 'was', 'were', 'will', 's'])
const POLARITY = new Set(['never', 'no', 'not', 'nor', 'none', 'nobody', 'nothing', 'neither', 'without', 't', 'cannot', 'only', 'always', 'must',
  'unless', 'except'])
const stem = (word: string) => /\d/.test(word) || word.length <= 3 || !word.endsWith('s') || word.endsWith('ss') ? word : word.slice(0, -1)

function segment(text: string, people: string[], clauses: number, body: string): Segment {
  const tokens = (body.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:[.:,%][\p{N}]+)*%?/gu) ?? []).map(stem)
  return { text, people, clauses, words: new Set(tokens.filter(t => !STOP.has(t))), polarity: new Set(tokens.filter(t => POLARITY.has(t))),
    numbers: new Set(tokens.filter(t => /\d/.test(t))) }
}

/** An item's segments: one per attribution as above, or the whole item when it has none. */
function segments(text: string): Segment[] {
  const found: { start: number; end: number; people: string[]; clauses: number }[] = []
  for (const match of text.matchAll(/\(([^()]*)\)/g)) {
    const parsed = attribution(match[1]!)
    if (parsed) found.push({ start: match.index!, end: match.index! + match[0].length, ...parsed })
  }
  const strip = (part: string) => part.replace(/\(([^()]*)\)/g, (whole, inside: string) => attribution(inside) ? ' ' : whole)
  if (found.length <= 1) return [segment(text, found[0]?.people ?? [], found[0]?.clauses ?? 0, strip(text))]
  return found.map((a, i) => {
    const from = i ? /^[.,;:!?]*\s*/.exec(text.slice(found[i - 1]!.end))![0].length + found[i - 1]!.end : 0
    const to = i === found.length - 1 ? text.length : a.end + /^[.,;:!?]*/.exec(text.slice(a.end))![0].length
    const part = text.slice(from, to).trim()
    return segment(part, a.people, a.clauses, strip(part))
  })
}

const ruleSegments = (text: string): Segment[] => items(text).flatMap(i => segments(i.text))

/** Every attributed rule of [text], in document order. */
export function attributedRules(text: string): AttributedRule[] {
  return ruleSegments(text).filter(s => s.people.length).map(s => ({ text: s.text, people: s.people }))
}

/** How many of [a]'s words [b] may lack and still say it: none for a short rule, one in ten for a longer one. */
const covers = (a: Set<string>, b: Set<string>): boolean => {
  let missing = 0
  for (const word of a) if (!b.has(word)) missing++
  return missing <= (a.size >= 5 ? Math.max(1, Math.floor(a.size / 10)) : 0)
}
const within = (a: Set<string>, b: Set<string>) => [...a].every(w => b.has(w))
const share = (a: Set<string>, b: Set<string>) => a.size ? [...a].filter(w => b.has(w)).length / a.size : 0

/** Whether [after] still says [rule]: the same words but for a rewording, and the same negations, limits and numbers. A
 *  segment holding more people or attributions is a merge: it may say more, as long as it says all of [rule]. */
function says(rule: Segment, after: Segment): boolean {
  if (!covers(rule.words, after.words) || !within(rule.numbers, after.numbers) || !within(rule.polarity, after.polarity)) return false
  if (after.clauses > rule.clauses || after.people.length > rule.people.length) return true
  return covers(after.words, rule.words) && within(after.numbers, rule.numbers) && within(after.polarity, rule.polarity)
}

/**
 * The attributed rules of [before] that [after] drops: removed, kept without its people, or changed beyond a rewording by the
 * same people. [identify] says who a written name is (commands.ts: a member's id), so "0xken15" and "Ken" can be one person;
 * by default a name is itself, honorifics aside.
 */
export function droppedRules(before: string, after: string, identify: (name: string) => string = personKey): DroppedRule[] {
  const next = items(after).map(i => segments(i.text))
  const flat = next.flat()
  const ids = new Map<Segment, Set<string>>(flat.map(s => [s, new Set(s.people.map(identify))]))
  const dropped: DroppedRule[] = []
  for (const rule of ruleSegments(before).filter(s => s.people.length)) {
    const people = rule.people.map(identify)
    const theirs = flat.filter(s => people.every(p => ids.get(s)!.has(p)))
    if (theirs.some(s => says(rule, s))) continue
    // Its words still there, whole: with its people that is a change of meaning, without them a lost attribution.
    const kept = next.find(item => covers(rule.words, item.reduce((all, s) => new Set([...all, ...s.words]), new Set<string>())))
    const why = kept ? (kept.some(s => theirs.includes(s)) ? 'changed' : 'unattributed')
      : theirs.some(s => share(rule.words, s.words) >= 0.5) ? 'changed' : 'removed'
    dropped.push({ text: rule.text, people: rule.people, why })
  }
  return dropped
}
