/** Read only an engine's live footer. No generated status words or transcript inference. */
export function terminalActivity(engine: string, screen: string | null): string | null {
  return terminalActivityReading(engine, screen)?.label ?? null
}

/** Keep the live indicator as well as its label: successive changes to its
 * timer/spinner prove the UI is alive; an abandoned static screen does not. */
export function terminalActivityReading(engine: string, screen: string | null): { label: string; indicator: string } | null {
  if (!screen || (engine !== 'claude' && engine !== 'codex')) return null
  const lines = screen.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
  let end = lines.length
  if (engine === 'claude') {
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
  }
  for (let i = end - 1; i >= Math.max(0, end - 16); i--) {
    const line = lines[i].trim()
    const match = engine === 'codex'
      ? /^[•◦⠁-⣿]\s+(.{1,60}?)\s+\([^\n]*\besc to interrupt\b[^\n]*\)\s*$/i.exec(line)
      : /^[✢✳✶✻✽·*]\s+([\p{L}][\p{L}\p{N} '\u2019-]{0,55}(?:…|\.{3}))(?:\s+\([^\n]*\))?\s*$/u.exec(line)
    if (match) return { label: match[1].trim().replace(/…/g, '...'), indicator: line }
  }
  return null
}
