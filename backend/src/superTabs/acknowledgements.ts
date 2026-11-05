/**
 * An agent's post that only acknowledges (task #3391, anh Dee's Swarm redesign, 11-05). "On it", "got it", "thanks" and
 * "will do" fill the chat, wake the agent they answer for nothing, and tell nobody what a reaction would not. The server
 * refuses such a post with ACK_ONLY and the next step; a reaction settles the delivery instead (reactions.ts).
 *
 * The classifier is conservative: a post is an acknowledgement only when every clause of it is on the list below, so a real
 * short answer ("Yes at 1a2b3c", "Merged.", a link, a question) is never refused. There is no length number: the list is the
 * whole rule.
 */

/** What a clause may say to acknowledge. At least one clause of a post is one of these. Apostrophes are dropped before the match. */
const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
  'on it', 'got it', 'i got it', 'took it', 'taking it', 'ill take it', 'will do', 'ill do', 'ill do it', 'noted', 'understood',
  'acknowledged', 'ack', 'roger', 'roger that', 'copy', 'copy that', 'sounds good', 'makes sense', 'confirmed',
  'thanks', 'thank you', 'thanks a lot', 'thanks so much', 'many thanks', 'thx', 'ty',
])

/** Words that may stand around an acknowledgement but acknowledge nothing alone: "ok, on it" is one; "ok" is an answer. */
const FILLERS: ReadonlySet<string> = new Set(['ok', 'okay', 'sure', 'yes', 'yep', 'yeah', 'great', 'cool', 'perfect', 'alright', 'all right', 'hi', 'hey'])

/** A question, a number, a tag, a link or a file name: something the post says beyond acknowledging. */
const SAYS_MORE = /[?@#/\\\d]|:\/\/|[a-z]\.[a-z]/

/** Whether the text says nothing beyond an acknowledgement. */
export function isAcknowledgement(text: string): boolean {
  const plain = text.toLowerCase().replace(/[\p{Extended_Pictographic}‍️]/gu, '').replace(/['’`]/g, '')
  if (SAYS_MORE.test(plain)) return false
  const clauses = plain.split(/[.,;:!\-–—…\n]+|\s&\s|\band\b/).map(clause => clause.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return clauses.some(clause => ACKNOWLEDGEMENTS.has(clause)) && clauses.every(clause => ACKNOWLEDGEMENTS.has(clause) || FILLERS.has(clause))
}

/** The refusal's words: the guard and the next step. */
export const ACK_ONLY_HINT = 'This post only acknowledges. React to the message instead: 👀 when you start, ✅ when you have done what it asked. Post only substance: a plan, a question, a finding, a verdict or a result.'
