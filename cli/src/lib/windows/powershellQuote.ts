/** The single quotes PowerShell knows: `'` and the typographic ones, which also end a single-quoted string. */
const SINGLE_QUOTES = new Set(["'", '\u2018', '\u2019', '\u201a', '\u201b'])

/** PowerShell single quotes: nothing is special inside them but a single quote, which is doubled. */
export function ps(word: string): string {
  let quoted = "'"
  for (const char of word) quoted += SINGLE_QUOTES.has(char) ? char + char : char
  return `${quoted}'`
}
