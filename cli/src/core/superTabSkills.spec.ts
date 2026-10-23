import { expect, it, vi } from 'vitest'
import { swarmRoleThrough } from './superTabSkills.js'

it('reads only validated role answers through the Super Tab process', async () => {
  const answers = [{ ok: true, role: 'lead' }, { ok: true, role: 'dev' }, { ok: true, role: 'review' }, { ok: true, role: null }, { role: 'lead' }, { ok: true, role: 'owner' }, { error: 'SERVICE_UNAVAILABLE' }]
  const call = vi.fn(async () => answers.shift()!)
  const read = swarmRoleThrough(call)
  expect(await read('native')).toBe('lead')
  expect(await read('native')).toBe('dev')
  expect(await read('native')).toBe('review')
  expect(await read('native')).toBeNull()
  for (let i = 0; i < 3; i++) expect(await read('native')).toBeUndefined()
  expect(call).toHaveBeenCalledWith('super_tabs', { action: 'swarmRole', harnessId: 'native' })
})
