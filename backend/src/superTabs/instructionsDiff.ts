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
