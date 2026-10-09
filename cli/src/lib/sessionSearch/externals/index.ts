/**
 * Every engine's discovery, pointed at where that engine keeps its conversations on this machine.
 * Each path follows the engine's own rules (its env overrides first), not Harness's defaults alone.
 *
 * Claude Code's and Codex's are declared and built here. The other engines' readers are their own code, loaded in
 * this process on the first scan or question that needs them (engines/inProcess.ts;
 * docs/design/2026-10-08-other-engines-out-of-core.md, (o5)).
 */

import { isAbsolute, join } from 'node:path'

import { cursorConfigDir, cursorDataDir } from '../../../engines/cursor/contract.js'
import { env } from '../../../config/env.js'
import { adoptionProviderOf } from '../../../engines/adoptions.js'
import { loadEngine, type InProcessModules, type OtherEngine } from '../../../engines/inProcess.js'
import { claudeProjectsRoots, codexHomeRoots } from '../../engineHomes.js'
import type { ExternalEngine, ExternalProvider } from './types.js'
import { externalReadFailed } from '../evidence.js'

export interface ExternalPaths {
  claudeProjectsDir: string
  codexHome: string
  /** Cursor keeps chats under its config folder and transcripts under its data folder: two roots. */
  cursorConfigDir: string
  cursorDataDir: string
  grokHome: string
  copilotHome: string
  opencodeDb: string
  kiloDb: string
  hermesRoot: string
  devinHome: string
  piAgentDir: string
  /** Pi's moved sessions folder (`PI_CODING_AGENT_SESSION_DIR`), when set. */
  piSessionDir?: string
  commandcodeHome: string
  museHome: string
  agyHome: string
}

/** An engine's database file: its own override (absolute, or relative to its data folder), else the default. */
function databasePath(override: string | undefined, dataDir: string, file: string): string {
  if (!override || override === ':memory:') return join(dataDir, file)
  return isAbsolute(override) ? override : join(dataDir, override)
}

/** Where each engine keeps its conversations, from this process's environment. */
export function externalPaths(vars: NodeJS.ProcessEnv = process.env): ExternalPaths {
  return {
    claudeProjectsDir: env.CLAUDE_PROJECTS_DIR,
    codexHome: env.CODEX_HOME,
    // Cursor ignores these when blank, as it ignores them unset.
    cursorConfigDir: cursorConfigDir(vars),
    cursorDataDir: cursorDataDir(vars),
    grokHome: env.GROK_HOME,
    copilotHome: env.COPILOT_HOME,
    opencodeDb: databasePath(vars.OPENCODE_DB, env.OPENCODE_DATA_DIR, 'opencode.db'),
    kiloDb: databasePath(vars.KILO_DB, env.KILO_DATA_DIR, 'kilo.db'),
    hermesRoot: env.HERMES_HOME,
    devinHome: env.DEVIN_HOME,
    piAgentDir: vars.PI_CODING_AGENT_DIR || join(env.PI_HOME, 'agent'),
    ...(vars.PI_CODING_AGENT_SESSION_DIR ? { piSessionDir: vars.PI_CODING_AGENT_SESSION_DIR } : {}),
    commandcodeHome: env.COMMANDCODE_HOME,
    museHome: env.MUSE_HOME,
    agyHome: env.AGY_HOME,
  }
}

/**
 * An engine's reader, built from its own code the first time a scan or a question needs it, then kept: what it
 * remembers between scans (the files it read, which session is where) stays its own. An engine whose code could not
 * be loaded, or whose reader could not be built from it, lists nothing and holds nothing open, as an engine with no
 * store does. Either failure is logged once (the loader logs the first), and never tried again: a rejection kept
 * for good would fail every scan of that engine instead.
 */
function loaded<Name extends OtherEngine>(engine: ExternalEngine, name: Name, build: (code: InProcessModules[Name]) => ExternalProvider): ExternalProvider {
  let provider: Promise<ExternalProvider | null> | null = null
  const reader = async (): Promise<ExternalProvider | null> => {
    const found = await (provider ??= loadEngine(name).then((code) => {
      if (!code) return null
      try {
        return build(code)
      } catch (error) {
        console.error(`[engine ${name}] adoption reader unavailable · ${error instanceof Error ? error.message : error}`)
        return null
      }
    }))
    if (!found) externalReadFailed(new Error('engine reader unavailable'), 'engine reader')
    return found
  }
  return {
    engine,
    scan: async (ctx) => await (await reader())?.scan(ctx) ?? [],
    owners: async (view) => await (await reader())?.owners?.(view) ?? [],
    // No answer reads as none, as for an engine whose store cannot say (external.ts `OpenSessions.busy`).
    busy: async (owner) => await (await reader())?.busy?.(owner) ?? null,
  }
}

/** One provider per engine that keeps its conversations on this machine's disk. */
export function externalProviders(paths: ExternalPaths = externalPaths()): ExternalProvider[] {
  return [
    // QA found search's separate process started before the core adopted the shell's homes.
    // Resolve roots on each scan, retaining the default and previously adopted conversations.
    // Claude Code's and Codex's are declared (engines/adoptions.ts): Claude Code's listed from each sessions
    // folder, its process records beside each; Codex's from each home.
    adoptionProviderOf('claude', { roots: () => claudeProjectsRoots(paths.claudeProjectsDir) }),
    adoptionProviderOf('codex', { roots: () => codexHomeRoots(paths.codexHome) }),
    loaded('cursor', 'cursor', (code) => code.cursorProvider({ configDir: paths.cursorConfigDir, dataDir: paths.cursorDataDir })),
    loaded('grok', 'grok', (code) => code.grokProvider({ home: paths.grokHome })),
    loaded('copilot', 'copilot', (code) => code.copilotProvider({ home: paths.copilotHome })),
    loaded('opencode', 'opencode', (code) => code.opencodeProvider({ engine: 'opencode', dbPath: paths.opencodeDb })),
    // These stores share a reader. Loading it must not make Kilo's runtime entry depend on OpenCode.
    loaded('kilo', 'opencode', (code) => code.opencodeProvider({ engine: 'kilo', dbPath: paths.kiloDb })),
    loaded('hermes', 'hermes', (code) => code.hermesProvider({ root: paths.hermesRoot })),
    loaded('devin', 'devin', (code) => code.devinProvider({ home: paths.devinHome })),
    loaded('pi', 'pi', (code) => code.piProvider({ agentDir: paths.piAgentDir, ...(paths.piSessionDir ? { sessionDir: paths.piSessionDir } : {}) })),
    loaded('commandcode', 'commandcode', (code) => code.commandcodeProvider({ home: paths.commandcodeHome })),
    loaded('muse', 'muse', (code) => code.museProvider({ home: paths.museHome })),
    loaded('agy', 'agy', (code) => code.agyProvider({ home: paths.agyHome })),
  ]
}
