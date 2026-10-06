import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { processAlive, stopSessionOwner, type SessionOwner } from '../../lib/sessionSearch/external.js'
import { createAdoption, type AdoptDeps } from './adopt.js'

vi.mock('../../lib/sessionSearch/external.js', async (real) => ({
  ...await real<object>(),
  processAlive: vi.fn(() => true),
  stopSessionOwner: vi.fn(async () => true),
}))

const folder = mkdtempSync(join(tmpdir(), 'core-adopt-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

const conversation = (over: Record<string, unknown> = {}) => ({ sessionId: 'c1', engine: 'claude', cwd: folder, title: 'Fix the build', ...over })
const owner = (over: Partial<SessionOwner> = {}): SessionOwner =>
  ({ pid: 7, engine: 'claude', tty: '/dev/ttys001', fromArgs: false, harness: false, unverified: false, ...over }) as SessionOwner

function setup(over: Partial<AdoptDeps> = {}) {
  const found = new Map<string, ReturnType<typeof conversation>>()
  let starting = true
  const deps: AdoptDeps = {
    bySession: vi.fn(() => undefined),
    byAgent: vi.fn(() => (starting ? { launch: { state: 'starting' } } : { launch: { state: 'ready' } }) as RegisteredSession),
    stoppedAgents: { list: vi.fn(() => []) },
    externalSessions: { get: vi.fn((id: string) => found.get(id) as never), scan: vi.fn(async () => []) },
    openSessions: { owner: vi.fn(async () => null), busy: vi.fn(async () => false) },
    search: null,
    ...over,
  }
  return { deps, found, adoption: createAdoption(deps), launched: () => { starting = false } }
}

describe('whether a conversation can be opened here', () => {
  it('refuses one that is already a harness, live, stopped, or under another of its names', async () => {
    const live = setup({ bySession: vi.fn((id: string) => id === 'c1' ? ({} as RegisteredSession) : undefined) })
    expect(await live.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ ok: false, error: 'SESSION_IN_HARNESS' })
    const stopped = setup({ stoppedAgents: { list: vi.fn(() => [{ sessionId: 'c1' } as RegisteredSession]) } })
    expect(await stopped.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ error: 'SESSION_IN_HARNESS' })
    const alias = setup({ bySession: vi.fn((id: string) => id === 'old-name' ? ({} as RegisteredSession) : undefined) })
    alias.found.set('c1', conversation({ aliases: ['old-name'] }))
    expect(await alias.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ error: 'SESSION_IN_HARNESS' })
  })

  it('looks again for one it has not seen, and refuses one that is gone, of another engine, or whose folder went', async () => {
    const run = setup()
    expect(await run.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ error: 'SESSION_NOT_FOUND' })
    expect(run.deps.externalSessions.scan).toHaveBeenCalled()
    run.found.set('c1', conversation({ engine: 'codex' }))
    expect(await run.adoption.adoptableSession('c1', 'claude', null)).toEqual({ ok: false, error: 'INVALID_ENGINE', detail: 'This is a codex conversation.' })
    run.found.set('c1', conversation({ cwd: join(folder, 'gone') }))
    expect(await run.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ error: 'SESSION_FOLDER_GONE' })
  })

  // Codex will not resume a conversation it archived ("session <id> is archived. Run `codex unarchive
  // <id>` to unarchive it first"). Search finds archived ones, and opening one used to start a pane that
  // only printed that error: refused before anything starts or is stopped, with how to get it back.
  it('refuses a conversation Codex archived, saying how to put it back, before asking who has it open', async () => {
    const run = setup()
    run.found.set('c1', conversation({ engine: 'codex', archived: true }))
    expect(await run.adoption.adoptableSession('c1', 'codex', 'now')).toEqual({
      ok: false, error: 'SESSION_ARCHIVED', detail: 'Codex archived this conversation. Run `codex unarchive c1` in a terminal, then open it here.',
    })
    expect(run.deps.openSessions.owner).not.toHaveBeenCalled()
  })

  it('opens one nobody has open, under its own title, or search\'s, or none', async () => {
    const run = setup({ search: { session: () => ({ title: 'From search' }) } })
    run.found.set('c1', conversation({ launchArgs: ['--model', 'opus'] }))
    expect(await run.adoption.adoptableSession('c1', 'claude', null)).toEqual({
      ok: true, cwd: folder, title: 'Fix the build', owner: null, busy: false, launchArgs: ['--model', 'opus'],
    })
    run.found.set('c1', conversation({ title: '' }))
    expect(await run.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ title: 'From search', launchArgs: [] })
    const bare = setup({ search: { session: () => undefined } })
    bare.found.set('c1', conversation({ title: '' }))
    expect(await bare.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ title: '' })
  })

  it('never takes one from Harness\'s own pane, an app, or a terminal it cannot be sure of', async () => {
    const run = setup()
    run.found.set('c1', conversation())
    const asked = async (who: SessionOwner) => {
      vi.mocked(run.deps.openSessions.owner).mockResolvedValueOnce(who)
      return run.adoption.adoptableSession('c1', 'claude', 'now')
    }
    expect(await asked(owner({ harness: true }))).toMatchObject({ error: 'SESSION_IN_HARNESS' })
    expect(await asked(owner({ fromArgs: true }))).toMatchObject({ error: 'SESSION_OPEN_ELSEWHERE', detail: expect.stringContaining('in a terminal') })
    expect(await asked(owner({ unverified: true }))).toMatchObject({ error: 'SESSION_OPEN_ELSEWHERE' })
    expect(await asked(owner({ tty: null } as Partial<SessionOwner>))).toMatchObject({ error: 'SESSION_OPEN_ELSEWHERE', detail: expect.stringContaining("Claude's app") })
  })

  it('takes one from a terminal only when asked, and says when that terminal is mid-turn', async () => {
    const run = setup()
    run.found.set('c1', conversation())
    vi.mocked(run.deps.openSessions.owner).mockResolvedValue(owner())
    expect(await run.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ error: 'SESSION_OPEN_IN_TERMINAL' })
    expect(await run.adoption.adoptableSession('c1', 'claude', 'idle')).toMatchObject({ ok: true, busy: false })
    vi.mocked(run.deps.openSessions.busy).mockResolvedValue(true)
    expect(await run.adoption.adoptableSession('c1', 'claude', null)).toMatchObject({ error: 'SESSION_BUSY_IN_TERMINAL' })
    expect(await run.adoption.adoptableSession('c1', 'claude', 'idle')).toMatchObject({ error: 'SESSION_BUSY_IN_TERMINAL' })
    expect(await run.adoption.adoptableSession('c1', 'claude', 'now')).toMatchObject({ ok: true, busy: true })
    expect(await run.adoption.adoptableSession('c1', 'claude', 'wait')).toMatchObject({ ok: true, busy: true })
  })
})

describe('who holds a conversation now', () => {
  it('is the same terminal process only on hard evidence', async () => {
    const run = setup()
    expect(await run.adoption.heldBy('c1', owner())).toBe('free')
    vi.mocked(run.deps.openSessions.owner).mockResolvedValueOnce(owner())
    expect(await run.adoption.heldBy('c1', owner())).toBe('same')
    for (const changed of [{ pid: 8 }, { tty: null }, { fromArgs: true }, { harness: true }, { unverified: true }] as Array<Partial<SessionOwner>>) {
      vi.mocked(run.deps.openSessions.owner).mockResolvedValueOnce(owner(changed))
      expect(await run.adoption.heldBy('c1', owner()), JSON.stringify(changed)).toBe('other')
    }
  })
})

describe('taking a conversation over when its turn ends', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(processAlive).mockReset().mockReturnValue(true)
    vi.mocked(stopSessionOwner).mockReset().mockResolvedValue(true)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('waits for the turn to end, then stops the terminal\'s process', async () => {
    const log = vi.mocked(console.log)
    const run = setup()
    vi.mocked(run.deps.openSessions.owner).mockResolvedValue(owner())
    vi.mocked(run.deps.openSessions.busy).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const done = run.adoption.takeOverWhenIdle('a1', owner(), 'c1')
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(stopSessionOwner).toHaveBeenCalledWith(owner())
    expect(String(log.mock.calls[0][0])).toContain('turn ended · pid 7 stopped')
    vi.mocked(stopSessionOwner).mockResolvedValueOnce(false)
    const again = run.adoption.takeOverWhenIdle('a1', owner(), 'c1')
    await vi.advanceTimersByTimeAsync(1_000)
    await again
    expect(String(log.mock.calls[1][0])).toContain('pid 7 did not stop')
  })

  it('gives up when the harness stops starting, the process is gone, or the terminal moved on', async () => {
    const log = vi.mocked(console.log)
    const run = setup()
    run.launched()
    await (async () => { const done = run.adoption.takeOverWhenIdle('a1', owner(), 'c1'); await vi.advanceTimersByTimeAsync(1_000); await done })()
    const gone = setup()
    vi.mocked(processAlive).mockReturnValueOnce(false)
    await (async () => { const done = gone.adoption.takeOverWhenIdle('a1', owner(), 'c1'); await vi.advanceTimersByTimeAsync(1_000); await done })()
    const moved = setup()
    vi.mocked(moved.deps.openSessions.owner).mockResolvedValue(owner({ pid: 8 }))
    await (async () => { const done = moved.adoption.takeOverWhenIdle('a1', owner(), 'c1'); await vi.advanceTimersByTimeAsync(1_000); await done })()
    expect(stopSessionOwner).not.toHaveBeenCalled()
    expect(String(log.mock.calls[0][0])).toContain('pid 7 moved on · left running')
  })
})
