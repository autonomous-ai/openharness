/** Inline runtime composition. Supervised workers load only their own engine's facet. */
import { runtime as claude } from './claude/runtimeProfile.js'
import { runtime as codex } from './codex/runtimeProfile.js'
import type { RuntimeFor } from './facets/runtime.js'
const runtimes = { claude, codex }
export const runtimeFor: RuntimeFor = engine => Object.hasOwn(runtimes, engine) ? runtimes[engine as keyof typeof runtimes] : undefined
