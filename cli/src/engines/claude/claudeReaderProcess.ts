import { runEngineReader, type EngineProcessOptions } from '../worker/process.js'

export const runClaudeReader = (options: EngineProcessOptions) => runEngineReader('claude', options)
