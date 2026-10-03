/** Public memory contract used by the companion application. */
export { conditionsSchema } from './types.js'
export { MEMORY_RECALL_CONDITIONS_SCHEMA } from './context.js'
export type { RecallPacket, RecallRequest, MemoryAccess } from './types.js'
export type { MemoryRuntimeStatus, MemoryHostContext, MemoryHostSession } from './runtime.js'
export type { MemoryInference, MemoryInferenceRunOptions } from './learner.js'

/** The character layer can ask for context; it cannot open or mutate the database. */
export interface CompanionMemory {
  recall(agentId: string, query: string): Promise<{ text: string; status: string }>
}

export { EXPORT_DESTINATIONS, type ExportDestination } from './lessons/types.js'
