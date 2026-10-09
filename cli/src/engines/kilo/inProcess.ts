/**
 * Kilo's code the core runs in its own process, loaded only once one of Kilo's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its transcripts' readers, and its runtime profile's.
 */
export { KiloReader, readKiloMessages } from './reader.js'
export { kiloMessagesToEvents, lastKiloTurnText, windowKiloMessages } from './normalizer.js'
export { kiloFooterModelId, parseKiloModelsOutput } from './runtimeProfile.js'
export { createRuntimeProfileReader } from './profileReader.js'
