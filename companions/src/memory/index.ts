/** Optional knowledge subsystem. The caller owns its explicit start/pause/close lifecycle. */
export * from './api.js'
export { CodingMemoryRuntime } from './runtime.js'
export { MemoryClient } from './client.js'
export { MemoryControl } from './control.js'
export { MemoryExperimentSettings } from './experiment.js'
export type { MemoryPort, Operation, Arguments, Result } from './operations.js'
