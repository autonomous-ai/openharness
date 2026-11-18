import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutedEntry } from './executedEntry.js'

const state = vi.hoisted(() => ({ loads: 0, selected: undefined as ExecutedEntry | undefined, release: vi.fn() }))
vi.mock('./executionArtifactProcess.js', () => {
  state.loads++
  return { createArtifactPreparation: () => ({ prepare: () => ({ result: Promise.resolve({
    fullScript: '/immutable/cohort.mjs', fullFingerprint: 'b'.repeat(64), release: state.release,
  }) }) }) }
})
vi.mock('./executedEntry.js', async original => ({ ...await original<object>(), executedEntry: () => state.selected }))
afterEach(() => { vi.unstubAllEnvs() })

it('loads standalone preparation only when an unadmitted packaged entry needs it', async () => {
  vi.stubEnv('HARNESSD_SESSION_STORAGE_ENTRY', '')
  vi.stubEnv('HARNESSD_SESSION_STORAGE_HASH', '')
  const { ownProcessSessionStorage } = await import('./sessionStorageOwner.js')
  expect(state.loads).toBe(0)
  const close = vi.fn(async () => {})
  state.selected = { file: '/source/entry.ts', sha256: 'a'.repeat(64), admitted: false }
  await (await ownProcessSessionStorage('/fixture', close)).close()
  expect(state.loads).toBe(0)
  state.selected = { file: '/immutable/core.mjs', sha256: 'a'.repeat(64), admitted: true }
  await (await ownProcessSessionStorage('/fixture', close)).close()
  expect(state.loads).toBe(0)
  state.selected = { file: '/explicit/core.mjs', sha256: 'a'.repeat(64), admitted: false }
  const owner = await ownProcessSessionStorage('/fixture', close)
  expect(state.loads).toBe(1)
  expect(state.release).not.toHaveBeenCalled()
  await owner.close()
  expect(close).toHaveBeenCalledTimes(3)
  expect(state.release).toHaveBeenCalledOnce()
})
