/**
 * The records both tiers write for iTerm2 (plan Decisions 2 and 3): a tab or split named by its place, a tmux or herdr
 * pane by the session it holds, so one evaluator grades both tiers and no tty or pane id reaches a result.
 */
import { HERDR_PANE } from '../../cable/hosts/herdrClient.js'
import type { SessionDef, SessionKey } from './types.js'

/** The window of `Seen.streams` the watch's tabs stream is recorded under. */
export const TABS_STREAM = 'tabs'

export interface TabRef { window: string; tab: number; split?: number }

// tmux's pane id as tmux.ts reads it (its TMUX_PANE_ID is private there).
const TMUX_PANE = /^%[0-9]{1,9}$/

/** `w1.1.0`: window, tab, split; split 0 when unset. */
export function tabLabel(ref: TabRef): string {
  return `${ref.window}.${ref.tab}.${ref.split ?? 0}`
}

/** The tab an iTerm2 session's select names: its own tab and split, or for tmux and herdr its client's tab (split 0). */
export function sessionTab(s: Pick<SessionDef, 'place' | 'window' | 'tab' | 'split'>): string {
  if (s.window === undefined || s.tab === undefined) throw new Error('an iTerm2 session names its window and tab')
  const inMultiplexer = s.place === 'tmux' || s.place === 'herdr'
  return tabLabel({ window: s.window, tab: s.tab, split: inMultiplexer ? 0 : s.split })
}

/** A tmux or herdr command's arguments with each pane id (`%N`, herdrClient.ts HERDR_PANE) written `pane:<key>`,
 *  `pane:other` for one keyOf names none; every other argument as it is. */
export function namedPanes(argv: readonly string[], keyOf: (pane: string) => SessionKey | undefined): string[] {
  return argv.map((arg) => (TMUX_PANE.test(arg) || HERDR_PANE.test(arg) ? `pane:${keyOf(arg) ?? 'other'}` : arg))
}

/** A select the devices wrote on the tabs stream as recorded: its tty as its tab's label, `other` for none. */
export function selectRecord(line: { app: string; tty: string; raise?: boolean },
  labelOf: (tty: string) => string | undefined): { app: string; tab: string; raise?: true } {
  const record: { app: string; tab: string; raise?: true } = { app: line.app, tab: labelOf(line.tty) ?? 'other' }
  if (line.raise === true) record.raise = true
  return record
}
