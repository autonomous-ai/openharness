/**
 * Copilot's code the core runs in its own process, loaded only once one of Copilot's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged.
 */
export { CopilotNormalizer, copilotHistoryTurnOpen, copilotMessagesToEvents, lastCopilotTurnText } from './normalizer.js'
export { copilotSessionCwd, copilotSessionForPid, findCopilotTranscript } from './session.js'
export { copilotProvider } from '../../lib/sessionSearch/externals/copilot.js'

export { createRuntimeProfileReader } from './profileReader.js'
