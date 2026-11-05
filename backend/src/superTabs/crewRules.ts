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
