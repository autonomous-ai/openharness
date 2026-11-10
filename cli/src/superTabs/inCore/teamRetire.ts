/**
 * Swarm v3 has no Team accounts (anh Dee, 2026-11-07; #4221). A Mac, Linux or Windows computer set up before keeps the
 * Team account's daemon, which its system starts at every boot. Its files are root's, and removing them needs an
 * administrator prompt nobody asked for, so the daemon stops itself for good instead: after a pass over its agents finds
 * none running, so the agents still there finish what they hold first (#4120). At the next boot it starts, finds none and
 * stops again. Since the Team installer and `harness team` went (anh Dee, 2026-11-10), this is all an old Team account does
 * (its boot job's `team __start` is a no-op in cli.ts): the account, its home and its boot job stay, idle.
 */
export const TEAM_RETIRED = 'retired'

/** What runs after each pass over this daemon's agents. Only a Team account's daemon (team/config.ts `isTeamAccount`)
 *  ever stops; a computer once signed in for team work only is the owner's own daemon and is not one. */
export function teamRetirement(deps: { teamAccount: boolean; live: () => number; stop: (reason: string) => void; log: (line: string) => void }): () => void {
  let stopped = !deps.teamAccount
  return () => {
    if (stopped || deps.live() > 0) return
    stopped = true
    deps.log('[team] Swarm v3 has no Team accounts: no agent runs here, stopping for good')
    deps.stop(TEAM_RETIRED)
  }
}
