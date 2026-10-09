/**
 * Reading a typed prompt in a composer: the mechanics Claude Code's and Codex's submission readers
 * (nativeSubmission.ts) share with the core's reading for the engines not yet behind a facet
 * (lib/sessionInput.ts). Moved verbatim from sessionInput.ts, so a prompt is judged as it was before.
 */

export function visibleTerminal(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

export function normalizedTerminalText(value: string): string {
  return visibleTerminal(value).replace(/\s+/g, ' ').trim()
}

// Composer region = from the last prompt-marker line to the end (mirrors runtimeProfile.currentPaneUi).
// Marker set covers claude ❯, codex ›, cursor →. A numbered row after the marker is a dialog's, not a prompt.
function composerRegion(capture: string): string {
  const lines = visibleTerminal(capture).split('\n')
  const idx = lines.findLastIndex((line) => {
    const marker = line.search(/[›❯→]/u)
    return marker >= 0 && !/^\s*\d+\.\s/.test(line.slice(marker + 1))
  })
  return (idx >= 0 ? lines.slice(idx) : lines).join('\n') // no marker → whole pane (safe fallback)
}

/** True while the injected prompt is still sitting un-submitted in the terminal composer. */
export function composerHolds(capture: string, content: string): boolean {
  const expected = normalizedTerminalText(content)
  return !!expected && normalizedTerminalText(composerRegion(capture)).includes(expected)
}

/** A row begins with a prompt marker: some composer is drawn, whatever it holds. */
export function composerShown(capture: string): boolean {
  return /^\s*[›❯→]/mu.test(visibleTerminal(capture))
}
