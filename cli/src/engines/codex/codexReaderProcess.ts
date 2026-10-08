import { runEngineReader, type EngineProcessOptions } from '../worker/process.js'

export const runCodexReader = (options: EngineProcessOptions) => runEngineReader('codex', options)
