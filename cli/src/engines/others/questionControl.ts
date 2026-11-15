/** The other engines' navigation. Core supplies one approved step and a revocable writer. */
import type { AgentEngine } from '../types.js'
import type { QuestionRow } from '../facets/screen.js'
import type { EngineQuestionControl, QuestionControlHost } from '../facets/questionControl.js'
import { contract as amp } from '../amp/contract.js'
import { contract as kilo } from '../kilo/contract.js'
import { walkKeys } from '../kit/questionPane.js'

const WALKS: Partial<Record<AgentEngine, NonNullable<QuestionRow['walk']>>> = { amp: amp.questionWalk, kilo: kilo.questionWalk }
export function rowKeys(engine: AgentEngine, row: QuestionRow): string[] {
  const walk = WALKS[engine] ?? row.walk
  return walk === 'right' || walk === 'down' ? walkKeys(walk, row) : [row.number]
}

export function otherQuestionControl(engine: AgentEngine,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): EngineQuestionControl {
  const text = async (row: QuestionRow, value: string, host: QuestionControlHost): Promise<boolean> => {
    if (!await host.key(row.number)) return false
    await wait(250)
    if (!await host.text(value)) return false
    await wait(250)
    return host.key('Enter')
  }
  return { async apply(step, host) {
    if (step.kind === 'review') return host.key(step.key)
    if (step.kind === 'select') {
      for (const key of rowKeys(engine, step.row)) {
        if (!await host.key(key)) return false
        await wait(250)
      }
    } else if (step.kind === 'text') {
      if (!await text(step.row, step.text, host)) return false
    } else {
      for (const row of step.rows) {
        if (!await host.key(row.number)) return false
        await wait(250)
      }
      if (step.freeText && !await text(step.freeText.row, step.freeText.text, host)) return false
      if (!await host.key(engine === 'devin' ? 'Enter' : 'Tab')) return false
    }
    await wait(350)
    return true
  } }
}
