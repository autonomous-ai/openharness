/**
 * The pane option an engine's launch wrapper sets when the engine exits and the pane falls back to
 * a shell (engineLaunch.ts, `harness_after`): the engine's exit status. Empty/absent while the
 * wrapper is still running the engine — and for the whole life of the fallback shell after that,
 * once something reads it, so `respawn` clears it before every new launch in the same pane.
 *
 * Its own file, so building a launch does not load tmux.ts, and with it the registry.
 */
export const ENGINE_EXIT_PANE_OPTION = '@harness_engine_exit'
