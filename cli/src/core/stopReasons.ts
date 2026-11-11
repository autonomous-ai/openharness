/** The core stops that keep the daemon stopped: the master exits after them, and launchd, systemd and Windows leave a
 *  clean exit stopped. A revoked sign-in, and a computer in use elsewhere. */
const FOR_GOOD = new Set(['revoked', 'busy'])

export const stopsForGood = (reason: string): boolean => FOR_GOOD.has(reason)
