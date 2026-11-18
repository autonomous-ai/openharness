import { expect, it, vi } from 'vitest'

it('retains an immutable original execution identity across canonical argv changes', async () => {
  vi.resetModules()
  const { rememberExecutedEntry, executedEntry } = await import('./executedEntry.js')
  expect(executedEntry()).toBeUndefined()
  const original = { file: '/immutable/original.mjs', sha256: 'a'.repeat(64), admitted: true }
  rememberExecutedEntry(original)
  original.file = '/canonical/replaced.mjs'
  rememberExecutedEntry({ file: '/different/cohort.mjs', sha256: 'b'.repeat(64), admitted: true })
  expect(executedEntry()).toEqual({ file: '/immutable/original.mjs', sha256: 'a'.repeat(64), admitted: true })
  expect(Object.isFrozen(executedEntry())).toBe(true)
})
