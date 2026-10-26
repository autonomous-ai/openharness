/**
 * omp's code the core runs in its own process, loaded only once one of omp's sessions needs it
 * (engines/inProcess.ts). It re-exports, and holds no code of its own.
 */
export { OmpNormalizer, lastOmpTurnText, ompMessagesToEvents, windowOmpLines } from './normalizer.js'
export { createRuntimeProfileReader } from './profileReader.js'
