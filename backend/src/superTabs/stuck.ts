/**
 * Who wrote in a task: the people a stuck line tagged (task #3915). The line itself went with the time checks (Swarm v4, 2026-11-09:
 * the server runs no v3 job on its own); its writers stay recorded for the task records' readers until they go (slice S13).
 */
import { MAX_MENTIONS } from './mentions.js'
import type { Conversation } from './model.js'

/** The people a task keeps as its writers (Conversation.writers): with its requester, at most MAX_MENTIONS. */
const WRITERS_KEPT = MAX_MENTIONS - 1

/** [personId] posted in [group]: its writers, newest last, at most WRITERS_KEPT. */
export function noteWriter(group: Conversation, personId: string): void {
  const writers = group.writers ?? []
  if (writers.at(-1) === personId) return
  group.writers = [...writers.filter(id => id !== personId), personId].slice(-WRITERS_KEPT)
}
