/**
 * Hermes's code the core runs in its own process, loaded only once one of Hermes's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its transcripts' readers, and its runtime profile's.
 */
export { HermesReader, readHermesMessages } from './reader.js'
export { hermesMessagesToEvents, lastHermesTurnText, windowHermesMessages } from './normalizer.js'
export { HERMES_EFFORTS, hermesStatusModel, parseHermesConfig, parseHermesModelsCache, parseHermesPickerPage } from './runtimeProfile.js'
// The half of Hermes's homes that fills the registry's row: Hermes's own lookup, run only for Hermes.
export { hermesDbForSession } from '../../lib/hermesHome.js'
export { probeHermesHome } from './homeProbe.js'
export { hermesProvider } from '../../lib/sessionSearch/externals/hermes.js'

export { createRuntimeProfileReader } from './profileReader.js'
