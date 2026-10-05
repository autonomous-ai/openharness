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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { env } from '../config/env.js'

const claudeHomes: string[] = []
const codexHomes: string[] = []
let loaded = false

const savedFile = (): string => join(env.ADAPTER_DATA_DIR, 'engine-homes.json')

/** The homes adopted on earlier boots, once per process, before anything asks for a root. */
function load(): void {
  if (loaded) return
  loaded = true
  try {
    const saved = JSON.parse(readFileSync(savedFile(), 'utf8')) as { claude?: unknown; codex?: unknown }
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

/** Test seam: forget every home, and read the data folder's again on next use. */
export function resetEngineHomes(): void {
  claudeHomes.length = 0
  codexHomes.length = 0
  loaded = false
}
