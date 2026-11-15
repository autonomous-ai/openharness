import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { ProfileEvidence } from '../facets/runtime.js'
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
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'grok' } { return new ProfileReader() }

/** The model a session update names (`params.update._meta.modelId`), read in the other engines' worker
 *  (engines/others/streams.ts). */
export function transcriptEvidence(raw: Record<string, unknown>): ProfileEvidence | null {
  const params = record(raw.params)
  const update = record(params?.update)
  const meta = record(update?._meta)
  const model = text(meta?.modelId)
  return model ? { model } : null
}
