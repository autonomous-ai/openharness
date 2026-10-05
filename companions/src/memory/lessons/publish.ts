/**
 * TEACH (daemons/LEARNING.md): how an approved lesson reaches the agents, without writing into any
 * engine's private folders (`~/.claude`, `~/.codex`, `.claude/skills`, `.agents/skills`, `~/.hermes` …) — export
 * (export.ts) is the one opt-in exception — and without touching a tracked file unless the person asked.
 *
 *   skills  Through the Store runtime path (dsh/runtime.ts): every harness session's runtime gets a COPY of the
 *           skills it may load at `<runtime>/lessons/<name>/SKILL.md`, files read-only (a-w), and its CONTEXT.md —
 *           which every engine reads through the bootstrap — one index line per skill. Never a link to the
 *           lessons folder: an agent's "in-project" edit through a link would rewrite the global store. A skill
 *           made in a project is listed only in that project's sessions. A revert or an archive takes the copy
 *           out of the runtimes in the folders harnesses run in (withdrawSkill); the index is rewritten at the
 *           next launch.
 *   notes   By default into the project's `.harness/lessons.md` — untracked: kept out of git through
 *           `.git/info/exclude`, never `.gitignore` — which Store sessions are pointed at by CONTEXT.md. Into a
 *           marked `<!-- harness:lessons -->` block of the project's AGENTS.md (or CLAUDE.md) ONLY for a project
 *           the person opted in (`pair.jsonc` `learn.agentsMd`), only when that file exists and is plain, or
 *           with `--create`. Never through a symlink. Each note is its own marked section, so a revert removes
 *           exactly it, wherever it is.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { LessonRecord, LessonStore } from './store.js'
import { projectHash } from './types.js'
import { addExcludeEntry, isLink, isPlainDir, isPlainFile } from '../../../../cli/src/lib/projectFiles.js'
export { addExcludeEntry, isLink, isPlainDir, isPlainFile }

/** What dsh/runtime.ts copies and lists for one session. */
export interface RuntimeLessons {
  /** The lessons folder's `skills/`, copied from. */
  dir: string
  skills: Array<{ name: string; description: string }>
  /** The project's `.harness/lessons.md`, when it has one. */
  notes?: string | null
}

function hashesOf(dir: string): Set<string> {
  const hashes = new Set<string>()
  const plain = projectHash(dir)
  if (plain) hashes.add(plain)
  try { const real = projectHash(realpathSync(dir)); if (real) hashes.add(real) } catch { /* gone */ }
  return hashes
}

/** The approved skills a session in `workspace` loads (every one made in no project, or in this one), and its notes. */
export function runtimeLessons(store: Pick<LessonStore, 'approved' | 'skillsDir'>, workspace: string): RuntimeLessons | null {
  const here = hashesOf(workspace)
  const skills = store.approved()
    .filter((r) => r.kind === 'skill' && (!r.project || here.has(r.project)))
    .map((r) => ({ name: r.name, description: r.description }))
    .sort((a, b) => a.name.localeCompare(b.name))   // a stable CONTEXT.md from launch to launch
  const notes = isPlainFile(notesPath(workspace)) ? notesPath(workspace) : null
  return skills.length || notes ? { dir: store.skillsDir, skills, notes } : null
}

/** A note's project folder, found among the folders harnesses run in: the store only keeps its hash. */
export function findProject(hash: string | null, folders: readonly string[]): string | null {
  if (!hash) return null
  return folders.find((folder) => hashesOf(folder).has(hash)) ?? null
}

// ── the runtime's copy ────────────────────────────────────────────────────────────────────────────────

/** A lessons folder Harness made in a runtime holds this file, so a folder it did not make is never taken for one. */
export const LESSONS_MARK = '.harness-lessons'
/** A lesson's name as the lessons folder writes one (agentskills.io): nothing that could leave the folder. */
const LESSON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Every file of a tree read-only (a-w). The folders stay writable by their owner, so the person's `rm -rf`
 * or `git clean` still works; the copy is what keeps an agent's edit away from the lessons folder, and a-w
 * makes an in-place edit of it fail. Never follows a link.
 */
function lock(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) for (const name of readdirSync(path)) lock(join(path, name))
    else chmodSync(path, 0o444)
  } catch { /* gone */ }
}

/**
 * Copy the session's lessons into `<runtimeDir>/lessons` (read-only) and answer CONTEXT.md's lines for them;
 * with none, take an old copy (or an old link) away. A folder Harness did not make there is left alone and
 * costs the lessons, never the launch.
 */
export function installLessons(runtimeDir: string, lessons: RuntimeLessons | null | undefined): string[] {
  const target = join(runtimeDir, 'lessons')
  const skills = (lessons?.skills ?? []).filter((skill) => LESSON_NAME.test(skill.name))
  const lines: string[] = []
  try {
    if (isLink(target)) unlinkSync(target)                  // L1 linked the global folder here: never again
    else if (existsSync(target)) {
      if (!isPlainFile(join(target, LESSONS_MARK))) throw new Error(`Harness lessons path is already occupied: ${target}`)
      rmSync(target, { recursive: true, force: true })
    }
    const copied: typeof skills = []
    if (lessons && skills.length) {
      mkdirSync(target, { recursive: true, mode: 0o700 })
      writeFileSync(join(target, LESSONS_MARK), 'Copied by Harness from the lessons folder at launch. Read-only; edits are not kept.\n', { mode: 0o444 })
      for (const skill of skills) {
        const from = join(lessons.dir, skill.name, 'SKILL.md')
        // Neither the file nor its folder may be a link: a linked folder would copy whatever it points at.
        if (!isPlainDir(join(lessons.dir, skill.name)) || !isPlainFile(from)) continue
        mkdirSync(join(target, skill.name), { mode: 0o700 })
        writeFileSync(join(target, skill.name, 'SKILL.md'), readFileSync(from, 'utf8'), { mode: 0o444 })
        copied.push(skill)
      }
      lock(target)
    }
    if (copied.length) {
      const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)
      lines.push(
        '## Lessons',
        'Approved by the person in Harness, from what their agents did. Read one when its description fits the task.',
        ...copied.map((skill) => `- ${skill.name}: ${oneLine(skill.description)} ${JSON.stringify(join(target, skill.name, 'SKILL.md'))}`),
        '',
      )
    }
  } catch (error) {
    console.warn(`[dsh] lessons not copied · ${error instanceof Error ? error.message : error}`)
  }
  if (lessons?.notes) {
    lines.push('## Project notes', `Approved by the person in Harness for this project. Read ${JSON.stringify(lessons.notes)} before you start.`, '')
  }
  return lines
}

/**
 * A reverted or archived skill taken out of the copies in the runtimes under these folders, at once: a
 * running session can no longer read it (its CONTEXT.md line goes at its next launch). Only folders Harness
 * made (LESSONS_MARK) are touched. Answers the files removed.
 */
export function withdrawSkill(name: string, folders: readonly string[]): string[] {
  if (!LESSON_NAME.test(name)) return []
  const removed: string[] = []
  for (const folder of new Set(folders)) {
    const root = join(folder, '.harness', 'runtime')
    if (!isPlainDir(root)) continue
    let keys: string[]
    try { keys = readdirSync(root) } catch { continue }
    for (const key of keys) {
      const lessons = join(root, key, 'lessons')
      const skill = join(lessons, name)
      if (!isPlainDir(lessons) || !isPlainFile(join(lessons, LESSONS_MARK)) || !isPlainDir(skill)) continue
      try {
        rmSync(skill, { recursive: true, force: true })
        removed.push(join(skill, 'SKILL.md'))
      } catch { /* the next launch rewrites it */ }
    }
  }
  return removed
}

// ── notes ─────────────────────────────────────────────────────────────────────────────────────────────

export const LESSONS_BEGIN = '<!-- harness:lessons -->'
export const LESSONS_END = '<!-- /harness:lessons -->'
const HEADER = [
  LESSONS_BEGIN,
  '## Lessons',
  '',
  'Approved in Harness from what agents did in this project. `harness pair lessons revert <id>` takes one back.',
  '',
]
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const
/** Where a project's notes go unless the person opted the project in to its AGENTS.md. */
export const NOTES_FILE = join('.harness', 'lessons.md')
/** The line that keeps it out of git, in `.git/info/exclude` (never a tracked `.gitignore`). */
export const NOTES_EXCLUDE = '**/.harness/lessons.md'

export function notesPath(projectDir: string): string {
  return join(projectDir, NOTES_FILE)
}

/** The project's instruction file a note may go in: AGENTS.md, else CLAUDE.md — an existing plain file. */
export function noteFile(projectDir: string): string | null {
  for (const name of INSTRUCTION_FILES) if (isPlainFile(join(projectDir, name))) return join(projectDir, name)
  return null
}

export type PublishResult =
  | { ok: true; file: string; created?: boolean; untracked?: boolean }
  | { ok: false; error: 'NO_INSTRUCTION_FILE' | 'NOT_A_FILE' | 'EDITED' | 'NOT_A_NOTE'; detail?: string }

const sectionBegin = (id: string): string => `<!-- lesson:${id} -->`
const sectionEnd = (id: string): string => `<!-- /lesson:${id} -->`

/** The block's bounds, or 'edited' when its markers are not exactly one pair in order. */
function block(text: string): { start: number; end: number } | null | 'edited' {
  const starts = text.split(LESSONS_BEGIN).length - 1
  const ends = text.split(LESSONS_END).length - 1
  if (!starts && !ends) return null
  if (starts !== 1 || ends !== 1) return 'edited'
  const start = text.indexOf(LESSONS_BEGIN)
  const end = text.indexOf(LESSONS_END)
  return end > start ? { start, end: end + LESSONS_END.length } : 'edited'
}

/** Write one note's section into `file`'s block (made when missing). Every byte outside the block is kept. */
function writeSection(file: string, record: LessonRecord, created: boolean): PublishResult | null {
  const before = created ? '' : readFileSync(file, 'utf8')
  const found = block(before)
  if (found === 'edited') return { ok: false, error: 'EDITED', detail: `the ${LESSONS_BEGIN} block in ${file} was edited; fix its markers first` }
  const section = [sectionBegin(record.id), ...(record.lines ?? [record.description]).map((line) => `- ${line}`), sectionEnd(record.id)].join('\n')
  let after: string
  if (!found) {
    const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    after = `${before}${lead}${[...HEADER, section, LESSONS_END].join('\n')}\n`
  } else {
    const inner = withoutSection(before.slice(found.start, found.end), record.id)
    const at = inner.lastIndexOf(LESSONS_END)
    after = `${before.slice(0, found.start)}${inner.slice(0, at)}${section}\n${inner.slice(at)}${before.slice(found.end)}`
  }
  writeFileSync(file, after, created ? { flag: 'wx', mode: 0o644 } : {})
  return null
}

/**
 * `.git/info/exclude` of the repository `projectDir` is in (a worktree's shared one), holding NOTES_EXCLUDE.
 * Never a tracked `.gitignore`; never through a symlink. Nothing when the folder is not in a repository.
 */
export function excludeNotes(projectDir: string, git = 'git'): string | null {
  let path: string
  try {
    path = execFileSync(git, ['-C', projectDir, 'rev-parse', '--git-path', 'info/exclude'], {
      stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    }).trim()
  } catch { return null }
  if (!path) return null
  return addExcludeEntry(isAbsolute(path) ? path : resolve(projectDir, path), { pattern: NOTES_EXCLUDE, comment: 'Harness lessons (untracked notes)' })
}

/**
 * Write a note for the project. Default: `.harness/lessons.md`, untracked. `agentsMd` (the person opted this
 * project in): into its AGENTS.md or CLAUDE.md block — only a file that exists, unless `create`.
 */
export function publishNote(projectDir: string, record: LessonRecord, opts: { agentsMd?: boolean; create?: boolean; git?: string } = {}): PublishResult {
  if (record.kind !== 'note') return { ok: false, error: 'NOT_A_NOTE' }
  if (!opts.agentsMd) {
    const dir = join(projectDir, '.harness')
    const file = notesPath(projectDir)
    if ((existsSync(dir) || isLink(dir)) && !isPlainDir(dir)) return { ok: false, error: 'NOT_A_FILE', detail: `${dir} is not a plain folder` }
    if ((existsSync(file) || isLink(file)) && !isPlainFile(file)) return { ok: false, error: 'NOT_A_FILE', detail: `${file} is not a plain file` }
    const created = !existsSync(file)
    // Kept out of git BEFORE the file exists, so it is never once untracked-and-visible.
    excludeNotes(projectDir, opts.git)
    mkdirSync(dir, { recursive: true })
    const failed = writeSection(file, record, created)
    return failed ?? { ok: true, file, untracked: true, ...(created ? { created: true } : {}) }
  }
  let file = noteFile(projectDir)
  let created = false
  if (!file) {
    const blocked = INSTRUCTION_FILES.map((name) => join(projectDir, name)).find((path) => existsSync(path) || isLink(path))
    if (blocked) return { ok: false, error: 'NOT_A_FILE', detail: `${blocked} is not a plain file` }
    if (!opts.create) return { ok: false, error: 'NO_INSTRUCTION_FILE', detail: 'the project has no AGENTS.md or CLAUDE.md' }
    file = join(projectDir, 'AGENTS.md')
    created = true
  }
  const failed = writeSection(file, record, created)
  return failed ?? { ok: true, file, ...(created ? { created: true } : {}) }
}

/** Take one note back out of wherever it is; the whole block goes with its last note. Nothing else changes. */
export function unpublishNote(projectDir: string, id: string): { ok: true; file: string | null } | { ok: false; error: 'EDITED'; detail: string } {
  for (const name of [NOTES_FILE, ...INSTRUCTION_FILES]) {
    const file = join(projectDir, name)
    if (!isPlainFile(file)) continue
    const before = readFileSync(file, 'utf8')
    if (!before.includes(sectionBegin(id))) continue
    const found = block(before)
    if (!found || found === 'edited') return { ok: false, error: 'EDITED', detail: `the ${LESSONS_BEGIN} block in ${file} was edited; remove lesson ${id} by hand` }
    const inner = withoutSection(before.slice(found.start, found.end), id)
    const empty = !/<!-- lesson:[a-f0-9]+ -->/.test(inner)
    let after: string
    if (empty) {
      const head = before.slice(0, found.start).replace(/\n\n$/, '\n')
      const tail = before.slice(found.end).replace(/^\n/, '')
      after = `${head}${tail}`
    } else after = `${before.slice(0, found.start)}${inner}${before.slice(found.end)}`
    if (name === NOTES_FILE && !after.trim()) rmSync(file, { force: true })
    else writeFileSync(file, after)
    return { ok: true, file }
  }
  return { ok: true, file: null }
}

function withoutSection(text: string, id: string): string {
  const begin = text.indexOf(sectionBegin(id))
  if (begin < 0) return text
  const endMarker = sectionEnd(id)
  const end = text.indexOf(endMarker, begin)
  if (end < 0) return text
  const stop = end + endMarker.length + (text[end + endMarker.length] === '\n' ? 1 : 0)
  return `${text.slice(0, begin)}${text.slice(stop)}`
}
