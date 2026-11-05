/**
 * The merge train's fixed numbers (task #3402). Its switch, interval and the reads a change needs are the project's rules
 * record (superTabs/policy.ts, task #3475): edited by people without a release, shared with the review steps.
 */

/** Branches the train builds batches on. Nothing else in a repository may use this prefix. */
export const TRAIN_BRANCH_PREFIX = 'harness-train/'
/** The most pull requests one batch holds. */
export const TRAIN_MAX_BATCH = 8
/** The check whose green the train waits for, at a member's head and at the batch's. */
export const TRAIN_CI_CHECK = 'ci/required'
/** A pull request with one of these labels (any case) waits: people hold one by hand this way. */
export const TRAIN_HOLD_LABELS = ['hold']
/** A batch whose CI has not finished in this long is closed and built again. */
export const TRAIN_CI_TIMEOUT_MS = 90 * 60_000
/** The most projects one pass walks, the most recently active first (ENGINEERING.md 4: no read grows without a bound). */
export const TRAIN_PROJECTS = 50

/** Paths that change nothing a build or test runs: their pull requests merge on their own, with no batch. Not scripts/: it
 *  holds the CI planner and release scripts, which run (review 2 of #3226). */
export const FAST_LANE: readonly RegExp[] = [/^docs\//, /\.md$/i]
/** Paths the train's token may not change (it has no `workflows` permission): GitHub would refuse the merge. */
export const NOT_MERGEABLE_BY_TOKEN = /^\.github\/workflows\//
