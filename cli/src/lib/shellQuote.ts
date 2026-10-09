/** `value` as one word to a POSIX shell: single-quoted, each `'` closed, given in double quotes, and reopened. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
