import type { SubmissionPolicy } from '../facets/submission.js'

/**
 * Codex's submission timing, declared as data so the core times its decisions without loading the reader.
 * It takes typing while a turn runs: it joined Claude Code here on 2026-09-15 (owner: a voice command spoken
 * while a Codex task ran sat invisible until the task ended); Codex has queued composer input since 0.36,
 * and a prompt that left the composer without a turn start is "queued by the TUI as a follow-up", not lost.
 * From 0.106 a message typed mid-turn steers the running turn (docs/in-flight-agent-input.md, #294); an
 * older or unknown release is native input, never claimed as steering.
 */
export const policy: SubmissionPolicy = {
  typesWhileBusy: true,
  verifyMs: 1_500,
  busyInput: { mode: 'native_input', steeringSince: [0, 106] },
}
