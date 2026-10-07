/**
 * The folders where the person's Claude Code and Codex keep their data, when the person has moved them.
 *
 * `CLAUDE_CONFIG_DIR` moves Claude Code's settings (its hooks with them), transcripts and process
 * records; `CODEX_HOME` moves Codex's hooks and rollouts. People set them in their shell profile, to
 * keep a work and a personal account apart, and every engine is launched through that shell, so the
 * engine takes them. The daemon never read the profile: the desktop app or launchd starts it. Measured
 * end to end (`e2e/enginehomes.e2e.ts`): with either one set, no agent ever bound. The engine read no
 * Harness hooks and wrote its transcript where the daemon never looked.
 *
 * So a moved home is adopted once the daemon reads its own or the login shell's environment
 * (`core/engines/hooks.ts`): the daemon's hooks are installed there as well, and a transcript beneath
 * it is the engine's own (`registry.validTranscriptPath`). The defaults stay: a session started without
 * the variable, from another terminal or before the profile set it, still lands in them.
 *
 * ⚠️ Remembered in the data folder (`engine-homes.json`), and read before the first transcript check.
 * The login shell is read after start-up begins, never waited on, and the registry checks every saved
 * agent's transcript as it loads: a home known only from this boot's shell was unknown at that check,
 * and every agent bound in it lost its binding at each restart (measured, the same test).
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { env } from '../config/env.js'
import { loginShellEnvironment } from './loginShellEnv.js'

const claudeHomes: string[] = []
const codexHomes: string[] = []
let loadedStamp = ''

const savedFile = (): string => join(env.ADAPTER_DATA_DIR, 'engine-homes.json')

/** Found by QA on a quiet machine: search starts before the core adopts its shell's homes. Read again when that process
 * replaces the small saved file, retaining in-memory homes if a write or read is unavailable. */
function load(): void {
  try {
    const file = savedFile(), stat = statSync(file)
    const stamp = `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}`
    if (stamp === loadedStamp) return
    loadedStamp = stamp
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { claude?: unknown; codex?: unknown }
    const take = (list: unknown, into: string[]): void => {
      for (const home of Array.isArray(list) ? list : []) {
        if (typeof home === 'string' && isAbsolute(home) && !into.includes(home)) into.push(home)
      }
    }
    take(saved.claude, claudeHomes)
    take(saved.codex, codexHomes)
  } catch { /* none adopted yet, or unreadable: the login shell's are adopted again once it is read */ }
}

function save(): void {
  const file = savedFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const draft = `${file}.${process.pid}.tmp`
    writeFileSync(draft, JSON.stringify({ claude: claudeHomes, codex: codexHomes }) + '\n', { mode: 0o600 })
    renameSync(draft, file)
  } catch { /* best effort: adopted again at the next start, once the login shell is read */ }
}

/** The homes an environment moved that the daemon did not already use: null where it moved none new. */
export interface MovedHomes {
  claude: string | null
  codex: string | null
}

/** Adopt the homes `environment` moves, beside the daemon's own (`defaults`), and say which are new. */
export function adoptEngineHomes(environment: NodeJS.ProcessEnv, defaults: { claudeHome: string; codexHome: string }): MovedHomes {
  load()
  const adopt = (value: string | undefined, own: string, known: string[]): string | null => {
    const dir = value?.trim()
    // A relative or `~` path is not a folder the engine resolves the same way from every directory.
    if (!dir || !isAbsolute(dir)) return null
    const home = resolve(dir)
    if (home === resolve(own) || known.includes(home)) return null
    known.push(home)
    return home
  }
  const moved = {
    claude: adopt(environment.CLAUDE_CONFIG_DIR, defaults.claudeHome, claudeHomes),
    codex: adopt(environment.CODEX_HOME, defaults.codexHome, codexHomes),
  }
  if (moved.claude || moved.codex) save()
  return moved
}

/** Every moved home known: adopted on this boot or an earlier one. */
export function movedEngineHomes(): { claude: string[]; codex: string[] } {
  load()
  return { claude: [...claudeHomes], codex: [...codexHomes] }
}

/** Every folder Claude Code's transcripts may be in: the daemon's own, then each moved home's. */
export function claudeProjectsRoots(own: string): string[] {
  load()
  return [own, ...claudeHomes.map((home) => join(home, 'projects'))]
}

/** Every Codex home whose rollouts are Codex's own: the daemon's, then each moved one. */
export function codexHomeRoots(own: string): string[] {
  load()
  return [own, ...codexHomes]
}

/**
 * The environment an engine launched now starts with, as far as its homes go. Every pane runs the engine
 * through the person's login shell, which reads their profile, so the login shell's variables outrank the
 * daemon's own; before that shell has been read (the first seconds of a start), the daemon's alone.
 */
function launchEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, ...loginShellEnvironment() }
}

/** A home an environment moves, absolute; null for none, or for one the engine would not resolve the
 *  same way from every folder (relative, `~`). */
function movedHome(value: string | undefined): string | null {
  const dir = value?.trim()
  return dir && isAbsolute(dir) ? resolve(dir) : null
}

/**
 * The Codex home an agent launched now reads its `config.toml` from: its own profile (the row's
 * `codexHome`, set on its pane as CODEX_HOME), else the CODEX_HOME the person's shell moves, else the
 * daemon's. What has to be in that config before Codex starts (its folder trust, lib/claudeTrust.ts) was
 * written to `~/.codex` alone, so an agent on its own profile, or a person who moved CODEX_HOME, got
 * Codex's trust prompt in a folder Harness had just made.
 */
export function launchCodexHome(codexHome: string | null | undefined, environment: NodeJS.ProcessEnv = launchEnvironment()): string {
  return codexHome || movedHome(environment.CODEX_HOME) || env.CODEX_HOME
}

/** Found by QA on a quiet machine: activity, close and Monitor looked at another server when the process's
 * environment was unreadable. A bound transcript identifies its adopted home even in a service
 * without the core's shell cache. An explicit profile remains authoritative. */
export function sessionCodexHome(session: { codexHome?: string | null; transcriptPath?: string | null }): string {
  if (session.codexHome) return session.codexHome
  const home = session.transcriptPath && codexHomeRoots(env.CODEX_HOME).find(root => {
    const path = relative(root, session.transcriptPath!)
    return path.startsWith(`sessions${sep}`) || path.startsWith(`archived_sessions${sep}`)
  })
  return home || launchCodexHome(null)
}

/** Found by QA on a quiet machine: Claude's picker and effort read another login's settings.
 * A known transcript keeps its home after the shell changes. Settings default to .claude, unlike
 * the folder-trust .claude.json below, which defaults to the user's home itself. */
export function sessionClaudeHome(session: { transcriptPath?: string | null }): string {
  const projects = session.transcriptPath && claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR).find(root => {
    const path = relative(root, session.transcriptPath!)
    return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  })
  return projects ? dirname(projects) : movedHome(launchEnvironment().CLAUDE_CONFIG_DIR) || dirname(env.CLAUDE_PROJECTS_DIR)
}

/**
 * The folder Claude Code keeps `.claude.json` in for an agent launched now: the CLAUDE_CONFIG_DIR the
 * person's shell sets, else the home folder. Claude Code's own rule (2.1.290:
 * `join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`); its folder trust was read and
 * written in `~/.claude.json` alone, which a moved Claude Code never reads.
 */
export function launchClaudeConfigDir(environment: NodeJS.ProcessEnv = launchEnvironment()): string {
  return movedHome(environment.CLAUDE_CONFIG_DIR) || homedir()
}

/** Test seam: forget every home, and read the data folder's again on next use. */
export function resetEngineHomes(): void {
  claudeHomes.length = 0
  codexHomes.length = 0
  loadedStamp = ''
}
