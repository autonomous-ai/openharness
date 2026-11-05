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

/** A machine rule the project's owners gave (project instructions, Machines), as data for moves until the project rules
 *  record holds them (River, review of #3229). By machine id: each machine of a Mac and its Harness Team account. */
export interface MachineRule {
  machineIds: string[]
  /** Why, in the words the project chat shows. */
  why: string
  /** Engines no crew member is moved there with. */
  noEngines?: string[]
  /** When it is away: on these weekdays (0 Sunday … 6 Saturday), between these local times, in its owner's time zone. */
  away?: { days: number[]; windows: Array<[string, string]>; timeZone: string }
}
export const MACHINE_RULES: MachineRule[] = [
  // 0xken15, 2026-11-03: offline Monday to Friday 07:30–09:30 and 18:00–21:00 Vietnam time (travel).
  { machineIds: ['592a20a2275f0b3114c955fabbf19d30', 'ac9162e10133353c005f76afa0600632'], why: 'Ken\'s MacBook Pro is away now',
    away: { days: [1, 2, 3, 4, 5], windows: [['07:30', '09:30'], ['18:00', '21:00']], timeZone: 'Asia/Ho_Chi_Minh' } },
  // Diego, 2026-10-28: no Codex agent runs on Diego's Mac.
  { machineIds: ['001bcba1e7e9deb6f8756c053a951ce2', 'e18bd65a4cccd861b634f59369e57880'], why: 'no Codex agent runs on Diego\'s Mac', noEngines: ['codex'] },
]
/** How long after losing its task to its machine a crew member still counts as holding it, so it moves with it. */
export const HELD_TASK_MS = HOUR
