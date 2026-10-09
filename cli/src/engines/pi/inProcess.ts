/**
 * Pi's code the core runs in its own process, loaded only once one of Pi's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its transcripts' readers, and its runtime profile's.
 */
export { PiNormalizer, lastPiTurnText, piMessagesToEvents, windowPiLines } from './normalizer.js'
export { PI_EFFORTS, PI_THINKING_LEVELS, parsePiFooterProfile, parsePiModelsOutput, parsePiThinkingSelection, piThinkingSteps } from './runtimeProfile.js'
export { piProvider, piSessionFolder, readPiHead } from '../../lib/sessionSearch/externals/pi.js'

export { createRuntimeProfileReader } from './profileReader.js'
