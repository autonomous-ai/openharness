/** Leaderboard weeks run Monday 00:00 to Monday 00:00 UTC (Lead ruling, 2026-10-27). */
export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS
/** 1970-01-05, the first Monday after the epoch. */
const FIRST_MONDAY = 4 * DAY_MS

export const weekStart = (ms: number): number => Math.floor((ms - FIRST_MONDAY) / WEEK_MS) * WEEK_MS + FIRST_MONDAY
