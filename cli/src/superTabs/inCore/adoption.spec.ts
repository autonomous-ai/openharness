import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SwarmSkillGrant } from '../../lib/swarmSkills.js'
import { createLaunchAuthority } from '../../core/agents/launchAuthority.js'
import { RETENTION_LAPSE_MS, retainContributions, retainedHarnesses } from '../retention.js'
import { createSwarmSkillAdoption } from './adoption.js'

const row = (over: Partial<RegisteredSession> = {}) => ({ agentId: 'old-session', engine: 'claude', sessionId: 'conversation',
  registeredAt: 1, cwd: '/project', runtimes: [], ...over }) as RegisteredSession

function setup(saved = row(), live: RegisteredSession | null = saved) {
  let current = true
  /** The pauses a held adoption waited, without waiting them. */
  const waits: number[] = []
  const wait = vi.fn(async (ms: number) => { waits.push(ms) })
  const log = vi.fn()
  const role = vi.fn(async (): Promise<SwarmSkillGrant | null | undefined> => ({ role: 'lead' }))
  const save = (id: string, skill: NonNullable<RegisteredSession['swarmSkill']>) => {
    if (!live || live.agentId !== id) return false
    live.swarmSkill = skill; return true
  }
  const authority = createLaunchAuthority({ byAgent: () => live ?? undefined, revision: () => 0, cancelled: () => !current })
  return { saved, role, waits, wait, log, adopt: createSwarmSkillAdoption({ role, authority, save, candidate: () => true, wait, log }),
    cancel: () => { current = false }, change: () => { if (live) live.cwd = '/replacement' }, current: () => current }
}

describe('old Swarm role adoption', () => {
  it.each(['claude', 'codex'] as const)('adopts each role for old %s sessions and persists it before launch', async engine => {
    for (const role of ['lead', 'dev', 'review'] as const) {
      const t = setup(row({ engine })); t.role.mockResolvedValue({ role })
      expect(await t.adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role, key: 'old-session' } })
      expect(t.saved.swarmSkill).toEqual({ role, key: 'old-session' })
    }
  })
  it('adopts the role with its project\'s skill mode, so the restarted session launches on that text', async () => {
    const t = setup(); t.role.mockResolvedValue({ role: 'lead', mode: 'default' })
    expect(await t.adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role: 'lead', key: 'old-session', mode: 'default' } })
    expect(t.saved.swarmSkill).toEqual({ role: 'lead', key: 'old-session', mode: 'default' })
  })
  it('carries metadata into a stopped resume without requiring a live registry row', async () => {
    const t = setup(row(), null)
    expect(await t.adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role: 'lead', key: 'old-session' } })
    expect(t.saved.swarmSkill).toBeUndefined()
  })
  it('leaves a personal or removed session untouched', async () => {
    const t = setup()
    t.role.mockResolvedValue(null)
    expect(await t.adopt(t.saved, t.current)).toEqual(t.saved)
    expect(t.saved.swarmSkill).toBeUndefined()
  })
  // Security follow-up from #2248: a Swarm session whose role cannot be read was resumed with none, so an old Buddy came back
  // without its guard. It is held instead, and comes back with its role as soon as a read answers.
  it.each(['offline', 'unregistered'] as const)('holds a Swarm session while its role is %s and adopts the Buddy role once a read answers', async unavailable => {
    const t = setup()
    for (let i = 0; i < 2; i++) {
      if (unavailable === 'offline') t.role.mockRejectedValueOnce(new Error('Offline'))
      else t.role.mockResolvedValueOnce(undefined)
    }
    t.role.mockResolvedValueOnce({ role: 'buddy' })
    expect(await t.adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role: 'buddy', key: 'old-session' } })
    expect(t.saved.swarmSkill).toEqual({ role: 'buddy', key: 'old-session' })
    expect(t.role).toHaveBeenCalledTimes(3)
    expect(t.waits).toEqual([2000, 4000])
    // Said once, not at every read.
    expect(t.log).toHaveBeenCalledOnce()
    expect(t.log.mock.calls[0]![0]).toMatch(/held/)
  })
  it('waits longer after each unanswered read, at most 30 seconds', async () => {
    const t = setup()
    for (let i = 0; i < 7; i++) t.role.mockResolvedValueOnce(undefined)
    t.role.mockResolvedValueOnce({ role: 'dev' })
    expect(await t.adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role: 'dev' } })
    expect(t.waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })
  it('resumes a held session as it is once a read says it is in no Swarm', async () => {
    const t = setup()
    t.role.mockResolvedValueOnce(undefined).mockResolvedValueOnce(null)
    expect(await t.adopt(t.saved, t.current)).toEqual(t.saved)
    expect(t.saved.swarmSkill).toBeUndefined()
  })
  it('stops holding, and reads no more, when the operation is cancelled while it waits', async () => {
    const t = setup()
    t.role.mockResolvedValue(undefined)
    t.wait.mockImplementation(async () => { t.cancel() })
    expect(await t.adopt(t.saved, t.current)).toBeNull()
    expect(t.role).toHaveBeenCalledOnce()
    expect(t.saved.swarmSkill).toBeUndefined()
  })
  it('does not adopt onto a session rebound while it was held', async () => {
    const t = setup()
    t.role.mockResolvedValueOnce(undefined)
    t.wait.mockImplementation(async () => { t.change() })
    expect(await t.adopt(t.saved, t.current)).toBeNull()
    expect(t.saved.swarmSkill).toBeUndefined()
  })
  it('does not wait for an offline backend when local membership excludes a personal session', async () => {
    const t = setup()
    t.role.mockImplementation(() => new Promise(() => {}))
    const adopt = createSwarmSkillAdoption({ role: t.role, authority: () => () => true, save: vi.fn(), candidate: () => false })
    const answer = await Promise.race([adopt(t.saved, t.current), new Promise(resolve => setTimeout(() => resolve('waiting'), 30))])
    expect(answer).toBe(t.saved)
    expect(t.role).not.toHaveBeenCalled()
  })
  it('asks the backend when the local roster record is unreadable, never taking the session for a personal one', async () => {
    const t = setup()
    const adopt = createSwarmSkillAdoption({ role: t.role, authority: () => () => true, save: vi.fn(), candidate: () => { throw new Error('Unreadable roster') }, wait: t.wait })
    t.role.mockResolvedValueOnce({ role: 'buddy' })
    expect(await adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role: 'buddy' } })
    t.role.mockResolvedValueOnce(null)
    expect(await adopt(row({ agentId: 'personal' }), t.current)).toEqual(row({ agentId: 'personal' }))
  })
  it('remembers a confirmed no-role result across restarts', async () => {
    const t = setup()
    t.role.mockResolvedValue(null)
    await t.adopt(t.saved, t.current)
    await t.adopt(t.saved, t.current)
    expect(t.role).toHaveBeenCalledTimes(1)
  })
  // Security review 2 of #2255: the local roster lapses after a week unconfirmed and leaves out a member whose only chat is
  // archived, so its "not a member" opened an old Buddy without its role. A session the Swarm started is always asked.
  describe('a session the Swarm started, which the local roster does not list', () => {
    const roots: string[] = []
    afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
    const roster = (rows: unknown[], at: number) => {
      const dir = mkdtempSync(join(tmpdir(), 'adoption-roster-')); roots.push(dir)
      retainContributions(dir, 'machine', rows, at)
      return (id: string) => retainedHarnesses(dir).has(id)
    }
    const listed = (extra: Record<string, unknown> = {}) => ({ tabId: 'tab', agent: { harnessId: 'old-session', machineId: 'machine' }, ...extra })
    it.each([
      ['a roster nobody confirmed for over a week', () => roster([listed()], Date.now() - RETENTION_LAPSE_MS - 60_000)],
      ['a roster that leaves out a member of only archived chats', () => roster([listed({ active: false })], Date.now())],
      ['no roster at all', () => () => false],
    ] as const)('is asked and held, then adopts its Buddy role, with %s', async (_case, candidate) => {
      const t = setup(row({ startedBy: 'agent' }))
      const adopt = createSwarmSkillAdoption({ role: t.role, authority: () => () => true, save: vi.fn(), candidate: candidate(), wait: t.wait, log: t.log })
      t.role.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ role: 'buddy' })
      expect(await adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role: 'buddy', key: 'old-session' } })
      expect(t.role).toHaveBeenCalledTimes(2)
    })
    it('leaves a harness another agent opened, or the person\'s own, to the local roster, unasked', async () => {
      for (const over of [{ startedBy: 'agent', parentAgentId: 'parent' }, {}] as Partial<RegisteredSession>[]) {
        const t = setup(row(over))
        const adopt = createSwarmSkillAdoption({ role: t.role, authority: () => () => true, save: vi.fn(), candidate: () => false, wait: t.wait, log: t.log })
        expect(await adopt(t.saved, t.current)).toBe(t.saved)
        expect(t.role).not.toHaveBeenCalled()
      }
    })
  })
  it('can adopt after a local roster snapshot first excludes the session', async () => {
    const t = setup()
    let present = false
    const adopt = createSwarmSkillAdoption({ role: t.role, authority: () => () => true, save: vi.fn(), candidate: () => present })
    expect(await adopt(t.saved, t.current)).toBe(t.saved)
    present = true
    expect(await adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role: 'lead' } })
    expect(t.role).toHaveBeenCalledOnce()
  })
  it('allows an unrelated live-row update while a no-role lookup runs', async () => {
    const t = setup()
    t.role.mockImplementation(async () => { t.change(); return null })
    expect(await t.adopt(t.saved, t.current)).toBe(t.saved)
    expect(t.saved.swarmSkill).toBeUndefined()
  })
  it.each([{ engine: 'opencode' }, { cwd: '' }, { guest: {} }, { swarmSkill: { role: 'dev', key: 'already-saved' } }] as Partial<RegisteredSession>[])
    ('does not consult the roster for ineligible or already-tagged sessions: %j', async over => {
      const t = setup(row(over))
      expect(await t.adopt(t.saved, t.current)).toEqual(t.saved)
      expect(t.role).not.toHaveBeenCalled()
    })
  it.each(['cancel', 'rebind'] as const)('does not adopt after %s while the roster is being read', async change => {
    const t = setup()
    t.role.mockImplementation(async () => { if (change === 'cancel') t.cancel(); else t.change(); return { role: 'lead' as const } })
    expect(await t.adopt(t.saved, t.current)).toBeNull()
    expect(t.saved.swarmSkill).toBeUndefined()
  })
  it('does not read or write for an already-cancelled operation', async () => {
    const t = setup(); t.cancel()
    expect(await t.adopt(t.saved, t.current)).toBeNull()
    expect(t.role).not.toHaveBeenCalled()
  })
})
