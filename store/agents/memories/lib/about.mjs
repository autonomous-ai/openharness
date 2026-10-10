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

import { constants, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ABOUT_FILE = 'about-you.md'
export const PREVIOUS_FILE = 'about-you.prev.md'
/**
 * Which build this is. Every machine keeps the highest it has seen; a build here is one more than that.
 * Machines compare generations, not file times: a machine whose clock runs ahead must not make every
 * newer build elsewhere look older.
 */
export const META_FILE = 'about-meta.json'

export function readMeta(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8'))
    return { gen: Number.isInteger(meta.gen) ? meta.gen : 0, seen: Number.isInteger(meta.seen) ? meta.seen : 0 }
  } catch { return { gen: 0, seen: 0 } }
}

function writeMeta(dir, meta) {
  const temporary = join(dir, `.${META_FILE}.${process.pid}.tmp`)
  rmSync(temporary, { force: true })
  writeFileSync(temporary, JSON.stringify(meta) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, join(dir, META_FILE))
}

/** Remember the highest generation another machine has, so the next build here outranks it. */
export function noteSeen(dir, gen) {
  if (!Number.isInteger(gen)) return
  const meta = readMeta(dir)
  if (gen <= meta.seen) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeMeta(dir, { ...meta, seen: gen })
}
const MAX_ABOUT = 32 * 1024

/** The file split into sections and lines, each line with its sources. */
export function parseAbout(text) {
  const source = String(text ?? '')
  const lines = []
  let section = null
  let intro = []
  // Plain string work per line: no pattern here can backtrack on a long run of spaces.
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('## ')) { section = line.slice(3).trim() || section; continue }
    if (line.startsWith('# ')) continue
    if (/^[-*][ \t]/.test(line) && line.length > 2) {
      let body = line.slice(2).trim()
      let refs = []
      const open = body.endsWith(']') ? body.lastIndexOf('[') : -1
      if (open >= 0) {
        refs = body.slice(open + 1, -1).split(',').map((ref) => ref.trim()).filter(Boolean)
        body = body.slice(0, open).trim()
      }
      if (body) lines.push({ section: section ?? 'About you', text: body, refs })
    } else if (!section && line) intro.push(line)
  }
  return { intro: intro.join(' '), lines }
}

/** The profile on disk, parsed, or `null` when none has been built yet. */
export function readAbout(dir) {
  const path = join(dir, ABOUT_FILE)
  try {
    const info = statSync(path)
    if (!info.isFile()) return null
    // Written only through writeAbout (≤ 32 KB); a larger file someone put there is read in part.
    const buffer = Buffer.alloc(Math.min(info.size, 2 * MAX_ABOUT))
    const fd = openSync(path, 'r')
    let read = 0
    try { read = readSync(fd, buffer, 0, buffer.length, 0) } finally { closeSync(fd) }
    const text = buffer.subarray(0, read).toString('utf8')
    const modified = info.mtimeMs
    return { text, modified: Math.round(modified), gen: readMeta(dir).gen, ...parseAbout(text) }
  } catch {
    return null
  }
}

/**
 * Replace the profile. The previous one is kept as about-you.prev.md; a half-written file never shows.
 *
 * A build here is numbered `max(now, highest seen + 1)`: later than anything any machine has told this
 * one, and — between builds made without seeing each other, a new machine's first and an old machine's
 * last — the later one in time. A copy of another machine's build keeps that build's number (`gen`)
 * and never moves this one backwards: an older number, or the same number with text that ranks lower
 * (lib/fleet.mjs newestAbout), is left unwritten and `null` is returned.
 */
export function writeAbout(dir, text, { gen, now = Date.now() } = {}) {
  const value = String(text ?? '')
  if (!value.trim()) throw new Error('Refusing to write an empty About You.')
  if (Buffer.byteLength(value) > MAX_ABOUT) throw new Error(`About You is limited to ${MAX_ABOUT / 1024} KB; keep it short.`)
  if (!parseAbout(value).lines.length) throw new Error('About You needs at least one "- line" under a "## Section".')
  // Every agent's copy is wrapped in <about-you> and, in shared files, between marker comments; text
  // that matches either would end the copy early, leaving the rest outside it or behind after `off`.
  if (/harness-memories:about-you|<\/?about-you/i.test(value)) throw new Error('About You cannot contain "<about-you" or the harness-memories marker.')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, ABOUT_FILE)
  if (Number.isInteger(gen)) {
    const have = readMeta(dir).gen
    let current = null
    try { current = readFileSync(path, 'utf8') } catch { /* nothing here yet */ }
    if (current !== null && (gen < have || (gen === have && current.trimEnd() >= value.trimEnd()))) return null
  }
  const previous = join(dir, PREVIOUS_FILE)
  const temporary = join(dir, `.${ABOUT_FILE}.${process.pid}.tmp`)
  // Never write through a link someone left at one of these names: remove whatever is there, then
  // create the file fresh (`wx` fails rather than follow a link planted in between).
  rmSync(temporary, { force: true })
  try {
    if (lstatSync(path).isFile()) { rmSync(previous, { force: true }); copyFileSync(path, previous, constants.COPYFILE_EXCL) }
  } catch { /* the first profile has nothing to keep */ }
  writeFileSync(temporary, value.endsWith('\n') ? value : value + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
  const meta = readMeta(dir)
  const next = Number.isInteger(gen) ? gen : Math.max(now, meta.gen + 1, meta.seen + 1)
  writeMeta(dir, { gen: next, seen: Math.max(meta.seen, next) })
  return path
}
