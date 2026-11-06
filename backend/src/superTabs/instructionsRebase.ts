/**
 * Every project's instructions on the new base, in one approved change (task #3600, anh Dee 11-06: "update them all and
 * override all of their existing instructions. ALL OF THEM"; River's ruling with him: "REPLACE 100%"). All process is the
 * Swarm's built-in PM text (pmSchedule.ts, #3603), never copied into a document. A document keeps only a short intro, the
 * project's own facts (repo, devices, people's areas: given per project by the run) and People notes: every block of the old
 * document that holds a person's rule, word for word with who gave it, filed under the section it came from. The rule guard's
 * own reader (instructionsDiff.ts droppedRules) checks that nothing a person gave is lost; a project that would lose one is
 * refused, never written.
 */
import { attributedRules, droppedRules, type AttributedRule, type DroppedRule } from './instructionsDiff.js'

export const REBASED_INTRO = `# Project instructions

How this project works is built into Harness. This document holds only this project's own facts and, in People notes, the
rules its people gave, word for word.`

export interface RebasedDocument {
  text: string
  /** The person's rules the new document carries, in the old document's order. */
  carried: AttributedRule[]
  /** Rules the new document would lose (droppedRules): none, or the project is not written. */
  lost: DroppedRule[]
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(?:```|~~~)/
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/
const PEOPLE_NOTES = /^people notes$/i
const indent = (line: string) => /^[ \t]*/.exec(line)![0].length
const holdsRule = (lines: readonly string[]) => attributedRules(lines.join('\n')).length > 0

/** One piece of the old document carried whole: a top-level block (a list item with its wrapped lines and the items under
 *  it, a paragraph or a fenced block) under [path], or a section whose heading names a person ([heading]). */
interface Piece { path: string; lines: string[]; section: boolean }

/** [text]'s pieces that hold a person's rule, in document order. A heading in a fence is text. */
function pieces(text: string): Piece[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const headings: (string | undefined)[] = []
  const pathOf = () => {
    const below = headings.slice(1).filter((h): h is string => !!h)
    const path = below.length ? below : headings.slice(0, 1).filter((h): h is string => !!h)
    // People notes of an earlier run (or kept by hand) file their rules again under the section they name.
    if (path[0] && PEOPLE_NOTES.test(path[0])) path.shift()
    return path.join(' › ')
  }
  const found: Piece[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }
    const heading = FENCE.test(line) ? null : HEADING.exec(line)
    if (heading) {
      const level = heading[1]!.length, title = heading[2]!.trim()
      if (holdsRule([title])) {
        // Every line under a heading that names a person is theirs: the section is carried whole, to its next sibling heading.
        const parent = (headings.length = level - 1, pathOf())
        const section = [line]
        let fenced = false
        for (i++; i < lines.length; i++) {
          const next = lines[i]!
          if (FENCE.test(next)) fenced = !fenced
          const inner = fenced || FENCE.test(next) ? null : HEADING.exec(next)
          if (inner && inner[1]!.length <= level) break
          section.push(next)
        }
        // Its heading becomes a People notes subsection; headings under it keep their depth below it.
        const shift = 3 - level
        let inFence = false
        const moved = section.map(l => {
          if (FENCE.test(l)) { inFence = !inFence; return l }
          const h = inFence ? null : HEADING.exec(l)
          return h ? `${'#'.repeat(Math.min(6, Math.max(3, h[1]!.length + shift)))} ${h[2]!.trim()}` : l
        })
        while (moved.length && !moved.at(-1)!.trim()) moved.pop()
        found.push({ path: parent, lines: moved, section: true })
        headings[level - 1] = undefined
        continue
      }
      headings.length = level - 1
      headings[level - 1] = title
      i++
      continue
    }
    const block = [line]
    const base = indent(line), listed = LIST_ITEM.test(line)
    let fenced = FENCE.test(line)
    for (i++; i < lines.length; i++) {
      const next = lines[i]!
      if (fenced) { block.push(next); if (FENCE.test(next)) fenced = false; continue }
      if (!next.trim()) {
        // A blank line ends the block unless what follows is indented under it.
        let k = i + 1
        while (k < lines.length && !lines[k]!.trim()) k++
        if (k < lines.length && listed && indent(lines[k]!) > base && !HEADING.exec(lines[k]!)) { block.push(...lines.slice(i, k)); i = k - 1; continue }
        break
      }
      if (HEADING.exec(next) && !FENCE.test(next)) break
      const item = LIST_ITEM.exec(next)
      if (item && (!listed || item[1]!.length <= base)) break
      if (FENCE.test(next)) fenced = true
      block.push(next)
    }
    if (holdsRule(block)) found.push({ path: pathOf(), lines: block, section: false })
  }
  return found
}

const key = (lines: readonly string[]) => lines.join(' ').replace(/\s+/g, ' ').trim()
/** Pieces joined as written: list items line after line, anything else after a blank line, so no paragraph joins an item. */
function joined(blocks: readonly string[][]): string {
  return blocks.map((lines, k) => (k && !(LIST_ITEM.test(lines[0]!) && LIST_ITEM.test(blocks[k - 1]![0]!)) ? '\n' : '') + lines.join('\n')).join('\n')
}

/** [before]'s document on the new base, with [facts] as its "This project" section. Pure: the same input gives the same text,
 *  and a document already on the base with the same facts gives itself. */
export function rebasedDocument(before: string, facts = ''): RebasedDocument {
  const seen = new Set<string>()
  const groups = new Map<string, string[][]>([['', []]])
  const sections: string[][] = []
  for (const piece of pieces(before)) {
    const id = key(piece.lines)
    if (seen.has(id)) continue
    seen.add(id)
    if (piece.section) sections.push(piece.lines)
    else groups.set(piece.path, [...groups.get(piece.path) ?? [], piece.lines])
  }
  const notes = [...groups].filter(([, blocks]) => blocks.length)
    .map(([path, blocks]) => path ? `### ${path}\n\n${joined(blocks)}` : joined(blocks))
  const parts = [REBASED_INTRO]
  if (facts.trim()) parts.push(`## This project\n\n${facts.trim()}`)
  if (notes.length || sections.length) parts.push(['## People notes', ...notes, ...sections.map(lines => lines.join('\n'))].join('\n\n'))
  const text = `${parts.join('\n\n')}\n`
  return { text, carried: attributedRules(before), lost: droppedRules(before, text) }
}
