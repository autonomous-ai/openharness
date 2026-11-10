/**
 * OpenClaw's code the core runs in its own process, loaded only once one of OpenClaw's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its live stream, its transcripts' readers, its runtime
 * profile's and session search.
 */
export { OpenclawReadError, OpenclawReader, readOpenclawEvents, readOpenclawHistory } from './reader.js'
export { OpenclawLive } from './live.js'
export { OpenclawNormalizer, lastOpenclawTurnText, openclawMessagesToEvents, windowOpenclawEvents } from './normalizer.js'
export { createRuntimeProfileReader, openclawPaneState, parseOpenclawFooter } from './runtimeProfile.js'
export { openclawProvider } from '../../lib/sessionSearch/externals/openclaw.js'
