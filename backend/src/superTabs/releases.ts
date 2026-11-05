/**
 * Releases scheduled by the Swarm (task #3405, anh Dee's Swarm redesign, 2026-11-05: the server does the routine). A merge
 * recorded on a task puts it on its project's release list; the worker (releaseWatch.ts) reads GitHub for each component's
 * newest verified release (a tag whose release workflow succeeded: its artifacts built and checked) and marks the tasks it
 * carries released, and inside the release window it opens a release step for the project's Integrator: Desktop, CLI and web
 * right after a visible merge, the backend at most every two hours and never in its morning pause. Everything here is pure.
 */
import { localNow } from './digest.js'
import type { Conversation } from './model.js'
import type { SwarmProject } from './projects.js'

/** The release window and pace, in the shape of the project rules record's `releaseWindow` and `releasePace` (task #3393,
 *  policy.ts). Until that record lands, these constants are the one place the numbers live. */
export interface ReleaseRules {
  releaseWindow: { start: string; end: string; timeZone: string }
  releasePace: { backendEveryMinutes: number; appsAfterVisibleBatch: boolean; backendPause: { start: string; end: string } | null }
}

/** Today's numbers (project instructions rev 78; River, 11-05: no backend release 09:00-10:00, off the morning peak). */
export const RELEASE_RULES: ReleaseRules = Object.freeze({
  releaseWindow: Object.freeze({ start: '09:00', end: '18:00', timeZone: 'Asia/Ho_Chi_Minh' }),
  releasePace: Object.freeze({ backendEveryMinutes: 120, appsAfterVisibleBatch: true, backendPause: Object.freeze({ start: '09:00', end: '10:00' }) }),
}) as ReleaseRules

export type ReleaseComponentId = 'backend' | 'cli' | 'desktop' | 'web'
/** What ships a part of the repository: its tag's suffix (`v1.4.16_backend`), the workflow a pushed tag runs, the folders
 *  whose visible changes it carries. Web is built from Desktop's folder. */
export interface ReleaseComponent { id: ReleaseComponentId; name: string; tagSuffix: string; workflow: string; paths: readonly string[] }

export const RELEASE_COMPONENTS: readonly ReleaseComponent[] = Object.freeze([
  { id: 'backend', name: 'Backend', tagSuffix: '_backend', workflow: 'production-be-build.yaml', paths: ['backend/'] },
  { id: 'cli', name: 'CLI', tagSuffix: '_cli', workflow: 'release.yml', paths: ['cli/'] },
  { id: 'desktop', name: 'Desktop', tagSuffix: '_desktop', workflow: 'release-desktop.yml', paths: ['desktop/'] },
  { id: 'web', name: 'Web', tagSuffix: '_web', workflow: 'release-web.yml', paths: ['desktop/'] },
] as const)

export const componentNamed = (id: ReleaseComponentId): ReleaseComponent => RELEASE_COMPONENTS.find(c => c.id === id)!

/** Whether [tag] is a release of [component]: `v` and three numbers, then its suffix and nothing more. */
export const isReleaseTag = (component: ReleaseComponent, tag: string): boolean =>
  new RegExp(`^v\\d+\\.\\d+\\.\\d+${component.tagSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(tag)

/** Tests, docs and fixtures reach nobody by a release: a change of only these ships at its merge. */
const INVISIBLE = [/(^|\/)(test|tests|integration|integration_test|test_driver|__tests__|fixtures)\//, /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.test-support\.[cm]?[jt]s$/, /_test\.dart$/, /\.md$/]

/** The components whose releases carry [files], in RELEASE_COMPONENTS order. */
export function componentsOf(files: readonly string[]): ReleaseComponentId[] {
  const visible = files.filter(file => !INVISIBLE.some(pattern => pattern.test(file)))
  return RELEASE_COMPONENTS.filter(c => visible.some(file => c.paths.some(path => file.startsWith(path)))).map(c => c.id)
}

const clock = (rules: ReleaseRules, now: number) => localNow(rules.releaseWindow.timeZone, now).time
const within = (time: string, span: { start: string; end: string }) => span.start <= time && time < span.end

/** From the window's start up to, not including, its end, in its own time zone. */
export const inReleaseWindow = (rules: ReleaseRules, now: number): boolean => within(clock(rules, now), rules.releaseWindow)
/** Inside the backend's pause, in the window's time zone. */
export const backendPaused = (rules: ReleaseRules, now: number): boolean =>
  !!rules.releasePace.backendPause && within(clock(rules, now), rules.releasePace.backendPause)

/** A task merged and not yet carried by every release it needs. `components` is unknown until the worker read its pull
 *  request's files; `shippedIn` names, per component, the verified release that carries it. */
export interface PendingRelease { groupId: string; url: string; mergedAt: number; components?: ReleaseComponentId[]; shippedIn?: Partial<Record<ReleaseComponentId, string>> }
/** A component's newest verified release: its tag, the tag's commit and when that commit landed on main, and when its
 *  release ran (the pace counts from it). */
export interface VerifiedRelease { tag: string; sha: string; at: number; committedAt: number }
/** The release step open for a component, and when the Swarm opened it. */
export interface ReleaseStep { groupId: string; at: number }
/** A project's release list (SwarmProject.releases). The server alone writes it; readers never get it. */
export interface ReleaseLedger { pending: PendingRelease[]; last?: Partial<Record<ReleaseComponentId, VerifiedRelease>>; steps?: Partial<Record<ReleaseComponentId, ReleaseStep>> }

/** At most this many tasks wait on a project's list; the oldest leaves first, with a warning. */
export const PENDING_MAX = 100
/** A merge no release carried in this long leaves the list, with a warning. */
export const PENDING_MS = 14 * 24 * 3_600_000

/** The tasks waiting for [component]: their components known, it among them, and no release of it carrying them yet. */
export const waitingFor = (ledger: ReleaseLedger, component: ReleaseComponentId): PendingRelease[] =>
  ledger.pending.filter(e => e.components?.includes(component) && !e.shippedIn?.[component])

/** Whether the Swarm opens a release step for [component] at [now]: inside the window, with a change waiting and no step
 *  open; the backend also outside its pause and at least the pace after its last verified release; the apps when the pace
 *  says they go after each visible batch. */
export function releaseDue(ledger: ReleaseLedger, component: ReleaseComponentId, now: number, rules: ReleaseRules): boolean {
  if (!inReleaseWindow(rules, now) || ledger.steps?.[component] || !waitingFor(ledger, component).length) return false
  if (component !== 'backend') return rules.releasePace.appsAfterVisibleBatch
  if (backendPaused(rules, now)) return false
  const last = ledger.last?.backend
  return !last || now - last.at >= rules.releasePace.backendEveryMinutes * 60_000
}

/** Whether [release] carries [entry]'s merge. Main is linear (every merge is a squash), so a merge recorded at or before the
 *  moment the tag's commit landed on main is in it; releaseWatch.ts reads only tags on main. */
export const carries = (release: VerifiedRelease, entry: PendingRelease): boolean => entry.mergedAt <= release.committedAt

/** Whether every release [entry] needs carries it: none for a change that only tests or documents. */
export const shipped = (entry: PendingRelease): boolean => !!entry.components && entry.components.every(c => !!entry.shippedIn?.[c])

/** Puts [group]'s merge of [url] at [mergedAt] on [project]'s release list, in the merge record's own write. The same merge
 *  recorded again adds nothing; a later merge of the same task waits on its own. Returns the entries the cap pushed out. */
export function notePendingRelease(project: SwarmProject, group: Pick<Conversation, 'id'>, url: string, mergedAt: number): PendingRelease[] {
  const ledger = project.releases ??= { pending: [] }
  if (ledger.pending.some(e => e.groupId === group.id && e.url === url)) return []
  ledger.pending.push({ groupId: group.id, url, mergedAt })
  ledger.pending.sort((a, b) => a.mergedAt - b.mergedAt)
  return ledger.pending.length > PENDING_MAX ? ledger.pending.splice(0, ledger.pending.length - PENDING_MAX) : []
}
