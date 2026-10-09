import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import { readRuntimeText as readText } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { join } from 'node:path'
import * as muse from './runtimeProfile.js'

class ProfileReader {
  readonly engine = 'muse' as const

  async config(context: InlineRuntimeContext): Promise<boolean> {
    const { state } = context
    // Both axes are plain scalars in ~/.config/muse/settings.json (`model`, `reasoning_effort`) and
    // neither is announced anywhere, so reading the file IS the only way the chip is ever populated.
    // `reasoning_effort` is muse's own vocabulary (none|minimal|low|medium|high|xhigh|ultra); the
    // absence of the key means the CLI default, which its own --help documents as `high`.
    const parsed = muse.parseMuseSettings(await readText(join(env.MUSE_CONFIG_DIR, 'settings.json')))
    if (parsed.model) state.model = parsed.model
    state.effort = parsed.effort ?? 'auto'
    state.observedAt = Date.now()

    return true
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'muse' } { return new ProfileReader() }
