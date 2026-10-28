import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SwarmSkillGrant } from '../../lib/swarmSkills.js'
import { createLaunchAuthority } from '../../core/agents/launchAuthority.js'
import { createSwarmSkillAdoption } from './adoption.js'

const row = (over: Partial<RegisteredSession> = {}) => ({ agentId: 'old-session', engine: 'claude', sessionId: 'conversation',
  registeredAt: 1, cwd: '/project', runtimes: [], ...over }) as RegisteredSession

function setup(saved = row(), live: RegisteredSession | null = saved) {
  let current = true
  const role = vi.fn(async (): Promise<SwarmSkillGrant | null | undefined> => ({ role: 'lead' }))
  const save = (id: string, skill: NonNullable<RegisteredSession['swarmSkill']>) => {
    if (!live || live.agentId !== id) return false
    live.swarmSkill = skill; return true
  }
  const authority = createLaunchAuthority({ byAgent: () => live ?? undefined, revision: () => 0, cancelled: () => !current })
  return { saved, role, adopt: createSwarmSkillAdoption({ role, authority, save, candidate: () => true }), cancel: () => { current = false },
    change: () => { if (live) live.cwd = '/replacement' }, current: () => current }
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
  it.each([null, 'unavailable'] as const)('leaves a personal/removed/unreadable session untouched (%s)', async role => {
    const t = setup()
    if (role === null) t.role.mockResolvedValue(null)
    else t.role.mockRejectedValue(new Error('Offline'))
    expect(await t.adopt(t.saved, t.current)).toEqual(t.saved)
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
  it('does not call the backend when the local roster record is unreadable', async () => {
    const t = setup()
    const adopt = createSwarmSkillAdoption({ role: t.role, authority: () => () => true, save: vi.fn(), candidate: () => { throw new Error('Unreadable roster') } })
    expect(await adopt(t.saved, t.current)).toBe(t.saved)
    expect(t.role).not.toHaveBeenCalled()
  })
  it('remembers a confirmed no-role result across restarts', async () => {
    const t = setup()
    t.role.mockResolvedValue(null)
    await t.adopt(t.saved, t.current)
    await t.adopt(t.saved, t.current)
    expect(t.role).toHaveBeenCalledTimes(1)
  })
  it.each(['offline', 'unregistered'] as const)('retries an %s lookup and adopts the role when available', async unavailable => {
    const t = setup()
    if (unavailable === 'offline') t.role.mockRejectedValueOnce(new Error('Offline'))
    else t.role.mockResolvedValueOnce(undefined)
    t.role.mockResolvedValueOnce({ role: 'dev' })
    expect(await t.adopt(t.saved, t.current)).toBe(t.saved)
    expect(await t.adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role: 'dev' } })
    expect(t.role).toHaveBeenCalledTimes(2)
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
