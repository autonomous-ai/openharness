/**
 * The most scrollback a moved pane is seeded with, as the create request carries it: JSON-encoded, where each ESC of a
 * colour code is six bytes (`\u001b`) and each line break four (`\r\n`). Half the host's frame limit (`MAX_FRAME`,
 * 8 MiB), so a seed never comes near it whatever the scrollback holds. The oldest lines are dropped first.
 */
export const SEED_MAX_BYTES = 4 * 1024 * 1024

/** How many history lines the old pane is captured with (`capture(..., { historyLines, ansi: true })`). */
export const SEED_HISTORY_LINES = 2000

/** What [line] costs in the create request's JSON: its escaped UTF-8 bytes, without the quotes. */
const encodedBytes = (line: string): number => Buffer.byteLength(JSON.stringify(line)) - 2
/** `\r\n` escaped. */
const BREAK_BYTES = 4

/**
 * A capture as the seed a new pty pane starts with: lines ending in `\r\n`, as the host's terminal expects, cut from the
 * top by whole lines until the text, JSON-encoded, fits `maxBytes`. A cut mid-line would start the pane on a torn escape
 * or a torn character. A single last line over the cap leaves an empty seed.
 */
export function seedFromCapture(text: string, maxBytes: number = SEED_MAX_BYTES): string {
  const lines = text.split(/\r?\n/)
  // A capture ends with a line break; the host drops one trailing break itself, so this one is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  let bytes = 0
  let start = lines.length
  while (start > 0) {
    const cost = encodedBytes(lines[start - 1]!) + (start < lines.length ? BREAK_BYTES : 0)
    if (bytes + cost > maxBytes) break
    bytes += cost
    start--
  }
  return lines.slice(start).join('\r\n')
}
