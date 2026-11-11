import { PROCESS_ENGINES, type AgentEngine, type ProcessEngine } from '../engines/types.js'
import { HARNESS_ADAPTERS, type HarnessAdapter } from './adapters.js'

/** A harness reaches its engine through an instruction file in the workspace or a flag. An engine with neither
 *  (OpenClaw, whose agent reads its own workspace in the Gateway) would run it with none of its instructions. */
const readsHarness = (engine: ProcessEngine): boolean => {
  const adapter: HarnessAdapter = HARNESS_ADAPTERS[engine]
  return adapter.instructionFiles.length > 0 || adapter.contextArgs !== undefined
}

/** Spec-1's engine is a default, not a binding. This daemon supplies the portable runtime for
 * every process engine it integrates. Old daemons continue to use the same default field.
 * Legacy argv belongs only to that default engine; the neutral content travels to every engine.
 */
export function compatibleHarnessEngines(manifest: { kind?: string; engine?: AgentEngine }): AgentEngine[] {
  if (manifest.kind === 'viewer' || !manifest.engine || manifest.engine === 'terminal') return []
  return [manifest.engine, ...PROCESS_ENGINES.filter(engine => engine !== manifest.engine)].filter(readsHarness)
}

export function incompatibleHarnessEngine(id: string, manifest: { kind?: string; engine?: AgentEngine },
  engine: AgentEngine): string | null {
  const supported = compatibleHarnessEngines(manifest)
  if (supported.includes(engine)) return null
  return supported.length
    ? `${id} supports ${supported.join(', ')}; ${engine} is not compatible`
    : `${id} cannot run as an agent`
}

