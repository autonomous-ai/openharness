// Pure, local text extraction shared by new turns and old USB recap records.
/** Seven readable rows below the companion, with room for word wrapping. */
export const RECAP_MAX_CHARS = 180
/** Keep enough of the opening to explain a short answer, whenever the source has it. */
export const RECAP_MIN_CHARS = 20
/** The body the dial's tap-to-read screen shows. */
export const BODY_MAX_CHARS = 250

/**
 * Turn the engine's own final message into the dial's `recap\n\nbody`, with no model in the loop.
 *
 * The dial is cabled to a Mac whose window is already showing this text in full, so the recap is a
 * GLANCE, not a substitute for reading: whoever wants the detail turns their head. That is what buys
 * the ~9s the one-shot used to cost on every turn. Keep as many opening sentences as fit; only a clipped
 * sentence ends in " +" to say there is more on the desktop.
 *
 * The work is not the cut, it is what gets cut. An engine's last message is markdown: a heading, then
 * bullets, then maybe a table. `slice(0, 60)` of that yields "## Kết quả\n\n- **SJC**: 149,1 triệu
 * đồng/lượn" — a markdown heading and a severed word. So the text is flattened to prose first, and the
 * recap starts at the first line that carries any and stops at the last complete sentence in budget.
 */
export function deriveTurnSummary(text: string): string | null {
  // Markers go, LINE BREAKS STAY. Flattening first merges a label into the sentence under it — "Kết
  // quả:" and its answer become one run with no boundary left to find, and the recap opens on the
  // word that says least.
  const stripped = stripMarkdown(text)
  const body = stripped.replace(/\s+/g, ' ').trim()
  if (!body) return null
  // The answer's OPENING is the headline. The engine-specific turn readers hand this the answer alone —
  // Codex's `commentary` messages ("I'll check the page", "I'm about to ask") are dropped there, since
  // a headline taken from those announced the work instead of stating the result.
  const recap = clip(firstProseOpening(stripped) || body, RECAP_MAX_CHARS, ' +')
  return `${recap}\n\n${deriveTurnBody(text)}`
}

/** The `text` under a recap: the answer flattened to one line and clipped — a glance, never a
 *  paraphrase. Shared by both recap writers so the body reads the same whoever wrote the headline. */
export function deriveTurnBody(text: string): string {
  return clip(stripMarkdown(text).replace(/\s+/g, ' ').trim(), BODY_MAX_CHARS)
}

/** Cut to `max` characters on a word boundary, marking the cut. Never mid-word if it can be helped. */
function clip(text: string, max: number, marker = '…'): string {
  const t = text.trim()
  if (t.length <= max) return t
  const head = t.slice(0, max - marker.length)
  const space = head.lastIndexOf(' ')
  // Only honour the word boundary when it is not throwing most of the budget away — a long unbroken
  // token (a path, a URL) would otherwise collapse the line to nothing.
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:–—-]+$/, '')}${marker}`
}

/**
 * Markdown → one flat run of prose the dial can draw.
 *
 * Fenced code and tables go entirely: a tile is 466px of round glass, and half a shell command wrapped
 * across three lines says less than the sentence next to it.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '\n')         // fenced code
    .replace(/^\s*\|.*\|\s*$/gm, '')           // table rows
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')        // headings — the marker, not the words
    .replace(/^\s*[-*+]\s+/gm, '')            // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '')            // ordered-list markers
    .replace(/^\s*>\s?/gm, '')                // block quotes
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')  // links and images → their label
    .replace(/[*_~`]/g, '')                   // emphasis and inline code marks
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * The longest opening run of complete sentences within the headline budget.
 *
 * Skips lead-ins that name the shape of the answer rather than the answer — "Kết quả:", "Here's what I
 * found:" — because those are exactly what a heading collapses into once its `##` is gone, and a tile
 * reading "Kết quả" has told the user nothing.
 */
function firstProseOpening(stripped: string): string {
  // Lines first, then sentences within a line: the line is the structure markdown actually carries,
  // and a label only reads as a label while it still has a line of its own.
  const candidates: string[] = []
  for (const line of stripped.split(/\n+/)) {
    for (const piece of line.split(/(?<=[.!?])\s+/)) {
      const candidate = piece.trim()
      if (candidate.length < 3 && !BARE_ACKNOWLEDGMENT.test(candidate)) continue
      if (/^[^\p{L}\p{N}]+$/u.test(candidate)) continue   // punctuation or symbols only
      candidates.push(candidate)
    }
  }
  // A LABEL is a short line that never finishes a thought — "Kết quả:", and the same words again once
  // a heading's `##` has been taken off it. Both name the shape of the answer instead of giving it, so
  // skip past them while there is anything else to say. Alone, a short line IS the answer.
  const start = Math.max(0, candidates.findIndex((c) =>
    c.length > LABEL_MAX_CHARS || /[.!?]$/.test(c) || BARE_ACKNOWLEDGMENT.test(c)))
  const opening = candidates.slice(start)
  let prefix = ''
  let complete = ''
  let useful = false
  for (const sentence of opening) {
    const next = prefix ? `${prefix} ${sentence}` : sentence
    if (next.length > RECAP_MAX_CHARS) break
    prefix = next
    useful ||= !BARE_ACKNOWLEDGMENT.test(sentence)
    if (useful && prefix.length >= RECAP_MIN_CHARS && /[.!?]$/.test(sentence)) complete = prefix
  }
  // An opening shorter than 20 characters must not strand its explanation.
  // Otherwise keep the complete prefix without marking the unselected remainder.
  // If nothing useful fits, clip the opening normally; never invent a sentence.
  return complete || opening.join(' ').replace(/:$/, '')
}

/** Longer than this and a line is saying something, not naming a section. */
const LABEL_MAX_CHARS = 24
const BARE_ACKNOWLEDGMENT = /^(?:yes|no|ok|okay|sure|done|right|correct)[.!?]*$/i

/** Repair recaps cached by older hosts using only the same turn's supplied body. */
export function extendShortRecap(recap: string, body: string): string {
  const clean = recap.trim().replace(/ \+$/, '')
  if (clean.length >= RECAP_MAX_CHARS || body.trim().length <= clean.length) return recap
  const extended = deriveTurnSummary(body)?.split('\n\n')[0] ?? ''
  // Grow older shorter recaps only when the longer body starts with the
  // exact same opening. Never replace it with unrelated text or invent length.
  return extended.startsWith(clean) && extended.length > clean.length ? extended : recap
}
