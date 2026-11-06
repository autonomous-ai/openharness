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
  '--settings', '--setting-sources', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file',
  '--mcp-config', '--fork-session', '--effort',
])
const CODEX_REFUSED = new Set([
  '--model', '-m', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--ask-for-approval', '-a', '--sandbox', '-s', '--profile', '-p',
])

// Codex's `-c k=v` overrides its config for one run, and the keys below are what Harness sets itself: the model, the
// provider, the sandbox and approvals, the instructions and the MCP servers. Every other key stays the owner's.
const CODEX_REFUSED_KEYS = new Set(['model', 'model_provider', 'profile', 'sandbox_mode', 'approval_policy', 'developer_instructions'])
const CODEX_REFUSED_KEY_PREFIXES = ['mcp_servers', 'model_providers']

/** The refused key a Codex `-c` override names, or null. `override` is the `k=v` part. */
function refusedCodexKey(override: string): string | null {
  const key = override.split('=')[0]!.trim()
  return CODEX_REFUSED_KEYS.has(key) || CODEX_REFUSED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) ? key : null
}

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
  const checked = checkLaunchWords(engine, args)
  return checked.ok ? { ok: true, args } : checked
}

/**
 * The rules every saved word list must meet, checked again where the words are applied: a row edited by hand, or a flag
 * a later release refuses, must not reach an engine because it was fine when saved. `parseLaunchArgs` runs the same
 * rules on what an owner just typed, so the two cannot drift.
 */
export function checkLaunchWords(engine: AgentEngine, args: readonly string[]): { ok: true } | { ok: false; detail: string } {
  if (args.length > LAUNCH_ARGS_MAX_WORDS) return { ok: false, detail: `Launch flags can be at most ${LAUNCH_ARGS_MAX_WORDS} words.` }
  if (args.some((word) => /[\0\n\r]/.test(word))) return { ok: false, detail: 'Launch flags can’t contain a new line or a NUL character.' }
  if (args.includes('--')) return { ok: false, detail: `-- is set by Harness and can't be added here.` }
  const refused = engine === 'claude' ? CLAUDE_REFUSED : engine === 'codex' ? CODEX_REFUSED : null
  if (refused) {
    // Checked after unquoting, so `"--model"` is the flag it spells.
    for (const [index, word] of args.entries()) {
      const flag = word.split('=')[0]!
      if (refused.has(flag)) return { ok: false, detail: `${flag} is set by Harness and can't be added here.` }
      // `-r<id>` is `-r <id>` to these CLIs: a single-dash word whose first letter is a refused short flag.
      if (/^-[^-]/.test(word) && refused.has(word.slice(0, 2))) return { ok: false, detail: `${word.slice(0, 2)} is set by Harness and can't be added here.` }
      if (engine === 'codex') {
        // `-c k=v`, `--config k=v`, `--config=k=v`, and `-ck=v` (or `-c=k=v`): the override is the next word, or what follows the flag.
        const override = word === '-c' || word === '--config' ? args[index + 1]
          : word.startsWith('--config=') ? word.slice('--config='.length)
          : /^-c[^-]/.test(word) ? word.slice(2).replace(/^=/, '') : undefined
        const key = override === undefined ? null : refusedCodexKey(override)
        if (key) return { ok: false, detail: `-c ${key} is set by Harness and can't be added here.` }
      }
    }
  }
  // Codex's `resume` and `fork` are subcommands, and Codex reads them after other flags too, so anywhere they would turn
  // the launch into another one.
  if (engine === 'codex') {
    const sub = args.find((word) => word === 'resume' || word === 'fork')
    if (sub) return { ok: false, detail: `${sub} is set by Harness and can't be added here.` }
  }
  return { ok: true }
}
