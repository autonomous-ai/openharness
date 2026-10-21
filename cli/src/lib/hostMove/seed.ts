/** The most scrollback a moved pane is seeded with; the oldest lines are dropped first. */
export const SEED_MAX_BYTES = 4 * 1024 * 1024

/** How many history lines the old pane is captured with (`capture(..., { historyLines, ansi: true })`). */
export const SEED_HISTORY_LINES = 2000

/**
 * A capture as the seed a new pty pane starts with: lines ending in `\r\n`, as the host's terminal expects, cut from the
 * top by whole lines until the text fits `maxBytes` (UTF-8). A cut mid-line would start the pane on a torn escape or a
 * torn character. A single last line over the cap leaves an empty seed.
 */
export function seedFromCapture(text: string, maxBytes: number = SEED_MAX_BYTES): string {
  const lines = text.split(/\r?\n/)
  // A capture ends with a line break; the host drops one trailing break itself, so this one is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  let bytes = 0
  let start = lines.length
  while (start > 0) {
    // The break between this line and the next one costs two bytes.
    const cost = Buffer.byteLength(lines[start - 1]!) + (start < lines.length ? 2 : 0)
    if (bytes + cost > maxBytes) break
    bytes += cost
    start--
  }
  return lines.slice(start).join('\r\n')
}
