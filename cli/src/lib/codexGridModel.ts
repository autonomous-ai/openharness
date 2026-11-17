/**
 * The model card Codex is given for a grid model: Codex's own card for a model it does not know, with
 * tool search on.
 *
 * Codex keeps a model's MCP servers and ChatGPT apps out of each request only when the model's card
 * says it can search for tools (`supports_search_tool`). A grid model has no card, so Codex uses its
 * fallback (`codex-rs/models-manager/src/model_info.rs`, `model_info_from_slug`), where search is off,
 * and sends every app's full definition on every turn. On the harness e2e account (2026-11-13, Codex
 * 0.168.0, `Qwen/Qwen3.8-27B`) that was 1.28 MB of a 1.32 MB first request, and the engine refused it:
 * "maximum context length is 262144 tokens … at least 262145 input tokens". With this card the same
 * request was 37 KB: one `tool_search` tool, and the apps found when the model asks for them — the way
 * Codex treats its own models. The relay runs the search for a grid engine
 * (`openai_contract.portable_client_tool_search` in autonomous-grid-platform).
 *
 * Everything else is the fallback, field for field, so a grid model gets the Codex it got before. A
 * card is all or nothing — Codex reads no instructions from anywhere else for a model in a catalog —
 * so the card carries the fallback's instructions too: `cli/assets/codex/grid-model-instructions.md`,
 * the text Codex 0.168.0 sent a fallback model (its `models-manager/prompt.md` without the planning
 * section it leaves out when `update_plan` is off, which Codex does not do for a catalog model). A
 * session forked onto the grid keeps the instructions it started with; only a new one reads these.
 *
 * Handed over as `-c model_catalog_json="<file>"` from a directory the daemon owns (see
 * `GridEngineLaunch.configDir`), never the person's `~/.codex`.
 */
import { readFileSync } from 'node:fs'

declare const __CODEX_GRID_INSTRUCTIONS__: string

/** The file the card is written to in the agent's grid config directory. */
export const CODEX_GRID_CATALOG_FILE = 'model-catalog.json'

/** The fallback's window when nothing else is known (`model_info_from_slug`: 272,000). */
const FALLBACK_CONTEXT_WINDOW = 272_000

// The release bundle carries the text inside cli.js (build-bundle.mjs `define`); a dev checkout and the
// tests read the file (src/lib/ and dist/lib/ are both two levels down from cli/).
function instructions(): string {
  return typeof __CODEX_GRID_INSTRUCTIONS__ === 'string'
    ? __CODEX_GRID_INSTRUCTIONS__
    : readFileSync(new URL('../../assets/codex/grid-model-instructions.md', import.meta.url), 'utf8')
}

/** The catalog (`{"models": [card]}`) for one grid model, as JSON. */
export function codexGridModelCatalog(model: string, contextWindow?: number): string {
  const window = contextWindow ?? FALLBACK_CONTEXT_WINDOW
  const card = {
    slug: model,
    display_name: model,
    description: null,
    supported_reasoning_levels: [],
    shell_type: 'unified_exec',
    visibility: 'none',
    supported_in_api: true,
    priority: 99,
    availability_nux: null,
    upgrade: null,
    model_messages: { instructions_template: instructions() },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    supports_image_detail_original: false,
    context_window: window,
    max_context_window: window,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    // The one difference from the fallback.
    supports_search_tool: true,
  }
  return `${JSON.stringify({ models: [card] }, null, 2)}\n`
}
