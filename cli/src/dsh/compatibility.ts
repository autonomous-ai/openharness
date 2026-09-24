import { PROCESS_ENGINES, type AgentEngine } from '../engines/types.js'

/** Spec-1's engine is a default, not a binding. This daemon supplies the portable runtime for
 * every process engine it integrates. Old daemons continue to use the same default field.
 * Legacy argv belongs only to that default engine; the neutral content travels to every engine.
 */
export function compatibleHarnessEngines(manifest: { kind?: string; engine?: AgentEngine }): AgentEngine[] {
  if (manifest.kind === 'viewer' || !manifest.engine || manifest.engine === 'terminal') return []
  return [manifest.engine, ...PROCESS_ENGINES.filter(engine => engine !== manifest.engine)]
}
