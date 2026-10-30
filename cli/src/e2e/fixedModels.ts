/**
 * Fixed models for the real subscription round-trip leg of the matrix (per user decision).
 *
 * The grid leg picks a model from `grid_models_list`; the subscription leg (codex/claude answering
 * on its OWN login) uses a fixed, cheap alias that is enabled in the tmux launch. codex and claude
 * expose no model-list CLI, so these are explicit and tuneable in one place.
 */
import type { AgentEngine } from '../engines/types.js'

export const SUBSCRIPTION_MODEL: Partial<Record<AgentEngine, string>> = {
  codex: 'gpt-5.5',
  claude: 'claude-sonnet-5',
}
