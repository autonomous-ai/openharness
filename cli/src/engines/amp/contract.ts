/**
 * What the core knows of Amp without loading its code: declared data, read by the kit
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing.
 */
export const contract = {
  /** Its approval rows are stacked and numbered by nothing: a row is reached by walking Down from the first
   *  (askQuestion.ts), and `kit/questionPane.ts` `walkKeys` turns that into keys. */
  questionWalk: 'down',
} as const
