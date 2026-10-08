/**
 * OpenCode's code the core runs in its own process, loaded only once one of OpenCode's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged.
 */
export { OpencodeReader, readOpencodeMessages } from './reader.js'
export { lastOpencodeTurnText, opencodeMessagesToEvents, windowOpencodeMessages } from './normalizer.js'
