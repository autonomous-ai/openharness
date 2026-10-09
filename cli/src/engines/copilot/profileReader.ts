import type { InlineRuntimeReader } from '../facets/inlineRuntime.js'

class ProfileReader {
  readonly engine = 'copilot' as const
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'copilot' } { return new ProfileReader() }
