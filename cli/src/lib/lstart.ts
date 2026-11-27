/**
 * A process's start as `ps` prints its `lstart` under psEnv's `LC_TIME=C`: the one parser of it, for the process table
 * (sessionSearch/externals/support.ts listProcesses) and a tab's tty (cable/hosts/tabs.ts readTabTty). Imports nothing:
 * the CLI's watch loads it through tabs.ts.
 */

/** The C locale's form, `DOW MON DD HH:MM:SS YYYY`. Date.parse alone reads a German `Di. 25 Nov. 10:00:00 2026` as a
 *  date too, and a start read under the person's own LC_TIME must never pass for the C one. The twin of processTable.ts
 *  LSTART_MARKER_RE, which the core loads: one shared would put this file in the core, so a change to one is made to
 *  the other. */
const C_LSTART = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4}$/

/** The start's ms since the epoch; none for a start in another form. */
export function lstartMs(lstart: string): number | undefined {
  if (!C_LSTART.test(lstart)) return undefined
  const ms = Date.parse(lstart)
  return Number.isFinite(ms) ? ms : undefined
}

/** The start as a process generation, `ps:<ms>`, which a later read of the same process equals. */
export function lstartGeneration(lstart: string): string | undefined {
  const ms = lstartMs(lstart)
  return ms === undefined ? undefined : `ps:${ms}`
}
