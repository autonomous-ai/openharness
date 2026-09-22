/**
 * How each engine is asked to come back to a conversation it already had.
 *
 * Mirrors the daemon's own two tables — `LAUNCH_RESUME_FLAG` and `ENGINE_CLI_ALIASES` in
 * `cli/src/lib/engineLaunch.ts` and `engineBin.ts` — because resuming a paused harness types the same
 * command into the pane that the daemon would have built. Mirrored rather than imported: this package
 * installs on its own and cannot reach the daemon's TypeScript.
 *
 * An engine that is NOT in this table cannot be resumed with its conversation, so Harness Monitor refuses to pause
 * it at all. That refusal is the whole safety property: nothing is ever stopped that cannot be brought
 * back. `devin` is deliberately absent (the daemon omits it too — it has no resume flag), and so is
 * `terminal`, which has no conversation to resume.
 */

/** engine → the argv that resumes a session id. A leading token without a dash is a SUBCOMMAND. */
export const RESUME_ARGS = {
  claude: ['--resume'],
  codex: ['resume'],
  cursor: ['--resume'],
  opencode: ['--session'],
  kilo: ['--session'],
  pi: ['--session'],
  hermes: ['--resume'],
  commandcode: ['--resume'],
  muse: ['resume'],
  amp: ['threads', 'continue'],
  grok: ['--resume'],
  agy: ['--conversation'],
  copilot: ['--resume'],
}

/** engine → the command a person types. The first alias is the canonical one. */
export const ENGINE_BIN = {
  claude: 'claude', codex: 'codex', cursor: 'cursor-agent', opencode: 'opencode', pi: 'pi',
  hermes: 'hermes', commandcode: 'cmd', muse: 'muse', amp: 'amp', kilo: 'kilo', grok: 'grok',
  agy: 'agy', copilot: 'copilot', devin: 'devin',
}

/** A session id as the engines write them: uuid-shaped, or hex/ulid-ish. Checked because this string is
 *  about to be typed into a shell — anything with a space, a quote or a semicolon in it is refused here
 *  rather than quoted and hoped for. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/

export function canResume(engine) {
  return Boolean(RESUME_ARGS[engine] && ENGINE_BIN[engine])
}

/**
 * The one line that brings an engine back: `claude --resume <id>`, `codex resume <id>`.
 *
 * Typed into the pane's fallback shell, which is where a paused harness leaves it. The daemon watches
 * that pane, recognizes the engine, and re-adopts the row — the same path it documents for a person who
 * types the engine's name into a pane whose engine has left (`adoptEngine`). Verified end to end against
 * a real Claude Code session: the conversation, the pane and the agent id all came back.
 */
export function resumeCommand(engine, sessionId) {
  if (!canResume(engine)) throw new Error(`Harness Monitor does not know how to resume ${engine}, so it will not pause it.`)
  if (!SESSION_ID.test(String(sessionId ?? ''))) throw new Error('That session id is not one an engine wrote.')
  return [ENGINE_BIN[engine], ...RESUME_ARGS[engine], sessionId].join(' ')
}
