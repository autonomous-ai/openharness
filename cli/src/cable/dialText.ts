/** A drawer row's words on the device (cable_notif_t summary, 240 B with its end): eight rows stay one frame. */
const NOTICE_SUMMARY_MAX = 239

/**
 * A drawer row's text as the dial keeps it (firmware recap_preview): whitespace folded to one space, cut on a whole
 * character at `max` bytes, no ellipsis. The dial matches a read row by its words, so a question asked whole and then
 * carried in a drawer stays read; and a window's question text, a plan of kilobytes, made the drawer frame too big to
 * send, every question it carried with it (2026-11-18). It is cut sooner where its JSON passes twice `max`, a field of
 * quotes: JSON writes a control character six bytes wide, and eight rows of them passed the frame cap. Folding them
 * instead changed the words of a question the dial had filed with them, and a read question came back unread. Half an
 * emoji is written '?' here as `send` writes it for the dial: counted as the three bytes UTF-8 gives it, the cut fell
 * short of the dial's own and a read question came back unread.
 */
export function dialText(text: string, max: number): string {
  let out = ''
  let bytes = 0
  let width = 0
  let space = false
  for (const char of text) {
    if (char === ' ' || (char >= '\t' && char <= '\r')) { space = bytes > 0; continue }
    const ch = /[\ud800-\udfff]/u.test(char) ? '?' : char
    const gap = space ? 1 : 0
    const size = Buffer.byteLength(ch, 'utf8')
    const wide = ch === '"' || ch === '\\' ? 2 : ch < ' ' ? 6 : size
    if (bytes + gap + size > max || width + gap + wide > 2 * max) break
    out += space ? ` ${ch}` : ch
    bytes += gap + size
    width += gap + wide
    space = false
  }
  return out
}

/** A drawer row's words and the inbox's summary of a refused question: one cut, or a question read on the dial would
 *  come back in other words and show unread. Cutting its own output changes nothing. */
export function noticeSummary(text: string): string {
  return dialText(text, NOTICE_SUMMARY_MAX)
}
