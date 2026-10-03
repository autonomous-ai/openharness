/**
 * CHECK, part one (daemons/LEARNING.md, L2): when each lesson was last USED, so the curator (curate.ts) can
 * put away what nobody reads.
 *
 * The signal is a session reading the lesson — the one thing every engine does the same way, with a tool:
 * Claude's Read of `<runtime>/lessons/<name>/SKILL.md`, a shell's `cat` or `sed` of that path (Codex, pi …),
 * a read of an exported copy (`~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`), or
 * Claude's Skill tool naming an exported skill. Reliable, because a skill is only ever used by being read; it
 * misses a model that recalls a lesson it read in an earlier session without reading it again, which errs on
 * the side of "unused" (and the curator only archives, never deletes). A note has no file of its own: it is
 * loaded with its project's instructions, so a turn in its project counts as a use.
 *
 * Kept in `usage.json` in the lessons folder (0600, not committed), never before the folder exists. Always on,
 * pairing or not: it only reads the events harnessd already has. Absences are remembered too: a stretch of a
 * week or more with no turn at all on this machine (a laptop in a drawer) never counts toward "unused".
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LessonRecord, LessonStore } from './store.js'
import { projectHash } from './types.js'
import type { LearnEvent } from './signals.js'

/** No turn at all for this long, and the time does not count toward a lesson being unused. */
export const USAGE_GAP_MS = 7 * 24 * 60 * 60_000
/** How often activity alone is written down (a use is written at once). */
const ACTIVITY_SAVE_MS = 60 * 60_000
const NAMES_TTL_MS = 60_000
const GAPS_MAX = 50
const DAY_MS = 24 * 60 * 60_000

export interface UsageEntry {
  /** The last time a session read it (a skill) or worked in its project (a note). */
  lastUsed: number | null
  uses: number
  /** When the curator marked it stale; cleared by a use. */
  stale?: number | null
  /** When it was last restored from the archive: the clock starts again. */
  restored?: number | null
}

interface UsageState {
  v: 1
  /** When tracking began: a lesson approved before it is not unused from its approval day. */
  since: number
  lastActivity: number | null
  gaps: Array<{ from: number; to: number }>
  lessons: Record<string, UsageEntry>
}

const SKILL_PATH = /(?:^|[\s"'`=(/])(?:lessons|\.claude\/skills|\.agents\/skills)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md\b/g

/** The lesson skill names one tool call reads: a SKILL.md path in its input, or Claude's Skill tool. */
export function lessonReads(tool: string, input: unknown): string[] {
  const names = new Set<string>()
  let text: string
  if (typeof input === 'string') text = input
  else {
    try { text = JSON.stringify(input) ?? '' } catch { text = '' }
  }
  text = text.slice(0, 8_000)
  if (/^skill$/i.test(tool.replace(/^functions\./, '')) && input && typeof input === 'object') {
    const args = input as Record<string, unknown>
    const named = args.skill ?? args.name ?? args.command
    if (typeof named === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(named.trim())) names.add(named.trim())
  }
  for (const m of text.replace(/\\\//g, '/').matchAll(SKILL_PATH)) names.add(m[1]!)
  return [...names]
}

export interface UsageDeps {
  store: Pick<LessonStore, 'root' | 'approved' | 'exists'>
  now: () => number
}

export class LessonUsage {
  private state: UsageState | null = null
  private savedActivity = -Infinity
  private names: { at: number; skills: Map<string, string[]>; notes: Map<string, string[]> } | null = null
  /** When this tracker started: where tracking begins when there is no usage.json yet. */
  private readonly startedAt: number

  constructor(private readonly deps: UsageDeps) {
    this.startedAt = deps.now()
  }

  private get file(): string { return join(this.deps.store.root, 'usage.json') }

  /** Session events, live (lib/normalize.ts). A replay is history: nothing in it is a use. */
  ingest(ctx: { cwd: string | null }, events: readonly LearnEvent[], opts: { replay?: boolean } = {}): void {
    if (opts.replay || !this.deps.store.exists) return
    for (const event of events) {
      const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>
      if (event.type === 'turn_started') {
        this.activity()
        const project = projectHash(ctx.cwd)
        for (const id of (project && this.known().notes.get(project)) || []) this.used(id)
      } else if (event.type === 'tool_start' && typeof payload.tool === 'string') {
        for (const name of lessonReads(payload.tool, payload.input)) for (const id of this.known().skills.get(name) ?? []) this.used(id)
      }
    }
  }

  /** A lesson was used now: its clock starts again, and it is no longer stale. */
  used(id: string): void {
    const state = this.load()
    const entry = state.lessons[id] ?? { lastUsed: null, uses: 0 }
    state.lessons[id] = { ...entry, lastUsed: this.deps.now(), uses: entry.uses + 1, stale: null }
    this.save()
  }

  /** Something ran on this machine now. An absence of a week or more before it is remembered as a gap. */
  activity(): void {
    const state = this.load()
    const now = this.deps.now()
    if (state.lastActivity !== null && now - state.lastActivity >= USAGE_GAP_MS) {
      state.gaps = [...state.gaps, { from: state.lastActivity, to: now }].slice(-GAPS_MAX)
      this.savedActivity = -Infinity
    }
    state.lastActivity = now
    if (now - this.savedActivity >= ACTIVITY_SAVE_MS) { this.savedActivity = now; this.save() }
  }

  entry(id: string): UsageEntry | null { return this.load().lessons[id] ?? null }

  markStale(id: string): void {
    const state = this.load()
    state.lessons[id] = { ...(state.lessons[id] ?? { lastUsed: null, uses: 0 }), stale: this.deps.now() }
    this.save()
  }

  /** Brought back from the archive: unused from now, not from its approval. */
  restored(id: string): void {
    const state = this.load()
    state.lessons[id] = { ...(state.lessons[id] ?? { lastUsed: null, uses: 0 }), restored: this.deps.now(), stale: null }
    this.save()
  }

  /**
   * How long a lesson has gone unused: from its last use, its approval, its restore or the start of tracking
   * (the latest), less every absence of a week or more — the current one included.
   */
  unusedMs(record: LessonRecord): number {
    const state = this.load()
    const now = this.deps.now()
    const entry = state.lessons[record.id]
    const approvedAt = record.approved && /^\d{4}-\d{2}-\d{2}$/.test(record.approved) ? Date.parse(`${record.approved}T00:00:00Z`) : record.created
    const since = Math.max(entry?.lastUsed ?? 0, entry?.restored ?? 0, approvedAt, state.since)
    const gaps = [...state.gaps]
    if (state.lastActivity !== null && now - state.lastActivity >= USAGE_GAP_MS) gaps.push({ from: state.lastActivity, to: now })
    let away = 0
    for (const gap of gaps) away += Math.max(0, Math.min(gap.to, now) - Math.max(gap.from, since))
    return Math.max(0, now - since - away)
  }

  /** Whole days unused, for `lessons list`. */
  unusedDays(record: LessonRecord): number { return Math.floor(this.unusedMs(record) / DAY_MS) }

  /** Approved lessons by what a session would read: skill names, and notes by project. Cached for a minute. */
  private known(): { skills: Map<string, string[]>; notes: Map<string, string[]> } {
    const now = this.deps.now()
    if (this.names && now - this.names.at < NAMES_TTL_MS) return this.names
    const skills = new Map<string, string[]>()
    const notes = new Map<string, string[]>()
    for (const r of this.deps.store.approved()) {
      if (r.kind === 'skill') skills.set(r.name, [...(skills.get(r.name) ?? []), r.id])
      else if (r.project) notes.set(r.project, [...(notes.get(r.project) ?? []), r.id])
    }
    this.names = { at: now, skills, notes }
    return this.names
  }

  /** Forget the cached names: a lesson was approved, reverted, archived or restored. */
  changed(): void { this.names = null }

  private load(): UsageState {
    if (this.state) return this.state
    const fresh: UsageState = { v: 1, since: this.startedAt, lastActivity: null, gaps: [], lessons: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<UsageState>
      this.state = parsed?.v === 1 && typeof parsed.since === 'number' ? {
        v: 1, since: parsed.since,
        lastActivity: typeof parsed.lastActivity === 'number' ? parsed.lastActivity : null,
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter((g) => typeof g?.from === 'number' && typeof g?.to === 'number') : [],
        lessons: parsed.lessons && typeof parsed.lessons === 'object' ? parsed.lessons : {},
      } : fresh
    } catch { this.state = fresh }
    return this.state
  }

  private save(): void {
    if (!this.state || !this.deps.store.exists) return
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch (err) {
      console.warn(`[learn] could not save usage: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
