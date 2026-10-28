import { expect, it, vi } from 'vitest'
import { swarmRoleThrough } from './role.js'

it('reads only validated role answers, with their project\'s skill mode, through the Super Tab process', async () => {
  const answers = [{ ok: true, role: 'lead', mode: 'default' }, { ok: true, role: 'dev', mode: 'orchestration' }, { ok: true, role: 'review', mode: 'light' },
    { ok: true, role: null }, { role: 'lead' }, { ok: true, role: 'owner' }, { error: 'SERVICE_UNAVAILABLE' }]
  const call = vi.fn(async () => answers.shift()!)
  const read = swarmRoleThrough(call)
  expect(await read('native')).toEqual({ role: 'lead', mode: 'default' })
  expect(await read('native')).toEqual({ role: 'dev', mode: 'orchestration' })
  // An older Super Tab process sends no mode, and an unknown one is not trusted: the session launches as before modes.
  expect(await read('native')).toEqual({ role: 'review' })
  expect(await read('native')).toBeNull()
  for (let i = 0; i < 3; i++) expect(await read('native')).toBeUndefined()
  expect(call).toHaveBeenCalledWith('super_tabs', { action: 'swarmRole', harnessId: 'native' })
})
