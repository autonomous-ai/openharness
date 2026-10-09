/** Explicit inline composition; supervised core does not import native navigation. */
import { createQuestionControl as claude } from './claude/questionControl.js'
import { createQuestionControl as codex } from './codex/questionControl.js'
export const questionControlFor = (engine: string, wait?: (ms: number) => Promise<void>) =>
  engine === 'claude' ? claude(wait) : engine === 'codex' ? codex(wait) : undefined
