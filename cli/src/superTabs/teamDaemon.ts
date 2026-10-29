/**
 * Whether this daemon is a Harness Team account's, and where its Codex Product Managers keep their engine homes (#895). Read
 * by the core's guard (inCore/teamApps.ts) and by the Swarm's host as it launches a Product Manager (start.ts), so it holds
 * nothing of the core's.
 */
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { readAuthSession } from '../lib/authSession.js'
import { readTeamConfig } from '../team/config.js'
import { TEAM_CONFIG_FILE } from '../team/layout.js'

/**
 * Whether this daemon is a Harness Team account's, decided once at startup (security review 1 of #2089): the Team config
 * names this macOS user, or the daemon is signed in as a Team account (a machine used only for agents, `harness team on`).
 * A Team config that is there but cannot be read counts as this user's: the guard is installed, as it fails closed.
 */
export function isTeamDaemon(deps: { configExists?: () => boolean; config?: () => ReturnType<typeof readTeamConfig>; user?: () => string;
  signedInAsTeam?: () => boolean } = {}): boolean {
  const exists = (deps.configExists ?? (() => existsSync(TEAM_CONFIG_FILE)))()
  const config = exists ? (deps.config ?? (() => readTeamConfig()))() : null
  if (exists && (!config || config.user === (deps.user ?? (() => userInfo().username))())) return true
  return (deps.signedInAsTeam ?? (() => readAuthSession()?.kind === 'team'))()
}

/** Where a Team daemon runs each Codex Product Manager in an engine home of its own, deleted whole when the Swarm ends it. */
export const PM_HOMES = '.harness-pm-homes'

/** The engine home a Product Manager's start [creationId] runs in on a Team daemon: its own, for Codex (security re-check 2
 *  of #2089, the Lead's option A). Null for Claude Code, whose transcripts core reads only from the shared home (its files
 *  are scrubbed instead, inCore/teamApps.ts scrubClaudeSession), and anywhere but a Team daemon. */
export function pmEngineHome(engine: string, creationId: string, team: boolean, home: string): string | null {
  if (!team || engine !== 'codex' || !/^[A-Za-z0-9_-]{1,160}$/.test(creationId)) return null
  return join(home, PM_HOMES, creationId, 'codex')
}
