/** Explicit inline composition; supervised core does not import the native submission readers. */
import { submission as claude } from './claude/submission.js'
import { submission as codex } from './codex/submission.js'
export const submissionFor = (engine: string) => engine === 'claude' ? claude : engine === 'codex' ? codex : undefined
