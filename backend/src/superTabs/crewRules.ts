/**
 * The crew keeper's numbers (task #3398), in one place until the project rules record (Ledger's task) holds them.
 * Each is a default a project may change there later.
 */
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, GB = 1024 ** 3

/** A crew member with nothing to do this long sleeps: its session closes, its folder stays. */
export const SLEEP_IDLE_MS = HOUR
/** Its machine silent this long: the member moves to a fallback machine. */
export const MOVE_OFFLINE_MS = 5 * MINUTE
/** Its engine's quota used up and not back for at least this long: the member moves. */
export const MOVE_QUOTA_OUT_MS = HOUR
/** Less free disk than this where it works: the member moves. */
export const MOVE_LOW_DISK_BYTES = 5 * GB
/** Asleep this long: its folder is dropped; a wake then starts it fresh. */
export const FOLDER_ASLEEP_MS = 7 * DAY
/** A machine with less free disk than this drops asleep members' folders first, the longest asleep first, one a pass. */
export const DISK_FLOOR_BYTES = 10 * GB
/** A machine that refused a member's move start (no token, no room) is not picked for that member again this long. */
export const MOVE_REFUSED_WAIT_MS = HOUR

/** How long after losing its task to its machine a crew member still counts as holding it, so it moves with it. */
export const HELD_TASK_MS = HOUR

/** The weekly quota an account keeps for a crew member (the routing's order and quota): below it the member moves to a fallback
 *  instead of reopening in place (task #3662). 5% for the big work a crew member does; 20% when the account runs a PM, whose work
 *  must never wait on a crew member's. */
export const QUOTA_FLOOR_PERCENT = 5
export const QUOTA_FLOOR_PM_PERCENT = 20
/** A crew member whose session stopped this many times within the window is moved, not reopened. */
export const UNSTABLE_STOPS = 3
export const UNSTABLE_WINDOW_MS = HOUR
