/**
 * Swarm state by parts (docs/design/2026-10-26-swarm-state-parts.md, section 7.2): the interface the store, the read API
 * and the migration share.
 */

export * from './types.js'
export { clock, createClock } from './clock.js'
export { knownKind, reassemble, split, toLegacyState } from './shape.js'

export { DORMANT_PAGE, FEED_IDS, FEED_PAGE, FEED_READS, insertParts, lastChangedAt, loadAccess, loadActive, loadAll, loadChanged, loadDelta, loadDormant, loadFeed, loadFinishedStarts, loadGroups, loadGroupsByKey, loadGroupKeysByNumber, loadGroupUnless, loadMachineParts, loadMachines, loadMachineAccounts, loadNamed, loadObserved, loadReadBase, loadStartsOfAgents } from './load.js'
export type { SwarmDelta } from './load.js'
export { loadLight, loadLightGroups } from './light.js'
export { guardedWrite, PartConflict, type PartWrite } from './write.js'
export type { DeltaRows } from './load.js'
