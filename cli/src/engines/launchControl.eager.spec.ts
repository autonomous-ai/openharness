import { expect, it, vi } from 'vitest'
import { opencodeBin } from '../lib/engineBin.js'

vi.mock('../lib/engineBin.js', () => ({ opencodeBin: vi.fn(() => { throw new Error('a native command was resolved during import') }) }))
vi.mock('./inProcess.js', () => ({ loadEngine: vi.fn(() => { throw new Error('optional code was loaded during import') }) }))

it('imports native control without probing an executable, reading a store or loading interpretation', async () => {
  const control = await import('./launchControl.js')
  expect(control.parseOpencodeMajor('opencode v2.0.18')).toBe(2)
  expect(control.parseOpencodeModelId('fixture/model')).toEqual({ providerID: 'fixture', modelID: 'model' })
  expect(opencodeBin).not.toHaveBeenCalled()
  expect((await import('./inProcess.js')).loadEngine).not.toHaveBeenCalled()
})
