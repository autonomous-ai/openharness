import { expect, it } from 'vitest'
import { encodeRuntimeProfile as encodeCore, parseRuntimeProfile as parseCore } from '../../../cli/src/lib/runtimeProfile.js'
import { encodeRuntimeProfile, parseRuntimeProfile } from './modelProfile.js'

it.each(['claude', 'codex', 'opencode'] as const)('reads the existing %s public model ID without its runtime manager', engine => {
  for (const effort of ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']) {
    const input = { sessionId: 'agent:with spaces', engine, model: 'provider/model@variant', effort }
    const id = encodeCore(input)
    expect(encodeRuntimeProfile(input)).toBe(id)
    expect(parseRuntimeProfile(id)).toEqual(parseCore(id))
  }
})

it.each([null, '', 'runtime-v2:a:claude:opus@high', 'runtime-v1:a:claude:%zz@high',
  'runtime-v1:a:claude:opus@unknown', 'runtime-v1:a:unknown:opus@high'])(
  'does not select a model from an unsupported or malformed ID %s', value => {
    expect(parseRuntimeProfile(value)).toBeNull()
  },
)
