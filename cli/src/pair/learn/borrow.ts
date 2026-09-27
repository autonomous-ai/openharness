/**
 * BORROW (daemons/LEARNING.md, L2): what an agent learned on its own, in its own engine's store, becomes a
 * lesson candidate for all of them. Off by default: `pair.jsonc` `"learn": { "borrow": true }`.
 *
 *   hermes  Agent-created skills under `<HERMES_HOME>/skills/**\/SKILL.md`. Hermes marks them in
 *           `skills/.usage.json` (`created_by: "agent"` from its background review, `"learn"` from a foreground
 *           agent, or `agent_created: true`) and lists what it did NOT write in `.bundled_manifest` (shipped) and
 *           `.hub/lock.json` (installed). With those marks, only marked skills are borrowed; a Hermes that keeps
 *           no marks (older) has every skill that is neither shipped nor installed read, if changed in the last
 *           30 days. Archived ones (`state: "archived"`, `.archive/`) never.
 *   claude  Claude Code's auto memory for the projects harnesses run in:
 *           `<CLAUDE_PROJECTS_DIR>/<the folder, mangled>/memory/*.md` (not the MEMORY.md index). A memory
 *           belongs to its project: the lesson is listed only in that project's sessions.
 *   codex   Codex memories, `<CODEX_HOME>/memories`: skills under `memories/skills`, and the sections of
 *           `MEMORY.md` (never the raw extracts or the summary made from it).
 *
 * READ-ONLY: nothing here writes, creates or touches a file in those stores, and a symlink is never followed.
 * Only SKILL.md text travels: a skill with scripts or references beside it is not borrowed. Each candidate is
 * one lesson (a skill), carrying where it came from (`borrowed from hermes`, `skills/deploy-api/SKILL.md`),
 * run through the same guard as every lesson (refused for a pipe to a shell, a credential, a safety switched
 * off, exfiltration or words to a model; redacted; its evidence struck through), never proposed twice (the
 * same source, or the same text as any lesson already here, pending, approved, archived, skipped or
 * reverted), and proposed through the same one-an-hour `[y/n/s]` line (propose.ts).
 */
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { mangleClaudeProjectDir } from '../../lib/claudeProject.js'
import { guardLesson, slug, type DistillWhy } from './distill.js'
import { untrusted } from './guard.js'
import type { LessonRecord, LessonStore } from './store.js'
import { contentHash, projectHash, projectName, type Signal } from './types.js'

export type BorrowEngine = 'hermes' | 'claude' | 'codex'

/** A file bigger than this is not a lesson. */
export const BORROW_MAX_FILE_BYTES = 128 * 1024
/** Without Hermes' own marks, only skills changed this recently are read. */
export const BORROW_RECENT_MS = 30 * 24 * 60 * 60_000
/** A borrowed skill was already written as a skill; it may be longer than a distilled one (30 lines). */
export const BORROWED_BODY_MAX_LINES = 150
/** New candidates one pass adds, and how many borrowed lessons may wait for a key at once. */
export const BORROW_PER_PASS = 3
export const BORROW_PENDING_MAX = 5
/** How often the learner looks, when nothing is working. */
export const BORROW_EVERY_MS = 6 * 60 * 60_000
const WALK_DEPTH = 4
const CANDIDATES_MAX = 200

export interface BorrowCandidate {
  engine: BorrowEngine
  /** Where in that engine's store, relative to it: never a home path. */
  source: string
  /** The project it belongs to (hashed), or null for every project. */
  project: string | null
  projectName: string | null
  name: string
  description: string
  body: string
  /** When the file last changed (ms). */
  modified: number
}

// ── reading, safely ─────────────────────────────────────────────────────────────────────────────────

/** A plain file's text: never a symlink, a folder or anything past the size bound. */
function readPlain(path: string): { text: string; modified: number } | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BORROW_MAX_FILE_BYTES) return null
    return { text: readFileSync(path, 'utf8'), modified: stat.mtimeMs }
  } catch { return null }
}

function isPlainDir(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() } catch { return false }
}

function entries(dir: string): Array<{ name: string; dir: boolean; file: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory(), file: d.isFile() }))
  } catch { return [] }
}

function readJson(path: string): unknown {
  const file = readPlain(path)
  if (!file) return null
  try { return JSON.parse(file.text) } catch { return null }
}

/** YAML front matter's top-level scalars (`name`, `description`, a folded `>` or `|` block) and the body. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  if (!match) return { fields: {}, body: normalized }
  const fields: Record<string, string> = {}
  const lines = match[1]!.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!m) continue
    let value = m[2]!.trim()
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === '')) block.push(lines[++i]!.trim())
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim()
    } else if (/^"(.*)"$/.test(value)) {
      try { value = JSON.parse(value) as string } catch { value = value.slice(1, -1) }
    } else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1).replace(/''/g, '\'')
    fields[m[1]!] = value
  }
  return { fields, body: normalized.slice(match[0].length) }
}

/** One line of at most `max`, cut at a word. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 3)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).trimEnd()}...`
}

/** Markdown paragraphs written as one long line, wrapped at words (never inside a code fence). */
function wrapLong(body: string, width = 200): string {
  const out: string[] = []
  let fenced = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (fenced || line.length <= 400) { out.push(line); continue }
    const indent = /^(\s*(?:[-*+]|\d+\.)?\s*)/.exec(line)![1]!
    let rest = line
    let first = true
    while (rest.length > width) {
      const at = rest.lastIndexOf(' ', width)
      if (at <= indent.length) break
      out.push(rest.slice(0, at))
      rest = `${first ? ' '.repeat(indent.length) : ''}${rest.slice(at + 1)}`
      if (first) first = false
      else rest = `${' '.repeat(indent.length)}${rest.trimStart()}`
    }
    out.push(rest)
  }
  return out.join('\n')
}

/** The description a candidate carries: its own, or its first line of prose. */
function describe(fields: Record<string, string>, body: string, fallback: string): string {
  const own = fields.description?.trim()
  if (own) return oneLine(own, 280)
  const first = body.split('\n').map((line) => line.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)
  return oneLine(first ?? fallback, 280)
}

// ── Hermes ──────────────────────────────────────────────────────────────────────────────────────────

export interface HermesProvenance {
  /** Hermes keeps its own marks (`created_by` / `agent_created` in `.usage.json`). */
  known: boolean
  /** Skills an agent wrote. */
  agent: Set<string>
  /** Skills archived or retired by its curator. */
  retired: Set<string>
  /** Skills Hermes shipped or installed from its hub: not learned. */
  installed: Set<string>
}

function hubNames(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 3 || !value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') out.add((item as { name: string }).name)
      else if (typeof item === 'string') out.add(item)
    }
    return
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (['installed', 'skills', 'packages', 'entries'].includes(key)) {
      if (item && typeof item === 'object' && !Array.isArray(item)) for (const name of Object.keys(item)) out.add(name)
      hubNames(item, out, depth + 1)
    }
  }
}

export function hermesProvenance(skillsDir: string): HermesProvenance {
  const agent = new Set<string>()
  const retired = new Set<string>()
  const installed = new Set<string>()
  let known = false
  const usage = readJson(join(skillsDir, '.usage.json'))
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    for (const [name, raw] of Object.entries(usage as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      if ('created_by' in entry || 'agent_created' in entry) known = true
      if (entry.created_by === 'agent' || entry.created_by === 'learn' || entry.agent_created === true) agent.add(name)
      if (entry.state === 'archived' || entry.state === 'retired' || (entry.archived_at !== undefined && entry.archived_at !== null)) retired.add(name)
    }
  }
  const manifest = readPlain(join(skillsDir, '.bundled_manifest'))
  for (const line of manifest?.text.split('\n') ?? []) {
    const name = line.trim().split(/[\s:=,]/)[0]
    if (name && !name.startsWith('#')) installed.add(name)
  }
  hubNames(readJson(join(skillsDir, '.hub', 'lock.json')), installed)
  return { known, agent, retired, installed }
}

/** Folders holding a SKILL.md, under `root`; dot-folders (`.archive`, `.hub`) and symlinks are never entered. */
function skillFolders(root: string, depth = 0, out: string[] = []): string[] {
  if (!isPlainDir(root) || out.length >= CANDIDATES_MAX) return out
  const list = entries(root)
  if (depth > 0 && list.some((e) => e.file && e.name === 'SKILL.md')) { out.push(root); return out }
  if (depth >= WALK_DEPTH) return out
  for (const e of list) if (e.dir && !e.name.startsWith('.')) skillFolders(join(root, e.name), depth + 1, out)
  return out
}

/** A skill folder's SKILL.md as a candidate, or null when it is not one this can carry. */
function skillCandidate(engine: BorrowEngine, root: string, folder: string, prefix: string): BorrowCandidate | null {
  // Only text travels: scripts, references or assets beside the SKILL.md would not come along.
  if (entries(folder).some((e) => e.name !== 'SKILL.md' && !e.name.startsWith('.'))) return null
  const file = readPlain(join(folder, 'SKILL.md'))
  if (!file) return null
  const { fields, body } = parseFrontmatter(file.text)
  const name = fields.name?.trim() || basename(folder)
  const rel = folder.slice(root.length + 1)
  return {
    engine, source: `${prefix}${rel}/SKILL.md`, project: null, projectName: null,
    name, description: describe(fields, body, name), body: wrapLong(body.trim()), modified: file.modified,
  }
}

export function readHermesSkills(hermesHome: string, now: number): BorrowCandidate[] {
  const root = join(hermesHome, 'skills')
  if (!isPlainDir(root)) return []
  const marks = hermesProvenance(root)
  const out: BorrowCandidate[] = []
  for (const folder of skillFolders(root)) {
    const candidate = skillCandidate('hermes', root, folder, 'skills/')
    if (!candidate) continue
    const names = [candidate.name, basename(folder)]
    if (names.some((n) => marks.installed.has(n) || marks.retired.has(n))) continue
    if (marks.known ? !names.some((n) => marks.agent.has(n)) : now - candidate.modified > BORROW_RECENT_MS) continue
    out.push(candidate)
  }
  return out
}

// ── Claude Code ─────────────────────────────────────────────────────────────────────────────────────

/** The memory folder names a project folder has: its path mangled, and its real path mangled. */
function claudeKeys(folder: string): string[] {
  const keys = new Set([mangleClaudeProjectDir(folder)])
  try { keys.add(mangleClaudeProjectDir(realpathSync(folder))) } catch { /* gone */ }
  return [...keys]
}

export function readClaudeMemory(projectsDir: string, folders: readonly string[]): BorrowCandidate[] {
  const out: BorrowCandidate[] = []
  const seen = new Set<string>()
  for (const folder of folders) {
    for (const key of claudeKeys(folder)) {
      const dir = join(projectsDir, key, 'memory')
      if (seen.has(dir) || !isPlainDir(dir)) continue
      seen.add(dir)
      for (const e of entries(dir)) {
        if (!e.file || !e.name.endsWith('.md') || e.name === 'MEMORY.md' || e.name.startsWith('.')) continue
        const file = readPlain(join(dir, e.name))
        if (!file) continue
        const { fields, body } = parseFrontmatter(file.text)
        const name = fields.name?.trim() || e.name.replace(/\.md$/, '')
        out.push({
          engine: 'claude', source: `memory/${e.name}`, project: projectHash(folder), projectName: projectName(folder),
          name, description: describe(fields, body, name), body: wrapLong(body.trim()), modified: file.modified,
        })
        if (out.length >= CANDIDATES_MAX) return out
      }
    }
  }
  return out
}

// ── Codex ───────────────────────────────────────────────────────────────────────────────────────────

/** Files in `memories/` that are Codex's working material, not what it learned: never read. */
const CODEX_SKIP = /^(raw_|memory_summary\.md$)/

/** A memory file without front matter, one candidate per heading. */
function sections(text: string): Array<{ heading: string; body: string }> {
  const out: Array<{ heading: string; body: string }> = []
  let current: { heading: string; lines: string[] } | null = null
  let fenced = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? null : /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      if (current) out.push({ heading: current.heading, body: current.lines.join('\n').trim() })
      current = { heading: heading[1]!, lines: [] }
    } else current?.lines.push(line)
  }
  if (current) out.push({ heading: current.heading, body: current.lines.join('\n').trim() })
  return out.filter((s) => s.body)
}

export function readCodexMemories(codexHome: string): BorrowCandidate[] {
  const root = join(codexHome, 'memories')
  if (!isPlainDir(root)) return []
  const out: BorrowCandidate[] = []
  for (const folder of skillFolders(join(root, 'skills'))) {
    const candidate = skillCandidate('codex', root, folder, '')
    if (candidate) out.push(candidate)
  }
  for (const e of entries(root)) {
    if (!e.file || !e.name.endsWith('.md') || CODEX_SKIP.test(e.name) || e.name.startsWith('.')) continue
    const file = readPlain(join(root, e.name))
    if (!file) continue
    const { fields, body } = parseFrontmatter(file.text)
    if (fields.name && fields.description) {
      out.push({
        engine: 'codex', source: `memories/${e.name}`, project: null, projectName: null,
        name: fields.name, description: describe(fields, body, fields.name), body: wrapLong(body.trim()), modified: file.modified,
      })
      continue
    }
    for (const section of sections(body)) {
      out.push({
        engine: 'codex', source: `memories/${e.name}#${slug(section.heading, 40)}`, project: null, projectName: null,
        name: section.heading, description: oneLine(`${section.heading}: ${describe({}, section.body, section.heading)}`, 280),
        body: wrapLong(section.body), modified: file.modified,
      })
      if (out.length >= CANDIDATES_MAX) return out
    }
  }
  return out
}

// ── into the lessons folder ─────────────────────────────────────────────────────────────────────────

/** The same text however it is spaced or cased. */
export function bodyHash(body: string): string {
  return contentHash(body.replace(/\s+/g, ' ').trim().toLowerCase())
}

/** The signal a candidate stands for: `borrowed`, keyed by where it came from, so one source is proposed once. */
export function borrowSignal(candidate: BorrowCandidate, machine: string, now: number, home: string | null = null): Signal {
  const where = untrusted(candidate.source, 160, { home })
  const said = untrusted(candidate.description, 240, { home })
  return {
    kind: 'borrowed',
    key: `borrow:${candidate.engine}:${contentHash([candidate.engine, candidate.source, candidate.project])}`,
    project: candidate.project, projectName: candidate.projectName, at: now,
    from: [{ engine: candidate.engine, machine, agentId: '', session: where, turn: 0, project: candidate.project, at: candidate.modified }],
    evidence: [`borrowed from ${candidate.engine}: ${where}`, ...(said ? [`it says: ${said}`] : [])],
    borrowed: { engine: candidate.engine, source: where },
  }
}

export interface BorrowSources {
  hermesHome?: string | null
  claudeProjectsDir?: string | null
  codexHome?: string | null
}

export interface BorrowerDeps {
  store: LessonStore
  sources: BorrowSources
  /** The folders harnesses run in: Claude's memory is read for these projects only. */
  projects: () => string[]
  /** This machine's name, for provenance. */
  machine: () => string
  now: () => number
  home?: string | null
  log?: (line: string) => void
}

export interface BorrowPass {
  added: LessonRecord[]
  considered: number
  /** Why the others were not added, counted. */
  passed: Partial<Record<DistillWhy | 'known' | 'duplicate' | 'skipped' | 'waiting', number>>
}

export class LessonBorrower {
  constructor(private readonly deps: BorrowerDeps) {}

  /** Every candidate in every store it may read, newest first. Reads only. */
  candidates(): BorrowCandidate[] {
    const { hermesHome, claudeProjectsDir, codexHome } = this.deps.sources
    const now = this.deps.now()
    const all = [
      ...(hermesHome ? readHermesSkills(hermesHome, now) : []),
      ...(claudeProjectsDir ? readClaudeMemory(claudeProjectsDir, this.deps.projects()) : []),
      ...(codexHome ? readCodexMemories(codexHome) : []),
    ]
    return all.sort((a, b) => b.modified - a.modified)
  }

  /**
   * Add at most BORROW_PER_PASS new candidates as pending lessons, credited to `learnedBy` (the paired
   * daemon, which found them). Nothing when BORROW_PENDING_MAX borrowed lessons already wait for a key.
   */
  pass(learnedBy: string): BorrowPass {
    const store = this.deps.store
    const out: BorrowPass = { added: [], considered: 0, passed: {} }
    const count = (why: keyof BorrowPass['passed']): void => { out.passed[why] = (out.passed[why] ?? 0) + 1 }
    const all = store.list()
    const waiting = all.filter((r) => r.status === 'pending' && r.source === 'borrowed').length
    const room = Math.min(BORROW_PER_PASS, BORROW_PENDING_MAX - waiting)
    if (room <= 0) { count('waiting'); return out }
    const keys = new Set(all.map((r) => r.signal.key))
    const bodies = new Set(all.map((r) => bodyHash(r.body)))
    const home = this.deps.home ?? null
    for (const candidate of this.candidates()) {
      if (out.added.length >= room) break
      out.considered++
      const signal = borrowSignal(candidate, this.deps.machine(), this.deps.now(), home)
      if (keys.has(signal.key)) { count('known'); continue }
      const guarded = guardLesson({ kind: 'skill', name: candidate.name, description: candidate.description, body: candidate.body },
        'borrowed', { home, maxBodyLines: BORROWED_BODY_MAX_LINES })
      if (!guarded.lesson) { count(guarded.why); continue }
      const lesson = guarded.lesson
      if (lesson.kind === 'skill' && bodies.has(bodyHash(lesson.body))) { count('duplicate'); continue }
      const added = store.add({ lesson, signal, learnedBy, source: 'borrowed', provenance: `borrowed from ${candidate.engine}` })
      if (!added.ok) { count(added.error === 'SKIPPED' ? 'skipped' : added.error === 'REFUSED' ? 'refused' : 'known'); continue }
      keys.add(signal.key)
      if (lesson.kind === 'skill') bodies.add(bodyHash(lesson.body))
      out.added.push(added.record)
      this.deps.log?.(`[learn] borrowed · pending ${added.record.id} "${added.record.name}" from ${candidate.engine}`)
    }
    return out
  }
}
