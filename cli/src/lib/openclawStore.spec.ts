import { afterEach, expect, it, vi } from 'vitest'
import { openclawStateDir } from './openclawStore.js'

afterEach(() => { vi.restoreAllMocks() })

it('says once that a TUI\'s open files cannot be read, by the kind of failure, never its words', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const unreadable = async (): Promise<string[]> => { throw Object.assign(new Error('lsof: /Users/someone/.openclaw-work: permission denied'), { code: 'EACCES' }) }
  expect(await openclawStateDir(4321, unreadable)).toBeNull()
  expect(await openclawStateDir(4321, unreadable)).toBeNull()
  expect(warn.mock.calls).toEqual([['[openclaw] open files of 4321 unreadable · EACCES']])
})
