/**
 * Swarm state by parts (docs/design/2026-10-26-swarm-state-parts.md, section 7.2): the interface the store, the read API
 * and the migration share.
 */

export * from './types.js'
export { clock, createClock } from './clock.js'
export { reassemble, split, toLegacyState } from './shape.js'

export { insertParts, lastChangedAt, loadActive, loadAll, loadChanged, loadDormant } from './load.js'
export { guardedWrite, PartConflict, type PartWrite } from './write.js'
