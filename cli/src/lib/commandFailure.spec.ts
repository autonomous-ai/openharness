import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dataDir = ''

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-onerror-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.ADAPTER_DATA_DIR
})

// A command's own terminal: the person who ran it reads the whole error.
it('prints the error whole', async () => {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  const { onError } = await import('./commandFailure.js')
  const said = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)
  const error = new Error('could not reach the backend')

  expect(() => onError(error)).toThrow('exit 1')

  expect(said.mock.calls).toEqual([['Failed to start adapter:', error]])
})

// As every command has failed on a trust file it cannot read: its sentence, with what to do, and where to look.
it('says a trust file that cannot be read by its sentence', async () => {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  const { onError } = await import('./commandFailure.js')
  const { StateFileUnreadable } = await import('./secureState.js')
  const said = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)

  expect(() => onError(new StateFileUnreadable('paired.json', 'not valid JSON'))).toThrow('exit 1')
  expect(() => onError(new StateFileUnreadable('group.json', 'EACCES', true))).toThrow('exit 1')

  expect(said.mock.calls).toEqual([
    ['✗ paired.json cannot be read (not valid JSON). Move it aside to start over.'], ['  harness status shows where it is'],
    ['✗ group.json could not be read (EACCES), so it was not changed.'], ['  harness status shows where it is'],
  ])
})
