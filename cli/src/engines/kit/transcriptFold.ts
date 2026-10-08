import type { LiveEvent } from './events.js'

/**
 * Fold a transcript that already exists into a fresh normalizer, and say whether what came out is
 * HISTORY (to be swallowed) or the LIVE conversation (to be emitted).
 *
 * Attaching to a session normally means catching up on turns the user has already seen elsewhere, so the
 * events are dropped and only a turn left half-open is replayed. That assumption breaks when the agent
 * exists BEFORE its session: the first prompt is what makes the engine open the transcript, so by the
 * time anything binds it, the whole first turn — question, tools and answer — can already be on disk.
 * Folded as history it is lost silently, and silently is literal: no `turn_started` means no
 * `turn_ended` and no recap either, so nothing in the log records that a turn ever happened.
 *
 * `live` picks the destination. It also forces `turnOpen` to false, because the caller's mid-turn rescue
 * ("replay the last turn_started") would otherwise emit that event a second time on top of the events
 * returned here.
 */
export function foldTranscript(
  ingest: (line: string) => LiveEvent[],
  lines: string[],
  turnOpenAfter: () => boolean,
  opts: { live: boolean },
): { history: LiveEvent[]; live: LiveEvent[]; turnOpen: boolean } {
  const folded: LiveEvent[] = []
  for (const line of lines) folded.push(...ingest(line))
  return {
    history: opts.live ? [] : folded,
    live: opts.live ? folded : [],
    turnOpen: !opts.live && turnOpenAfter(),
  }
}

/**
 * `foldTranscript` one record at a time, for a transcript streamed in rather than loaded
 * (lib/attachTranscript.ts). History keeps only its last `turn_started` — the one event an attach ever
 * replays from it — so folding a long turn holds nothing but that.
 */
export class TranscriptFold {
  private lastStarted: LiveEvent | null = null
  private readonly folded: LiveEvent[] = []

  constructor(
    private readonly ingest: (line: string) => LiveEvent[],
    private readonly turnOpenAfter: () => boolean,
    private readonly live: boolean,
  ) {}

  push(line: string): void {
    for (const event of this.ingest(line)) {
      if (this.live) this.folded.push(event)
      else if (event.type === 'turn_started') this.lastStarted = event
    }
  }

  finish(): { history: LiveEvent[]; live: LiveEvent[]; turnOpen: boolean } {
    return {
      history: this.lastStarted ? [this.lastStarted] : [],
      live: this.folded,
      turnOpen: !this.live && this.turnOpenAfter(),
    }
  }
}
