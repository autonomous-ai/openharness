import { numberedQuestionControl } from '../kit/questionControl.js'

export const createQuestionControl = (wait?: (ms: number) => Promise<void>) => numberedQuestionControl(({ row }) => {
  // Numbered questions normally submit on the digit. Preserve the shared dialog's explicit walk hint.
  if (row.walk) return [...Array(Number(row.number)).fill(row.walk === 'right' ? 'Right' : 'Down'), 'Enter']
  return [row.number]
}, wait)
export const questionControl = createQuestionControl()
