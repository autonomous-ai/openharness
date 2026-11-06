import type { AgentEngine } from '../engines/types.js'

/** Extra launch flags an owner adds to a Buddy: parsed into argv words and checked, never run through a shell. */

export const LAUNCH_ARGS_MAX_CHARS = 1024
export const LAUNCH_ARGS_MAX_WORDS = 20

export type LaunchArgsResult = { ok: true; args: string[] } | { ok: false; detail: string }

// Flags Harness sets itself for an engine: the session, the model, the permission mode and the instructions. The same
// short flag means different things per engine (`-c` is Claude Code's --continue but Codex's config override, which an
// owner may want), so the sets are per engine.
const CLAUDE_REFUSED = new Set([
  '--resume', '-r', '--continue', '-c', '--model', '--permission-mode', '--dangerously-skip-permissions', '--session-id',
  '--settings', '--append-system-prompt', '--system-prompt', '--mcp-config', '--fork-session',
])
const CODEX_REFUSED = new Set([
  '--model', '-m', '--dangerously-bypass-approvals-and-sandbox', '--ask-for-approval', '-a', '--sandbox', '-s', '--profile', '-p',
])

/** POSIX word splitting without expansion: whitespace separates words, single quotes are literal, double quotes allow
 *  `\"` and `\\`, and a backslash outside quotes escapes the next character. Null when a quote or escape is left open. */
function splitWords(text: string): string[] | null {
  const words: string[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) word += text[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === '\\') {
      if (i + 1 >= text.length) return null
      word += text[++i]
      started = true
    } else if (/\s/.test(c)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += c
      started = true
    }
  }
  if (quote) return null
  if (started) words.push(word)
  return words
}

export function parseLaunchArgs(engine: AgentEngine, text: string): LaunchArgsResult {
  if (text.length > LAUNCH_ARGS_MAX_CHARS) return { ok: false, detail: `Launch flags can be at most ${LAUNCH_ARGS_MAX_CHARS} characters.` }
  if (/[\0\n\r]/.test(text)) return { ok: false, detail: 'Launch flags can’t contain a new line or a NUL character.' }
  const args = splitWords(text)
  if (!args) return { ok: false, detail: 'Launch flags have an unclosed quote or a trailing backslash.' }
  if (args.length > LAUNCH_ARGS_MAX_WORDS) return { ok: false, detail: `Launch flags can be at most ${LAUNCH_ARGS_MAX_WORDS} words.` }
  if (args.includes('--')) return { ok: false, detail: `-- is set by Harness and can't be added here.` }
  const refused = engine === 'claude' ? CLAUDE_REFUSED : engine === 'codex' ? CODEX_REFUSED : null
  if (refused) {
    // Checked after unquoting, so `"--model"` is the flag it spells.
    for (const word of args) {
      const flag = word.split('=')[0]!
      if (refused.has(flag)) return { ok: false, detail: `${flag} is set by Harness and can't be added here.` }
      // `-r<id>` is `-r <id>` to these CLIs: a single-dash word whose first letter is a refused short flag.
      if (/^-[^-]/.test(word) && refused.has(word.slice(0, 2))) return { ok: false, detail: `${word.slice(0, 2)} is set by Harness and can't be added here.` }
    }
  }
  // Codex's `resume` and `fork` are subcommands, and Codex reads them after other flags too, so anywhere they would turn
  // the launch into another one.
  if (engine === 'codex') {
    const sub = args.find((word) => word === 'resume' || word === 'fork')
    if (sub) return { ok: false, detail: `${sub} is set by Harness and can't be added here.` }
  }
  return { ok: true, args }
}
