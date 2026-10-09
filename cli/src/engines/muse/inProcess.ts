/**
 * Muse's code the core runs in its own process, loaded only once one of Muse's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its transcripts' readers, and its runtime profile's.
 */
export { MuseNormalizer, lastMuseTurnText, museMessagesToEvents } from './normalizer.js'
export { parseMuseSettings } from './runtimeProfile.js'
export { museEvent, museWorkspaceRoot } from './normalizer.js'
export { museProvider } from '../../lib/sessionSearch/externals/muse.js'

export { createRuntimeProfileReader } from './profileReader.js'
