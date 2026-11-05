/**
 * What an instructions save really changed, for the line it posts in the project chat (task #3021, Ken 11-05): the
 * lines it removed and added against the revision it replaced, so a PM's "I wrote it into the instructions" can be
 * checked. Computed once per save from the two texts the save already holds (commands.ts saveInstructions); nothing
 * is stored or read for it.
 */

/** Changed lines the chat line shows; the rest are counted. */
export const CHANGE_LINES = 12
/** Characters of one shown line; a longer one is cut, never left out. */
export const LINE_CHARS = 160
/** Edits compared line by line. Past this a 64 KB rewrite would cost (N+M)·D steps, so the region between the common
 *  head and tail is shown as removed and added whole: still the real lines, only not the smallest diff. */
const MAX_EDITS = 1000

type Edit = { sign: '-' | '+'; line: string }

/** The Markdown under the summary of a save from [before] to [after]: the changed lines in a `diff` code block, then how
 *  many more there are. Every line in the block starts with its sign, so a saved line's backticks, tags or links never
 *  leave it. [before] null is an earlier revision the store could not read: said, never shown as no change. */
export function instructionsChange(before: string | null, after: string): string {
  if (before === null) return 'The earlier revision could not be read, so the change is not shown.'
  const edits = lineEdits(lines(before), lines(after))
  if (!edits.length) return 'Only blank lines changed.'
  const shown = edits.slice(0, CHANGE_LINES).map(e => `${e.sign} ${cut(e.line)}`)
  const more = edits.length - shown.length
  return `\`\`\`diff\n${shown.join('\n')}\n\`\`\`${more ? `\n\nand ${more} more line${more === 1 ? '' : 's'}.` : ''}`
}

/** The lines that carry words: blank ones are spacing, neither shown nor counted. */
const lines = (text: string) => text.split(/\r?\n/).filter(line => line.trim())

function cut(line: string): string {
  if (line.length <= LINE_CHARS) return line
  let end = LINE_CHARS - 1
  // Never half of a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(line[end - 1]!)) end -= 1
  return `${line.slice(0, end)}…`
}

/** The removals and additions from [a] to [b] in document order, a removal before the addition that replaces it. */
function lineEdits(a: string[], b: string[]): Edit[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const from = a.slice(head, a.length - tail), to = b.slice(head, b.length - tail)
  return myers(from, to) ?? [...from.map(line => ({ sign: '-' as const, line })), ...to.map(line => ({ sign: '+' as const, line }))]
}

/** Myers' shortest edit script (1986), or null past MAX_EDITS. Each step keeps only its own diagonals -d..d. */
function myers(a: string[], b: string[]): Edit[] | null {
  const n = a.length, m = b.length
  if (!n || !m) return [...a.map(line => ({ sign: '-' as const, line })), ...b.map(line => ({ sign: '+' as const, line }))]
  const offset = n + m + 1
  const v = new Int32Array(2 * offset + 1)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
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
    edits.push(down ? { sign: '+', line: b[prevY]! } : { sign: '-', line: a[prevX]! })
    x = prevX
    y = prevY
  }
  return edits.reverse()
}
