/**
 * About You: one short Markdown file about how you work, built from your own words across every agent.
 *
 * It lives at `~/.harness/memory/about-you.md` — one per person on this computer, not one per workspace —
 * so every Memories workspace shows the same profile and, later, every agent can be handed it. The
 * agent in the Memories pane writes it (skills/about-you); this module reads it for the viewer and writes
 * it for `mem about write`, atomically and keeping the previous version beside it.
 *
 * The format is plain Markdown the person can read without this viewer:
 *
 *   ## How you work
 *   - Wants short, direct answers; asks for a tl;dr when replies run long. [claude:concise-replies.md, asks:37]
 *
 * A trailing `[…]` on a line lists where it came from: `<agent>:<file>` for an agent's memory,
 * `session:<id>` for a conversation, `asks:<n>` for how many of your messages say it.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

export const ABOUT_FILE = 'about-you.md'
export const PREVIOUS_FILE = 'about-you.prev.md'
const MAX_ABOUT = 32 * 1024

/** The file split into sections and lines, each line with its sources. */
export function parseAbout(text) {
  const source = String(text ?? '')
  const lines = []
  let section = null
  let intro = []
  for (const raw of source.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw)
    if (heading) { section = heading[1]; continue }
    if (/^#\s+/.test(raw)) continue
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(raw)
    if (item) {
      const sources = /\s*\[([^\]]*)\]\s*$/.exec(item[1])
      const refs = sources ? sources[1].split(',').map((ref) => ref.trim()).filter(Boolean) : []
      const text = sources ? item[1].slice(0, sources.index).trim() : item[1]
      if (text) lines.push({ section: section ?? 'About you', text, refs })
    } else if (!section && raw.trim()) intro.push(raw.trim())
  }
  return { intro: intro.join(' '), lines }
}

/** The profile on disk, parsed, or `null` when none has been built yet. */
export function readAbout(dir) {
  const path = join(dir, ABOUT_FILE)
  try {
    const text = readFileSync(path, 'utf8')
    const modified = statSync(path).mtimeMs
    return { text, modified: Math.round(modified), ...parseAbout(text) }
  } catch {
    return null
  }
}

/** Replace the profile. The previous one is kept as about-you.prev.md; a half-written file never shows. */
export function writeAbout(dir, text) {
  const value = String(text ?? '')
  if (!value.trim()) throw new Error('Refusing to write an empty About You.')
  if (Buffer.byteLength(value) > MAX_ABOUT) throw new Error(`About You is limited to ${MAX_ABOUT / 1024} KB; keep it short.`)
  if (!parseAbout(value).lines.length) throw new Error('About You needs at least one "- line" under a "## Section".')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, ABOUT_FILE)
  try { copyFileSync(path, join(dir, PREVIOUS_FILE)) } catch { /* the first profile has nothing to keep */ }
  const temporary = join(dir, `.${ABOUT_FILE}.${process.pid}.tmp`)
  writeFileSync(temporary, value.endsWith('\n') ? value : value + '\n', { mode: 0o600 })
  renameSync(temporary, path)
  return path
}
