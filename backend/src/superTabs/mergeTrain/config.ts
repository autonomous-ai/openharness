/**
 * The merge train's numbers (task #3402), in one place until the project rules record (task #3393) holds them: the train is
 * off until a project switches it on (River, 2026-11-05: merging someone's repository by itself would surprise them), and
 * runs every 10 minutes once on.
 */
export const TRAIN_DEFAULTS = Object.freeze({ enabled: false, everyMinutes: 10 })

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

/** Paths that change nothing a build or test runs: their pull requests merge on their own, with no batch. */
export const FAST_LANE: readonly RegExp[] = [/^docs\//, /\.md$/i, /^scripts\//]

/**
 * Where each area of the review table lives in the repository, by the table's own area names (task #3393's seed). Until the
 * table maps its areas to paths, these patterns do; they err wide, as a pull request that needs one more read than it got
 * only waits, and one merged with too few cannot be taken back (River, 2026-11-05: fail closed on the review table).
 */
export const REVIEW_AREAS: ReadonlyArray<{ area: string; paths: RegExp }> = [
  { area: 'Sign-in', paths: /(^|\/)(auth|login|sign_?in|signin|session)[^/]*$|^backend\/src\/middlewares\//i },
  { area: 'Tokens', paths: /token|^backend\/src\/github\//i },
  { area: 'Encryption', paths: /crypt|cipher|secret|credential|key(s|chain)?\b/i },
  { area: 'Access', paths: /access|permission|audience|membership/i },
  { area: 'Buddy guard', paths: /guard/i },
  { area: 'Device links', paths: /device|harness_?links|pairing|join_?link/i },
  { area: 'Deletion', paths: /purge|delet|cleanup|sweep|prune/i },
]
/** Reads an area above needs while the project has no review table. */
export const SECURITY_READS = 2
