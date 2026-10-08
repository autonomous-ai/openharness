/**
 * OpenCode's code the core runs in its own process, loaded only once one of OpenCode's sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own: what the core calls is the engine's own, unchanged: its transcripts' readers, and its runtime profile's.
 */
export { OpencodeReader, readOpencodeMessages } from './reader.js'
export { lastOpencodeTurnText, opencodeMessagesToEvents, windowOpencodeMessages } from './normalizer.js'
export { countOpencodePickers, opencodeFooterModelId, opencodeRowMatches, opencodeRowNamesModel, parseOpencodeFooter, parseOpencodeModelsOutput, parseOpencodePickerRows } from './runtimeProfile.js'
