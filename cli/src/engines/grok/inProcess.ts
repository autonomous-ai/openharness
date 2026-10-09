/**
 * Grok's code the core runs in its own process, loaded only once one of Grok's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its transcripts' readers, and its runtime profile's.
 */
export { GrokNormalizer, grokMessagesToEvents, lastGrokTurnText } from './normalizer.js'
export { parseGrokFooterProfile } from './runtimeProfile.js'
export { findGrokTranscript } from './session.js'
export { grokProvider } from '../../lib/sessionSearch/externals/grok.js'

export { createRuntimeProfileReader } from './profileReader.js'
