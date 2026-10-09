/**
 * What the core knows of Kilo without loading its code: declared data, read by the kit
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing.
 */
export const contract = {
  /** Its permission prompt lays its rows side by side under `⇆ select` and numbers none: a row is reached by
   *  walking Right from the first (askQuestion.ts), and `kit/questionPane.ts` `walkKeys` turns that into keys. */
  questionWalk: 'right',
} as const
