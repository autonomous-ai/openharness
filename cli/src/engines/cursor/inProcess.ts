/**
 * Cursor's code the core runs in its own process, loaded only once one of Cursor's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged.
 */
export { CursorNormalizer, cursorMessagesToEvents, lastCursorTurnText, windowCursorLines } from './normalizer.js'
export { CursorSubagentManager, loadCursorReplayTaskLinks } from './subagent.js'
export { CursorTaskHookQueue } from './taskHookQueue.js'
export { cursorConfigDir, cursorDataDir } from './home.js'
export { CursorTranscriptDiscovery, findCursorTranscript } from './discovery.js'
export { loadCursorPendingTasks, removeCursorPendingTasks } from './pendingTasks.js'
export { cursorProvider } from '../../lib/sessionSearch/externals/cursor.js'

export { createRuntimeProfileReader } from './profileReader.js'
