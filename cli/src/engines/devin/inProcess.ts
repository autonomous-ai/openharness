/**
 * Devin's code the core runs in its own process, loaded only once one of Devin's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its transcripts' readers, and its runtime profile's.
 */
export { DevinReader, readDevinMessages } from './reader.js'
export { devinMessagesToEvents, lastDevinTurnText, windowDevinMessages } from './normalizer.js'
export { DEVIN_EFFORTS, devinFooterModel, devinModelCommandResult, parseDevinModelsOutput } from './runtimeProfile.js'
export { devinProvider } from '../../lib/sessionSearch/externals/devin.js'

export { createRuntimeProfileReader } from './profileReader.js'
