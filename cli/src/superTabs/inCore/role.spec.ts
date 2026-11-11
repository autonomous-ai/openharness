import { expect, it, vi } from 'vitest'
import { swarmRoleThrough } from './role.js'

it('reads only validated role answers through the Super Tab process', async () => {
  const answers = [{ ok: true, role: 'lead' }, { ok: true, role: null }, { role: 'lead' }, { ok: true, role: 'owner' }, { error: 'SERVICE_UNAVAILABLE' }]
  const call = vi.fn(async () => answers.shift()!)
  const read = swarmRoleThrough(call)
  expect(await read('native')).toEqual({ role: 'coordinator' })
  expect(await read('native')).toBeNull()
  for (let i = 0; i < 3; i++) expect(await read('native')).toBeUndefined()
  expect(call).toHaveBeenCalledWith('super_tabs', { action: 'swarmRole', harnessId: 'native' })
})

// Project instructions, phase 4 (decision 1): the Super Tab process answers in the wire's values, which an older core reads
// too; a Reviewer's answer keeps its kind. The skill modes are gone (PM, 2026-11-11): a mode an older process sends is read
// as nothing.
it('reads the Super Tab process\'s answer as a role kind, in either value set, and no skill mode', async () => {
  const answers = [{ ok: true, role: 'review', mode: 'default' }, { ok: true, role: 'lead' }, { ok: true, role: 'dev' },
    { ok: true, role: 'coordinator' }, { ok: true, role: 'agent', mode: 'orchestration' }, { ok: true, role: 'pm' }]
  const read = swarmRoleThrough(vi.fn(async () => answers.shift()!))
  expect(await read('native')).toEqual({ role: 'agent', fallback: 'review' })
  expect(await read('native')).toEqual({ role: 'coordinator' })
  expect(await read('native')).toEqual({ role: 'agent' })
  expect(await read('native')).toEqual({ role: 'coordinator' })
  expect(await read('native')).toEqual({ role: 'agent' })
  expect(await read('native')).toBeUndefined()
})
