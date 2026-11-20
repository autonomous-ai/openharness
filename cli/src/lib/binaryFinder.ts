// The devices' and the edge host's way to find a multiplexer's binary once and share it (cable/hosts/tmux.ts, zellij.ts,
// kitty.ts, services/homeBridge.ts). Not in tmuxOnPath.ts, which the core loads: the core grows nothing only its
// components use (cli/AGENTS.md, rule 7).
import { ensureTmuxOnPath, tmuxAvailableNow, type TmuxPathOutcome } from './tmuxOnPath.js'

/** tmux as the core finds it (ensureTmuxOnPath), asked at the first tmux call and shared by the adapter and the lookup,
 *  on a copy of the environment: this process's own PATH stays the master's. None found is asked again once a tmux is
 *  where the core looks without a shell (tmuxAvailableNow), as the core retries its own (terminalBackendRecovery.ts). */
export function tmuxFinder(
  find = (): Promise<TmuxPathOutcome> => ensureTmuxOnPath({ ...process.env }),
  arrived = (): boolean => tmuxAvailableNow(),
): () => Promise<TmuxPathOutcome> {
  return binaryFinder(find, arrived)
}

/** A multiplexer's binary, found by [find] at its first call and shared by every caller. One found holds. None, or a
 *  lookup that threw, is asked again once [arrived] (filesystem reads only) sees one: one installed after this process
 *  started, or a login shell that timed out on a loaded Mac, otherwise left the dial with none until the process
 *  restarted. Never rejects. */
export function binaryFinder(find: () => Promise<TmuxPathOutcome>, arrived: () => boolean): () => Promise<TmuxPathOutcome> {
  let found: Promise<TmuxPathOutcome> | undefined
  let none = false
  return () => {
    if (!found || (none && arrived())) {
      none = false
      const asking = find().catch((): TmuxPathOutcome => ({ state: 'absent', reason: 'the lookup failed' }))
      // Registered before any caller's wait on it, so it runs first: a call after the answer sees it.
      void asking.then((outcome) => { none = outcome.state === 'absent' })
      found = asking
    }
    return found
  }
}
