import type { EngineQuestionControl, QuestionControlHost, QuestionStep } from '../facets/questionControl.js'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** Numbered TUI navigation shared by Claude Code and Codex. Core supplies only an approved step. */
export function numberedQuestionControl(
  selection: (step: Extract<QuestionStep, { kind: 'select' }>) => string[],
  wait: (ms: number) => Promise<void> = sleep,
): EngineQuestionControl {
  const text = async (row: string, value: string, host: QuestionControlHost) => {
    if (!await host.key(row)) return false
    await wait(250)
    if (!await host.text(value)) return false
    await wait(250)
    return host.key('Enter')
  }
  return {
    async apply(step, host) {
      if (step.kind === 'review') return host.key(step.key)
      if (step.kind === 'select') {
        for (const key of selection(step)) {
          if (!await host.key(key)) return false
          await wait(250)
        }
      } else if (step.kind === 'text') {
        if (!await text(step.row.number, step.text, host)) return false
      } else {
        for (const row of step.rows) {
          if (!await host.key(row.number)) return false
          await wait(250)
        }
        if (step.freeText && !await text(step.freeText.row.number, step.freeText.text, host)) return false
        if (!await host.key('Tab')) return false
      }
      await wait(350) // The next capture must see the repaint after the last key.
      return true
    },
  }
}
