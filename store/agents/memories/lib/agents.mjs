/**
 * The agents whose memory this package can read, where each keeps it, and how it is switched on.
 *
 * Every agent learns on its own and keeps what it learned to itself: Claude Code in Markdown under
 * `~/.claude/projects/<repo>/memory/`, Codex in `~/.codex/memories/`, Grok Build in `~/.grok/memory-v2/`,
 * Hermes in `~/.hermes/memories/`. None of them shares with another agent or another machine. This file is
 * the one place that knows those locations; the readers in sources.mjs only walk what it names.
 *
 * The home folders honour the same environment variables the agents themselves read (CLAUDE_CONFIG_DIR,
 * CODEX_HOME, GROK_HOME, HERMES_HOME, PI_HOME), so a person who moved one is still read from the right
 * place, and tests point every one of them at a throwaway folder.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The display order, the tile name, and a color per agent (the viewer tints the agent's name with it). */
export const AGENTS = [
  { id: 'claude', name: 'Claude Code', color: '#d97757' },
  { id: 'codex', name: 'Codex', color: '#3fae8c' },
  { id: 'grok', name: 'Grok Build', color: '#8f9bb3' },
  { id: 'hermes', name: 'Hermes', color: '#d8a93b' },
  { id: 'openclaw', name: 'OpenClaw', color: '#e5484d' },
  { id: 'gemini', name: 'Gemini CLI', color: '#4c8bf5' },
  { id: 'windsurf', name: 'Windsurf', color: '#2bb8a6' },
  { id: 'pi', name: 'Pi', color: '#9b7bf0' },
  { id: 'opencode', name: 'OpenCode', color: '#e0913a' },
  { id: 'cursor', name: 'Cursor', color: '#9aa0a6' },
  { id: 'copilot', name: 'Copilot', color: '#7d6ee7' },
]

export const AGENT_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]))

/** Every agent home this package reads, resolved once per collection. */
export function homes(env = process.env, home = homedir()) {
  return {
    home,
    claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    codex: env.CODEX_HOME || join(home, '.codex'),
    grok: env.GROK_HOME || join(home, '.grok'),
    hermes: env.HERMES_HOME || join(home, '.hermes'),
    openclaw: env.OPENCLAW_HOME || join(home, '.openclaw'),
    gemini: env.GEMINI_HOME || join(home, '.gemini'),
    windsurf: join(home, '.codeium', 'windsurf'),
    pi: env.PI_HOME || join(home, '.pi'),
    opencode: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'),
    cursor: join(home, '.cursor'),
    copilot: join(home, '.copilot'),
    // The session index Harness keeps for search (cli/src/lib/sessionSearch): read-only here.
    harnessData: env.ADAPTER_DATA_DIR || join(home, '.harness', 'cli', 'data'),
    // Where the About You profile lives: one per person on this computer, not per workspace, so every
    // Memories workspace (and, later, every agent) reads the same file.
    memory: env.MEMORIES_HOME || join(home, '.harness', 'memory'),
  }
}

function readText(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/** `[section] key = true` in a TOML file, without a TOML parser: the agents' own configs are small and
 *  the question is one boolean. A missing file or key is `undefined`, never `false`. */
export function tomlFlag(text, section, key) {
  if (!text) return undefined
  let current = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) { current = header[1].trim(); continue }
    if (current !== section) continue
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(true|false)\b/.exec(line)
    if (pair && pair[1] === key) return pair[2] === 'true'
  }
  return undefined
}

/**
 * Whether each agent's own memory is switched on. Claude Code's is on unless turned off; Codex's and
 * Grok Build's are off unless turned on (both documented as off by default). `null` means the agent
 * keeps no memory of its own on this computer, or keeps it somewhere this package cannot read.
 */
export function memorySwitches(h, env = process.env) {
  let claude = true
  try {
    const settings = JSON.parse(readText(join(h.claude, 'settings.json')) || '{}')
    if (settings.autoMemoryEnabled === false) claude = false
  } catch { /* an unreadable settings file leaves Claude Code's default, which is on */ }
  if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') claude = false
  const codexConfig = readText(join(h.codex, 'config.toml'))
  const grokConfig = readText(join(h.grok, 'config.toml'))
  const grokEnv = env.GROK_MEMORY === '1' ? true : env.GROK_MEMORY === '0' ? false : undefined
  return {
    claude,
    codex: tomlFlag(codexConfig, 'features', 'memories') === true,
    grok: grokEnv ?? (tomlFlag(grokConfig, 'memory', 'enabled') === true || tomlFlag(grokConfig, 'memory_v2', 'enabled') === true),
    hermes: true,
    openclaw: true,
    gemini: true,
    windsurf: true,
    pi: null,
    opencode: null,
    cursor: null,
    copilot: null,
  }
}

/** One plain sentence per agent about where its memory is, for the Agents view and `mem sources`. */
export const WHERE = {
  claude: { at: 'projects/*/memory/', says: 'Learns as you work, one folder per repository.' },
  codex: { at: 'memories/', says: 'Learns in the background from idle conversations. Off unless you turn it on.' },
  grok: { at: 'memory-v2/', says: 'Learns after each turn. Off unless you turn it on.' },
  hermes: { at: 'memories/', says: 'A small profile and notes, loaded into every session.' },
  openclaw: { at: 'workspace/', says: 'A Markdown workspace with daily notes.' },
  gemini: { at: 'GEMINI.md', says: 'Saved memories are appended to your GEMINI.md.' },
  windsurf: { at: 'memories/', says: 'Saved in a binary format; only your global rules can be read.' },
  pi: { at: null, says: 'Keeps no memory of its own. Reads AGENTS.md.' },
  opencode: { at: null, says: 'Keeps no memory of its own. Reads AGENTS.md.' },
  cursor: { at: null, says: 'Removed its memories in version 2.1. Reads rules and AGENTS.md.' },
  copilot: { at: null, says: 'Keeps its memory on GitHub, per repository.' },
}
