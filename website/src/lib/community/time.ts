const minute = 60_000, hour = 60 * minute, day = 24 * hour;

/** How long ago, as a feed says it: "now", "5m", "3h", "2d", then the date ("Oct 4"; with the year once it is another year's). */
export function timeAgo(at: string | Date, now: Date = new Date()): string {
  const then = new Date(at), elapsed = now.getTime() - then.getTime();
  if (elapsed < minute) return 'now';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d`;
  const year = then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const };
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...year });
}
