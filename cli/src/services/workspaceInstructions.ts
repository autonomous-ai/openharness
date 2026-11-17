/** Saved-API discovery and instruction writes belong to workspaces, never the session loop. */
import { isAbsolute } from 'node:path'
import { ENGINES } from '../engines/types.js'

interface Writer {
  prepare(workspace: string): Promise<void>
  write(workspace: string, engine: string): void
}

async function load(dataDir: string): Promise<Writer> {
  const [{ ApiConnectionMetadata }, { prepareApiInstructions }, { prepareInstructionWrites }] = await Promise.all([
    import('../lib/apiConnectionMetadata.js'), import('../lib/apiInstructions.js'), import('../scm/instructionWrites.js'),
  ])
  const metadata = new ApiConnectionMetadata(dataDir)
  return { prepare: prepareInstructionWrites, write: (workspace, engine) => prepareApiInstructions(metadata, workspace, engine) }
}

export function createWorkspaceInstructions(dataDir: string, stopped: () => boolean, writer: typeof load = load) {
  let active = 0
  return async (workspace: string, engine: string, closed?: AbortSignal): Promise<boolean> => {
    const current = () => !stopped() && !closed?.aborted
    if (!current()) return false
    if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.length > 4096 || /[\x00-\x1f\x7f]/.test(workspace)
      || !(ENGINES as readonly unknown[]).includes(engine)) return false
    if (engine === 'terminal') return true
    if (active >= 8) { console.warn('[workspaces] INSTRUCTIONS_BUSY'); return false }
    active++
    try {
      const files = await writer(dataDir)
      if (!current()) return false
      await files.prepare(workspace)
      if (!current()) return false
      files.write(workspace, engine)
      return true
    } catch { console.warn('[workspaces] INSTRUCTIONS_FAILED'); return false }
    // A core timeout does not settle this work. Keep its slot until all preparation really returns.
    finally { active-- }
  }
}
