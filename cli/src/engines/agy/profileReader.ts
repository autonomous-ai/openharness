import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import * as agy from './runtimeProfile.js'

class ProfileReader {
  readonly engine = 'agy' as const

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state } = context
    // agy's transcript never names the model, so the pane footer is the only continuous source; the
    // hook payload's `modelName` seeds it at session start.
    const footer = agy.parseAgyFooterProfile(paneText)
    if (footer) {
      state.model = footer.model
      state.effort = footer.effort
      state.observedAt = Date.now()
    }
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'agy' } { return new ProfileReader() }
