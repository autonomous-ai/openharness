import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { ownProcessSessionStorage, ownSessionStorage } from './sessionStorageOwner.js'
import type { ExecutionArtifact } from './executionArtifacts.js'
import { createArtifactPreparation } from './executionArtifactProcess.js'
import { executedEntry } from './executedEntry.js'

vi.mock('./executionArtifactProcess.js', () => ({ createArtifactPreparation: vi.fn() }))
vi.mock('./executedEntry.js', async original => ({ ...await original<object>(), executedEntry: vi.fn() }))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

function fixture(admitted: boolean) {
  const release = vi.fn(), close = vi.fn(async () => {}), configure = vi.fn()
  const artifact = { fullScript: '/immutable/cohort.mjs', fullFingerprint: 'b'.repeat(64), release } as unknown as ExecutionArtifact
  const prepare = vi.fn(async () => artifact)
  return { release, close, configure, prepare, entry: () => ({ file: '/executed/core.mjs', sha256: 'a'.repeat(64), admitted }) }
}

describe('session storage execution ownership', () => {
  it('selects the already verified lean core in a prepared no-master cohort', async () => {
    const deps = fixture(false)
    deps.prepare.mockResolvedValue({ fullScript: '/immutable/cohort.mjs', fullFingerprint: 'b'.repeat(64),
      leanCoreScript: '/immutable/core.mjs', leanCoreFingerprint: 'c'.repeat(64), release: deps.release } as unknown as ExecutionArtifact)
    let settle!: () => void
    deps.close.mockImplementation(() => new Promise(resolve => { settle = resolve }))
    const owner = await ownSessionStorage(deps)
    expect(deps.configure).toHaveBeenCalledWith('/immutable/core.mjs', 'c'.repeat(64))
    expect(deps.release).not.toHaveBeenCalled()
    const closing = owner.close()
    expect(deps.release).not.toHaveBeenCalled()
    settle(); await closing
    expect(deps.release).toHaveBeenCalledOnce()
  })

  it.each(['leanCoreScript', 'leanCoreFingerprint'] as const)('uses the full pair only before selection when %s is absent', async absent => {
    const deps = fixture(false)
    const artifact = { fullScript: '/immutable/cohort.mjs', fullFingerprint: 'b'.repeat(64),
      leanCoreScript: '/immutable/core.mjs', leanCoreFingerprint: 'c'.repeat(64), release: deps.release }
    delete (artifact as Partial<typeof artifact>)[absent]
    deps.prepare.mockResolvedValue(artifact as unknown as ExecutionArtifact)
    const owner = await ownSessionStorage(deps)
    expect(deps.configure).toHaveBeenCalledWith('/immutable/cohort.mjs', 'b'.repeat(64))
    await owner.close()
  })

  it('reuses the admitted executed entry without selecting the mutable canonical CLI', async () => {
    const deps = fixture(true)
    const owner = await ownSessionStorage(deps)
    expect(deps.prepare).not.toHaveBeenCalled()
    expect(deps.configure).toHaveBeenCalledWith('/executed/core.mjs', 'a'.repeat(64))
    await owner.close(); await owner.close()
    expect(deps.close).toHaveBeenCalledTimes(1)
    expect(deps.release).not.toHaveBeenCalled()
  })

  it('pins the explicit initial no-master image and releases its claim only after actual child settlement', async () => {
    const deps = fixture(false)
    let settle!: () => void
    deps.close.mockImplementation(() => new Promise(resolve => { settle = resolve }))
    const owner = await ownSessionStorage(deps)
    expect(deps.prepare).toHaveBeenCalledWith('/executed/core.mjs', 'a'.repeat(64))
    expect(deps.configure).toHaveBeenCalledWith('/immutable/cohort.mjs', 'b'.repeat(64))
    const closing = owner.close()
    expect(deps.release).not.toHaveBeenCalled()
    settle(); await closing
    expect(deps.release).toHaveBeenCalledTimes(1)
  })

  it('keeps the artifact claim when child cleanup cannot confirm ownership release', async () => {
    const deps = fixture(false)
    deps.close.mockRejectedValue(new Error('cleanup-unconfirmed'))
    const owner = await ownSessionStorage(deps)
    await expect(owner.close()).rejects.toThrow('cleanup-unconfirmed')
    expect(deps.release).not.toHaveBeenCalled()
  })

  it('refuses an absent or changed initial payload without a canonical-path fallback', async () => {
    const deps = fixture(false)
    await expect(ownSessionStorage({ ...deps, entry: () => undefined })).rejects.toThrow('Session storage entry unavailable')
    deps.prepare.mockRejectedValue(new Error('worker_artifact_source_changed'))
    await expect(ownSessionStorage(deps)).rejects.toThrow('worker_artifact_source_changed')
    expect(deps.configure).not.toHaveBeenCalled()
  })

  it('keeps source execution on its explicit source graph', async () => {
    vi.mocked(executedEntry).mockReturnValue({ file: '/source/entry.ts', sha256: 'a'.repeat(64), admitted: false })
    const close = vi.fn(async () => {})
    const owner = await ownProcessSessionStorage('/fixture', close, vi.fn())
    await owner.close()
    expect(close).toHaveBeenCalledOnce()
    expect(createArtifactPreparation).not.toHaveBeenCalled()
  })

  it('configures the original admitted payload after canonical argv rewriting', async () => {
    vi.stubEnv('HARNESSD_SESSION_STORAGE_ENTRY', '')
    vi.stubEnv('HARNESSD_SESSION_STORAGE_HASH', '')
    vi.mocked(executedEntry).mockReturnValue({ file: '/immutable/core.mjs', sha256: 'c'.repeat(64), admitted: true })
    const configure = vi.fn()
    const owner = await ownProcessSessionStorage('/fixture', async () => {}, configure)
    expect(process.env.HARNESSD_SESSION_STORAGE_ENTRY).toBe('')
    expect(process.env.HARNESSD_SESSION_STORAGE_HASH).toBe('')
    expect(configure).toHaveBeenCalledWith('/immutable/core.mjs', 'c'.repeat(64))
    expect(createArtifactPreparation).not.toHaveBeenCalled()
    await owner.close()
  })

  it('uses the existing artifact preparation owner for a standalone packaged core', async () => {
    vi.stubEnv('HARNESSD_SESSION_STORAGE_ENTRY', '')
    vi.stubEnv('HARNESSD_SESSION_STORAGE_HASH', '')
    const release = vi.fn(), close = vi.fn(async () => {})
    const artifact = { fullScript: '/immutable/cohort.mjs', fullFingerprint: 'd'.repeat(64), release } as unknown as ExecutionArtifact
    const prepare = vi.fn(() => ({ result: Promise.resolve(artifact) }))
    vi.mocked(createArtifactPreparation).mockReturnValue({ prepare } as unknown as ReturnType<typeof createArtifactPreparation>)
    vi.mocked(executedEntry).mockReturnValue({ file: '/explicit/initial.mjs', sha256: 'a'.repeat(64), admitted: false })
    const configure = vi.fn()
    const owner = await ownProcessSessionStorage('/fixture', close, configure)
    expect(createArtifactPreparation).toHaveBeenCalledWith({ directory: join('/fixture', 'lean'), node: process.execPath })
    expect(prepare).toHaveBeenCalledWith('/explicit/initial.mjs', 'a'.repeat(64))
    expect(process.env.HARNESSD_SESSION_STORAGE_ENTRY).toBe('')
    expect(process.env.HARNESSD_SESSION_STORAGE_HASH).toBe('')
    expect(configure).toHaveBeenCalledWith('/immutable/cohort.mjs', 'd'.repeat(64))
    await owner.close()
    expect(close).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not infer a standalone entry from a mutable canonical path', async () => {
    vi.mocked(executedEntry).mockReturnValue(undefined)
    await expect(ownProcessSessionStorage('/fixture', async () => {}, vi.fn())).rejects.toThrow('Session storage entry unavailable')
    expect(createArtifactPreparation).not.toHaveBeenCalled()
  })
})
