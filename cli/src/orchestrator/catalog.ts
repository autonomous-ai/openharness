import { isHiddenBuiltin } from '../dsh/builtins.js'
import { listInstalledDsh } from '../dsh/installed.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { supportsFirstPrompt } from '../lib/engineLaunch.js'
import type { HarnessChoice } from './prompts.js'

/** The engines an orchestrator can start a worker on; the daemon and --dry-run share it. */
export function orchestratorEngineSupported(engine: string): boolean {
  return ENGINES.includes(engine as AgentEngine) && supportsFirstPrompt(engine as AgentEngine)
}
/** Installed harnesses a task may name: agents (not viewers), not hidden, on an engine that takes a first prompt. */
export function installedHarnessCatalog(): HarnessChoice[] {
  return listInstalledDsh().filter(d => d.manifest.kind !== 'viewer' && !isHiddenBuiltin(d) && !!d.manifest.engine && supportsFirstPrompt(d.manifest.engine)).map(d => ({
    id: d.id, name: d.manifest.name, description: d.manifest.description ?? '', engine: d.manifest.engine!, viewer: !!d.manifest.viewer,
  }))
}
