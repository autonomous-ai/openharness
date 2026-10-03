/**
 * CHECK, part two (daemons/LEARNING.md, L2): the curator. Once a day, when nothing on the machine is working,
 * it reads how long each approved lesson has gone unused (usage.ts) and:
 *
 *   30 days  marks it STALE: an empty commit (`stale: <name>`), a journal entry, and a mark in `lessons list`.
 *            It still loads. A use clears the mark.
 *   90 days  ARCHIVES a skill: `skills/<name>` moves to `archive/`, out of every session's index, one commit
 *            (`archive: <name>`); its copies leave running sessions and exports (propose.ts). `harness pair
 *            lessons restore <id>` brings it back (one commit) and starts its clock again.
 *
 * A note is marked stale but never archived: it lives in its project's notes file, where the person sees it,
 * and taking it out would mean editing their project behind their back. Nothing is ever deleted.
 */
import type { LessonRecord, LessonStore } from './store.js'
import type { LessonUsage } from './usage.js'

export const STALE_AFTER_MS = 30 * 24 * 60 * 60_000
export const ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60_000
export const CURATE_EVERY_MS = 24 * 60 * 60_000

export interface CuratorDeps {
  store: LessonStore
  usage: LessonUsage
  now: () => number
  /** Something on this machine is working: the curator waits. */
  busy?: () => boolean
  /** A skill was archived: take its copies out of sessions and exports. */
  archived?: (record: LessonRecord) => void
  log?: (line: string) => void
}

export interface CuratorPass { stale: string[]; archived: string[]; failed: string[] }

export class LessonCurator {
  constructor(private readonly deps: CuratorDeps) {}

  /** A day since the last pass (kept in state.json, so a restart does not run it again). */
  due(): boolean {
    const at = this.deps.store.curatedAt()
    return at === null || this.deps.now() - at >= CURATE_EVERY_MS
  }

  /** Run when due and idle; null when it did not. */
  maybeRun(): CuratorPass | null {
    if (!this.deps.store.exists || !this.due() || this.deps.busy?.()) return null
    return this.run()
  }

  run(): CuratorPass {
    const { store, usage } = this.deps
    const pass: CuratorPass = { stale: [], archived: [], failed: [] }
    for (const record of store.approved()) {
      const unused = usage.unusedMs(record)
      if (record.kind === 'skill' && unused >= ARCHIVE_AFTER_MS) {
        const done = store.archive(record.id, 'unused for 90 days')
        if (!done.ok) { pass.failed.push(record.id); continue }
        pass.archived.push(record.name)
        usage.changed()
        this.deps.archived?.(record)
        continue
      }
      if (unused >= STALE_AFTER_MS && !usage.entry(record.id)?.stale) {
        const done = store.markStale(record.id, 'unused for 30 days')
        if (!done.ok) { pass.failed.push(record.id); continue }
        usage.markStale(record.id)
        pass.stale.push(record.name)
      }
    }
    store.markCurated(this.deps.now())
    if (pass.stale.length || pass.archived.length || pass.failed.length) {
      this.deps.log?.(`[learn] curator · stale ${pass.stale.join(', ') || '-'} · archived ${pass.archived.join(', ') || '-'}${pass.failed.length ? ` · failed ${pass.failed.join(', ')}` : ''}`)
    }
    return pass
  }
}
