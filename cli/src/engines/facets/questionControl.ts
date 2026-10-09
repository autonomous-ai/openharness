import type { QuestionRow } from './screen.js'

/** One step already matched to the user's answer by core. No pending answers or terminal identity. */
export type QuestionStep =
  | { kind: 'select'; row: QuestionRow; enterSubmits?: boolean }
  | { kind: 'multiple'; rows: QuestionRow[]; freeText?: { row: QuestionRow; text: string } }
  | { kind: 'text'; row: QuestionRow; text: string }
  | { kind: 'review'; key: string }

export interface QuestionControlHost {
  key(key: string): Promise<boolean>
  text(text: string): Promise<boolean>
}
export interface EngineQuestionControl {
  apply(step: QuestionStep, host: QuestionControlHost): Promise<boolean>
}
