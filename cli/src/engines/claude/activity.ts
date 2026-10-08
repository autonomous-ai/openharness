/** Native live indicator, read only from the current footer. */
export function activity(screen: string): { label: string; indicator: string } | null {
  const lines = screen.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
  let end = lines.length
  // The expanded agent tree sits BELOW the prompt and can push the live
  // spinner out of the last 16 rows. Anchor to the actual input/footer pair,
  // retaining a short search above it instead of scanning old output.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 64); i--) {
    if (/^\s*[❯›>](?:\s|$)/u.test(lines[i]) &&
        lines.slice(i + 1, i + 9).some(line => /shift\+tab to cycle|esc to interrupt/i.test(line))) {
      end = i
      break
    }
  }
  for (let i = end - 1; i >= Math.max(0, end - 16); i--) {
    const line = lines[i].trim()
    const match = /^[✢✳✶✻✽·*]\s+([\p{L}][\p{L}\p{N} '\u2019-]{0,55}(?:…|\.{3}))(?:\s+\([^\n]*\))?\s*$/u.exec(line)
    if (match) return { label: match[1].trim().replace(/…/g, '...'), indicator: line }
  }
  return null
}
