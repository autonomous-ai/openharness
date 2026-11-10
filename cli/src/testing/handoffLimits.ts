/**
 * The change-agent handoff's limits for a spec that runs real file reads, fsyncs and git on a loaded machine:
 * about 1 s a case alone, 5-8 s at load 30 (the release gates, 2026-11-10), past the shipped 5 s deadline
 * (lib/handoffAuthority.ts HANDOFF_DEADLINE_MS), 2 s git limit and 1.5 s discovery. The shipped limits keep their
 * own tests (lib/agentHandoff.spec.ts, services/handoff.spec.ts, core/handoffPublication.spec.ts).
 */
export const LOADED_HANDOFF_MS = 30_000
export const LOADED_HANDOFF_LIMITS = { deadlineMs: LOADED_HANDOFF_MS, gitTimeoutMs: LOADED_HANDOFF_MS, discoverMs: LOADED_HANDOFF_MS }
/** Above the limits, so a case that runs out of time fails with the product's own answer, not vitest's. */
export const LOADED_HANDOFF_TEST_MS = LOADED_HANDOFF_MS + 10_000
