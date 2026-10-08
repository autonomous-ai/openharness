/**
 * Hermes's code the core runs in its own process, loaded only once one of Hermes's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged.
 */
export { HermesReader, readHermesMessages } from './reader.js'
export { hermesMessagesToEvents, lastHermesTurnText, windowHermesMessages } from './normalizer.js'
