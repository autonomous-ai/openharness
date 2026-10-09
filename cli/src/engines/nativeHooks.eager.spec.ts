import { expect, it, vi } from 'vitest'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { opencodeBin } from '../lib/engineBin.js'
import { loadEngine } from './inProcess.js'

vi.mock('node:fs', async real => ({ ...await real<object>(),
  mkdirSync: vi.fn(() => { throw new Error('directory created while importing native hooks') }),
  renameSync: vi.fn(() => { throw new Error('file replaced while importing native hooks') }),
  unlinkSync: vi.fn(() => { throw new Error('file removed while importing native hooks') }),
  writeFileSync: vi.fn(() => { throw new Error('file written while importing native hooks') }),
}))
vi.mock('../lib/engineBin.js', () => ({ opencodeBin: vi.fn(() => { throw new Error('native executable resolved during import') }) }))
vi.mock('./inProcess.js', () => ({ loadEngine: vi.fn(() => { throw new Error('optional code requested during import') }) }))

it('composes hook declarations without probing, installing or requesting optional code', async () => {
  const hooks = await import('./nativeHooks.js')
  expect(Object.keys(hooks)).toHaveLength(11)
  for (const operation of [opencodeBin, loadEngine, mkdirSync, renameSync, unlinkSync, writeFileSync]) expect(operation).not.toHaveBeenCalled()
})
