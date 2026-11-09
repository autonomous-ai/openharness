import { shippedNotice } from './buddyNews.js'
/**
 * Releases scheduled by the Swarm (task #3405, anh Dee's Swarm redesign, 2026-11-05: the server does the routine). A merge
 * recorded on a task puts it on its project's release list; the worker (releaseWatch.ts) reads GitHub for each component's
 * newest verified release (a tag whose release workflow succeeded: its artifacts built and checked) and marks the tasks it
 * carries released, and inside the release window it opens a release step for the project's Integrator: Desktop, CLI and web
 * right after a visible merge, the backend at most every two hours and never in its morning pause. Everything here is pure.
 */
import { agentDisplayName } from './agentNames.js'
import { localNow } from './localTime.js'
import { activeWork, nextConversationNumber, stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, projectsOf, type SwarmProject } from './projects.js'
import { SEED_RULES, type ProjectRules } from './policy.js'
import { processOf, taskProcess } from './process.js'

/** The release window, pace and backend pause: the project rules record's own (policy.ts, task #3393), which people edit
 *  without a release. The store reads each project's record when it settles (store.ts settleReleases). */
export type ReleaseRules = Pick<ProjectRules, 'releaseWindow' | 'releasePace'>

/** The record's seed (09:00-18:00 VN, the backend every 120 minutes and never 09:00-10:00, apps after each visible batch):
 *  what a project without a saved record runs on, and the pure functions' default. */
export const RELEASE_RULES: ReleaseRules = { releaseWindow: SEED_RULES.releaseWindow, releasePace: SEED_RULES.releasePace }

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
 *  request's files, and `sha` until it found the merge's commit on main (its own merge commit, or the batch's that closed
 *  it); `shippedIn` names, per component, the verified release that carries it. */
export interface PendingRelease { groupId: string; url: string; mergedAt: number; components?: ReleaseComponentId[]; sha?: string
  shippedIn?: Partial<Record<ReleaseComponentId, string>>
  /** Per component, the newest verified release this merge was compared with and found not in it (task #3586): it is compared
   *  once with each release, so one cut before the merge was recorded still ships it, and one that does not hold it is not read again. */
  checked?: Partial<Record<ReleaseComponentId, string>> }
/** A component's newest verified release: its tag, the tag's commit, and when its release ran (the pace counts from it). */
export interface VerifiedRelease { tag: string; sha: string; at: number }

/** One entry's name on the list, by which a release says it carries it. */
export const pendingKey = (entry: Pick<PendingRelease, 'groupId' | 'url'>): string => `${entry.groupId} ${entry.url}`

/** Release tags by version (`v1.3.100_desktop` after `v1.3.99_desktop`): negative when [a] is older than [b]. */
export function compareTags(a: string, b: string): number {
  const version = (tag: string) => (/^v(\d+)\.(\d+)\.(\d+)/.exec(tag) ?? []).slice(1).map(Number)
  const [x, y] = [version(a), version(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}
/** The release step open for a component, when the Swarm opened it, and when it first saw that step over without a verified
 *  release (done, cancelled or archived: the release may still be running). */
export interface ReleaseStep { groupId: string; at: number; endedAt?: number }
/** A project's release list (SwarmProject.releases). The server alone writes it; readers never get it. */
export interface ReleaseLedger { pending: PendingRelease[]; last?: Partial<Record<ReleaseComponentId, VerifiedRelease>>; steps?: Partial<Record<ReleaseComponentId, ReleaseStep>>
  /** Tasks the cap pushed off the list with no other merge left on it: the merge's write may not hold them, so the next settle
   *  loads them and clears their `releasing` (review of #3267). */
  leaving?: string[]
  /** When each component's release may next open (nextReleaseAt): 0 for now, absent for one left to people. Written by the settle
   *  only when it changes, and sent to readers in `derived.releaseTimes` for the board's Merged cards (task #3827). */
  nextAt?: Partial<Record<ReleaseComponentId, number>> }

/** The groups a settle of [ledger] loads: the tasks waiting, the open release steps, the tasks leaving. */
export const ledgerGroupIds = (ledger: ReleaseLedger): string[] =>
  [...new Set([...ledger.pending.map(e => e.groupId), ...Object.values(ledger.steps ?? {}).map(s => s!.groupId), ...ledger.leaving ?? []])]

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

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
/** Minutes from the clock time [from] to the next [to], 0 to 1439. */
const minutesUntil = (from: string, to: string): number => (minutesOf(to) - minutesOf(from) + 1440) % 1440

/**
 * When a release of [component] may next open, as the board's Merged cards say it (task #3827): 0 when it may now (so the read
 * does not change with the clock), else the minute it may, in ms; null for the apps when the pace leaves them to people. It is
 * [releaseDue] without the waiting change and the open step: a merged task waits by definition. The backend's pace counts from
 * its last verified release, and every component waits for the window, the backend also for its pause to end. The clock's own
 * minutes carry it past a boundary; a zone that shifts its clock may need another look, so a few rounds settle it.
 */
export function nextReleaseAt(ledger: ReleaseLedger, component: ReleaseComponentId, now: number, rules: ReleaseRules): number | null {
  if (component !== 'backend' && !rules.releasePace.appsAfterVisibleBatch) return null
  let at = now
  if (component === 'backend') {
    const last = ledger.last?.backend
    if (last) at = Math.max(at, last.at + rules.releasePace.backendEveryMinutes * 60_000)
  }
  const pause = component === 'backend' ? rules.releasePace.backendPause : null
  for (let round = 0; round < 4; round++) {
    const time = clock(rules, at)
    if (!within(time, rules.releaseWindow)) at += minutesUntil(time, rules.releaseWindow.start) * 60_000
    else if (pause && within(time, pause)) at += minutesUntil(time, pause.end) * 60_000
    else break
  }
  at -= at % 60_000
  return at <= now ? 0 : at
}

/** Whether every release [entry] needs carries it: none for a change that only tests or documents. */
export const shipped = (entry: PendingRelease): boolean => !!entry.components && entry.components.every(c => !!entry.shippedIn?.[c])

/** Puts [group]'s merge of [url] at [mergedAt] on [project]'s release list, in the merge record's own write. The same merge
 *  recorded again adds nothing; a later merge of the same task waits on its own. Returns the entries the cap pushed out. */
export function notePendingRelease(project: SwarmProject, group: Pick<Conversation, 'id' | 'releasing' | 'process' | 'number'>, url: string, mergedAt: number): PendingRelease[] {
  if (taskProcess(project, group) === 'simple') return []
  const ledger = project.releases ??= { pending: [] }
  if (ledger.pending.some(e => e.groupId === group.id && e.url === url)) return []
  // Releasing from its merge on; its parts are known once the worker reads its pull request's files.
  group.releasing ??= []
  ledger.pending.push({ groupId: group.id, url, mergedAt })
  ledger.pending.sort((a, b) => a.mergedAt - b.mergedAt)
  const dropped = ledger.pending.length > PENDING_MAX ? ledger.pending.splice(0, ledger.pending.length - PENDING_MAX) : []
  for (const { groupId } of dropped) {
    if (!ledger.pending.some(e => e.groupId === groupId) && !ledger.leaving?.includes(groupId)) (ledger.leaving ??= []).push(groupId)
  }
  return dropped
}

/** How long a step that ended without a verified release still holds its component: a release workflow that is still
 *  running (Desktop's verifies nine downloads) lands within it. After it, the next pass opens a new step. */
export const STEP_GRACE_MS = 60 * 60_000
/** Why a release step names no requester: the Swarm opens it on its schedule (the task contract's recorded reason, #3389). */
export const RELEASE_NO_REQUESTER = 'scheduled release'
/** The one check of a release step: what tells the Integrator it is done. */
export const RELEASE_CHECK = 'Each release here is verified (its tag\'s release workflow passed) and live, and the Swarm said so in this task'

/** The project's Integrator: an agent of [projectId] whose crew role (task #3397) or role name is Integrator. */
export function integratorOf(state: SuperTabState, projectId: string): Agent | undefined {
  const role = (agent: Agent) => ((agent as Agent & { crew?: { role?: string } }).crew?.role ?? agent.roleName ?? '').trim().toLowerCase()
  return state.agents.find(agent => role(agent) === 'integrator' && agentProjectId(state, agent) === projectId)
}

/** What the worker read from GitHub for one project's release list (releaseWatch.ts). */
export interface ReleaseFacts {
  /** What the worker found of pending entries: their components (their pull requests' files), their merge commits on main. */
  resolved: Array<{ groupId: string; url: string; components?: ReleaseComponentId[]; sha?: string }>
  /** Each component's newest verified release on main, with the entries whose merge commits GitHub says its tag contains
   *  (pendingKey). A component GitHub could not read or compare is absent, and nothing of it changes. */
  releases: Partial<Record<ReleaseComponentId, VerifiedRelease & { carries: string[]; compared?: string[] }>>
}
/** What a settle did: rows to write, the tasks it marked released, the release step it opened, the entries it dropped. */
export interface SettledReleases { messages: MessageDraft[]; shipped: string[]; opened: string | null; dropped: PendingRelease[] }

const ended = (group: Conversation | undefined): boolean => !group || group.archived || (!!group.assignment && !activeWork(group))
const named = (state: SuperTabState, groupId: string): string => {
  const group = state.conversations.find(c => c.id === groupId)
  return group ? `#${group.number} ${group.title}` : 'a task no longer here'
}
const joined = (words: string[]): string => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/**
 * Settles [projectId]'s release list in [state] (a copy the caller writes) at [now]: [facts]' components fill their entries;
 * each component's newer verified release is kept, marks the entries it carries, and says so in its open release step, which
 * it frees; an entry every release it needs carries is marked released on its task and leaves the list; one past PENDING_MS
 * leaves too. A step that ended without a verified release frees its components STEP_GRACE_MS later. Then, when components are
 * due (releaseDue), one release step opens for them all, naming the Integrator. Deterministic in [now]: a retried write opens
 * the same step id.
 */
export function settleReleases(state: SuperTabState, projectId: string, facts: ReleaseFacts, now: number, rules: ReleaseRules = RELEASE_RULES): SettledReleases {
  const outcome: SettledReleases = { messages: [], shipped: [], opened: null, dropped: [] }
  const project = projectsOf(state).find(p => p.id === projectId)
  const ledger = project?.releases
  if (!project || !ledger) return outcome
  const chat = state.conversations.find(c => c.id === project.leadConversationId)
  const lead = chat?.leadId ? state.agents.find(a => a.id === chat.leadId) : undefined
  const row = (conversationId: string, text: string, recipients: string[], key: string): MessageDraft | null => lead ? {
    id: stableId('release', state.id, projectId, key, String(now)), conversationId, replyTo: null, recipients, text, source: { kind: 'release' },
    author: { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration },
  } : null
  const say = (draft: MessageDraft | null) => { if (draft) outcome.messages.push(draft) }

  for (const read of facts.resolved) {
    const entry = ledger.pending.find(e => pendingKey(e) === pendingKey(read))
    if (!entry) continue
    if (!entry.components && read.components) entry.components = [...read.components]
    if (!entry.sha && read.sha) entry.sha = read.sha
  }
  const fresh = ledger.pending.filter(e => e.mergedAt > now - PENDING_MS)
  outcome.dropped = ledger.pending.filter(e => !fresh.includes(e))
  ledger.pending = fresh
  const left = new Set<string>([...outcome.dropped.map(e => e.groupId), ...ledger.leaving ?? []])
  delete ledger.leaving

  for (const component of RELEASE_COMPONENTS) {
    const read = facts.releases[component.id]
    const known = ledger.last?.[component.id]
    // A re-run of an older tag's workflow is no newer release; the same tag read again only carries merges resolved since.
    const order = read && known ? compareTags(read.tag, known.tag) : 1
    if (!read || order < 0) continue
    const { carries: keys, compared, ...release } = read
    const carried = waitingFor(ledger, component.id).filter(e => keys.includes(pendingKey(e)))
    for (const entry of carried) (entry.shippedIn ??= {})[component.id] = release.tag
    // Compared and not held: not compared with this release again (task #3586).
    for (const entry of waitingFor(ledger, component.id)) if (compared?.includes(pendingKey(entry)) && !keys.includes(pendingKey(entry))) (entry.checked ??= {})[component.id] = release.tag
    if (order === 0) continue
    ;(ledger.last ??= {})[component.id] = release
    const step = ledger.steps?.[component.id]
    if (step && release.at >= step.at) {
      const tasks = carried.map(e => named(state, e.groupId))
      if (state.conversations.some(c => c.id === step.groupId)) {
        say(row(step.groupId, `Verified ${release.tag}: ${tasks.length ? `it carries ${joined(tasks)}` : 'no task waited for it'}.`, [], `verified-${release.tag}`))
      }
      delete ledger.steps![component.id]
    }
  }

  ledger.pending = ledger.pending.filter(entry => {
    if (!shipped(entry)) return true
    const group = state.conversations.find(c => c.id === entry.groupId)
    const tags = [...new Set(Object.values(entry.shippedIn ?? {}))].sort()
    const at = Math.max(entry.mergedAt, ...entry.components!.map(c => ledger.last?.[c]?.at ?? entry.mergedAt))
    if (group) {
      group.released = { at, tags }
      outcome.shipped.push(group.id)
    }
    left.add(entry.groupId)
    return false
  })
  // What each task still waits for, across its merges still on the list; none left, and it is releasing no more.
  const waits = new Map<string, Set<ReleaseComponentId>>()
  for (const entry of ledger.pending) {
    const parts = waits.get(entry.groupId) ?? new Set<ReleaseComponentId>()
    for (const c of entry.components ?? []) if (!entry.shippedIn?.[c]) parts.add(c)
    waits.set(entry.groupId, parts)
  }
  for (const groupId of new Set([...left, ...waits.keys()])) {
    const group = state.conversations.find(c => c.id === groupId)
    const parts = waits.get(groupId)
    if (!group) continue
    if (parts) group.releasing = RELEASE_COMPONENTS.filter(c => parts.has(c.id)).map(c => c.id)
    else delete group.releasing
  }


  // Shipped once a verified release holds all of it (task #4217: a merge alone is not shipped): a proposal's card says so, and only
  // there (task #4558); a task's requester's Buddy hears it, by an id the release fixes, so a settle retried tells nobody twice.
  if (lead) for (const id of new Set(outcome.shipped)) {
    const group = state.conversations.find(c => c.id === id)
    if (!group || group.releasing) continue
    const sender = { kind: 'agent' as const, id: lead.id, name: lead.name, membershipGeneration: lead.membershipGeneration }
    const once = stableId(group.id, 'shipped', String(group.released!.at))
    const news = shippedNotice(state, group, sender, once)
    if (news) outcome.messages.push(news)
  }

  for (const component of RELEASE_COMPONENTS) {
    const step = ledger.steps?.[component.id]
    if (!step || !ended(state.conversations.find(c => c.id === step.groupId))) continue
    step.endedAt ??= now
    if (now - step.endedAt >= STEP_GRACE_MS) delete ledger.steps![component.id]
  }

  const nextAt: Partial<Record<ReleaseComponentId, number>> = {}
  for (const component of RELEASE_COMPONENTS) {
    const at = nextReleaseAt(ledger, component.id, now, rules)
    if (at !== null) nextAt[component.id] = at
  }
  if (JSON.stringify(ledger.nextAt) !== JSON.stringify(nextAt)) ledger.nextAt = nextAt

  // A return to Full applies to new work only. Keep the old pending history for verified releases, but open no new
  // release step for a task the switch made Simple. The ledger is bounded by PENDING_MAX.
  const tasks = new Map(state.conversations.map(group => [group.id, group]))
  const scheduled = { ...ledger, pending: ledger.pending.filter(entry => taskProcess(project, tasks.get(entry.groupId) ?? {}) === 'full') }
  const due = RELEASE_COMPONENTS.filter(c => releaseDue(scheduled, c.id, now, rules))
  if (!due.length || state.paused || processOf(project) === 'simple') return outcome
  const id = stableId('release-step', state.id, projectId, due.map(c => c.id).join(','), String(now))
  if (state.conversations.some(c => c.id === id)) return outcome
  const integrator = integratorOf(state, projectId)
  const waitingIds = [...new Set(due.flatMap(c => waitingFor(scheduled, c.id).map(e => e.groupId)))]
  const waiting = waitingIds.map(groupId => named(state, groupId))
  // Each task merged while its Windows test step waited for a Windows machine owes a person's Windows check, which the Windows
  // rules ask for on the signed build (osSteps.ts, task #4410, River's ruling 11-07): listed here, for whoever records it.
  const owed = waitingIds.filter(groupId => state.conversations.find(c => c.id === groupId)?.waitingWindowsStep).map(groupId => named(state, groupId))
  const names = joined(due.map(c => c.name)), window = rules.releaseWindow
  const brief = [`Release ${names}: ${waiting.length} merged ${waiting.length === 1 ? 'task waits' : 'tasks wait'} for it (${waiting.join('; ')}).`,
    ...owed.length ? [`Windows check owed on the signed build: ${owed.join('; ')}. No Windows machine took ${owed.length === 1
      ? 'its test step: record it here.' : 'their test steps: record each here.'}`] : [],
    `Release between ${window.start} and ${window.end} (${window.timeZone}), applying the merged pull requests' rollout notes first, and verify each release is live.`,
    'The Swarm marks those tasks shipped once each tag\'s release workflow succeeds, and says so here.'].join('\n')
  const number = nextConversationNumber(state)
  state.groupCounter = number
  state.conversations.push({ id, projectId, number, title: `Release ${names}`, leadId: chat?.leadId ?? null,
    agentIds: [...chat?.leadId ? [chat.leadId] : [], ...integrator ? [integrator.id] : []], archived: false, brief, priority: 'P1',
    assignment: null, lastMessageSequence: 0,
    // The task contract (#3389) holds for what the Swarm opens too: a check, a priority, and why nobody is named as its requester.
    checks: [{ id: stableId(id, 'check', '0'), description: RELEASE_CHECK, independent: false, evidence: null, passedBy: null }],
    ledger: { askedAt: now, noRequesterReason: RELEASE_NO_REQUESTER } } as unknown as Conversation)
  for (const component of due) (ledger.steps ??= {})[component.id] = { groupId: id, at: now }
  outcome.opened = id
  say(row(id, integrator
    ? `${integrator.displayName ?? integrator.name}, this release is yours: assign it to yourself and release ${names}.\n${brief}\n\nNo requester: ${RELEASE_NO_REQUESTER}`
    : `${brief}\nNo Integrator in this project: the PM assigns it.\n\nNo requester: ${RELEASE_NO_REQUESTER}`, integrator ? [integrator.id] : [], 'opened'))
  return outcome
}
