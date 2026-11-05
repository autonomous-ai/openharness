import { fail, type Actor } from './model.js'

/** What a deleted message that keeps its thread reads as, stored as its text so every reader shows it: older apps, the CLI
 *  and inbox previews among them. New apps draw it from `deletedAt`. */
export const DELETED_TEXT = 'This message was deleted.'

/** The message `message.edit` or `message.delete` names, found by the store in that conversation and readable by the actor
 *  (store.ts messageChangeTarget, the checks reactionTarget makes). Absent when it is not there or the actor may not see it. */
export interface MessageChangeTarget {
  messageId: string
  author: { kind: string; id: string }
  /** A person's own post: no system source (parts/commit.ts counts the same rows as a person's). */
  plain: boolean
  /** Only a stored Buddy proposal supplies this: the person it was posted for. Delete only, never edit. */
  proposalOwnerId?: string
  deleted: boolean
  hasFiles: boolean
  /** For a delete: some other row replies in its thread, so it stays as DELETED_TEXT. */
  hasReplies: boolean
  text: string
  sequence: number
  /** For a delete that removes the row: the newest sequence left of each of the group's counters (model.ts lastMessageSequence,
   *  lastMainSequence, lastPersonSequence), so a chat whose newest message goes is not left unread. Absent when none was found. */
  before?: { message?: number; main?: number; person?: number }
}

type Counters = { reactionSeq?: number; lastMessageSequence: number; lastMainSequence?: number; lastPersonSequence?: number }

/** Only the author changes a message: a person, on their own plain post, or deleting their own Buddy proposal (#3322).
 *  Its source owner must agree with its attribution. An agent (a Buddy too) never does, for anyone.
 *  A message the actor cannot see reads as unavailable, so a refusal tells nothing about it. */
function changeable(actor: Actor, messageId: string, target: MessageChangeTarget | undefined, operation: 'edit' | 'delete'): MessageChangeTarget {
  if (target?.messageId !== messageId) fail('NOT_FOUND', 'This message is unavailable.', 404)
  if (actor.kind !== 'person' || target.author.kind !== 'person' || target.author.id !== actor.userId
    || (!target.plain && !(operation === 'delete' && target.proposalOwnerId === actor.userId))) {
    fail('FORBIDDEN', 'Only its author can change this message.', 403)
  }
  if (target.deleted) fail('MESSAGE_DELETED', 'This message was deleted.', 409)
  return target
}

/** `message.edit`: the author's new text replaces the old; no earlier text is kept. Empty only for a message with files.
 *  A change bumps the group, so every reader's next read takes the page again (reactions.ts). */
export function editMessage(group: { reactionSeq?: number }, actor: Actor, messageId: string, text: string,
  target: MessageChangeTarget | undefined): boolean {
  const found = changeable(actor, messageId, target, 'edit')
  if (!text && !found.hasFiles) fail('INVALID_MESSAGE', 'Write something, or delete the message.', 400)
  if (found.text === text) return false
  group.reactionSeq = (group.reactionSeq ?? 0) + 1
  return true
}

/** `message.delete`: the row goes, or stays as DELETED_TEXT while replies hang under it. The store removes the rest. */
export function deleteMessage(group: Counters, actor: Actor, messageId: string,
  target: MessageChangeTarget | undefined): { kept: boolean } {
  const found = changeable(actor, messageId, target, 'delete')
  group.reactionSeq = (group.reactionSeq ?? 0) + 1
  if (found.hasReplies) return { kept: true }
  // Each counter that pointed at the row steps back to the newest row left of its kind (parts/commit.ts numberMessages).
  // One with no row of its kind found within the look-back stays as it was: rare, and safer than saying the chat is empty.
  const before = found.before ?? {}
  if (group.lastMessageSequence === found.sequence && before.message !== undefined) group.lastMessageSequence = before.message
  if (group.lastMainSequence === found.sequence && before.main !== undefined) group.lastMainSequence = before.main
  if (group.lastPersonSequence === found.sequence && before.person !== undefined) group.lastPersonSequence = before.person
  return { kept: false }
}
