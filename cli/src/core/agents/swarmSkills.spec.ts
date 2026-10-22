import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLaunchAuthority } from './launchAuthority.js'
import { createSwarmSkillAdoption } from './swarmSkills.js'

const row = (over: Partial<RegisteredSession> = {}) => ({ agentId: 'old-session', engine: 'claude', sessionId: 'conversation',
  registeredAt: 1, cwd: '/project', runtimes: [], ...over }) as RegisteredSession

function setup(saved = row(), live: RegisteredSession | null = saved) {
  let current = true
  const role = vi.fn(async (): Promise<'lead' | 'dev' | null> => 'lead')
  const save = (id: string, skill: NonNullable<RegisteredSession['swarmSkill']>) => {
    if (!live || live.agentId !== id) return false
    live.swarmSkill = skill; return true
  }
  const authority = createLaunchAuthority({ byAgent: () => live ?? undefined, revision: () => 0, cancelled: () => !current })
  return { saved, role, adopt: createSwarmSkillAdoption({ role, authority, save }), cancel: () => { current = false },
    change: () => { if (live) live.cwd = '/replacement' }, current: () => current }
}

describe('old Swarm role adoption', () => {
  it.each(['claude', 'codex'] as const)('adopts each role for old %s sessions and persists it before launch', async engine => {
    for (const role of ['lead', 'dev'] as const) {
      const t = setup(row({ engine })); t.role.mockResolvedValue(role)
      expect(await t.adopt(t.saved, t.current)).toMatchObject({ swarmSkill: { role, key: 'old-session' } })
      expect(t.saved.swarmSkill).toEqual({ role, key: 'old-session' })
    }
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
  it.each([{ engine: 'opencode' }, { cwd: '' }, { guest: {} }, { swarmSkill: { role: 'dev', key: 'already-saved' } }] as Partial<RegisteredSession>[])
    ('does not consult the roster for ineligible or already-tagged sessions: %j', async over => {
      const t = setup(row(over))
      expect(await t.adopt(t.saved, t.current)).toEqual(t.saved)
      expect(t.role).not.toHaveBeenCalled()
    })
  it.each(['cancel', 'rebind'] as const)('does not adopt after %s while the roster is being read', async change => {
    const t = setup()
    t.role.mockImplementation(async () => { if (change === 'cancel') t.cancel(); else t.change(); return 'lead' })
    expect(await t.adopt(t.saved, t.current)).toBeNull()
    expect(t.saved.swarmSkill).toBeUndefined()
  })
  it('does not read or write for an already-cancelled operation', async () => {
    const t = setup(); t.cancel()
    expect(await t.adopt(t.saved, t.current)).toBeNull()
    expect(t.role).not.toHaveBeenCalled()
  })
})
