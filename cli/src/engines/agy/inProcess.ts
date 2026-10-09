/**
 * agy's code the core runs in its own process, loaded only once one of agy's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its transcripts' readers, and its runtime profile's.
 */
export { AgyNormalizer, agyMessagesToEvents, lastAgyTurnText } from './normalizer.js'
export { agyPaneIdle, parseAgyFooterProfile } from './runtimeProfile.js'
export { agyConversationForPid, findAgyTranscript } from './session.js'
export { agyProvider } from '../../lib/sessionSearch/externals/agy.js'

export { createRuntimeProfileReader } from './profileReader.js'
