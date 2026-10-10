/**
 * Small text helpers shared by the readers: front matter, Markdown sections, titles, `~` paths.
 *
 * The memory files are written by models and by people, so nothing here trusts their shape: front matter
 * may be missing or half-written, headings may be absent, and a file may be one long paragraph. Every
 * function returns something usable for any input.
 */

import { basename, extname } from 'node:path'

const unquote = (value) => {
  const text = value.trim()
  if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))) return text.slice(1, -1)
  return text
}

/**
 * YAML front matter, one level of nesting deep — enough for Claude Code's `name`, `description` and
 * `metadata: { type }`. A value this cannot read stays a string; a file without front matter is all body.
 */
export function frontmatter(text) {
  const source = String(text ?? '')
  if (!/^---\r?\n/.test(source)) return { data: {}, body: source }
  const end = source.search(/\r?\n---\s*(\r?\n|$)/)
  if (end < 0) return { data: {}, body: source }
  const head = source.slice(source.indexOf('\n') + 1, end)
  const after = source.slice(end).replace(/^\r?\n---\s*/, '')
  const data = {}
  let parent = null
  let block = []
  let literal = false
  // `key:` followed by indented lines is either a nested map (`metadata:\n  type: user`) or a block of
  // text (`description: |` or plain continuation lines); text becomes the key's string value.
  const close = () => {
    if (parent && block.length && !Object.keys(data[parent]).length) data[parent] = block.join(' ').trim()
    else if (parent && typeof data[parent] === 'object' && !Object.keys(data[parent]).length) data[parent] = ''
    parent = null; block = []; literal = false
  }
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = /^([ \t]*)([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line.slice(0, 4000))
    const indented = /^[ \t]/.test(line)
    if (!match || (literal && indented)) { if (parent && indented) block.push(line.trim()); continue }
    const [, indent, key, value] = match
    if (indent.length === 0) {
      close()
      if (value === '' || ['|', '>', '|-', '>-', '|+', '>+'].includes(value)) { data[key] = {}; parent = key; literal = value !== '' } else data[key] = unquote(value)
    } else if (parent && typeof data[parent] === 'object' && !block.length) {
      data[parent][key] = unquote(value)
    } else if (parent) block.push(line.trim())
  }
  close()
  return { data, body: after.replace(/^\r?\n/, '') }
}

/**
 * A heading line's text, or null: `## Title ##` → `Title`. Plain string work, no backtracking regex —
 * a model-written line of thousands of spaces once made a `(.+?)\s*#*\s*$` pattern take seconds, and the
 * viewer re-reads every few seconds. Lines over 2,000 characters are not headings.
 */
export function headingText(line, maxLevel = 6, exactLevel = null) {
  const value = String(line ?? '')
  if (value.length > 2000 || value[0] !== '#') return null
  let level = 0
  while (value[level] === '#') level++
  if (level > maxLevel || (exactLevel !== null && level !== exactLevel)) return null
  if (value[level] !== ' ' && value[level] !== '\t') return null
  let text = value.slice(level).trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trim()
  return text || null
}

/** The first Markdown heading's text (levels 1–3), or null. */
export function firstHeading(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = headingText(line, 3)
    if (heading) return heading
  }
  return null
}

/** A file name or slug as words: `feedback_merge-without-asking.md` → `Feedback merge without asking`. */
export function humanize(name) {
  const words = basename(String(name ?? ''), extname(String(name ?? ''))).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Untitled'
}

/** The first sentence-ish line of prose, for a row's description when the file gives none. */
export function firstLine(text, max = 160) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[-*>#\s]+/, '').replace(/[*_`]/g, '').trim()
    if (line.length > 2) return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line
  }
  return ''
}

/**
 * A long file cut at its headings of `level` (2 = `##`), each part with its own title. Text before the
 * first heading is a part of its own when it has more than a line of prose. A file with no such heading
 * is one part.
 */
export function sections(text, level = 2) {
  const parts = []
  let current = { title: null, lines: [] }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = headingText(line, level, level)
    if (heading) {
      if (current.title || current.lines.join('').trim().length > 40) parts.push(current)
      current = { title: heading, lines: [] }
    } else current.lines.push(line)
  }
  if (current.title || current.lines.join('').trim()) parts.push(current)
  return parts.map((part) => ({ title: part.title, body: part.lines.join('\n').trim() })).filter((part) => part.body || part.title)
}

/** Entries separated by `§` lines (Hermes keeps its memory this way); plain text is one entry. */
export function entries(text) {
  const parts = String(text ?? '').split(/^[ \t]*§[ \t]*$/m).map((part) => part.trim()).filter(Boolean)
  return parts.length ? parts : []
}

/** `/Users/x/.claude/…` → `~/.claude/…` for display; paths outside the home folder are unchanged. */
export function tilde(path, home) {
  const value = String(path ?? '')
  if (home && (value === home || value.startsWith(home + '/'))) return '~' + value.slice(home.length)
  return value
}

/** What Claude Code (and Harness's session index) use as a folder's key: every non-alphanumeric → `-`. */
export function encodePath(path) {
  return String(path ?? '').replace(/[^A-Za-z0-9]/g, '-')
}

/** Cut a body to `max` characters at a line break where possible, saying it was cut. */
export function clip(text, max = 64 * 1024) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const cut = value.lastIndexOf('\n', max)
  return value.slice(0, cut > max * 0.8 ? cut : max) + '\n\n…'
}
