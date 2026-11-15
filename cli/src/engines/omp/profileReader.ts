/**
 * omp writes the model on `model_change` and on each assistant message, and the
 * thinking level on `thinking_level_change`. Measured on a live session file.
 * Levels seen: high, xhigh, max.
 */
import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { ProfileEvidence, RuntimeModelOption } from '../facets/runtime.js'
import { addOption, record, text } from '../kit/runtime.js'
import { RUNTIME_EFFORTS } from '../kit/runtime.js'

export function createRuntimeProfileReader(): InlineRuntimeReader {
  return {
    engine: 'omp',
    async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
      const output: RuntimeModelOption[] = []
      const seen = new Set<string>()
      const model = context.state.model
      if (model) addOption(output, seen, context.session, model, context.state.effort && RUNTIME_EFFORTS.has(context.state.effort) ? context.state.effort : 'auto', model)
      return output
    },
  }
}

/** The model of a `model_change` or an assistant message, and the level of a `thinking_level_change`, read in the other
 *  engines' worker (engines/others/streams.ts). */
export function transcriptEvidence(raw: Record<string, unknown>): ProfileEvidence | null {
  const message = record(raw.message)
  const model = raw.type === 'model_change' ? text(raw.model)
    : raw.type === 'message' && message?.role === 'assistant' ? text(message.model) : ''
  const level = raw.type === 'thinking_level_change' ? text(raw.thinkingLevel) : ''
  const effort = level && RUNTIME_EFFORTS.has(level) ? level : ''
  if (!model && !effort) return null
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), confirms: true }
}
