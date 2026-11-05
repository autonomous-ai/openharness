/**
 * Releases scheduled by the Swarm (task #3405, anh Dee's Swarm redesign, 2026-11-05: the server does the routine). A merge
 * recorded on a task puts it on its project's release list; the worker (releaseWatch.ts) reads GitHub for each component's
 * newest verified release (a tag whose release workflow succeeded: its artifacts built and checked) and marks the tasks it
 * carries released, and inside the release window it opens a release step for the project's Integrator: Desktop, CLI and web
 * right after a visible merge, the backend at most every two hours and never in its morning pause. Everything here is pure.
 */
import { agentDisplayName } from './agentNames.js'
import { localNow } from './digest.js'
import { activeWork, nextConversationNumber, stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, projectsOf, type SwarmProject } from './projects.js'

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
/** The release step open for a component, when the Swarm opened it, and when it first saw that step over without a verified
 *  release (done, cancelled or archived: the release may still be running). */
export interface ReleaseStep { groupId: string; at: number; endedAt?: number }
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

/** How long a step that ended without a verified release still holds its component: a release workflow that is still
 *  running (Desktop's verifies nine downloads) lands within it. After it, the next pass opens a new step. */
export const STEP_GRACE_MS = 60 * 60_000

/** The project's Integrator: an agent of [projectId] whose crew role (task #3397) or role name is Integrator. */
export function integratorOf(state: SuperTabState, projectId: string): Agent | undefined {
  const role = (agent: Agent) => ((agent as Agent & { crew?: { role?: string } }).crew?.role ?? agent.roleName ?? '').trim().toLowerCase()
  return state.agents.find(agent => role(agent) === 'integrator' && agentProjectId(state, agent) === projectId)
}

/** What the worker read from GitHub for one project's release list (releaseWatch.ts). */
export interface ReleaseFacts {
  /** Pending entries' components, from their pull requests' files. */
  components: Array<{ groupId: string; url: string; components: ReleaseComponentId[] }>
  /** Each component's newest verified release on main; a component GitHub could not read is absent, and nothing of it changes. */
  releases: Partial<Record<ReleaseComponentId, VerifiedRelease>>
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

  for (const read of facts.components) {
    const entry = ledger.pending.find(e => e.groupId === read.groupId && e.url === read.url)
    if (entry && !entry.components) entry.components = [...read.components]
  }
  const fresh = ledger.pending.filter(e => e.mergedAt > now - PENDING_MS)
  outcome.dropped = ledger.pending.filter(e => !fresh.includes(e))
  ledger.pending = fresh

  for (const component of RELEASE_COMPONENTS) {
    const release = facts.releases[component.id]
    const known = ledger.last?.[component.id]
    if (!release || (known && known.at >= release.at)) continue
    ;(ledger.last ??= {})[component.id] = release
    const carried = waitingFor(ledger, component.id).filter(e => carries(release, e))
    for (const entry of carried) (entry.shippedIn ??= {})[component.id] = release.tag
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
    return false
  })

  for (const component of RELEASE_COMPONENTS) {
    const step = ledger.steps?.[component.id]
    if (!step || !ended(state.conversations.find(c => c.id === step.groupId))) continue
    step.endedAt ??= now
    if (now - step.endedAt >= STEP_GRACE_MS) delete ledger.steps![component.id]
  }

  const due = RELEASE_COMPONENTS.filter(c => releaseDue(ledger, c.id, now, rules))
  if (!due.length || state.paused) return outcome
  const id = stableId('release-step', state.id, projectId, due.map(c => c.id).join(','), String(now))
  if (state.conversations.some(c => c.id === id)) return outcome
  const integrator = integratorOf(state, projectId)
  const waiting = [...new Set(due.flatMap(c => waitingFor(ledger, c.id).map(e => e.groupId)))].map(groupId => named(state, groupId))
  const names = joined(due.map(c => c.name)), window = rules.releaseWindow
  const brief = [`Release ${names}: ${waiting.length} merged ${waiting.length === 1 ? 'task waits' : 'tasks wait'} for it (${waiting.join('; ')}).`,
    `Release between ${window.start} and ${window.end} (${window.timeZone}), applying the merged pull requests' rollout notes first, and verify each release is live.`,
    'The Swarm marks those tasks shipped once each tag\'s release workflow succeeds, and says so here.'].join('\n')
  const number = nextConversationNumber(state)
  state.groupCounter = number
  state.conversations.push({ id, projectId, number, title: `Release ${names}`, leadId: chat?.leadId ?? null,
    agentIds: [...chat?.leadId ? [chat.leadId] : [], ...integrator ? [integrator.id] : []], archived: false, brief, priority: 'P1',
    assignment: null, lastMessageSequence: 0, checks: [] } as unknown as Conversation)
  for (const component of due) (ledger.steps ??= {})[component.id] = { groupId: id, at: now }
  outcome.opened = id
  say(row(id, integrator
    ? `${integrator.displayName ?? integrator.name}, this release is yours: assign it to yourself and release ${names}.\n${brief}`
    : `${brief}\nNo Integrator in this project: the PM assigns it.`, integrator ? [integrator.id] : [], 'opened'))
  return outcome
}
