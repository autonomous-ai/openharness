/**
 * The lessons folder (daemons/LEARNING.md, "Store"): a git-backed folder OUTSIDE any repo, by default
 * `~/.harness/lessons/`, shared by every daemon you pair with (a new daemon keeps the lessons).
 *
 *   pending/<id>/SKILL.md | NOTE.md   proposed, waiting for your key (not committed)
 *   skills/<name>/SKILL.md           approved skills: the folder the Store runtime publishes (publish.ts)
 *   notes/<id>/NOTE.md               approved project notes (written into that project's AGENTS.md block)
 *   archive/<name>/SKILL.md          skills the curator put away, unused for 90 days (restore brings one back)
 *   lesson.json                      beside each: the record the daemon reads back
 *   journal.jsonl, state.json        what happened, and what not to propose again (not committed)
 *   usage.json, export.json          when each lesson was last used; what was exported where (not committed)
 *
 * SKILL.md is an Agent Skills file (agentskills.io): `name` (the folder's name), `description`, and a
 * `metadata.harness` map — learnedBy (the daemon), from (provenance), approved (the date), evidence.
 *
 * ONE commit per approval, per revert, per archive and per restore (and an empty one when a lesson goes stale), made with git in this folder and nowhere else, with no
 * global or system git config (no hooks, no signing, a fixed author: never the person's name or email).
 * A revert is `git revert` of the lesson's own commit. Without git the same moves happen with a plain
 * journal, and every answer says so.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactDeep, refusal } from './guard.js'
import { contentHash, type Lesson, type Provenance, type Signal, type SignalKind } from './types.js'

export type LessonStatus = 'pending' | 'approved' | 'reverted' | 'skipped' | 'archived'
export type LessonSource = 'template' | 'model' | 'borrowed'

export interface LessonRecord {
  id: string
  kind: 'skill' | 'note'
  /** A skill's name (its folder); a note's is `note-<id>`. */
  name: string
  description: string
  body: string
  lines?: string[]
  hash: string
  signal: { kind: SignalKind; key: string }
  /** The project, hashed. A note belongs to it; a skill made in it is listed only in its sessions. */
  project: string | null
  projectName: string | null
  learnedBy: string
  from: Provenance[]
  evidence: string[]
  source: LessonSource
  /** Where a borrowed lesson came from, in words: `borrowed from hermes`. */
  provenance?: string | null
  created: number
  status: LessonStatus
  /** The day it was approved (YYYY-MM-DD). */
  approved?: string | null
  approvedBy?: string | null
  commit?: string | null
}

export type StoreResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string; detail?: string }

export interface LessonStoreOptions {
  root: string
  now: () => number
  newId?: () => string
  /** The git command; null means no git (a plain journal). Default `git`, if it runs. */
  git?: string | null
  env?: NodeJS.ProcessEnv
}

export const NO_GIT_NOTE = 'git is not installed: lessons are kept with a plain journal, not commits'
const SKIPPED_MAX = 2_000
const IGNORED = ['pending/', 'reverted/', 'state.json', 'journal.jsonl', 'usage.json', 'export.json', '*.tmp']

interface StoreState { v: 1; skipped: string[]; proposed: Record<string, number>; lastProposedAt: number | null; curatedAt: number | null }

export class LessonStore {
  readonly root: string
  private readonly now: () => number
  private readonly newId: () => string
  private readonly gitCommand: string | null
  private readonly env: NodeJS.ProcessEnv
  private gitWorks: boolean | null = null

  constructor(opts: LessonStoreOptions) {
    this.root = opts.root
    this.now = opts.now
    this.newId = opts.newId ?? (() => randomBytes(4).toString('hex'))
    this.gitCommand = opts.git === undefined ? 'git' : opts.git
    this.env = opts.env ?? process.env
  }

  get skillsDir(): string { return join(this.root, 'skills') }
  /** Whether the folder exists yet: nothing is ever made before the first lesson. */
  get exists(): boolean { return existsSync(this.root) }

  /** Git is here and runs. Asked once. */
  get git(): boolean {
    if (this.gitWorks === null) {
      if (!this.gitCommand) this.gitWorks = false
      else {
        try { execFileSync(this.gitCommand, ['--version'], { stdio: 'pipe', env: this.gitEnv() }); this.gitWorks = true } catch { this.gitWorks = false }
      }
    }
    return this.gitWorks
  }

  // ── reading ─────────────────────────────────────────────────────────────────────────────────────────

  pending(): LessonRecord[] {
    return this.readDir('pending').sort(byCreated)
  }

  approved(): LessonRecord[] {
    const commits = new Map<string, string | null>()
    for (const entry of this.journal()) if (entry.op === 'approved') commits.set(entry.id, entry.record?.commit ?? null)
    return [...this.readDir('skills'), ...this.readDir('notes')]
      .map((r) => ({ ...r, commit: commits.get(r.id) ?? null }))
      .sort(byCreated)
  }

  /** Skills the curator put away (archive/). `restore` brings one back. */
  archived(): LessonRecord[] {
    return this.readDir('archive').sort(byCreated)
  }

  /** Every lesson: pending, approved, archived, and the ones reverted or skipped (from the journal). */
  list(): LessonRecord[] {
    const live = [...this.pending(), ...this.approved(), ...this.archived()]
    const seen = new Set(live.map((r) => r.id))
    const gone = new Map<string, LessonRecord>()
    for (const entry of this.journal()) {
      if ((entry.op === 'reverted' || entry.op === 'skipped') && entry.record && !seen.has(entry.id)) gone.set(entry.id, { ...entry.record, status: entry.op })
      if ((entry.op === 'approved' || entry.op === 'added') && gone.has(entry.id)) gone.delete(entry.id)
    }
    return [...live, ...gone.values()]
  }

  get(id: string): LessonRecord | null {
    if (!/^[a-f0-9]{4,32}$/.test(id)) return null
    return this.list().find((r) => r.id === id) ?? null
  }

  /** The file an agent reads: SKILL.md for a skill, NOTE.md for a note. */
  text(record: LessonRecord): string {
    return record.kind === 'skill' ? renderSkill(record) : renderNote(record)
  }

  // ── adding ──────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A distilled lesson, pending your key. Refused when you skipped or reverted it (or its signal) before,
   * or when the same lesson is already here.
   */
  add(input: { lesson: Lesson; signal: Signal; learnedBy: string; source: LessonSource; provenance?: string | null }): StoreResult<{ record: LessonRecord }> {
    const { lesson, signal } = input
    const hash = contentHash(lesson.kind === 'skill' ? ['skill', lesson.name, lesson.body] : ['note', signal.project, lesson.lines])
    const state = this.state()
    if (state.skipped.includes(hash) || state.skipped.includes(signal.key)) return { ok: false, error: 'SKIPPED' }
    const known = [...this.pending(), ...this.approved(), ...this.archived()]
    if (known.some((r) => r.hash === hash || (r.status === 'pending' && r.signal.key === signal.key))) return { ok: false, error: 'KNOWN' }
    const id = this.newId()
    const record: LessonRecord = {
      id, kind: lesson.kind,
      name: lesson.kind === 'skill' ? lesson.name : `note-${id}`,
      description: lesson.kind === 'skill' ? lesson.description : lesson.lines[0]!,
      body: lesson.kind === 'skill' ? lesson.body : lesson.lines.map((line) => `- ${line}`).join('\n'),
      ...(lesson.kind === 'note' ? { lines: lesson.lines } : {}),
      hash, signal: { kind: signal.kind, key: signal.key }, project: signal.project, projectName: signal.projectName,
      learnedBy: input.learnedBy, from: signal.from.slice(0, 8), evidence: signal.evidence.slice(0, 8), source: input.source,
      ...(input.provenance ? { provenance: input.provenance } : {}),
      created: this.now(), status: 'pending', approved: null,
    }
    // The guard once more, over the file an agent would read — front matter, provenance and evidence too.
    const why = refusal(this.text(record))
    if (why) return { ok: false, error: 'REFUSED', detail: why }
    this.ensure()
    this.writeLesson(join(this.root, 'pending', id), record)
    this.log({ op: 'added', id, kind: record.kind, name: record.name })
    return { ok: true, record }
  }

  // ── your key ────────────────────────────────────────────────────────────────────────────────────────

  /** Pending → skills/<name> or notes/<id>, one commit. `by`: a key, or the CLI. */
  approve(id: string, by: string): StoreResult<{ record: LessonRecord; commit: string | null; note?: string }> {
    const record = this.pending().find((r) => r.id === id)
    if (!record) return this.missing(id, 'pending')
    this.ensure()
    const date = new Date(this.now()).toISOString().slice(0, 10)
    let name = record.name
    if (record.kind === 'skill') {
      // Two lessons, one name: the second gets a number. The folder and `name` always agree (agentskills.io).
      for (let n = 2; existsSync(join(this.root, 'skills', name)); n++) name = `${record.name.slice(0, 60)}-${n}`
    }
    const approved: LessonRecord = { ...record, name, status: 'approved', approved: date, approvedBy: by }
    const rel = record.kind === 'skill' ? join('skills', name) : join('notes', id)
    this.writeLesson(join(this.root, rel), approved)
    rmSync(join(this.root, 'pending', id), { recursive: true, force: true })
    let commit: string | null = null
    if (this.git) {
      try {
        this.run(['add', '--', rel])
        this.run(['commit', '-q', '-m', `learn: ${name}\n\nLesson-Id: ${id}\nLearned-By: ${record.learnedBy}\nApproved-By: ${by}`, '--', rel])
        commit = this.run(['rev-parse', 'HEAD']).trim()
      } catch (err) {
        // Put it back as it was: nothing half-approved.
        try { this.run(['reset', '-q', '--', rel]) } catch { /* nothing staged */ }
        rmSync(join(this.root, rel), { recursive: true, force: true })
        this.writeLesson(join(this.root, 'pending', id), record)
        return { ok: false, error: 'COMMIT_FAILED', detail: gitError(err) }
      }
    }
    const final: LessonRecord = { ...approved, commit }
    this.log({ op: 'approved', id, kind: record.kind, name, commit, record: final })
    return { ok: true, record: final, commit, ...(this.git ? {} : { note: NO_GIT_NOTE }) }
  }

  /** Pending → gone, and never proposed again (its lesson and its signal are remembered as skipped). */
  skip(id: string): StoreResult<{ record: LessonRecord }> {
    const record = this.pending().find((r) => r.id === id)
    if (!record) return this.missing(id, 'pending')
    rmSync(join(this.root, 'pending', id), { recursive: true, force: true })
    this.remember(record)
    const skipped: LessonRecord = { ...record, status: 'skipped' }
    this.log({ op: 'skipped', id, kind: record.kind, name: record.name, record: skipped })
    return { ok: true, record: skipped }
  }

  /** Approved → `git revert` of its commit (or, without git, moved to reverted/). Never proposed again. */
  revert(id: string): StoreResult<{ record: LessonRecord; commit: string | null; note?: string }> {
    const record = this.approved().find((r) => r.id === id)
    if (!record) return this.missing(id, 'approved')
    const rel = record.kind === 'skill' ? join('skills', record.name) : join('notes', id)
    let commit: string | null = null
    const learned = this.git ? this.commitOf(id) : null
    if (learned) {
      try {
        this.run(['revert', '--no-commit', learned])
        this.run(['commit', '-q', '-m', `unlearn: ${record.name}\n\nThis reverts commit ${learned}.\nLesson-Id: ${id}`])
        commit = this.run(['rev-parse', 'HEAD']).trim()
      } catch (err) {
        try { this.run(['revert', '--abort']) } catch { try { this.run(['reset', '-q', '--merge']) } catch { /* nothing to abort */ } }
        return { ok: false, error: 'REVERT_FAILED', detail: gitError(err) }
      }
      // A revert of a commit that also held other paths (a hand edit) leaves them; this lesson's folder goes.
      rmSync(join(this.root, rel), { recursive: true, force: true })
    } else {
      mkdirSync(join(this.root, 'reverted'), { recursive: true, mode: 0o700 })
      renameSync(join(this.root, rel), join(this.root, 'reverted', `${id}-${record.name}`))
    }
    this.remember(record)
    const reverted: LessonRecord = { ...record, status: 'reverted' }
    this.log({ op: 'reverted', id, kind: record.kind, name: record.name, commit, record: reverted })
    return { ok: true, record: reverted, commit, ...(this.git ? {} : { note: NO_GIT_NOTE }) }
  }

  // ── the curator (curate.ts) ─────────────────────────────────────────────────────────────────────────

  /**
   * An approved skill → archive/, out of every session's index, one commit (`archive: <name>`). A note is
   * never archived: it lives in its project's AGENTS.md, where the person sees it.
   */
  archive(id: string, why = 'unused for 90 days'): StoreResult<{ record: LessonRecord; commit: string | null; note?: string }> {
    const record = this.approved().find((r) => r.id === id)
    if (!record) return this.missing(id, 'approved')
    if (record.kind !== 'skill') return { ok: false, error: 'NOT_A_SKILL', detail: 'only skills are archived; a note stays in its project\'s AGENTS.md' }
    const from = join('skills', record.name)
    const to = existsSync(join(this.root, 'archive', record.name)) ? join('archive', `${record.name}-${id}`) : join('archive', record.name)
    mkdirSync(join(this.root, 'archive'), { recursive: true, mode: 0o700 })
    renameSync(join(this.root, from), join(this.root, to))
    const moved = this.commitMove(from, to, `archive: ${record.name}\n\n${why}.\nLesson-Id: ${id}`)
    if (!moved.ok) { renameSync(join(this.root, to), join(this.root, from)); return moved }
    const archived: LessonRecord = { ...record, status: 'archived' }
    this.log({ op: 'archived', id, kind: record.kind, name: record.name, commit: moved.commit, why, record: archived })
    return { ok: true, record: archived, commit: moved.commit, ...(this.git ? {} : { note: NO_GIT_NOTE }) }
  }

  /** An archived skill back into skills/, one commit (`restore: <name>`). Refused when its name is taken. */
  restore(id: string): StoreResult<{ record: LessonRecord; commit: string | null; note?: string }> {
    const folder = this.folderOf('archive', id)
    const record = folder ? this.archived().find((r) => r.id === id) : null
    if (!folder || !record) return this.missing(id, 'archived')
    const to = join('skills', record.name)
    if (existsSync(join(this.root, to))) return { ok: false, error: 'NAME_TAKEN', detail: `another skill is called ${record.name}; revert it first` }
    const from = join('archive', folder)
    mkdirSync(join(this.root, 'skills'), { recursive: true, mode: 0o700 })
    renameSync(join(this.root, from), join(this.root, to))
    const moved = this.commitMove(from, to, `restore: ${record.name}\n\nLesson-Id: ${id}`)
    if (!moved.ok) { renameSync(join(this.root, to), join(this.root, from)); return moved }
    const restored: LessonRecord = { ...record, status: 'approved' }
    this.log({ op: 'restored', id, kind: record.kind, name: record.name, commit: moved.commit, record: restored })
    return { ok: true, record: restored, commit: moved.commit, ...(this.git ? {} : { note: NO_GIT_NOTE }) }
  }

  /**
   * A lesson unused for 30 days: an empty commit (`stale: <name>`) and a journal entry. Nothing in its folder
   * changes, so its `learn:` commit still reverts cleanly.
   */
  markStale(id: string, why = 'unused for 30 days'): StoreResult<{ record: LessonRecord; commit: string | null }> {
    const record = this.approved().find((r) => r.id === id)
    if (!record) return this.missing(id, 'approved')
    let commit: string | null = null
    if (this.git && existsSync(join(this.root, '.git'))) {
      try {
        this.run(['commit', '-q', '--allow-empty', '-m', `stale: ${record.name}\n\n${why}.\nLesson-Id: ${id}`])
        commit = this.run(['rev-parse', 'HEAD']).trim()
      } catch (err) { return { ok: false, error: 'COMMIT_FAILED', detail: gitError(err) } }
    }
    this.log({ op: 'stale', id, kind: record.kind, name: record.name, commit, why })
    return { ok: true, record, commit }
  }

  curatedAt(): number | null { return this.state().curatedAt }

  markCurated(at: number): void {
    const state = this.state()
    state.curatedAt = at
    this.saveState(state)
  }

  // ── proposals ───────────────────────────────────────────────────────────────────────────────────────

  lastProposedAt(): number | null { return this.state().lastProposedAt }
  proposedAt(id: string): number | null { return this.state().proposed[id] ?? null }

  markProposed(id: string, at: number): void {
    const state = this.state()
    state.proposed[id] = at
    state.lastProposedAt = at
    const pending = new Set(this.pending().map((r) => r.id))
    for (const key of Object.keys(state.proposed)) if (!pending.has(key)) delete state.proposed[key]
    this.saveState(state)
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────

  /** One commit for a folder that moved: the new path added, the old one gone from the index. */
  private commitMove(from: string, to: string, message: string): StoreResult<{ commit: string | null }> {
    if (!this.git || !existsSync(join(this.root, '.git'))) return { ok: true, commit: null }
    try {
      this.run(['add', '-A', '--', to])
      this.run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', from])
      this.run(['commit', '-q', '-m', message])
      return { ok: true, commit: this.run(['rev-parse', 'HEAD']).trim() }
    } catch (err) {
      try { this.run(['reset', '-q', 'HEAD', '--', from, to]) } catch { /* nothing staged */ }
      return { ok: false, error: 'COMMIT_FAILED', detail: gitError(err) }
    }
  }

  /** The folder a lesson is kept in under `dir`, by its lesson.json. */
  private folderOf(dir: 'archive', id: string): string | null {
    let names: string[]
    try { names = readdirSync(join(this.root, dir)) } catch { return null }
    for (const name of names) {
      try {
        const record = JSON.parse(readFileSync(join(this.root, dir, name, 'lesson.json'), 'utf8')) as { id?: unknown }
        if (record?.id === id) return name
      } catch { /* not a lesson */ }
    }
    return null
  }

  /** The commit that approved this lesson: its `Lesson-Id` trailer, found by git itself. */
  private commitOf(id: string): string | null {
    try {
      const lines = this.run(['log', '-F', `--grep=Lesson-Id: ${id}`, '--format=%H%x09%s']).split('\n')
      return lines.map((line) => line.split('\t')).find(([, subject]) => subject?.startsWith('learn: '))?.[0] ?? null
    } catch { return null }
  }

  private missing(id: string, want: LessonStatus): StoreResult<never> {
    const record = this.get(id)
    if (!record) return { ok: false, error: 'NOT_FOUND', detail: `no lesson ${id}` }
    return { ok: false, error: `NOT_${want.toUpperCase()}`, detail: `lesson ${id} is ${record.status}` }
  }

  private remember(record: LessonRecord): void {
    const state = this.state()
    state.skipped = [...state.skipped.filter((h) => h !== record.hash && h !== record.signal.key), record.hash, record.signal.key].slice(-SKIPPED_MAX)
    delete state.proposed[record.id]
    this.saveState(state)
  }

  /** The folder, its .gitignore and its repository, made on the first write — never before. */
  private ensure(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const ignore = join(this.root, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, `${IGNORED.join('\n')}\n`, { mode: 0o600 })
    else this.ignoreMore(ignore)
    if (!this.git || existsSync(join(this.root, '.git'))) return
    this.run(['init', '-q'])
    this.run(['add', '--', '.gitignore'])
    this.run(['commit', '-q', '-m', 'lessons: start\n\nLessons your daemons learned, one commit per approval and per revert.'])
  }

  /** A folder made by an older version: the files it did not know to ignore, added in one commit. */
  private ignoreMore(ignore: string): void {
    let text: string
    try { text = readFileSync(ignore, 'utf8') } catch { return }
    const lines = text.split('\n').map((line) => line.trim())
    const missing = IGNORED.filter((rule) => !lines.includes(rule))
    if (!missing.length) return
    writeFileSync(ignore, `${text}${text.endsWith('\n') || !text ? '' : '\n'}${missing.join('\n')}\n`, { mode: 0o600 })
    if (!this.git || !existsSync(join(this.root, '.git'))) return
    try {
      this.run(['add', '--', '.gitignore'])
      this.run(['commit', '-q', '-m', 'lessons: ignore usage and export records', '--', '.gitignore'])
    } catch {
      // Put it back, so the next write tries again: left staged, it would ride along in the next commit.
      try { this.run(['reset', '-q', '--', '.gitignore']) } catch { /* nothing staged */ }
      writeFileSync(ignore, text, { mode: 0o600 })
    }
  }

  private gitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(this.env)) if (!key.startsWith('GIT_')) env[key] = value
    return {
      ...env,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Harness', GIT_AUTHOR_EMAIL: 'lessons@harness.invalid',
      GIT_COMMITTER_NAME: 'Harness', GIT_COMMITTER_EMAIL: 'lessons@harness.invalid',
    }
  }

  private run(args: string[]): string {
    return execFileSync(this.gitCommand!, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
      { cwd: this.root, env: this.gitEnv(), stdio: 'pipe', encoding: 'utf8' })
  }

  private readDir(folder: 'pending' | 'skills' | 'notes' | 'archive'): LessonRecord[] {
    const dir = join(this.root, folder)
    let names: string[]
    try { names = readdirSync(dir) } catch { return [] }
    const records: LessonRecord[] = []
    for (const name of names) {
      try {
        const record = JSON.parse(readFileSync(join(dir, name, 'lesson.json'), 'utf8')) as LessonRecord
        if (typeof record?.id !== 'string' || (record.kind !== 'skill' && record.kind !== 'note') || typeof record.name !== 'string') continue
        records.push({ ...record, status: folder === 'pending' ? 'pending' : folder === 'archive' ? 'archived' : 'approved' })
      } catch { /* not a lesson, or a hand-made folder */ }
    }
    return records
  }

  private writeLesson(dir: string, raw: LessonRecord): void {
    const record = redactDeep(raw)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, record.kind === 'skill' ? 'SKILL.md' : 'NOTE.md'), this.text(record), { mode: 0o600 })
    // The record as kept: where it is says its status, and git (or the journal) says its commit.
    const { status: _status, commit: _commit, ...kept } = record
    writeFileSync(join(dir, 'lesson.json'), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 })
  }

  private journal(): Array<{ at: number; op: string; id: string; record?: LessonRecord }> {
    let text: string
    try { text = readFileSync(join(this.root, 'journal.jsonl'), 'utf8') } catch { return [] }
    const entries: Array<{ at: number; op: string; id: string; record?: LessonRecord }> = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { entries.push(JSON.parse(line)) } catch { /* a torn line */ }
    }
    return entries
  }

  private log(entry: Record<string, unknown>): void {
    const file = join(this.root, 'journal.jsonl')
    const fresh = !existsSync(file)
    appendFileSync(file, `${JSON.stringify(redactDeep({ at: this.now(), ...entry, ...(this.git ? {} : { git: false }) }))}\n`, { mode: 0o600 })
    if (fresh) chmodSync(file, 0o600)
  }

  private state(): StoreState {
    try {
      const parsed = JSON.parse(readFileSync(join(this.root, 'state.json'), 'utf8')) as Partial<StoreState>
      return {
        v: 1,
        skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter((h): h is string => typeof h === 'string') : [],
        proposed: parsed.proposed && typeof parsed.proposed === 'object' ? parsed.proposed : {},
        lastProposedAt: typeof parsed.lastProposedAt === 'number' ? parsed.lastProposedAt : null,
        curatedAt: typeof parsed.curatedAt === 'number' ? parsed.curatedAt : null,
      }
    } catch { return { v: 1, skipped: [], proposed: {}, lastProposedAt: null, curatedAt: null } }
  }

  private saveState(state: StoreState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const file = join(this.root, 'state.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
}

function byCreated(a: LessonRecord, b: LessonRecord): number {
  return a.created - b.created || a.id.localeCompare(b.id)
}

function gitError(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown }
  const text = typeof e?.stderr === 'string' && e.stderr.trim() ? e.stderr : typeof e?.message === 'string' ? e.message : String(err)
  return text.trim().split('\n').slice(-2).join(' ').slice(0, 200)
}

// ── the files an agent reads ──────────────────────────────────────────────────────────────────────────

/** A YAML scalar that is always read back as the same string: JSON's quoting is valid YAML. */
const q = (value: unknown): string => JSON.stringify(value ?? null)

function frontmatter(record: LessonRecord): string {
  return [
    '---',
    `name: ${record.name}`,
    `description: ${q(record.description)}`,
    'metadata:',
    '  harness:',
    `    id: ${q(record.id)}`,
    `    kind: ${q(record.kind)}`,
    `    learnedBy: ${q(record.learnedBy)}`,
    `    signal: ${q(record.signal.kind)}`,
    `    project: ${q(record.project)}`,
    `    source: ${q(record.source)}`,
    ...(record.provenance ? [`    provenance: ${q(record.provenance)}`] : []),
    `    approved: ${q(record.approved ?? null)}`,
    '    from:',
    ...(record.from.length ? record.from.map((f) => `      - ${JSON.stringify({ engine: f.engine, machine: f.machine, session: f.session, turn: f.turn, project: f.project })}`) : ['      []']),
    '    evidence:',
    ...(record.evidence.length ? record.evidence.map((line) => `      - ${q(line)}`) : ['      []']),
    '---',
  ].join('\n').replace(/:\n {6}\[\]/g, ': []')
}

export function renderSkill(record: LessonRecord): string {
  return `${frontmatter(record)}\n${record.body.trim()}\n`
}

export function renderNote(record: LessonRecord): string {
  return `${frontmatter(record)}\n${(record.lines ?? [record.description]).map((line) => `- ${line}`).join('\n')}\n`
}
