import { describe, expect, it } from 'vitest'
import type { Agent, Conversation, SuperTabState } from './model.js'
import type { SwarmProject } from './projects.js'
import { missingContract } from './taskContract.js'
import { backendPaused, compareTags, componentsOf, inReleaseWindow, isReleaseTag, notePendingRelease, PENDING_MAX, RELEASE_COMPONENTS, RELEASE_RULES,
  ledgerGroupIds, nextReleaseAt, pendingKey, releaseDue, settleReleases, PENDING_MS, shipped, waitingFor, type PendingRelease, type ReleaseLedger } from './releases.js'

/** A time in Vietnam (UTC+7, no daylight saving) on 6 November 2026. */
const vn = (hour: number, minute = 0) => Date.UTC(2026, 10, 6, hour - 7, minute)
const MINUTE = 60_000

const entry = (over: Partial<PendingRelease> = {}): PendingRelease =>
  ({ groupId: 'g1', url: 'https://github.com/o/r/pull/1', mergedAt: vn(9), components: ['desktop'], ...over })
const ledger = (over: Partial<ReleaseLedger> = {}): ReleaseLedger => ({ pending: [entry()], ...over })

describe('release rules', () => {
  it('seeds today\'s numbers in the project rules record\'s shape', () => {
    expect(RELEASE_RULES.releaseWindow).toEqual({ start: '09:00', end: '18:00', timeZone: 'Asia/Ho_Chi_Minh' })
    expect(RELEASE_RULES.releasePace).toEqual({ backendEveryMinutes: 120, appsAfterVisibleBatch: true, backendPause: { start: '09:00', end: '10:00' } })
  })

  it('is inside the window from 09:00 up to, not including, 18:00 Vietnam time', () => {
    expect(inReleaseWindow(RELEASE_RULES, vn(8, 59))).toBe(false)
    expect(inReleaseWindow(RELEASE_RULES, vn(9))).toBe(true)
    expect(inReleaseWindow(RELEASE_RULES, vn(17, 59))).toBe(true)
    expect(inReleaseWindow(RELEASE_RULES, vn(18))).toBe(false)
    expect(inReleaseWindow(RELEASE_RULES, vn(23))).toBe(false)
  })

  it('pauses the backend from 09:00 up to 10:00, and nothing when the pause is off', () => {
    expect(backendPaused(RELEASE_RULES, vn(9, 30))).toBe(true)
    expect(backendPaused(RELEASE_RULES, vn(10))).toBe(false)
    expect(backendPaused({ ...RELEASE_RULES, releasePace: { ...RELEASE_RULES.releasePace, backendPause: null } }, vn(9, 30))).toBe(false)
  })
})

describe('componentsOf', () => {
  it('maps visible files to the releases that carry them, web with Desktop', () => {
    expect(componentsOf(['backend/src/worker.ts'])).toEqual(['backend'])
    expect(componentsOf(['cli/src/index.ts', 'desktop/lib/main.dart'])).toEqual(['cli', 'desktop', 'web'])
  })

  it('maps tests, docs and other folders to none: they ship at their merge', () => {
    expect(componentsOf(['backend/src/a.test.ts', 'backend/integration/x.test.ts', 'desktop/test/a_test.dart', 'cli/test/a.spec.ts',
      'backend/README.md', 'docs/plans/x.md', '.github/workflows/ci.yml', 'scripts/ci-plan.py'])).toEqual([])
  })

  it('knows each component\'s release tag and workflow', () => {
    expect(RELEASE_COMPONENTS.map(c => [c.id, c.tagSuffix, c.workflow])).toEqual([
      ['backend', '_backend', 'production-be-build.yaml'], ['cli', '_cli', 'release.yml'],
      ['desktop', '_desktop', 'release-desktop.yml'], ['web', '_web', 'release-web.yml']])
    const desktop = RELEASE_COMPONENTS.find(c => c.id === 'desktop')!
    expect(isReleaseTag(desktop, 'v1.3.77_desktop')).toBe(true)
    expect(isReleaseTag(desktop, 'v1.3.77_desktop-candidate')).toBe(false)
    expect(isReleaseTag(desktop, 'main')).toBe(false)
    expect(isReleaseTag(desktop, 'v1.4.16_backend')).toBe(false)
  })
})

describe('releaseDue', () => {
  it('opens Desktop right after a visible merge, inside the window only', () => {
    expect(releaseDue(ledger(), 'desktop', vn(11), RELEASE_RULES)).toBe(true)
    expect(releaseDue(ledger(), 'desktop', vn(8, 30), RELEASE_RULES)).toBe(false)
    expect(releaseDue(ledger(), 'desktop', vn(18, 30), RELEASE_RULES)).toBe(false)
  })

  it('opens nothing without a waiting change, or while a step is open', () => {
    expect(releaseDue(ledger(), 'cli', vn(11), RELEASE_RULES)).toBe(false)
    expect(releaseDue(ledger({ pending: [entry({ shippedIn: { desktop: 'v1_desktop' } })] }), 'desktop', vn(11), RELEASE_RULES)).toBe(false)
    expect(releaseDue(ledger({ pending: [entry({ components: undefined })] }), 'desktop', vn(11), RELEASE_RULES)).toBe(false)
    expect(releaseDue(ledger({ steps: { desktop: { groupId: 's', at: vn(10) } } }), 'desktop', vn(11), RELEASE_RULES)).toBe(false)
  })

  it('opens the backend at most every 120 minutes after its last verified release, never in the pause', () => {
    const backend = (lastAt?: number) => ledger({ pending: [entry({ components: ['backend'] })],
      ...lastAt === undefined ? {} : { last: { backend: { tag: 'v1.4.16_backend', sha: 'abc', at: lastAt } } } })
    expect(releaseDue(backend(), 'backend', vn(11), RELEASE_RULES)).toBe(true)
    expect(releaseDue(backend(vn(11)), 'backend', vn(11) + 119 * MINUTE, RELEASE_RULES)).toBe(false)
    expect(releaseDue(backend(vn(11)), 'backend', vn(11) + 120 * MINUTE, RELEASE_RULES)).toBe(true)
    expect(releaseDue(backend(), 'backend', vn(9, 30), RELEASE_RULES)).toBe(false)
    expect(releaseDue(backend(), 'backend', vn(10), RELEASE_RULES)).toBe(true)
  })

  it('leaves the apps to people when the pace says so', () => {
    const rules = { ...RELEASE_RULES, releasePace: { ...RELEASE_RULES.releasePace, appsAfterVisibleBatch: false } }
    expect(releaseDue(ledger(), 'desktop', vn(11), rules)).toBe(false)
  })
})

describe('nextReleaseAt', () => {
  const DAY = 24 * 60 * MINUTE
  const backendLast = (at: number): ReleaseLedger => ledger({ pending: [entry({ components: ['backend'] })], last: { backend: { tag: 'v1.4.16_backend', sha: 'abc', at } } })

  it('is 0 when a release may open now, so the read does not change with the clock', () => {
    expect(nextReleaseAt(ledger(), 'desktop', vn(11), RELEASE_RULES)).toBe(0)
    expect(nextReleaseAt(ledger(), 'backend', vn(11), RELEASE_RULES)).toBe(0)
  })

  it('is the window\'s start before it, and the next day\'s after it', () => {
    expect(nextReleaseAt(ledger(), 'desktop', vn(8, 30), RELEASE_RULES)).toBe(vn(9))
    expect(nextReleaseAt(ledger(), 'desktop', vn(18), RELEASE_RULES)).toBe(vn(9) + DAY)
    expect(nextReleaseAt(ledger(), 'cli', vn(23, 15), RELEASE_RULES)).toBe(vn(9) + DAY)
  })

  it('moves the backend out of its pause, and past its pace after its last release', () => {
    expect(nextReleaseAt(ledger(), 'backend', vn(9, 30), RELEASE_RULES)).toBe(vn(10))
    expect(nextReleaseAt(backendLast(vn(11)), 'backend', vn(11, 30), RELEASE_RULES)).toBe(vn(13))
    // 16:00 + 120 minutes is 18:00, outside the window: the next day's window opens at 09:00 into the pause, so 10:00.
    expect(nextReleaseAt(backendLast(vn(16)), 'backend', vn(16, 30), RELEASE_RULES)).toBe(vn(10) + DAY)
    // Before the window the backend waits for the pause to end too.
    expect(nextReleaseAt(ledger(), 'backend', vn(8), RELEASE_RULES)).toBe(vn(10))
  })

  it('is null for the apps when the pace leaves them to people', () => {
    const rules = { ...RELEASE_RULES, releasePace: { ...RELEASE_RULES.releasePace, appsAfterVisibleBatch: false } }
    expect(nextReleaseAt(ledger(), 'desktop', vn(11), rules)).toBeNull()
    expect(nextReleaseAt(ledger(), 'backend', vn(11), rules)).toBe(0)
  })

  it('answers on the minute', () => {
    expect(nextReleaseAt(ledger(), 'desktop', vn(8, 30) + 41_000, RELEASE_RULES)).toBe(vn(9))
  })
})

describe('shipping', () => {
  it('orders release tags by version, not by when they ran', () => {
    expect(compareTags('v1.3.78_desktop', 'v1.3.77_desktop')).toBeGreaterThan(0)
    expect(compareTags('v1.3.100_desktop', 'v1.3.99_desktop')).toBeGreaterThan(0)
    expect(compareTags('v1.4.0_desktop', 'v1.3.99_desktop')).toBeGreaterThan(0)
    expect(compareTags('v1.3.77_desktop', 'v1.3.77_desktop')).toBe(0)
    expect(compareTags('v0.5.53_cli', 'v0.5.54_cli')).toBeLessThan(0)
  })

  it('ships a task only when every release it needs carries it', () => {
    expect(shipped(entry({ components: ['backend', 'desktop'], shippedIn: { desktop: 'v1.3.78_desktop' } }))).toBe(false)
    expect(shipped(entry({ components: ['backend', 'desktop'], shippedIn: { desktop: 'v1.3.78_desktop', backend: 'v1.4.17_backend' } }))).toBe(true)
    expect(shipped(entry({ components: [] }))).toBe(true)
    expect(shipped(entry({ components: undefined }))).toBe(false)
  })

  it('lists what waits for a component', () => {
    const waiting = ledger({ pending: [entry({ groupId: 'a' }), entry({ groupId: 'b', components: ['cli'] }), entry({ groupId: 'c', shippedIn: { desktop: 't' } })] })
    expect(waitingFor(waiting, 'desktop').map(e => e.groupId)).toEqual(['a'])
  })
})

describe('notePendingRelease', () => {
  const project = () => ({ id: 'p1' }) as SwarmProject

  it('does not schedule a release for a Simple task after its project switches to Full', () => {
    const p = project(), group = { id: 'simple', process: 'simple' } as Conversation
    notePendingRelease(p, group, 'https://github.com/o/r/pull/1', vn(10))
    expect(p.releases).toBeUndefined()
    expect(group.releasing).toBeUndefined()
  })

  it('marks the task releasing, its parts not known yet', () => {
    const p = project(), group = { id: 'a' } as Conversation
    notePendingRelease(p, group, 'https://github.com/o/r/pull/1', vn(10))
    expect(group.releasing).toEqual([])
  })

  it('adds a merge once, oldest first', () => {
    const p = project()
    notePendingRelease(p, { id: 'b' }, 'https://github.com/o/r/pull/2', vn(11))
    notePendingRelease(p, { id: 'a' }, 'https://github.com/o/r/pull/1', vn(10))
    notePendingRelease(p, { id: 'a' }, 'https://github.com/o/r/pull/1', vn(10))
    expect(p.releases!.pending.map(e => e.groupId)).toEqual(['a', 'b'])
  })

  it('keeps at most PENDING_MAX, pushing out the oldest', () => {
    const p = project()
    for (let i = 0; i < PENDING_MAX; i++) notePendingRelease(p, { id: `g${i}` }, `https://github.com/o/r/pull/${i + 1}`, vn(10) + i)
    const dropped = notePendingRelease(p, { id: 'late' }, 'https://github.com/o/r/pull/999', vn(12))
    expect(dropped.map(e => e.groupId)).toEqual(['g0'])
    expect(p.releases!.pending).toHaveLength(PENDING_MAX)
    // Review of #3267: the merge's write may not hold the task it pushed out, so the next settle clears its releasing.
    expect(p.releases!.leaving).toEqual(['g0'])
  })

  it('names no task as leaving while another of its merges is still on the list', () => {
    const p = project()
    notePendingRelease(p, { id: 'g0' }, 'https://github.com/o/r/pull/1', vn(9))
    for (let i = 1; i < PENDING_MAX; i++) notePendingRelease(p, { id: i === 1 ? 'g0' : `g${i}` }, `https://github.com/o/r/pull/${i + 1}`, vn(10) + i)
    notePendingRelease(p, { id: 'late' }, 'https://github.com/o/r/pull/999', vn(12))
    expect(p.releases!.leaving).toBeUndefined()
  })
})

describe('settleReleases', () => {
  const T = vn(11)
  const agent = (id: string, roleName?: string): Agent => ({ id, name: id, contributorId: 'owner', membershipGeneration: 'g', machineId: 'mac',
    harnessId: `h-${id}`, machineOwnerId: 'owner', projectId: 'p1', ...roleName ? { roleName } : {},
    configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } } as unknown as Agent)
  const task = (number: number, over: Partial<Conversation> = {}): Conversation => ({ id: `g${number}`, projectId: 'p1', number,
    title: `Task ${number}`, leadId: 'lead', agentIds: ['lead'], archived: false, brief: 'Do it.', checks: [], assignment: null,
    lastMessageSequence: 1, ...over }) as Conversation
  function swarm(pending: PendingRelease[], { integrator = true, ...over }: Partial<ReleaseLedger> & { integrator?: boolean } = {}): SuperTabState {
    return {
      version: 1, id: 'tab', name: 'Swarm', ownerId: 'owner', environment: 'prod', paused: false, invitations: [], groupCounter: 20,
      people: [{ id: 'owner', email: 'owner@example.com', role: 'owner', generation: 'g' }] as SuperTabState['people'],
      agents: [agent('lead'), ...integrator ? [agent('ship', 'Integrator')] : [], agent('eng', 'Engineer')],
      projects: [{ id: 'p1', name: 'openharness', ownerId: 'owner', leadConversationId: 'lead-p1', visibility: 'public', members: [], updateMinutes: 5,
        releases: { pending, ...over } }],
      conversations: [{ ...task(0), id: 'lead-p1', number: undefined, title: 'Lead' } as Conversation, task(12), task(13)],
    } as SuperTabState
  }
  const ledgerOf = (state: SuperTabState) => state.projects![0]!.releases!
  const key12 = pendingKey({ groupId: 'g12', url: 'https://github.com/o/r/pull/1' })
  /** A verified Desktop release whose tag GitHub says contains the merge commits of [carries]. */
  const desktopRelease = (carries = [key12], tag = 'v1.3.78_desktop', at = T - 5 * MINUTE) => ({ tag, sha: 'd1', at, carries })
  const webRelease = { tag: 'v1.3.98_web', sha: 'w1', at: T - 5 * MINUTE, carries: [key12] }
  const noFacts = { resolved: [], releases: {} }

  it('opens no new release step after switching a project to Simple, preserving its existing ledger', () => {
    const state = swarm([entry({ groupId: 'g12' })])
    Object.assign(state.projects![0]!, { process: 'simple' })
    const outcome = settleReleases(state, 'p1', noFacts, T)
    expect(outcome.opened).toBeNull()
    expect(ledgerOf(state).pending).toHaveLength(1)
    expect(state.conversations.map(c => c.id)).toEqual(['lead-p1', 'g12', 'g13'])
  })

  it('still records a verified release for an existing step after switching to Simple', () => {
    const state = swarm([entry({ groupId: 'g12' })], { steps: { desktop: { groupId: 'step', at: T - 10 * MINUTE } } })
    state.conversations.push({ ...task(14), id: 'step' })
    Object.assign(state.projects![0]!, { process: 'simple' })
    const outcome = settleReleases(state, 'p1', { resolved: [], releases: { desktop: desktopRelease() } }, T)
    expect(outcome.shipped).toContain('g12')
    expect(outcome.opened).toBeNull()
    expect(state.conversations.some(c => c.id === 'step')).toBe(true)
  })

  it('does not reopen releases for old Simple work when the project returns to Full', () => {
    const state = swarm([entry({ groupId: 'g12' })])
    Object.assign(state.projects![0]!, { process: 'full', simpleThrough: 20 })
    expect(settleReleases(state, 'p1', noFacts, T).opened).toBeNull()
    expect(ledgerOf(state).pending).toHaveLength(1)
    state.conversations.push(task(21))
    ledgerOf(state).pending.push(entry({ groupId: 'g21', components: ['cli'] }))
    const opened = settleReleases(state, 'p1', noFacts, T).opened
    expect(opened).not.toBeNull()
    expect(state.conversations.find(c => c.id === opened)!.brief).toContain('Release CLI')
    expect(state.conversations.find(c => c.id === opened)!.brief).not.toContain('Desktop')
  })

  it('records when each component may next release, and changes nothing when that has not changed (task #3827)', () => {
    const state = swarm([entry({ groupId: 'g12', mergedAt: vn(8), components: ['desktop', 'backend'] })])
    settleReleases(state, 'p1', noFacts, vn(8, 30))
    expect(ledgerOf(state).nextAt).toEqual({ backend: vn(10), cli: vn(9), desktop: vn(9), web: vn(9) })
    const before = JSON.stringify(ledgerOf(state))
    settleReleases(state, 'p1', noFacts, vn(8, 45))
    expect(JSON.stringify(ledgerOf(state))).toBe(before)
    // Inside the window the apps may go at once: 0, and the backend after its pause.
    settleReleases(state, 'p1', noFacts, vn(9, 30))
    expect(ledgerOf(state).nextAt).toEqual({ backend: vn(10), cli: 0, desktop: 0, web: 0 })
  })

  it('marks a task released once every release it needs carries it, and takes it off the list', () => {
    const state = swarm([entry({ groupId: 'g12', mergedAt: T - 20 * MINUTE, components: ['desktop', 'web'] })])
    const group = () => state.conversations.find(c => c.id === 'g12')!
    settleReleases(state, 'p1', { resolved: [], releases: {} }, vn(20))
    // River, 11-05: while on the list a task says which parts it still waits for, for the board's "merged, releasing".
    expect(group().releasing).toEqual(['desktop', 'web'])
    const first = settleReleases(state, 'p1', { resolved: [], releases: { desktop: desktopRelease() } }, T)
    expect(first.shipped).toEqual([])
    expect(group().releasing).toEqual(['web'])
    expect(ledgerOf(state).pending[0]!.shippedIn).toEqual({ desktop: 'v1.3.78_desktop' })
    const second = settleReleases(state, 'p1', { resolved: [], releases: { desktop: desktopRelease(), web: webRelease } }, T)
    expect(second.shipped).toEqual(['g12'])
    expect(group()).not.toHaveProperty('releasing')
    expect(state.conversations.find(c => c.id === 'g12')!.released).toEqual({ at: T - 5 * MINUTE, tags: ['v1.3.78_desktop', 'v1.3.98_web'] })
    expect(ledgerOf(state).pending).toEqual([])
  })

  it('leaves a merge the tag does not contain waiting, and marks nothing without a verified release', () => {
    const state = swarm([entry({ groupId: 'g12', mergedAt: T - 5 * MINUTE, components: ['desktop'] })])
    settleReleases(state, 'p1', { resolved: [], releases: { desktop: desktopRelease([]) } }, vn(18, 30))
    settleReleases(state, 'p1', noFacts, vn(18, 30))
    expect(ledgerOf(state).pending[0]!.shippedIn).toBeUndefined()
    expect(state.conversations.find(c => c.id === 'g12')!.released).toBeUndefined()
  })

  // Task #3586: a merge compared with a release and not carried is not compared with it again; the next release that holds it ships it.
  it('marks a merge compared with a release that does not hold it, and ships it with the release that does', () => {
    const state = swarm([entry({ groupId: 'g12', mergedAt: T - 5 * MINUTE, components: ['desktop'], sha: 'm12' })])
    settleReleases(state, 'p1', { resolved: [], releases: { desktop: { ...desktopRelease([]), compared: [key12] } } }, T)
    expect(ledgerOf(state).pending[0]!.checked).toEqual({ desktop: 'v1.3.78_desktop' })
    const later = settleReleases(state, 'p1', { resolved: [], releases: { desktop: { ...desktopRelease([key12], 'v1.3.79_desktop'), compared: [key12] } } }, T + MINUTE)
    expect(later.shipped).toEqual(['g12'])
    expect(state.conversations.find(c => c.id === 'g12')!.released).toMatchObject({ tags: ['v1.3.79_desktop'] })
  })

  it('ships work that changed no released part at its merge', () => {
    const state = swarm([entry({ groupId: 'g13', url: 'https://github.com/o/r/pull/13', mergedAt: T - MINUTE, components: undefined })])
    state.conversations.find(c => c.id === 'g13')!.releasing = []
    const outcome = settleReleases(state, 'p1', { resolved: [{ groupId: 'g13', url: 'https://github.com/o/r/pull/13', components: [] }], releases: {} }, vn(20))
    expect(outcome.shipped).toEqual(['g13'])
    expect(state.conversations.find(c => c.id === 'g13')!.released).toEqual({ at: T - MINUTE, tags: [] })
    expect(state.conversations.find(c => c.id === 'g13')).not.toHaveProperty('releasing')
  })

  // Task #4410, River's ruling 11-07: a task merged while its Windows test step waited for a Windows machine owes a person's
  // Windows check, which the Windows rules ask for on the signed build: the release that ships it lists every such task.
  it('lists each task it ships whose Windows check is owed, for whoever checks Windows on the signed build', () => {
    const waiting = { step: { name: 'Test on a Windows machine', kind: 'test' as const, areas: [], where: ['The CLI on a Windows machine'], os: 'windows' as const }, pulls: [] }
    const state = swarm([entry({ groupId: 'g12', mergedAt: T - MINUTE, components: ['desktop'] }),
      entry({ groupId: 'g13', url: 'https://github.com/o/r/pull/13', mergedAt: T - MINUTE, components: ['desktop'] })])
    state.conversations.find(c => c.id === 'g12')!.waitingWindowsStep = waiting
    const opened = settleReleases(state, 'p1', noFacts, T).opened
    const step = state.conversations.find(c => c.id === opened)!
    expect(step.brief).toContain('#12 Task 12; #13 Task 13')
    expect(step.brief).toContain('Windows check owed on the signed build: #12 Task 12. No Windows machine took its test step: record it here.')
    expect(step.brief).not.toContain('owed on the signed build: #12 Task 12; #13')
  })

  it('opens one release step for the Integrator inside the window, and no second one while it is open', () => {
    const state = swarm([entry({ groupId: 'g12', mergedAt: T - MINUTE, components: ['desktop', 'web'] })])
    const outcome = settleReleases(state, 'p1', noFacts, T)
    const step = state.conversations.find(c => c.id === outcome.opened)!
    expect(step).toMatchObject({ projectId: 'p1', number: 21, title: 'Release Desktop and Web', priority: 'P1', assignment: null, archived: false })
    expect(step.agentIds).toEqual(['lead', 'ship'])
    expect(step.brief).toContain('#12 Task 12')
    // River, 11-05: the task contract (#3389) holds for the step the Swarm opens: a check, a priority, and why nobody asked.
    expect(step.checks).toEqual([expect.objectContaining({ description: expect.stringContaining('verified'), independent: false, evidence: null, passedBy: null })])
    expect(step.ledger).toEqual({ askedAt: T, noRequesterReason: 'scheduled release' })
    expect(outcome.messages[0]!.text).toContain('No requester: scheduled release')
    // The guard's own test of an agent's create, on what the Swarm wrote: nothing missing.
    expect(missingContract({ goal: step.brief, checks: step.checks.length, priority: !!step.priority,
      requester: !!(step.requesterId || step.ledger?.noRequesterReason) })).toEqual([])
    expect(ledgerOf(state).steps).toEqual({ desktop: { groupId: step.id, at: T }, web: { groupId: step.id, at: T } })
    expect(outcome.messages).toEqual([expect.objectContaining({ conversationId: step.id, recipients: ['ship'], source: { kind: 'release' } })])
    expect(settleReleases(state, 'p1', noFacts, T + 5 * MINUTE).opened).toBeNull()
  })

  it('opens no step outside the window, and the backend only at its pace', () => {
    const late = swarm([entry({ components: ['desktop'] })])
    expect(settleReleases(late, 'p1', noFacts, vn(18)).opened).toBeNull()
    const backend = swarm([entry({ components: ['backend'], mergedAt: T - MINUTE })],
      { last: { backend: { tag: 'v1.4.16_backend', sha: 'b', at: T - 60 * MINUTE } } })
    expect(settleReleases(backend, 'p1', noFacts, T).opened).toBeNull()
    expect(settleReleases(backend, 'p1', noFacts, T + 60 * MINUTE).opened).not.toBeNull()
  })

  it('says the PM assigns it when the project has no Integrator', () => {
    const state = swarm([entry({ components: ['cli'] })], { integrator: false })
    const outcome = settleReleases(state, 'p1', noFacts, T)
    expect(outcome.messages[0]).toMatchObject({ recipients: [] })
    expect(outcome.messages[0]!.text).toContain('No Integrator')
  })

  it('says in the step which verified release carried which tasks, and frees the component for the next step', () => {
    const state = swarm([entry({ groupId: 'g12', mergedAt: T - 20 * MINUTE, components: ['desktop'] })],
      { steps: { desktop: { groupId: 'g13', at: T - 15 * MINUTE } } })
    const outcome = settleReleases(state, 'p1', { resolved: [], releases: { desktop: desktopRelease() } }, T)
    expect(outcome.messages).toEqual([expect.objectContaining({ conversationId: 'g13', text: 'Verified v1.3.78_desktop: it carries #12 Task 12.' })])
    expect(ledgerOf(state).steps).toEqual({})
  })

  it('frees a step that ended without a verified release an hour after it ended, so a failed release gets a new step', () => {
    const state = swarm([entry({ groupId: 'g12', components: ['desktop'] })], { steps: { desktop: { groupId: 'g13', at: T - 30 * MINUTE } } })
    state.conversations.find(c => c.id === 'g13')!.assignment = { id: 'a', agentId: 'ship', status: 'done' } as Conversation['assignment']
    expect(settleReleases(state, 'p1', noFacts, T).opened).toBeNull()
    expect(ledgerOf(state).steps!.desktop!.endedAt).toBe(T)
    expect(settleReleases(state, 'p1', noFacts, T + 59 * MINUTE).opened).toBeNull()
    expect(settleReleases(state, 'p1', noFacts, T + 60 * MINUTE).opened).not.toBeNull()
  })

  it('keeps a resolved merge commit, and marks a task the newest tag carries once it resolves, without moving back to an older tag', () => {
    const state = swarm([entry({ groupId: 'g12', components: ['desktop'] })], { last: { desktop: { tag: 'v1.3.78_desktop', sha: 'd1', at: T - 5 * MINUTE } } })
    settleReleases(state, 'p1', { resolved: [{ groupId: 'g12', url: 'https://github.com/o/r/pull/1', sha: 'm12' }], releases: {} }, vn(20))
    expect(ledgerOf(state).pending[0]!.sha).toBe('m12')
    // The same tag, read again now that the merge commit is known: it carries the task, and announces nothing new.
    const again = settleReleases(state, 'p1', { resolved: [], releases: { desktop: desktopRelease() } }, vn(20))
    expect(again.shipped).toEqual(['g12'])
    // A re-run of an older tag's workflow is not newer: the last release stays.
    settleReleases(state, 'p1', { resolved: [], releases: { desktop: desktopRelease([], 'v1.3.77_desktop', T) } }, vn(20))
    expect(ledgerOf(state).last!.desktop!.tag).toBe('v1.3.78_desktop')
  })

  it('loads and clears the tasks the cap pushed off the list', () => {
    const state = swarm([], { leaving: ['g12'] })
    state.conversations.find(c => c.id === 'g12')!.releasing = ['desktop']
    expect(ledgerGroupIds(ledgerOf(state))).toEqual(['g12'])
    settleReleases(state, 'p1', noFacts, vn(20))
    expect(state.conversations.find(c => c.id === 'g12')).not.toHaveProperty('releasing')
    expect(ledgerOf(state)).not.toHaveProperty('leaving')
  })

  it('drops a merge no release carried in 14 days', () => {
    const state = swarm([entry({ groupId: 'g12', mergedAt: T - PENDING_MS - 1, components: ['desktop'] })])
    state.conversations.find(c => c.id === 'g12')!.releasing = ['desktop']
    expect(settleReleases(state, 'p1', noFacts, vn(20)).dropped.map(e => e.groupId)).toEqual(['g12'])
    expect(state.conversations.find(c => c.id === 'g12')).not.toHaveProperty('releasing')
    expect(ledgerOf(state).pending).toEqual([])
  })
})
