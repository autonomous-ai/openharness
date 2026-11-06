/** The privacy reading this process sends with its machine's Super Tab observation (superTabs/machines.ts). */
import { userInfo } from 'node:os'
import { readAuthSession } from '../lib/authSession.js'
import { readTeamConfig, type TeamConfig } from './config.js'
import { TEAM_SIGNED_OUT_DETAIL, TeamPrivacyObserver, runPrivacyCheck, writeTeamStatus, type PrivacyObservation } from './privacy.js'

let observer: TeamPrivacyObserver | null = null

export function teamPrivacyObserver(): PrivacyObservation | null {
  observer ??= new TeamPrivacyObserver({
    config: () => readTeamConfig(),
    user: () => userInfo().username,
    teamSession: () => readAuthSession()?.kind === 'team',
    check: (config) => runPrivacyCheck(config),
    writeStatus: writeTeamStatus,
    now: () => Date.now(),
  })
  return observer.observe()
}

/** What [recordTeamSignedOut] reads and writes: seams, so a spec touches no real account. */
export interface TeamSignedOutDeps {
  config(): TeamConfig | null
  user(): string
  writeStatus: typeof writeTeamStatus
  now(): number
}

/**
 * As a revoke stops this daemon (core/main.ts `onRevoked`): in the Harness Team account, its status file says the sign-in is
 * gone, as `team __start` says it at the next start. A revoke stops the daemon for good, so that start never came, and the
 * owner's card offered Restart, not Sign in again (security review 2 of #3331, #3684). Fixed words, never the sign-in itself;
 * nothing in the owner's own daemon, and never a throw: the stop goes on either way.
 */
export function recordTeamSignedOut(deps: TeamSignedOutDeps = {
  config: () => readTeamConfig(), user: () => userInfo().username, writeStatus: writeTeamStatus, now: () => Date.now(),
}): void {
  try {
    const config = deps.config()
    if (!config || config.user !== deps.user()) return
    deps.writeStatus(config.statusFile, { signIn: { state: 'signed-out', at: deps.now(), detail: TEAM_SIGNED_OUT_DETAIL } })
  } catch { /* the stop goes on; the next start writes it */ }
}
