import type { QuestionRow, QuestionView } from '../facets/screen.js'
import { numberedQuestionControl } from '../kit/questionControl.js'

/** Measured on 0.149: request_user_input highlights on a digit and submits on Enter;
 * approval prompts select and commit on the digit alone. */
export function codexRowKeys(row: QuestionRow, view?: QuestionView | Pick<QuestionView, 'enterSubmits'>): string[] {
  return view?.enterSubmits ? [row.number, 'Enter'] : [row.number]
}
export const createQuestionControl = (wait?: (ms: number) => Promise<void>) => numberedQuestionControl(step => codexRowKeys(step.row, step), wait)
export const questionControl = createQuestionControl()
