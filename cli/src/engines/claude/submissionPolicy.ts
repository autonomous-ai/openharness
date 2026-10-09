import type { SubmissionPolicy } from '../facets/submission.js'

/**
 * Claude Code's submission timing, declared as data so the core times its decisions without loading the
 * reader. It takes typing while a turn runs and queues the message itself (its own queue is the one the
 * person sees), so the core types at once. Its window has been 3 s since the CLI's first release: a long
 * paste is collapsed to `[Pasted text]` before Enter counts as submit (lib/tmux.ts), and the prompt reaches
 * the transcript only after its UserPromptSubmit hooks have run.
 */
export const policy: SubmissionPolicy = {
  typesWhileBusy: true,
  verifyMs: 3_000,
  busyInput: { mode: 'native_queue' },
}
