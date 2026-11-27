/**
 * What Claude Code itself offers a session: its `/model` list (each model's id, its name as people know it, "Opus 5.5",
 * the line under it and the efforts it takes) and its `/` commands (built in, the person's, the project's and their
 * plugins' skills, each with its line and the argument it takes).
 *
 * Asked of Claude Code, not written down here: both lists move with every release, plan and plugin, and Claude Code
 * answers an `initialize` control request in its stream-json mode without starting a turn — no API call, nothing
 * billed. The person's settings are read, so their own commands and plugins are listed, but `disableAllHooks` keeps
 * every hook out of that process (Harness's own among them: no SessionStart for a session nobody opened), and
 * `--strict-mcp-config` with no config starts none of their MCP servers (a plugin's Telegram bot polled twice, measured
 * on this Mac 2026-11-17). `--no-session-persistence` leaves no transcript.
 *
 * One answer per Claude home, folder and CLI version, kept for [CACHE_MS]; one read in flight per key. Null when Claude
 * Code could not be asked or did not answer — the caller keeps its own short list then, or shows none.
 */
import type { ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { engineBin } from '../../lib/engineBin.js'
import { sessionClaudeHome } from '../../lib/engineHomes.js'
import { oneShotParentEnv } from '../../lib/loginShellEnv.js'
import { spawnTied } from '../../lib/tied.js'
import { windowsEngineArgv } from '../../lib/windows/launch.js'
import { ownProcessGroup } from '../../lib/windows/noWindow.js'

export interface ClaudeListedModel {
  /** What `/model` takes: an alias (`opus`, `default`) or a model id (`claude-fable-5-1`). */
  value: string
  displayName: string
  description: string
  /** Empty for a model that takes no effort (Haiku). */
  efforts: string[]
}

export interface ClaudeListedCommand {
  /** What follows the `/`: `compact`, `review`, a plugin's `telegram:access`. */
  name: string
  description: string
  /** The argument it takes, as Claude Code shows it: `[instructions]`, `<model>`; empty for none. */
  argumentHint: string
}

export interface ClaudeListOptions {
  spawn?: typeof spawnTied
  timeoutMs?: number
  claudePath?: string
  now?: () => number
}

interface ClaudeLists { models: ClaudeListedModel[] | null; commands: ClaudeListedCommand[] | null }
type ListedSession = { transcriptPath?: string | null; cwd?: string | null; cliVersion?: string | null }

/** Long enough that opening the picker again never starts Claude Code again; short enough to see a new model the same day. */
const CACHE_MS = 30 * 60_000
const REQUEST_ID = 'harness-lists'
/** Claude Code 2.1.283 with a few plugins lists 74; the cap bounds what one answer carries to a phone. */
const MAX_COMMANDS = 200

const cached = new Map<string, { at: number; lists: ClaudeLists }>()
const reading = new Map<string, Promise<ClaudeLists | null>>()

export async function listClaudeModels(session: ListedSession, options: ClaudeListOptions = {}): Promise<ClaudeListedModel[] | null> {
  return (await listClaude(session, options))?.models ?? null
}

export async function listClaudeCommands(session: ListedSession, options: ClaudeListOptions = {}): Promise<ClaudeListedCommand[] | null> {
  return (await listClaude(session, options))?.commands ?? null
}

/** Test seam. */
export function resetClaudeListCache(): void {
  cached.clear()
  reading.clear()
}

function listClaude(session: ListedSession, options: ClaudeListOptions): Promise<ClaudeLists | null> {
  const home = sessionClaudeHome(session)
  // The folder is in the key: a project's own commands and skills are listed only where it is open.
  const key = `${home}\u0000${session.cwd ?? ''}\u0000${session.cliVersion ?? ''}`
  const now = options.now ?? Date.now
  const hit = cached.get(key)
  if (hit && now() - hit.at < CACHE_MS) return Promise.resolve(hit.lists)
  const running = reading.get(key)
  if (running) return running
  const read = readOnce(home, session.cwd ?? undefined, options)
    .then((lists) => {
      if (lists) cached.set(key, { at: now(), lists })
      return lists
    })
    .finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}

function readOnce(
  home: string,
  cwd: string | undefined,
  { spawn = spawnTied, timeoutMs = 15_000, claudePath = engineBin('claude') }: ClaudeListOptions,
): Promise<ClaudeLists | null> {
  return new Promise((resolve) => {
    const env = oneShotParentEnv()
    // Only a moved home is named: the default one is Claude Code's own default, and naming it would move where it
    // looks for `.claude.json` (CLAUDE_CONFIG_DIR replaces the home folder for that file too).
    if (home !== join(homedir(), '.claude')) env.CLAUDE_CONFIG_DIR = home
    let child: ChildProcess
    try {
      const argv = windowsEngineArgv('claude', [
        claudePath, '-p', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--no-session-persistence',
        '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      ], { environment: env })
      child = spawn(argv[0]!, argv.slice(1), { env, cwd, stdio: ['pipe', 'pipe', 'ignore'], ...ownProcessGroup() })
    } catch {
      resolve(null)
      return
    }
    const lines = createInterface({ input: child.stdout! })
    let done = false
    const finish = (lists: ClaudeLists | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      lines.close()
      killGroup(child)
      resolve(lists)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.on('error', () => finish(null))
    child.on('close', () => finish(null))
    child.stdin!.on('error', () => {})
    lines.on('line', (line) => {
      let message: unknown
      try { message = JSON.parse(line) } catch { return }
      const response = record(record(message)?.response)
      if (record(message)?.type !== 'control_response' || response?.request_id !== REQUEST_ID) return
      const answer = response.subtype === 'success' ? record(response.response) : null
      const lists = answer && { models: parseClaudeModelList(answer.models), commands: parseClaudeCommandList(answer.commands) }
      finish(lists && (lists.models || lists.commands) ? lists : null)
    })
    child.stdin!.write(`${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`)
  })
}

/** Claude Code's rows, kept to what a picker shows; a malformed row is dropped, a list with none left is null. */
export function parseClaudeModelList(raw: unknown): ClaudeListedModel[] | null {
  if (!Array.isArray(raw)) return null
  const models: ClaudeListedModel[] = []
  for (const row of raw) {
    const entry = record(row)
    if (!entry || entry.disabled === true) continue
    const value = text(entry.value), displayName = text(entry.displayName)
    if (!value || !displayName || !/^[A-Za-z0-9._:[\]-]+$/.test(value)) continue
    const efforts = entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels.filter((e): e is string => typeof e === 'string' && /^[a-z]{2,16}$/.test(e))
      : []
    models.push({ value, displayName, description: text(entry.description) ?? '', efforts })
  }
  return models.length ? models : null
}

/**
 * Claude Code's own commands that do nothing a chat can show: each opens a menu or a dialog on its screen, which waits
 * for keys a chat never sends (`/config`, `/resume`), or prints to its screen alone (`/context`, `/usage`). The chat's
 * `/` list leaves them out; `/model` and `/effort` stay, as the phone opens its own Model sheet for
 * them. Claude Code reports its commands and its skills alike (every row `builtin`), so what is left out is named:
 * from 2.1.283's list, and the commands earlier releases had.
 */
const SCREEN_ONLY = new Set([
  'add-dir', 'advisor', 'agents', 'auto-mode-setup', 'autocompact', 'bashes', 'color', 'config', 'context', 'cost',
  'design-consent', 'design-revoke', 'doctor', 'exit', 'export', 'extra-usage', 'fast', 'focus', 'heapdump', 'help',
  'hooks', 'ide', 'import', 'insights', 'keybindings', 'list-agents', 'login', 'logout', 'mcp', 'memory', 'output-style',
  'permissions', 'plugin', 'privacy-settings', 'quit', 'release-notes', 'reload-plugins', 'reload-skills', 'rename',
  'resume', 'rewind', 'skill-doctor', 'status', 'statusline', 'tasks', 'team-onboarding', 'terminal-setup', 'theme',
  'todos', 'upgrade', 'usage', 'usage-credits', 'vim', 'workflow-launch-exec',
])

/**
 * Claude Code's commands a chat can use, kept to what a `/` list shows: its skills, the commands that start a turn
 * (`/review`, `/init`), and those the phone answers itself (`/model`). Those that act only on its screen are left out
 * ([SCREEN_ONLY]), and so are a name a person could not type and Claude Code's internal ones (`__remote-workflow`); a
 * skill's long description is cut to its first line's start.
 */
export function parseClaudeCommandList(raw: unknown): ClaudeListedCommand[] | null {
  if (!Array.isArray(raw)) return null
  const commands: ClaudeListedCommand[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    const entry = record(row)
    const name = typeof entry?.name === 'string' ? entry.name : ''
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(name) || seen.has(name) || SCREEN_ONLY.has(name)) continue
    seen.add(name)
    commands.push({ name, description: clip(entry!.description, 160), argumentHint: clip(entry!.argumentHint, 60) })
    if (commands.length >= MAX_COMMANDS) break
  }
  return commands.length ? commands : null
}

/** The first line of [v], at most [max] characters; empty for anything else. */
function clip(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const line = v.trim().split('\n', 1)[0]!.trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 256 ? v.trim() : null)
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/** Claude Code and anything it started: its group off Windows (ownProcessGroup), the child itself on Windows. */
function killGroup(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return
  if (child.pid !== undefined && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* fall back to the child alone */ }
  }
  child.kill('SIGKILL')
}
