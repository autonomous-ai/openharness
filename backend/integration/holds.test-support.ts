/**
 * A hold that waits for a quota reset an hour after [now], the clock of the store the test writes through (heldReason.ts refuses
 * a reset time that has passed). Task #3914: a fixed time, 2026-11-06T09:00Z, passed on the day and turned main's integration
 * tests red; a time read off the test's own clock never expires before the test that sends it.
 */
export const quotaReset = (now = Date.now()) => ({ kind: 'reset' as const, what: 'quota' as const, at: new Date(now + 3_600_000).toISOString() })
