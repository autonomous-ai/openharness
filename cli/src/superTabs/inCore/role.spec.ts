import { expect, it, vi } from 'vitest'
import { swarmRoleThrough } from './role.js'

it('reads only validated role answers, with their project\'s skill mode, through the Super Tab process', async () => {
  const answers = [{ ok: true, role: 'lead', mode: 'default' }, { ok: true, role: 'dev', mode: 'orchestration' }, { ok: true, role: 'review', mode: 'light' },
    { ok: true, role: null }, { role: 'lead' }, { ok: true, role: 'owner' }, { error: 'SERVICE_UNAVAILABLE' }]
  const call = vi.fn(async () => answers.shift()!)
  const read = swarmRoleThrough(call)
  expect(await read('native')).toEqual({ role: 'coordinator', mode: 'default' })
  expect(await read('native')).toEqual({ role: 'agent', mode: 'orchestration' })
  // An older Super Tab process sends no mode, and an unknown one is not trusted: the session launches as before modes.
  expect(await read('native')).toEqual({ role: 'agent', fallback: 'review' })
  expect(await read('native')).toBeNull()
  for (let i = 0; i < 3; i++) expect(await read('native')).toBeUndefined()
  expect(call).toHaveBeenCalledWith('super_tabs', { action: 'swarmRole', harnessId: 'native' })
})

// Project instructions, phase 4 (decision 1): the Super Tab process answers in the wire's values, which an older core reads
// too; a Reviewer's answer keeps its swarm-review file.
it('reads the Super Tab process\'s answer as a role kind, in either value set', async () => {
  const answers = [{ ok: true, role: 'review', mode: 'default' }, { ok: true, role: 'lead' }, { ok: true, role: 'dev' }, { ok: true, role: 'buddy' },
    { ok: true, role: 'coordinator' }, { ok: true, role: 'agent', mode: 'orchestration' }, { ok: true, role: 'pm' }]
  const read = swarmRoleThrough(vi.fn(async () => answers.shift()!))
  expect(await read('native')).toEqual({ role: 'agent', fallback: 'review', mode: 'default' })
  expect(await read('native')).toEqual({ role: 'coordinator' })
  expect(await read('native')).toEqual({ role: 'agent' })
  expect(await read('native')).toEqual({ role: 'buddy' })
  expect(await read('native')).toEqual({ role: 'coordinator' })
  expect(await read('native')).toEqual({ role: 'agent', mode: 'orchestration' })
  expect(await read('native')).toBeUndefined()
})
