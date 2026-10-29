/**
 * Swarm state by parts (docs/design/2026-10-26-swarm-state-parts.md, section 7.2): the interface the store, the read API
 * and the migration share.
 */

export * from './types.js'
export { clock, createClock } from './clock.js'
export { knownKind, reassemble, split, toLegacyState } from './shape.js'

export { DORMANT_PAGE, insertParts, lastChangedAt, loadActive, loadAll, loadChanged, loadDormant, loadGroups, loadMachines, loadObserved, loadReadBase } from './load.js'
export { loadLight } from './light.js'
export { guardedWrite, PartConflict, type PartWrite } from './write.js'
