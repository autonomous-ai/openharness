/**
 * A project's instructions read as items, to check what a save drops (task #3151): a bullet, a numbered step, a paragraph or a
 * fenced block, its wrapped lines joined and its list marker dropped (so rewrapped and renumbered items are no change), and
 * each heading. The chat line that showed a save's change (#3021) left with #3132; these items now find the rules people
 * gave and the lines a save drops, for the save's check and the revision's History (ruleGuard.ts).
 */

/** Characters of one line a History lists; a longer one is cut. */
export const ITEM_CHARS = 400

/** One item of a document: its words on one line, the section path it sits under, and whether it is a heading. */
interface Item { key: string; text: string; path: string; heading: boolean }

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
 *  condition, more than a rewording). The last is "can't tell", refused like the others. `waiting`: moved into a code task
 *  that has not merged, named by `movedTo` (#3392): its line stays until that task merges. */
export interface DroppedRule extends AttributedRule { why: 'removed' | 'unattributed' | 'changed' | 'waiting'; movedTo?: string }
/**
 * A place outside the document a person's rule may move to (task #3392, anh Dee 11-05, decision 5): the project's rules record
 * or a code task, its words as written there. `people`: who is known to have given what it holds, as `identify` names them
 * (a rules record's asker), besides any attribution in its words. `open`: a code task not merged yet, which keeps the line.
 */
export interface RulePlace { text: string; people: readonly string[]; where: string; open: boolean }

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
  /** Its content words in order (stemmed; negations, limits and numbers among them), attributions left out. */
  seq: string[]
  words: Set<string>
}

/** Words that carry no rule: articles, prepositions and the like. Negations, limits, numbers and "and"/"or" are kept. */
const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'it', 'its', 'their', 'that', 'this', 'by', 'with',
  'as', 'at', 'from', 'into', 'so', 'was', 'were', 'will', 's'])
/** A word a merge may add between the rules it joins. */
const JOINERS = new Set(['and'])
const stem = (word: string) => /\d/.test(word) || word.length <= 3 || !word.endsWith('s') || word.endsWith('ss') ? word : word.slice(0, -1)

function segment(text: string, people: string[], clauses: number, body: string): Segment {
  const seq = (body.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:[.:,%][\p{N}]+)*%?/gu) ?? []).map(stem).filter(t => !STOP.has(t))
  return { text, people, clauses, seq, words: new Set(seq) }
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

/** Whether all of [a]'s words are in [b]: a line merged into another, as far as words show (keptIn, for the History). */
const covers = (a: Set<string>, b: Set<string>): boolean => [...a].every(word => b.has(word))
const share = (a: Set<string>, b: Set<string>) => a.size ? [...a].filter(w => b.has(w)).length / a.size : 0
/** Every place [part] runs, word for word and in order, inside [whole]. */
function occurrences(whole: readonly string[], part: readonly string[]): number[] {
  const found: number[] = []
  outer: for (let i = 0; i + part.length <= whole.length; i++) {
    for (let j = 0; j < part.length; j++) if (whole[i + j] !== part[j]) continue outer
    found.push(i)
  }
  return found
}
const contains = (whole: readonly string[], part: readonly string[]) => occurrences(whole, part).length > 0

/**
 * The attributed rules of [before] that [after] drops: removed, kept without its people, or changed beyond a rewording by the
 * same people. [identify] says who a written name is (commands.ts: a member's id), so "0xken15" and "Ken" can be one person;
 * by default a name is itself, honorifics aside.
 */
export function droppedRules(before: string, after: string, identify: (name: string) => string = personKey,
  places: readonly RulePlace[] = []): DroppedRule[] {
  const next = items(after).map(i => segments(i.text))
  const flat = next.flat()
  const ids = new Map<Segment, Set<string>>(flat.map(s => [s, new Set(s.people.map(identify))]))
  const rules = ruleSegments(before).filter(s => s.people.length).map(rule => ({ rule, people: rule.people.map(identify) }))
  // A segment says only what the rules it names said: each of its words lies in one of them, word for word and in order, or
  // joins two of them (a merge). Anything else (a word changed, moved, added: "unless the PM judges it urgent") is a change
  // nobody can tell is harmless, so every rule in it counts as changed (review of #3112).
  const faithfulTo = (s: Segment, who: Set<string>) => {
    const covered = s.seq.map(word => JOINERS.has(word))
    for (const { rule, people } of rules) {
      if (!rule.seq.length || !people.every(p => who.has(p))) continue
      for (const at of occurrences(s.seq, rule.seq)) for (let k = 0; k < rule.seq.length; k++) covered[at + k] = true
    }
    return covered.every(Boolean)
  }
  const faithful = new Map<Segment, boolean>()
  const isFaithful = (s: Segment) => faithful.get(s) ?? faithful.set(s, faithfulTo(s, ids.get(s)!)).get(s)!
  // Each place's segments with who gave them: its attributions and the people it is known to hold. A rule moved there is
  // held to the same test as in the document: its words in order, with its people, and nothing else said in that segment.
  const moves = places.map(place => ({ place, at: items(place.text).flatMap(i => segments(i.text))
    .map(s => ({ s, who: new Set([...s.people.map(identify), ...place.people]) })) }))
  const movedTo = (rule: Segment, people: string[]) => moves.find(({ at }) => at.some(({ s, who }) =>
    people.every(p => who.has(p)) && contains(s.seq, rule.seq) && faithfulTo(s, who)))?.place
  const dropped: DroppedRule[] = []
  for (const { rule, people } of rules) {
    const theirs = flat.filter(s => people.every(p => ids.get(s)!.has(p)))
    if (theirs.some(s => contains(s.seq, rule.seq) && isFaithful(s))) continue
    const place = rule.seq.length ? movedTo(rule, people) : undefined
    if (place && !place.open) continue
    if (place) { dropped.push({ text: rule.text, people: rule.people, why: 'waiting', movedTo: place.where }); continue }
    // Its words still there, in order: with its people that is a change of meaning, without them a lost attribution.
    const kept = next.find(item => contains(item.flatMap(s => s.seq), rule.seq))
    const why = kept ? (kept.some(s => theirs.includes(s)) ? 'changed' : 'unattributed')
      : theirs.some(s => share(rule.words, s.words) >= 0.5) ? 'changed' : 'removed'
    dropped.push({ text: rule.text, people: rule.people, why })
  }
  return dropped
}

/** The items of [before] that [after] no longer has word for word (a moved or renumbered item is no removal), in document
 *  order: what the History lists as a save's dropped lines (commands.ts instructions.save). */
export function removedItems(before: string, after: string): string[] {
  const left = new Map<string, number>()
  for (const item of items(after)) left.set(item.key, (left.get(item.key) ?? 0) + 1)
  return items(before).flatMap(item => {
    const n = left.get(item.key) ?? 0
    if (n) { left.set(item.key, n - 1); return [] }
    return [item.text]
  })
}

/** Whether an item's words, attributions aside, are all still in one item of [after]: merged there, as far as words show. */
export function keptIn(after: string): (text: string) => boolean {
  const kept = items(after).map(i => new Set(segments(i.text).flatMap(s => [...s.words])))
  return text => {
    const words = new Set(segments(text).flatMap(s => [...s.words]))
    return kept.some(set => covers(words, set))
  }
}

/**
 * The size budget of a project's instructions, in UTF-8 bytes (task #3392, anh Dee 11-05, decision 5: these instructions stay
 * as small as possible). Core is everything outside the role sections and people notes. One object, passed in, so a project's
 * own numbers can replace it.
 */
export const INSTRUCTIONS_BUDGET = { core: 6 * 1024, role: 2 * 1024, people: 3 * 1024, total: 20 * 1024 } as const
export type InstructionsBudget = { readonly [K in keyof typeof INSTRUCTIONS_BUDGET]: number }
/** One part of a document and its size: `core`, `role <heading>` (a ### under ## Roles), `people notes` (a ## People notes
 *  section) or `total` (the whole document). */
export interface BudgetPart { part: string; bytes: number; budget: number }

const ROLES = /^roles$/i
const PEOPLE_NOTES = /^people notes$/i

/** [text]'s budget parts in document order, `total` last. A line belongs to the section its heading opened; a heading in a
 *  fenced block is text. */
export function budgetParts(text: string, budget: InstructionsBudget = INSTRUCTIONS_BUDGET): BudgetPart[] {
  const bytes = new Map<string, number>([['core', 0]])
  let h2 = '', h3 = '', fenced = false
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced
    else if (!fenced) {
      const heading = HEADING.exec(line)
      if (heading?.[1]!.length === 2) { h2 = heading[2]!.trim(); h3 = '' }
      else if (heading?.[1]!.length === 1) { h2 = ''; h3 = '' }
      else if (heading?.[1]!.length === 3) h3 = heading[2]!.trim()
    }
    const part = PEOPLE_NOTES.test(h2) ? 'people notes' : ROLES.test(h2) && h3 ? `role ${h3}` : 'core'
    bytes.set(part, (bytes.get(part) ?? 0) + Buffer.byteLength(line) + (i < lines.length - 1 ? 1 : 0))
  })
  const of = (part: string) => part === 'core' ? budget.core : part === 'people notes' ? budget.people : budget.role
  return [...[...bytes].filter(([part, n]) => n || part === 'core').map(([part, n]) => ({ part, bytes: n, budget: of(part) })),
    { part: 'total', bytes: Buffer.byteLength(text), budget: budget.total }]
}

/** A line [after] adds that repeats one it keeps: the added line's words and the existing line's, as the document has them. */
export interface RepeatedRule { added: string; existing: string }
/** Fewest content words of a line that can be a repeat: a short line ("Tests pass.") says too little to be the same rule. */
const MIN_REPEAT_WORDS = 4
/** Repeats one refusal lists; more are cut. */
export const MAX_REPEATS = 20

/**
 * The lines [after] adds, or rewrites, that say what a line it keeps already says (task #3283, Leo 11-05, from lamp: a PM
 * saved a rule the document had as if it were new, which hid that it had skipped it). Conservative: a repeat has the same
 * content words in the same order, so case, punctuation, list marker, wrapping, attribution, filler words and plurals make no
 * difference, and any changed, added or dropped word, negation or number is a change of substance, not a repeat. A line the
 * old text has word for word is not new; headings and lines under MIN_REPEAT_WORDS words are never repeats; the existing line
 * is one the save keeps, in the same section, or an attributed rule against another (a rule is one rule wherever it sits).
 */
export function repeatedRules(before: string, after: string): RepeatedRule[] {
  const old = new Map<string, number>()
  for (const item of items(before)) old.set(item.key, (old.get(item.key) ?? 0) + 1)
  const kept = new Map<string, { text: string; path: string; attributed: boolean }[]>()
  const added: { segment: Segment; path: string }[] = []
  for (const item of items(after)) {
    if (item.heading) continue
    const n = old.get(item.key) ?? 0
    if (n) old.set(item.key, n - 1)
    for (const segment of segments(item.text)) {
      if (segment.seq.length < MIN_REPEAT_WORDS) continue
      if (n) {
        const key = segment.seq.join(' ')
        kept.set(key, [...kept.get(key) ?? [], { text: segment.text, path: item.path, attributed: segment.people.length > 0 }])
      } else added.push({ segment, path: item.path })
    }
  }
  const repeats: RepeatedRule[] = []
  for (const { segment, path } of added) {
    const same = kept.get(segment.seq.join(' '))?.find(k => k.path === path || (k.attributed && segment.people.length > 0))
    if (same) repeats.push({ added: segment.text, existing: same.text })
  }
  return repeats
}
