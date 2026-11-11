import { CHANNEL_EXEMPTIONS_END } from '../src/superTabs/commands.js'

const DAY = 24 * 60 * 60_000

/** A store clock inside the channel exemptions' window (commands.ts CHANNEL_EXEMPTIONS_END) on any day it runs: the wall clock
 *  until a day before the window ends, then a day before its end, still ticking. A test of an exemption passes on every day. */
export function exemptClock(): () => number {
  const shift = Math.max(0, Date.now() - (CHANNEL_EXEMPTIONS_END - DAY))
  return () => Date.now() - shift
}

/** A store clock past the window on any day it runs: from its end, still ticking. */
export function pastExemptionsClock(): () => number {
  const shift = Math.max(0, CHANNEL_EXEMPTIONS_END - Date.now())
  return () => Date.now() + shift
}
