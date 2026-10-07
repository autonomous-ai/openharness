/**
 * Codex's `/model` pickers as 0.145 and 0.160 draw them. Built from Codex's own code, read only, not
 * captured (no Codex was run): the insta snapshots and render code at rust-v0.145.0 and rust-v0.160.0
 * (`tui/src/chatwidget/snapshots/`, `chatwidget/model_popups.rs`, `luna_reserve_model.rs`,
 * `bottom_pane/list_selection_view.rs`). The text and layout are theirs; the styling is the one
 * `selection_style` and the dim hints give it. Each screen names the snapshot or the code it is from.
 *
 * `codex-home-0.160/models_cache.json` beside this file is the catalog 0.160 ships
 * (`codex-rs/models-manager/models.json`) in the cache file's own shape (`ModelsCacheEntry`), with each
 * model's 60 KB of instructions cut short. The rows of CODEX_0160_ALL_MODELS are its listed models.
 */

const SELECTED = '\u001b[36m'
const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'
const RESET = '\u001b[0m'

/** The composer and the conversation above a picker, as the pane holds them in its history. */
const ABOVE = [
  '\u001b[1m›\u001b[0m Write the release notes',
  '',
  '• Release notes are in NOTES.md.',
  '',
]

const picker = (lines: string[]): string => [...ABOVE, ...lines].join('\n')

/** 0.160, the account's full list: rows are the catalog's display names (snapshot `model_selection_popup`). */
export const CODEX_0160_ALL_MODELS = picker([
  `  ${BOLD}Select Model and Effort${RESET}`,
  '',
  '',
  `  1. GPT-6.1-Sol (default)  ${DIM}Latest workhorse model for coding and everyday work.${RESET}`,
  `  2. GPT-6-Astra            ${DIM}Frontier intelligence for the most demanding work.${RESET}`,
  `  3. GPT-6-Sol              ${DIM}Previous generation workhorse model.${RESET}`,
  `  4. GPT-6-Luna             ${DIM}Fast and affordable model for easier tasks.${RESET}`,
  `  5. GPT-5.6-Sol            ${DIM}Older generation workhorse model.${RESET}`,
  `  6. GPT-5.6-Terra          ${DIM}Older balanced model for straightforward work.${RESET}`,
  `  7. GPT-5.6-Luna           ${DIM}Older fast and efficient model.${RESET}`,
  `${SELECTED}› 8. GPT-5.5 (current)      Legacy coding model.${RESET}`,
  '',
  `  enter${DIM} select · ${RESET}esc${DIM} back${RESET}`,
])

/**
 * The same list after the server's answer reached the open picker with a new model first: every row
 * below it moved down one (model_popup_state.rs `refresh_open_model_picker`, which keeps the highlight
 * on the same slug, not on the same row).
 */
export const CODEX_0160_ALL_MODELS_REFRESHED = picker([
  `  ${BOLD}Select Model and Effort${RESET}`,
  '',
  '',
  `  1. GPT-6.2-Sol (default)  ${DIM}Newest workhorse model for coding and everyday work.${RESET}`,
  `  2. GPT-6.1-Sol            ${DIM}Latest workhorse model for coding and everyday work.${RESET}`,
  `  3. GPT-6-Astra            ${DIM}Frontier intelligence for the most demanding work.${RESET}`,
  `  4. GPT-6-Sol              ${DIM}Previous generation workhorse model.${RESET}`,
  `  5. GPT-6-Luna             ${DIM}Fast and affordable model for easier tasks.${RESET}`,
  `  6. GPT-5.6-Sol            ${DIM}Older generation workhorse model.${RESET}`,
  `  7. GPT-5.6-Terra          ${DIM}Older balanced model for straightforward work.${RESET}`,
  `  8. GPT-5.6-Luna           ${DIM}Older fast and efficient model.${RESET}`,
  `${SELECTED}› 9. GPT-5.5 (current)      Legacy coding model.${RESET}`,
  '',
  `  enter${DIM} select · ${RESET}esc${DIM} back${RESET}`,
])

/**
 * 0.160's quick menu over a catalog with an auto preset, and a display name with a space in it (snapshot
 * `custom_model_display_name_quick_picker`; its test gives `us.openai.gpt-5.6-luna` the name `GPT-5.6
 * Luna` and `codex-auto-fast` the name `Auto Fast`).
 */
export const CODEX_0160_QUICK_MENU = picker([
  `  ${BOLD}Select Model${RESET}`,
  `  ${DIM}Pick a quick auto mode or browse all models.${RESET}`,
  '',
  '',
  `  1. Auto Fast             ${DIM}Custom provider model${RESET}`,
  `${SELECTED}› 2. All models (current)  Choose a specific model and reasoning level (current:${RESET}`,
  `${SELECTED}                           GPT-5.6 Luna)${RESET}`,
  '',
  `  enter${DIM} select · ${RESET}esc${DIM} back${RESET}`,
])

/** Its `All models` (snapshot `custom_model_display_name_all_models`). */
export const CODEX_0160_ALL_MODELS_SPACED = picker([
  `  ${BOLD}Select Model and Effort${RESET}`,
  '',
  '',
  `${SELECTED}› 1. GPT-5.6 Luna (current)  Custom provider model${RESET}`,
  '',
  `  enter${DIM} select · ${RESET}esc${DIM} back${RESET}`,
])

/** Its reasoning picker: the title names the display name, and the default row is also the current one
 *  (snapshot `custom_model_display_name_reasoning`). */
export const CODEX_0160_REASONING_SPACED = picker([
  `  ${BOLD}Select Reasoning Level for GPT-5.6 Luna${RESET}`,
  '',
  '',
  `  1. Low                       ${DIM}Quick answers${RESET}`,
  `${SELECTED}› 2. High (default) (current)  Deeper reasoning${RESET}`,
  '',
  `  enter${DIM} default · ${RESET}s${DIM} session · ${RESET}esc${DIM} back${RESET}`,
])

/** A reasoning picker with 0.160's new `Persistent` row (snapshot `model_reasoning_selection_popup`). */
export const CODEX_0160_REASONING = picker([
  `  ${BOLD}Select Reasoning Level for GPT-5.5${RESET}`,
  '',
  '',
  `  1. Low               ${DIM}Fast responses with lighter reasoning${RESET}`,
  `  2. Medium (default)  ${DIM}Balances speed and reasoning depth for everyday tasks${RESET}`,
  `${SELECTED}› 3. High (current)    Greater reasoning depth for complex problems${RESET}`,
  `  4. Extra high        ${DIM}Extra high reasoning depth for complex problems${RESET}`,
  `  5. Persistent        ${DIM}Continue working until put to sleep${RESET}`,
  `  6. More reasoning…   ${DIM}Max and Ultra consume usage limits faster${RESET}`,
  '',
  `  enter${DIM} default · ${RESET}s${DIM} session · ${RESET}esc${DIM} back${RESET}`,
])

/** Max and Ultra, a screen of their own (snapshot `model_advanced_reasoning_selection_popup`). */
export const CODEX_0160_ADVANCED = picker([
  `  ${BOLD}Advanced Reasoning${RESET}`,
  `  \u001b[36m⚠ Consumes usage limits faster${RESET}`,
  '',
  '',
  `  1. Max              ${DIM}For difficult problems when quality matters more than${RESET}`,
  `                      ${DIM}speed · higher usage${RESET}`,
  `${SELECTED}› 2. Ultra (current)  For demanding work using multiple agents · highest usage${RESET}`,
  '',
  `  enter${DIM} apply · ${RESET}s${DIM} session · ${RESET}esc${DIM} back${RESET}`,
])

/**
 * The quick menu once a refresh brought an auto preset in, its name copied from `gpt-5.5`'s: the first
 * row is the preset, not the model (snapshot `model_picker_refreshes_auto_models`).
 */
export const CODEX_0160_QUICK_MENU_SHARED_NAME = picker([
  `  ${BOLD}Select Model${RESET}`,
  `  ${DIM}Pick a quick auto mode or browse all models.${RESET}`,
  '',
  '',
  `  1. GPT-5.5               ${DIM}Auto model${RESET}`,
  `${SELECTED}› 2. All models (current)  Choose a specific model and reasoning level (current:${RESET}`,
  `${SELECTED}                           GPT-5.5)${RESET}`,
  '',
  `  enter${DIM} select · ${RESET}esc${DIM} back${RESET}`,
])

/** Two models under one display name, one of them renamed by a refresh (snapshot
 *  `model_picker_refresh_preserves_highlight`). */
export const CODEX_0160_SHARED_NAMES = picker([
  `  ${BOLD}Select Model and Effort${RESET}`,
  '',
  '',
  `${SELECTED}› 1. Renamed model                  Older balanced model for straightforward${RESET}`,
  `${SELECTED}                                    work.${RESET}`,
  `  2. Shared display name (current)  ${DIM}Legacy coding model.${RESET}`,
  '',
  `  enter${DIM} select · ${RESET}esc${DIM} back${RESET}`,
])

/**
 * An account held to the reserve model: one row, the ordinary model's name and description standing for
 * `gpt-reserve`, always current (luna_reserve_model.rs `open_luna_reserve_model_popup`; no snapshot, its
 * header is `model_menu_header` and its footer `picker_hint_line_for_keymap`).
 */
export const CODEX_0160_RESERVE = picker([
  `  ${BOLD}Select Model${RESET}`,
  `  ${DIM}Other models return when ordinary usage is available again.${RESET}`,
  '',
  '',
  `${SELECTED}› 1. GPT-6-Luna (current)  Fast and affordable model for easier tasks.${RESET}`,
  '',
  `  enter${DIM} select · ${RESET}esc${DIM} back${RESET}`,
])

/** Its reasoning picker: titled with the ordinary model's name, applied to the reserve model. */
export const CODEX_0160_RESERVE_REASONING = picker([
  `  ${BOLD}Select Reasoning Level for GPT-6-Luna${RESET}`,
  '',
  '',
  `  1. Low               ${DIM}Fast responses with lighter reasoning${RESET}`,
  `${SELECTED}› 2. Medium (default)  Balances speed and reasoning depth for everyday tasks${RESET}`,
  `  3. High              ${DIM}Greater reasoning depth for complex problems${RESET}`,
  `  4. Extra high        ${DIM}Extra high reasoning depth for complex problems${RESET}`,
  `  5. More reasoning…   ${DIM}Max consumes usage limits faster${RESET}`,
  '',
  `  enter${DIM} default · ${RESET}s${DIM} session · ${RESET}esc${DIM} back${RESET}`,
])

/**
 * The full list in a pane 22 columns wide: the header wraps, the descriptions are hidden (the picker's
 * `HideWhenNarrow`, under 24 columns for them), and a name too long for its line wraps under where it
 * starts (snapshot `shared_menu_presentation_at_wide_and_narrow_sizes`, 40x16, for the same layout).
 */
export const CODEX_0160_ALL_MODELS_NARROW = picker([
  `  ${BOLD}Select Model and${RESET}`,
  `  ${BOLD}Effort${RESET}`,
  '',
  '',
  '  1. GPT-6.1-Sol',
  '     (default)',
  '  2. GPT-6-Astra',
  '  3. GPT-6-Sol',
  `${SELECTED}› 4. GPT-5.6 Luna${RESET}`,
  `${SELECTED}     (current)${RESET}`,
  '',
  `  enter${DIM} select · ${RESET}esc${DIM} back${RESET}`,
])

/** 0.145's full list: slugs, and a subtitle (its snapshot `model_selection_popup`). */
export const CODEX_0145_ALL_MODELS = picker([
  `  ${BOLD}Select Model and Effort${RESET}`,
  `  ${DIM}Access legacy models by running codex -m <model_name> or in your config.toml${RESET}`,
  '',
  `  1. gpt-5.6-sol (default)  ${DIM}Latest frontier agentic coding model.${RESET}`,
  `  2. gpt-5.6-terra          ${DIM}Balanced agentic coding model for everyday work.${RESET}`,
  `  3. gpt-5.6-luna           ${DIM}Fast and affordable agentic coding model.${RESET}`,
  `  4. gpt-5.5                ${DIM}Frontier model for complex coding, research, and${RESET}`,
  `                            ${DIM}real-world work.${RESET}`,
  `${SELECTED}› 5. gpt-5.2 (current)      Optimized for professional work and long-running${RESET}`,
  `${SELECTED}                            agents.${RESET}`,
  '',
  `  ${DIM}Press enter to confirm or esc to go back${RESET}`,
])

/** 0.145's reasoning picker: the title names the slug (its snapshot `model_reasoning_selection_popup`). */
export const CODEX_0145_REASONING = picker([
  `  ${BOLD}Select Reasoning Level for gpt-5.4${RESET}`,
  '',
  `  1. Low               ${DIM}Fast responses with lighter reasoning${RESET}`,
  `  2. Medium (default)  ${DIM}Balances speed and reasoning depth for everyday tasks${RESET}`,
  `${SELECTED}› 3. High (current)    Greater reasoning depth for complex problems${RESET}`,
  `  4. Extra high        ${DIM}Extra high reasoning depth for complex problems${RESET}`,
  `  5. More reasoning…   ${DIM}Max and Ultra consume usage limits faster${RESET}`,
  '',
  `  ${DIM}Press enter to confirm or esc to go back${RESET}`,
])

/** The composer back after a choice was applied. */
export const CODEX_0160_COMPOSER = [...ABOVE, `${BOLD}›${RESET} ${DIM}Ask Codex to do anything${RESET}`, '', '  gpt-6.1-sol low · /tmp/project'].join('\n')
