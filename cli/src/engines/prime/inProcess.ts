/**
 * Prime Agent's code the core runs in its own process, loaded only once one of its sessions needs it
 * (engines/inProcess.ts; docs/design/2026-10-08-other-engines-out-of-core.md). It re-exports, and holds no code of
 * its own.
 */
export { PrimeNormalizer, lastPrimeTurnText, primeMessagesToEvents, windowPrimeLines } from './normalizer.js'
export { PRIME_EFFORTS, PRIME_THINKING_LEVELS, parsePrimeFooterProfile, parsePrimeModelsOutput, parsePrimeThinkingSelection, primeThinkingSteps } from './runtimeProfile.js'
export { primeProvider, readPrimeHead } from '../../lib/sessionSearch/externals/prime.js'

export { createRuntimeProfileReader } from './profileReader.js'
