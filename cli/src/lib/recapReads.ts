/**
 * Reading a session's stored recaps: its last turns' summaries and answers, and the person's last
 * questions. Pure functions of what the recaps hold (`SessionRecaps`), so that the recaps service
 * (lib/commander.ts, in its process) and the core, which answers from what that service last reported
 * (core/recapsLink.ts), read them with one rule and cannot drift apart.
 */

/** What the recaps hold of one session, newest first. */
export interface SessionRecaps {
  /** The latest turn's stored "recap\n\nbody" (summaries.json), which a session from before the history
   *  has alone. */
  latest: string | null
  /** The last few turns' "recap\n\nbody". */
  history: string[]
  /** The same turns' complete final answers, index-aligned with `history`. */
  fullTexts: string[]
  /** What the person asked on each of the last few turns. */
  asks: string[]
  /** Whether the devices' card for it is still busy: a turn open, or its recap being cut. */
  busy: boolean
}

/** One stored turn, as a device restoring its tile and the router read it. */
export interface RecentRecap {
  kind: string
  text: string
  recap?: string
  fullText?: string
}

export const MAX_PART = 2000

/** How many turn summaries are kept per session. Three is what the voice router reads: enough to tell one
 *  agent's subject from another's, few enough that one chatty agent cannot crowd the others out. */
export const RECENT_TURNS = 3

/** Split a persisted "recap\n\nbody" into its parts (mirror websocket.ts:540 / getRecentEvents). */
export function splitSummary(summary: string): { recap: string; body: string } {
  const nl = summary.indexOf('\n\n')
  const recap = (nl >= 0 ? summary.slice(0, nl) : summary).replace(/\s+/g, ' ').trim().slice(0, MAX_PART)
  const body = (nl >= 0 ? summary.slice(nl + 2) : summary).replace(/\s+/g, ' ').trim().slice(0, MAX_PART)
  return { recap, body }
}

/**
 * The session's last `n` turn summaries, newest first — for a device restoring its tile at boot and for
 * the voice router deciding which agent a spoken sentence belongs to.
 *
 * Falls back to the single latest summary when the history is empty, so the recaps already on disk from
 * before the history existed are usable on the first run rather than after three more turns.
 */
export function recentRecaps(recaps: SessionRecaps | null, n = 2): RecentRecap[] {
  if (!recaps) return []
  const want = Math.max(1, n)
  const stored = recaps.history
  // The latest lives in both places once a turn has run under this build; dedupe so it is not read twice.
  const usingHistory = stored.length > 0
  const all = usingHistory ? stored : recaps.latest ? [recaps.latest] : []
  const fulls = recaps.fullTexts
  return all
    .slice(0, want)
    // PAIRED BEFORE FILTERING, not after. The filter below drops empty summaries, and dropping them
    // from one array while reading the other by position is how a turn ends up carrying the previous
    // turn's answer — wrong in the one way nobody would think to check.
    .map((summary, at) => ({ summary, full: fulls[usingHistory ? at : 0] }))
    .filter(({ summary }) => summary && summary.trim())
    .map(({ summary, full }) => {
      const { recap, body } = splitSummary(summary)
      return { kind: 'summary', text: body || recap, recap, ...(full ? { fullText: full } : {}) }
    })
}

/** The person's own last questions to this agent, newest first. */
export function recentAsks(recaps: SessionRecaps | null, n = RECENT_TURNS): string[] {
  return (recaps?.asks ?? []).filter(Boolean).slice(0, Math.max(1, n))
}

/** The newest turn's complete final answer, for a consumer that reads rather than glances. */
export function lastFullText(recaps: SessionRecaps | null): string | undefined {
  return recaps?.fullTexts[0]
}
