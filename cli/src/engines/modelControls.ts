/** Explicit inline composition only. Normal core loads these facets in supervised workers. */
import { modelControl as claude } from './claude/modelControl.js'
import { modelControl as codex } from './codex/modelControl.js'
import { modelControl as opencode } from './opencode/modelControl.js'
export const modelControlFor = (engine: string) => engine === 'claude' ? claude : engine === 'codex' ? codex : engine === 'opencode' ? opencode : undefined
