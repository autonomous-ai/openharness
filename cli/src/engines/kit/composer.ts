import { stripVTControlCharacters } from 'node:util'

export function screenLines(capture: string): { lines: string[]; raw: string[] } {
  const raw = capture.split('\n')
  const lines = raw.map((line) => stripVTControlCharacters(line).replace(/ /g, ' ').trimEnd())
  while (lines.length && !lines.at(-1)) { lines.pop(); raw.pop() }
  return { lines, raw }
}

/** Whether the first character of a row is drawn bold: the SGR in force when it is written. */
export function startsBold(row: string): boolean {
  let bold = false
  const sgr = /^\u001b\[([0-9;:]*)m/
  let rest = row
  for (let match = sgr.exec(rest); match; match = sgr.exec(rest)) {
    for (const code of match[1].split(/[;:]/)) {
      if (code === '1') bold = true
      else if (code === '' || code === '0' || code === '22') bold = false
    }
    rest = rest.slice(match[0].length)
  }
  return bold
}

/** The word being typed at the end of a draft, where a `/command` or an `@mention` opens its popup. */
export function typedToken(draft: string): string {
  return draft.split(/\s/).at(-1) ?? ''
}

