/**
 * Every engine's discovery, pointed at where that engine keeps its conversations on this machine.
 * Each path follows the engine's own rules (its env overrides first), not Harness's defaults alone.
 */

import { isAbsolute, join } from 'node:path'

import { cursorConfigDir, cursorDataDir } from '../../../engines/cursor/home.js'
import { env } from '../../../config/env.js'
import { agyProvider } from './agy.js'
import { claudeProvider } from './claude.js'
import { codexProvider } from './codex.js'
import { commandcodeProvider } from './commandcode.js'
import { copilotProvider } from './copilot.js'
import { cursorProvider } from './cursor.js'
import { devinProvider } from './devin.js'
import { grokProvider } from './grok.js'
import { hermesProvider } from './hermes.js'
import { museProvider } from './muse.js'
import { opencodeProvider } from './opencode.js'
import { piProvider } from './pi.js'
import type { ExternalProvider } from './types.js'

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

/** One provider per engine that keeps its conversations on this machine's disk. */
export function externalProviders(paths: ExternalPaths = externalPaths()): ExternalProvider[] {
  return [
    claudeProvider({ projectsDir: paths.claudeProjectsDir, home: join(paths.claudeProjectsDir, '..') }),
    codexProvider({ home: paths.codexHome }),
    cursorProvider({ configDir: paths.cursorConfigDir, dataDir: paths.cursorDataDir }),
    grokProvider({ home: paths.grokHome }),
    copilotProvider({ home: paths.copilotHome }),
    opencodeProvider({ engine: 'opencode', dbPath: paths.opencodeDb }),
    opencodeProvider({ engine: 'kilo', dbPath: paths.kiloDb }),
    hermesProvider({ root: paths.hermesRoot }),
    devinProvider({ home: paths.devinHome }),
    piProvider({ agentDir: paths.piAgentDir, ...(paths.piSessionDir ? { sessionDir: paths.piSessionDir } : {}) }),
    commandcodeProvider({ home: paths.commandcodeHome }),
    museProvider({ home: paths.museHome }),
    agyProvider({ home: paths.agyHome }),
  ]
}
