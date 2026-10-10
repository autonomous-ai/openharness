/**
 * Every memory the agents on this computer keep, read in place and never written.
 *
 * Each reader walks one agent's own folder (lib/agents.mjs says where) and turns what it finds into rows
 * of one shape, so the viewer and the `mem` command can show Claude Code's typed notes, Codex's handbook,
 * Grok Build's topics and Hermes's profile side by side:
 *
 *   { id, agent, kind, type, scope, project, title, description, body, path, modified, size }
 *
 * `kind` is what the row is about, across agents:
 *   you          how you work, your preferences, your corrections (Claude's user and feedback notes,
 *                Hermes and OpenClaw USER.md, Grok's global topics, things you asked an agent to remember)
 *   project      facts about one repository
 *   reference    where something lives
 *   summary      an agent's own digest (Codex's memory summary and handbook)
 *   note         everything else an agent wrote down: observations, daily notes, skills
 *   instructions what you told your agents to always do (global CLAUDE.md, AGENTS.md, rules)
 *
 * The files are the agents' own: this module only reads them, caps what it reads, and skips what it
 * cannot parse. A file an agent is writing while we read it is simply read again on the next pass.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { AGENTS, WHERE, homes as resolveHomes, memorySwitches } from './agents.mjs'
import { GROK_FILE, withoutOurBlock } from './deliver.mjs'
import { clip, encodePath, entries, firstHeading, firstLine, frontmatter, humanize, sections, tilde } from './text.mjs'

const MAX_FILE = 512 * 1024
const MAX_FILES = 4000
const MAX_DEPTH = 6

/**
 * Files read in one pass, across every agent. The viewer reads again every few seconds while open; a
 * home with thousands of memory files must cost a bounded amount of work, and the cache below means an
 * unchanged file costs a stat, not a read.
 */
const pass = { files: 0, truncated: false }
const cache = new Map()

function list(dir) {
  try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

function stat(path) {
  try { return statSync(path) } catch { return null }
}

/** A file's text and dates, or null when it is missing, a directory, or too large to be a note. */
function read(path) {
  if (pass.files >= MAX_FILES) { pass.truncated = true; return null }
  pass.files++
  const info = stat(path)
  if (!info?.isFile() || info.size > MAX_FILE) return null
  const known = cache.get(path)
  if (known && known.size === info.size && known.modified === info.mtimeMs) return known
  try {
    const entry = { text: readFileSync(path, 'utf8'), size: info.size, modified: info.mtimeMs }
    cache.set(path, entry)
    return entry
  } catch { return null }
}

/** A front-matter value as text: a missing key, or a nested map where a string was expected, is ''. */
const text = (value) => (typeof value === 'string' ? value : '')

/** Markdown files under `dir`, depth-first, at most `MAX_DEPTH` folders down. */
function walk(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out
  for (const entry of list(dir)) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, depth + 1, out)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(path)
  }
  return out
}

/**
 * A Claude Code project folder name back to the folder it stands for. Claude replaces every
 * non-alphanumeric character with `-`, so `-Users-me-code-my-app` is ambiguous on its own; the session
 * index's folders settle most of them, and for the rest each level of the real file system is matched
 * against what is left of the name, longest entry first. A folder that no longer exists keeps the name
 * with the home prefix removed.
 */
const probed = new Map()
const MISS_TTL = 5 * 60_000

export function resolveProject(encoded, { home, folders = new Map(), now = Date.now() } = {}) {
  const known = folders.get(encoded)
  if (known) return { name: basename(known), path: known }
  // The viewer collects every few seconds while it is open; the disk probe below lists a directory per
  // level, so its answer is kept — a found folder for good, a miss for a few minutes.
  const cached = probed.get(`${home}\0${encoded}`)
  if (cached && (cached.path || now - cached.at < MISS_TTL)) return { name: cached.name, path: cached.path }
  const answer = probeProject(encoded, home)
  probed.set(`${home}\0${encoded}`, { ...answer, at: now })
  return answer
}

// Folders the probe never lists: on macOS, reading these asks the person for permission (a privacy
// prompt in their face because a viewer was resolving a name), and network volumes can hang.
const ROOT_PRIVATE = ['Applications', 'Library', 'Network', 'System', 'Volumes', 'cores', 'dev', 'proc']
const HOME_PRIVATE = ['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public']

function probeProject(encoded, home) {
  // Matched by full path: a project in `~/dev/app` or `~/code/Library` is still found.
  const skip = new Set([...ROOT_PRIVATE.map((name) => join(sep, name)), ...(home ? HOME_PRIVATE.map((name) => join(home, name)) : [])])
  const probe = (dir, rest, depth) => {
    if (!rest) return dir
    if (depth > 14) return null
    if (skip.has(dir)) return null
    // A symlinked folder counts: on macOS /var and /tmp are links to /private/….
    const names = list(dir).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name)
      .sort((a, b) => b.length - a.length)
    for (const name of names) {
      const key = encodePath(name)
      if (!rest.startsWith(key)) continue
      const after = rest.slice(key.length)
      if (after && after[0] !== '-') continue
      const found = probe(join(dir, name), after.slice(1), depth + 1)
      if (found) return found
    }
    return null
  }
  const rest = encoded.replace(/^-/, '')
  const found = rest ? probe(sep, rest, 0) : null
  if (found) return { name: basename(found), path: found }
  const homeKey = encodePath(home ?? '')
  const label = (homeKey && encoded.startsWith(homeKey) ? encoded.slice(homeKey.length) : encoded).replace(/^-+/, '') || encoded
  return { name: label, path: null }
}

function makeRow(h, fields) {
  const file = fields.file
  const rel = relative(h.home, file)
  const id = `${fields.agent}:${rel.startsWith('..') ? file : rel}${fields.part != null ? `#${fields.part}` : ''}`
  const body = clip(fields.body ?? '')
  return {
    id,
    agent: fields.agent,
    kind: fields.kind,
    type: fields.type ?? null,
    scope: fields.scope ?? (fields.project ? 'project' : 'global'),
    project: fields.project ?? null,
    title: (text(fields.title) || firstHeading(body) || humanize(file)).slice(0, 200),
    description: (text(fields.description) || firstLine(body) || '').slice(0, 400),
    body,
    path: tilde(file, h.home),
    modified: Number.isFinite(fields.modified) ? Math.round(fields.modified) : null,
    size: fields.size ?? body.length,
  }
}

const isoTime = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

// ── Claude Code: ~/.claude/projects/<repo>/memory/*.md, typed in front matter, titled in MEMORY.md ──

const CLAUDE_KIND = { user: 'you', feedback: 'you', project: 'project', reference: 'reference' }

/** `- [Title](file.md) — hook` lines of a MEMORY.md index, by file name. */
export function claudeIndex(text) {
  const index = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?:[—–:-]+\s*)?(.*)$/.exec(line)
    if (match) index.set(basename(match[2]), { title: match[1].trim(), hook: match[3].trim() })
  }
  return index
}

function readClaude(h, folders) {
  const rows = []
  const root = join(h.claude, 'projects')
  for (const entry of list(root)) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name, 'memory')
    const files = list(dir).filter((file) => file.isFile() && file.name.endsWith('.md'))
    if (!files.length) continue
    const index = claudeIndex(read(join(dir, 'MEMORY.md'))?.text)
    const project = resolveProject(entry.name, { home: h.home, folders })
    for (const file of files) {
      if (file.name === 'MEMORY.md') continue
      const path = join(dir, file.name)
      const content = read(path)
      if (!content) continue
      const { data, body } = frontmatter(content.text)
      const type = (text(data.type) || text(data.metadata?.type)).toLowerCase() || null
      const listed = index.get(file.name)
      rows.push(makeRow(h, {
        agent: 'claude', file: path, body, project, scope: 'project',
        kind: CLAUDE_KIND[type] ?? 'note', type: type ?? 'note',
        title: listed?.title || firstHeading(body) || (text(data.name) && !/^[a-z0-9_-]+$/.test(data.name) ? data.name : humanize(text(data.name) || file.name)),
        description: text(data.description) || listed?.hook,
        modified: isoTime(text(data.modified) || text(data.metadata?.modified)) ?? content.modified,
        size: content.size,
      }))
    }
  }
  return rows
}

// ── Codex: ~/.codex/memories/ (v1) and memories_v2/, written by Codex's background consolidation ──

function readCodex(h) {
  const rows = []
  for (const [folder, version] of [['memories', 'v1'], ['memories_v2', 'v2']]) {
    const dir = join(h.codex, folder)
    const summary = read(join(dir, 'memory_summary.md'))
    if (summary?.text.trim()) {
      rows.push(makeRow(h, {
        agent: 'codex', file: join(dir, 'memory_summary.md'), body: summary.text, kind: 'summary', type: `summary ${version}`,
        title: 'What Codex keeps about you', modified: summary.modified, size: summary.size,
      }))
    }
    const handbook = read(join(dir, 'MEMORY.md'))
    if (handbook?.text.trim()) {
      sections(handbook.text).forEach((part, n) => rows.push(makeRow(h, {
        agent: 'codex', file: join(dir, 'MEMORY.md'), part: n, body: part.body, kind: 'summary', type: `handbook ${version}`,
        title: part.title || 'Codex handbook', modified: handbook.modified, size: part.body.length,
      })))
    }
    for (const file of list(join(dir, 'rollout_summaries'))) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue
      const path = join(dir, 'rollout_summaries', file.name)
      const content = read(path)
      if (!content?.text.trim()) continue
      rows.push(makeRow(h, { agent: 'codex', file: path, body: content.text, kind: 'note', type: 'conversation summary', modified: content.modified, size: content.size }))
    }
    // What you asked Codex to remember, word for word: its consolidation treats these as authoritative.
    for (const path of walk(join(dir, 'extensions', 'ad_hoc'))) {
      const content = read(path)
      if (!content?.text.trim()) continue
      rows.push(makeRow(h, { agent: 'codex', file: path, body: content.text, kind: 'you', type: 'remembered on request', modified: content.modified, size: content.size }))
    }
    for (const path of walk(join(dir, 'skills'))) {
      const content = read(path)
      if (!content?.text.trim()) continue
      const { data, body } = frontmatter(content.text)
      rows.push(makeRow(h, {
        agent: 'codex', file: path, body, kind: 'note', type: 'skill',
        title: text(data.name) ? humanize(data.name) : humanize(basename(dirname(path))), description: text(data.description),
        modified: content.modified, size: content.size,
      }))
    }
    // Memory v2 keeps one short summary and little else; any other Markdown at its top level is shown as is.
    if (version === 'v2') {
      for (const file of list(dir)) {
        if (!file.isFile() || !file.name.endsWith('.md') || ['memory_summary.md', 'MEMORY.md'].includes(file.name)) continue
        const path = join(dir, file.name)
        const content = read(path)
        if (content?.text.trim()) rows.push(makeRow(h, { agent: 'codex', file: path, body: content.text, kind: 'summary', type: 'v2', modified: content.modified, size: content.size }))
      }
    }
  }
  return rows
}

// ── Grok Build: ~/.grok/memory-v2/<scope>/topics|observations, or the legacy ~/.grok/memory/ ─────────

function readGrok(h) {
  const rows = []
  for (const path of walk(join(h.grok, 'memory-v2'))) {
    if (basename(path) === 'MEMORY.md') continue // the generated index of both scopes, not a note
    const content = read(path)
    if (!content?.text.trim()) continue
    const parts = relative(join(h.grok, 'memory-v2'), path).split(sep)
    const global = parts.includes('global')
    const observation = parts.includes('observations')
    const { data, body } = frontmatter(content.text)
    rows.push(makeRow(h, {
      agent: 'grok', file: path, body,
      kind: observation ? 'note' : global ? 'you' : 'project',
      type: observation ? 'observation' : 'topic',
      scope: global ? 'global' : 'project',
      project: global ? null : { name: text(data.workspace) ? basename(data.workspace) : 'a workspace', path: text(data.workspace) || null },
      title: text(data.title) || firstHeading(body) || humanize(path), description: text(data.description),
      modified: isoTime(text(data.updated) || text(data.modified)) ?? content.modified, size: content.size,
    }))
  }
  const legacy = join(h.grok, 'memory')
  const global = read(join(legacy, 'MEMORY.md'))
  if (global?.text.trim()) {
    sections(global.text).forEach((part, n) => rows.push(makeRow(h, {
      agent: 'grok', file: join(legacy, 'MEMORY.md'), part: n, body: part.body, kind: 'you', type: 'notes',
      title: part.title || 'Grok notes', modified: global.modified, size: part.body.length,
    })))
  }
  for (const entry of list(legacy)) {
    if (!entry.isDirectory()) continue
    for (const path of walk(join(legacy, entry.name))) {
      const content = read(path)
      if (content?.text.trim()) rows.push(makeRow(h, { agent: 'grok', file: path, body: content.text, kind: 'project', type: 'workspace notes', scope: 'project', project: { name: 'a workspace', path: null }, modified: content.modified, size: content.size }))
    }
  }
  return rows
}

// ── Hermes: ~/.hermes/memories/{USER,MEMORY}.md, entries separated by § ; profiles have their own ──────

function readHermes(h) {
  const rows = []
  const folders = [[join(h.hermes, 'memories'), null]]
  for (const profile of list(join(h.hermes, 'profiles'))) {
    if (profile.isDirectory()) folders.push([join(h.hermes, 'profiles', profile.name, 'memories'), profile.name])
  }
  for (const [dir, profile] of folders) {
    for (const [file, kind, type] of [['USER.md', 'you', 'profile'], ['MEMORY.md', 'note', 'notes']]) {
      const content = read(join(dir, file))
      if (!content?.text.trim()) continue
      entries(content.text).forEach((entry, n) => rows.push(makeRow(h, {
        agent: 'hermes', file: join(dir, file), part: n, body: entry, kind,
        type: profile ? `${type} · ${profile}` : type, title: firstLine(entry, 90), description: '',
        modified: content.modified, size: entry.length,
      })))
    }
  }
  return rows
}

// ── OpenClaw: a Markdown workspace, ~/.openclaw/workspace unless openclaw.json moved it ───────────────

function openclawWorkspace(h) {
  const config = read(join(h.openclaw, 'openclaw.json'))?.text
  const match = config ? /"workspace"\s*:\s*"([^"]+)"/.exec(config) : null
  if (match) return match[1].replace(/^~(?=\/|$)/, h.home)
  return join(h.openclaw, 'workspace')
}

function readOpenclaw(h) {
  const rows = []
  const dir = openclawWorkspace(h)
  const user = read(join(dir, 'USER.md'))
  if (user?.text.trim()) {
    sections(user.text).forEach((part, n) => rows.push(makeRow(h, { agent: 'openclaw', file: join(dir, 'USER.md'), part: n, body: part.body, kind: 'you', type: 'profile', title: part.title || firstHeading(part.body) || 'About you', modified: user.modified })))
  }
  for (const [file, type] of [['MEMORY.md', 'notes'], ['DREAMS.md', 'dreams']]) {
    const content = read(join(dir, file))
    if (!content?.text.trim()) continue
    sections(content.text).forEach((part, n) => rows.push(makeRow(h, { agent: 'openclaw', file: join(dir, file), part: n, body: part.body, kind: 'note', type, title: part.title, modified: content.modified })))
  }
  for (const file of list(join(dir, 'memory'))) {
    if (!file.isFile() || !file.name.endsWith('.md')) continue
    const path = join(dir, 'memory', file.name)
    const content = read(path)
    if (content?.text.trim()) rows.push(makeRow(h, { agent: 'openclaw', file: path, body: content.text, kind: 'note', type: 'daily note', title: basename(file.name, '.md'), modified: content.modified, size: content.size }))
  }
  return rows
}

// ── Gemini CLI: memories saved with /memory add land under "## Gemini Added Memories" in GEMINI.md ──

function readGemini(h) {
  const rows = []
  const path = join(h.gemini, 'GEMINI.md')
  const content = read(path)
  if (!content?.text.trim()) return rows
  // Delivery appends About You at the end of GEMINI.md, which is inside this section when it comes last:
  // read without it, or About You's own lines come back as things Gemini saved.
  const added = sections(withoutOurBlock(content.text)).find((part) => /gemini added memories/i.test(part.title ?? ''))
  if (added) {
    added.body.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean).forEach((line, n) => rows.push(makeRow(h, {
      agent: 'gemini', file: path, part: `saved-${n}`, body: line, kind: 'you', type: 'saved', title: firstLine(line, 90), modified: content.modified,
    })))
  }
  return rows
}

// ── What you told your agents: global instruction files and rules, written by you ────────────────────

function readInstructions(h) {
  const files = [
    ['claude', join(h.claude, 'CLAUDE.md')],
    ['codex', join(h.codex, 'AGENTS.md')],
    ['codex', join(h.codex, 'AGENTS.override.md')],
    ['gemini', join(h.gemini, 'GEMINI.md')],
    ['opencode', join(h.opencode, 'AGENTS.md')],
    ['pi', join(h.pi, 'agent', 'AGENTS.md')],
    ['hermes', join(h.hermes, 'SOUL.md')],
    ['windsurf', join(h.windsurf, 'memories', 'global_rules.md')],
  ]
  for (const [agent, dir] of [['claude', join(h.claude, 'rules')], ['grok', join(h.grok, 'rules')]]) {
    for (const file of list(dir)) if (file.isFile() && file.name.endsWith('.md') && file.name !== GROK_FILE) files.push([agent, join(dir, file.name)])
  }
  const rows = []
  for (const [agent, path] of files) {
    const content = read(path)
    // Delivery's copy of About You in these files is not something the person wrote: About You must
    // never cite itself as evidence.
    const text = withoutOurBlock(content?.text ?? '')
    if (!text.trim()) continue
    rows.push(makeRow(h, {
      agent, file: path, body: text, kind: 'instructions', type: basename(path),
      title: `${basename(path)} for every project`, modified: content.modified, size: content.size,
    }))
  }
  return rows
}

/** Windsurf keeps its memories as protobuf files; count them so the Agents view can say they exist. */
function windsurfOpaque(h) {
  return list(join(h.windsurf, 'memories')).filter((file) => file.isFile() && file.name.endsWith('.pb')).length
}

const READERS = { claude: readClaude, codex: readCodex, grok: readGrok, hermes: readHermes, openclaw: readOpenclaw, gemini: readGemini }

/**
 * One pass over every agent. `folders` maps Claude-style encoded folder keys to real paths (from the
 * session index) so project names resolve without probing the disk. `sessions` (engine → count) only
 * annotates the Agents view.
 */
export function collect({ env = process.env, home, folders = new Map(), sessions = {} } = {}) {
  const h = resolveHomes(env, home)
  const switches = memorySwitches(h, env)
  const problems = []
  pass.files = 0
  pass.truncated = false
  const memories = []
  for (const [agent, reader] of Object.entries(READERS)) {
    try { memories.push(...reader(h, folders)) } catch (error) { problems.push({ agent, error: error instanceof Error ? error.message : String(error) }) }
  }
  try { memories.push(...readInstructions(h)) } catch (error) { problems.push({ agent: 'instructions', error: String(error?.message ?? error) }) }
  memories.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0) || a.id.localeCompare(b.id))
  if (pass.truncated) problems.push({ agent: 'all', error: `More than ${MAX_FILES} memory files; the rest are not shown.` })
  // The cache holds at most two passes' worth of files; past that it starts over, which also drops
  // files that were deleted.
  if (cache.size > MAX_FILES * 2) cache.clear()

  const opaque = windsurfOpaque(h)
  const agents = AGENTS.map((agent) => {
    const rows = memories.filter((row) => row.agent === agent.id)
    const present = Boolean(stat(h[agent.id])?.isDirectory())
    const where = WHERE[agent.id]
    return {
      ...agent,
      present,
      home: tilde(h[agent.id], h.home),
      memory: switches[agent.id] === null ? 'none' : switches[agent.id] ? 'on' : 'off',
      where: where.at ? tilde(join(h[agent.id], where.at), h.home) : null,
      says: where.says,
      memories: rows.filter((row) => row.kind !== 'instructions').length,
      instructions: rows.filter((row) => row.kind === 'instructions').length,
      unreadable: agent.id === 'windsurf' ? opaque : 0,
      sessions: Number(sessions[agent.id] ?? 0),
    }
  })
  return { memories, agents, problems, homes: { memory: tilde(h.memory, h.home) } }
}
