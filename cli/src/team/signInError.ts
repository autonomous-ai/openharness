/**
 * A Team sign-in that could not be made or used. Its own module, with nothing imported, so the files the core loads
 * (team/relay.ts, through team/windowsTeam.ts) can refuse with it without loading the sign-in code in ./handoff.ts and
 * the end-to-end encryption under it (architecture.spec.ts, the core's closure).
 */
export class TeamSignInError extends Error {
  constructor(message: string, readonly code: 'NOT_SIGNED_IN' | 'TEAM_SESSION' | 'EXPIRED' | 'BACKEND' | 'NOT_TEAM' | 'UNSAFE_FILE' | 'NO_PROOF',
    /** The backend's HTTP status, when it answered with one. */
    readonly status?: number) {
    super(message)
    this.name = 'TeamSignInError'
  }
}
