/**
 * An agent's post that only acknowledges (task #3391, anh Dee's Swarm redesign, 11-05). "On it", "got it", "thanks" and
 * "will do" fill the chat, wake the agent they answer for nothing, and tell nobody anything. The server refuses such a post
 * with ACK_ONLY and the next step; the delivery stays until the agent has something to say.
 *
 * The classifier is conservative: a post is an acknowledgement only when every clause of it is on the list below, or when it is
 * emoji alone, so a real short answer ("Yes at 1a2b3c", "Merged.", a link, a question) is never refused. There is no length
 * number: the list is the whole rule.
 */

/** What a clause may say to acknowledge. At least one clause of a post is one of these. Apostrophes are dropped before the match. */
const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
  'on it', 'got it', 'i got it', 'took it', 'taking it', 'ill take it', 'will do', 'ill do', 'ill do it', 'noted', 'understood',
  'acknowledged', 'ack', 'roger', 'roger that', 'copy', 'copy that', 'sounds good', 'makes sense', 'confirmed',
  'thanks', 'thank you', 'thanks a lot', 'thanks so much', 'many thanks', 'thx', 'ty',
])

/** Words that may stand around an acknowledgement but acknowledge nothing alone. Only greetings: "yes", "ok", "sure" or "great"
 *  can answer a question, so "Yes, thanks." is an answer and passes (review of #3391). */
const FILLERS: ReadonlySet<string> = new Set(['hi', 'hey'])

/** A question, a number, a tag, a link or a file name: something the post says beyond acknowledging. */
const SAYS_MORE = /[?@#/\\\d]|:\/\/|[a-z]\.[a-z]/

/** Whether the text says nothing beyond an acknowledgement. */
export function isAcknowledgement(text: string): boolean {
  const plain = text.toLowerCase().replace(/[\p{Extended_Pictographic}‍️]/gu, '').replace(/['’`]/g, '')
  if (SAYS_MORE.test(plain)) return false
  // Emoji alone says nothing in words. Since reactions went (#3892, 2026-11-10) an agent posts its 👍 instead, and a post under
  // another agent's message starts that agent's turn: in the rehearsal of 2026-11-11 the PM's 👍 under each builder's
  // "stopping" woke the builder again. An emoji that meant yes is said in words, as the refusal asks.
  if (/\p{Extended_Pictographic}/u.test(text) && !/[\p{L}\p{N}]/u.test(plain)) return true
  const clauses = plain.split(/[.,;:!\-–—…\n]+|\s&\s|\band\b/).map(clause => clause.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return clauses.some(clause => ACKNOWLEDGEMENTS.has(clause)) && clauses.every(clause => ACKNOWLEDGEMENTS.has(clause) || FILLERS.has(clause))
}

/** The refusal's words: the guard and the next step. */
export const ACK_ONLY_HINT = 'This post only acknowledges: nothing needs to be said. Post only substance: a plan, a question, a finding, a verdict or a result. An answer is said in words.'
