/**
 * Swarm state by parts (docs/design/2026-10-26-swarm-state-parts.md, section 7.2): the interface the store and the read
 * API share.
 */

export * from './types.js'
export { clock, createClock } from './clock.js'
export { knownKind, reassemble, split } from './shape.js'

export { DORMANT_PAGE, insertParts, lastChangedAt, loadAccess, loadActive, loadAll, loadChanged, loadDelta, loadDormant, loadFinishedStarts, loadGroups, loadGroupUnless, loadMachineParts, loadMachines, loadNamed, loadObserved, loadReadBase, loadStartsOfAgents } from './load.js'
export type { SwarmDelta } from './load.js'
export { loadLight, loadLightGroups } from './light.js'
export { guardedWrite, PartConflict, type PartWrite } from './write.js'
export type { DeltaRows } from './load.js'
