import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import { readRuntimeText as readText } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { join } from 'node:path'
import * as amp from './runtimeProfile.js'

class ProfileReader {
  readonly engine = 'amp' as const

  async config(context: InlineRuntimeContext): Promise<boolean> {
    const { state } = context
    // Amp has no models — only agent MODES — so the mode is reported as the model and there is no
    // second axis to report. `~/.local/share/amp/session.json` is the only local place it is written.
    const parsed = amp.parseAmpSession(await readText(join(env.AMP_STATE_DIR, 'session.json')))
    if (parsed.mode) state.model = parsed.mode
    state.effort = 'auto'
    state.observedAt = Date.now()

    return true
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'amp' } { return new ProfileReader() }
