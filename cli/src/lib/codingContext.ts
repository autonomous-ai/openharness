/**
 * The smallest context a coding agent can work in. Codex, Claude Code and OpenCode each open a
 * session with a system prompt and tool list of several thousand tokens and grow from there; Ollama's
 * own guides for all three put the floor at 64K, and below it a session survives a few turns and then
 * fails. Every model offered here is one this machine can give at least this much: a local model
 * (localModels.ts) and an API's (apiModels.ts) alike.
 *
 * Its own module because the API launches are the core's, and the local models the models service's,
 * which runs in a process of its own (docs/design/2026-10-06-core-boundary-next.md, step 7).
 */
export const MIN_CODING_CONTEXT = 64 * 1024
