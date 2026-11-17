/**
 * The `/` commands a chat with Codex can use, each with Codex's own line: those the phone answers with its own Model
 * sheet (`/model`, `/permissions`) and those that start a turn or a new chat, which the chat then shows. Chosen from
 * the 55 its menu lists in Codex 0.167.2 (MSI, 2026-11-17): the rest open a menu on its screen,
 * which waits for keys a chat never sends (`/resume`, `/theme`, `/review`'s presets), or print to its screen alone
 * (`/status`, `/diff`).
 *
 * Written down, unlike Claude Code's and OpenCode's lists, which are asked of the engine: Codex answers no request for
 * them (its app server lists skills, not commands), and its menu opens only by typing `/` into the agent's own pane.
 */
const ROWS: ReadonlyArray<readonly [string, string]> = [
  ['model', 'choose what model and reasoning effort to use'],
  ['permissions', 'choose what Codex is allowed to do'],
  ['init', 'create an AGENTS.md file with instructions for Codex'],
  ['compact', 'summarize conversation to prevent hitting the context limit'],
  ['recap', 'summarize the current conversation now'],
  ['goal', 'set or view the goal for a long-running task'],
  ['plan', 'switch to Plan mode'],
  ['new', 'start a new chat during a conversation'],
  ['clear', 'clear the terminal and start a new chat'],
]

export const CODEX_COMMANDS: ReadonlyArray<{ name: string; description: string; argumentHint: string }> =
  ROWS.map(([name, description]) => ({ name, description, argumentHint: '' }))
