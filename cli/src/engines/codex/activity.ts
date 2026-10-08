/** Native live indicator, read only from the current footer. */
export function activity(screen: string): { label: string; indicator: string } | null {
  const lines = screen.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
  const end = lines.length
  for (let i = end - 1; i >= Math.max(0, end - 16); i--) {
    const line = lines[i].trim()
    const match = /^[•◦⠁-⣿]\s+(.{1,60}?)\s+\([^\n]*\besc to interrupt\b[^\n]*\)\s*$/i.exec(line)
    if (match) return { label: match[1].trim().replace(/…/g, '...'), indicator: line }
  }
  return null
}
