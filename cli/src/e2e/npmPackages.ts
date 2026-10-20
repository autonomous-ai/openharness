/**
 * The npm package that ships each engine, used by the npm version source to read its `latest`
 * dist-tag. Kept separate so the real registry reader and any spec both mean the same package.
 */
import type { AgentEngine } from '../engines/types.js'

export const NPM_PACKAGE: Partial<Record<AgentEngine, string>> = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
}
