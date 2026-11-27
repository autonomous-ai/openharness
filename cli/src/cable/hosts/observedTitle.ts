// The same rule as the hook's own observedTitle. Two copies on purpose: the hook is one file that ships alone, and
// this process must not load the core's code. The hook's test holds the copies together.
const MAX_TITLE = 64

/** The title to show, or undefined for none. */
export function observedTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let title = value.replace(/\s+/g, ' ').trim()
  if (title.length > MAX_TITLE) {
    title = title.slice(0, MAX_TITLE)
    // A cut between the two halves of a surrogate pair would leave half a character.
    if (/[\ud800-\udbff]$/.test(title)) title = title.slice(0, -1)
    title = title.trim()
  }
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  if (title === '' || /[\u0000-\u001f\u007f]/.test(title)) return undefined
  return title
}
