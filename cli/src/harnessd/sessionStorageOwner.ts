/** Required session storage reuses this core's admitted payload, never its canonical helper path. */
import { join } from 'node:path'
import { executedEntry, type ExecutedEntry } from './executedEntry.js'
import type { ExecutionArtifact } from './executionArtifacts.js'

interface StorageOwnerDeps {
  entry(): ExecutedEntry | undefined
  prepare(file: string, hash: string): Promise<ExecutionArtifact>
  configure(file: string, hash: string): void
  close(): Promise<void>
}

export async function ownSessionStorage(deps: StorageOwnerDeps): Promise<{ close(): Promise<void> }> {
  const selected = deps.entry()
  if (!selected) throw new Error('Session storage entry unavailable')
  let artifact: ExecutionArtifact | undefined
  if (selected.admitted) deps.configure(selected.file, selected.sha256)
  else {
    artifact = await deps.prepare(selected.file, selected.sha256)
    deps.configure(artifact.fullScript, artifact.fullFingerprint)
  }
  let closing: Promise<void> | undefined
  return { close() {
    return closing ??= (async () => {
      await deps.close()
      artifact?.release()
    })()
  } }
}

export async function ownProcessSessionStorage(directory: string, close: () => Promise<void>,
  configure: (file: string, hash: string) => void): Promise<{ close(): Promise<void> }> {
  const entry = executedEntry()
  // Source execution has a dedicated explicit entry; it cannot execute a copied .ts file without its source graph.
  if (entry?.file.endsWith('.ts')) return { close }
  return ownSessionStorage({
    entry: () => entry,
    prepare: async (file, hash) => {
      const { createArtifactPreparation } = await import('./executionArtifactProcess.js')
      return createArtifactPreparation({ directory: join(directory, 'lean'), node: process.execPath }).prepare(file, hash).result
    },
    configure,
    close,
  })
}
