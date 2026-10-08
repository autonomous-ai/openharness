/** A read-only interpretation of one captured terminal screen. */
/** Device-facing question shape — byte-for-byte the hosted runtime’s `commanderQuestions()` output. */
export interface ShapedQuestion {
  key: string
  q: string
  options: string[]
  multi: boolean
  /** Observed free-text editor; never inferred for permission prompts. */
  canText?: boolean
}

export interface QuestionRow {
  /** The digit to press. */
  number: string
  /** Option text with any `[ ]` checkbox prefix removed. */
  label: string
  checked: boolean
  /**
   * Set only when the dialog does NOT number its rows: the row is then reached by walking to it and
   * pressing Enter, and `number` carries its INDEX rather than a key.
   *
   * The direction is a property of the DIALOG, not of the engine. OpenCode draws BOTH a numbered ask
   * dialog and — for permissions — the horizontal prompt kilo inherited from it, so keying by engine
   * would send digits into a dialog that numbers nothing and select nothing at all.
   */
  walk?: 'right' | 'down'
}

export interface QuestionView {
  kind: 'question'
  permission?: boolean
  /**
   * The dialog is on screen but its top — the question and its first rows — is scrolled out of the pane
   * (Codex's request_user_input keeps the footer anchored and lets a short pane cut the top off; measured
   * in a four-pane window: rows 3–5 and the footer visible, "1." and the question gone). Enough to know a
   * dialog is STILL OPEN — the watcher must not close it — and not enough to announce as a question.
   */
  partial?: boolean
  /** The footer says a digit only highlights and Enter commits (`enter to submit answer` — Codex's
   *  request_user_input). Absent where one digit selects and submits, which is every other dialog. */
  enterSubmits?: boolean
  question: string
  rows: QuestionRow[]
  multi: boolean
  /** The "Type something." row, when the dialog offers free text. */
  typeRow: QuestionRow | null
  /**
   * A permission prompt's WHOLE dialog, every line as painted (ANSI stripped), from its frame to its last
   * row. `question` is one line clipped for a device's screen; a command that wraps — `npm test &&` on one
   * line, `git push` on the next — is only whole here. What the pair brain's floor reads (pair/classify.ts),
   * and part of the dialog's fingerprint, so two prompts that differ below their first line are two ids.
   */
  dialog?: string
}

export interface ReviewView {
  kind: 'review'
  submitRow: string
}

export type PaneView = QuestionView | ReviewView | null

export interface PaneInspection {
  idle: boolean
  plan: boolean
  dialog: boolean
  draft: boolean
}


export type ComposerState = 'ready' | 'popup' | 'absent'
export type PaneTakeover = 'rewind' | 'transcript' | 'search' | 'trust' | 'update' | 'model' | 'sign_in'
export type PaneModal = PaneTakeover | 'permission' | 'menu' | null
export type MessageHold = 'permission_open' | 'question_open' | 'menu_open' | 'rewind_picker_open' | 'transcript_open'
  | 'search_open' | 'trust_open' | 'update_prompt_open' | 'model_prompt_open' | 'sign_in_open' | 'popup_open'
  | 'prompt_hidden' | 'screen_unreadable'
export interface FoundDialog { view: QuestionView | ReviewView; at: number }
export interface ScreenReading {
  activity: { label: string; indicator: string } | null
  busy: boolean
  stoppedGoal: boolean
  pane: PaneInspection
  question: PaneView
  messageHold: MessageHold | null
  teamHold: string | null
}
export interface EngineScreen {
  inspect(capture: string): ScreenReading
}
