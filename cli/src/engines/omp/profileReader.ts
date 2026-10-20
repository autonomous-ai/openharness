/**
 * omp writes the model on `model_change` and on each assistant message, and the
 * thinking level on `thinking_level_change`. Measured on a live session file.
 * Levels seen: high, xhigh, max.
 */
import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { addOption, record, text } from '../kit/runtime.js'
import { RUNTIME_EFFORTS } from '../kit/runtime.js'

export function createRuntimeProfileReader(): InlineRuntimeReader {
  return {
    engine: 'omp',
    transcript(context: InlineRuntimeContext, raw: Record<string, unknown>): void {
      const message = record(raw.message)
      const model = raw.type === 'model_change' ? text(raw.model)
        : raw.type === 'message' && message?.role === 'assistant' ? text(message.model) : ''
      const effort = raw.type === 'thinking_level_change' ? text(raw.thinkingLevel) : ''
      if (model) {
        context.state.model = model
        context.state.observedAt = Date.now()
        if (context.control && context.control.target.model === model) context.control.modelConfirmed = true
      }
      if (effort && RUNTIME_EFFORTS.has(effort)) {
        context.state.effort = effort
        context.state.observedAt = Date.now()
        if (context.control && context.control.target.effort === effort) context.control.effortConfirmed = true
      }
    },
    async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
      const output: RuntimeModelOption[] = []
      const seen = new Set<string>()
      const model = context.state.model
      if (model) addOption(output, seen, context.session, model, context.state.effort && RUNTIME_EFFORTS.has(context.state.effort) ? context.state.effort : 'auto', model)
      return output
    },
  }
}
