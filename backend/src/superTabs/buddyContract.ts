/**
 * The server's Buddy refusals that more than one place words alike (commands.ts, store.ts). Desktop's CI still checks out
 * this file (.github/workflows/ci.yml, scripts/record-ci-validation.py); since Codex Buddies are accepted (#2832) no
 * Desktop test reads it.
 */

/** Why a Buddy is refused a machine: the same words whether the machine is someone else's, shared with the person, a Harness
 *  Team account, or no machine at all, so they never say which (security review 2 of #2234). */
export const BUDDY_OWN_MACHINE_REFUSAL = 'A Buddy runs only on your own machine. Pick one of yours.'
