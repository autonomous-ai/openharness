import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import { record, text } from '../kit/runtime.js'
import * as grok from './runtimeProfile.js'

class ProfileReader {
  readonly engine = 'grok' as const

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state } = context
    const footer = grok.parseGrokFooterProfile(paneText)
    if (footer) {
      state.model = footer.model
      state.effort = footer.effort
      state.observedAt = Date.now()
    }
  }

  transcript(context: InlineRuntimeContext, raw: Record<string, unknown>): void {
    const { state } = context
    const params = record(raw.params)
    const update = record(params?.update)
    const meta = record(update?._meta)
    const model = text(meta?.modelId)
    if (!model) return
    state.model = model
    state.observedAt = Date.now()
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'grok' } { return new ProfileReader() }
