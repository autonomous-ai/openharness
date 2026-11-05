import { describe, expect, it } from 'vitest'
import { backendPaused, carries, componentsOf, inReleaseWindow, isReleaseTag, RELEASE_COMPONENTS, RELEASE_RULES, releaseDue, shipped,
  waitingFor, type PendingRelease, type ReleaseLedger } from './releases.js'

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
      'backend/README.md', 'docs/plans/x.md', '.github/workflows/ci.yml', 'scripts/release-window.py'])).toEqual([])
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
      ...lastAt === undefined ? {} : { last: { backend: { tag: 'v1.4.16_backend', sha: 'abc', at: lastAt, committedAt: lastAt } } } })
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

describe('shipping', () => {
  const release = { tag: 'v1.3.78_desktop', sha: 'abc', at: vn(12), committedAt: vn(11) }

  it('carries the merges that landed on main up to its tag\'s commit', () => {
    expect(carries(release, entry({ mergedAt: vn(11) }))).toBe(true)
    expect(carries(release, entry({ mergedAt: vn(11) + 1 }))).toBe(false)
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
