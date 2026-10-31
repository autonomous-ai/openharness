import { fail, stableId, type SuperTabState } from './model.js'

// Deleting a Swarm (Dee, 10-31: "owners can delete a Swarm, like deleting a Slack workspace").
//
// `swarm.delete` (commands.ts), by its owner alone, removes every agent with its session and every machine with the Swarm's
// folders there, as removing them one by one does, and marks the state deleted. In the same write its index row lists no
// member and no invitation (parts/commit.ts indexesOf), so it leaves every person's lists at once, and every read and write
// answers as for a Swarm that does not exist (store.ts row). Its machines' hosts still read what they must close and clean
// up, through the machine index, which stays until they have. Its owner can restore it (`swarm.restore`) until `purgeAt`:
// people, projects, chats and files come back, without agents or machines. After that the sweep (purge.ts) removes its
// records and stored files, and only its own.

/** How long a deleted Swarm can be restored before it is purged. */
export const SWARM_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** The request id Desktop creates the person's Personal Swarm with (desktop super_tabs/swarm_switcher.dart). */
export const PERSONAL_SWARM_OPERATION = 'personal-swarm'

/** The owner's Personal Swarm: its id is derived from the owner and the Personal request (store.ts create). */
export const isPersonalSwarm = (state: Pick<SuperTabState, 'id' | 'environment' | 'ownerId'>): boolean =>
  state.id === stableId('super-tab', state.environment, state.ownerId, PERSONAL_SWARM_OPERATION)

/** What a caller who may not delete or restore this Swarm is told: word for word what the store tells about a Swarm that
 *  does not exist (store.ts row), so nobody learns from a refusal whether it exists or was deleted. */
export function notThere(): never {
  return fail('NOT_FOUND', 'This Super Tab is unavailable.', 404)
}

/** Commands that delete or restore the whole Swarm: whoever is refused on the way, for any reason, is told `notThere`. */
export const DELETION_COMMANDS: ReadonlySet<string> = new Set(['swarm.delete', 'swarm.restore'])

/** Commands a deleted Swarm still takes: its machines' hosts confirming the closes and cleanups its deletion asked for, and
 *  its owner restoring it. Everything else answers as for a Swarm that does not exist. */
export const DELETED_SWARM_COMMANDS: ReadonlySet<string> = new Set(['agent.sessionClosed', 'machine.cleaned', 'swarm.restore'])
