/**
 * Whether a prompt core typed into a pane was taken: the engine's reading of its own composer and of the
 * prompt as it recorded it. Core keeps the writer, the lease, every Enter and every verdict; an engine
 * only reads text core passes it and reports what it sees.
 */

/**
 * The declared facts that time core's own decisions on the input path. Data, not code: core reads them
 * synchronously as a message arrives, without loading an interpreter or waiting on a worker.
 */
export interface SubmissionPolicy {
  /** The engine's own TUI takes a message typed while a turn runs and queues it itself. */
  readonly typesWhileBusy: boolean
  /** How long after Enter core waits for the turn to start before it reads the pane. */
  readonly verifyMs: number
  /**
   * How a message typed mid-turn is taken, as the Device is told: `native_queue` or `native_input`, or
   * `steering` from the release `steeringSince` ([major, minor]) on.
   */
  readonly busyInput: { readonly mode: 'native_queue' | 'native_input'; readonly steeringSince?: readonly [number, number] }
}

/** What a pane shows of a prompt core typed. Facts only: core decides whether Enter is pressed again. */
export interface SubmissionReading {
  /** The prompt's text is still in the composer: the rows from the last prompt marker down (the whole
   *  pane when none is drawn) hold it, unsent. */
  draft: boolean
  /** A row starts with a prompt marker: a composer is on screen. */
  composer: boolean
  /** The Device's stricter reading of the same: only the engine's own prompt rows count, and a pane
   *  with none drawn is unreadable rather than read whole. */
  nativeDraft: 'pending' | 'clear' | 'unreadable'
}

/** Where, in a prompt as the engine recorded it, the text that was typed lies: its own wrapping left out. */
export interface PromptSpan { start: number; end: number }

export interface EngineSubmission {
  readonly policy: SubmissionPolicy
  /** The pane after a paste, against the prompt typed into it. */
  read(capture: string, prompt: string): SubmissionReading
  /** A turn's prompt as the engine recorded it. */
  echo(recorded: string): PromptSpan
}
