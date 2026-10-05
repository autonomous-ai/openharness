/**
 * THE FLOOR (daemons/BRAIN.md, "Control interface"): what the paired daemon may never do, at any autonomy
 * level, from any caller — a key a person pressed, a tool the pair harness called, a rule in pair.jsonc.
 *
 *   - No delete, restart, fork or bypass. Those verbs do not exist in the control interface at all; a
 *     harness it starts runs in mode `ask`.
 *   - It never types into a terminal (a shell is not an agent) or into its own harness.
 *   - A deny-class permission prompt (push, force, rm -rf, deploy, publish, drop, merge — protocol.ts
 *     `isDenyClass`) is never approved: the only answer anything but the person's own hands may key into
 *     it is the dialog's own decline.
 *   - An answer is always one of the dialog's own options, never free text typed into its "Type
 *     something" row — and never one that answers for more than this once ("don't ask again", "allow
 *     all edits during this session").
 *
 * Decided here, and checked AGAIN on the machine that owns the harness (pair/owner.ts): question text is
 * untrusted, a remote brain may be older or wrong, and a model's tool call is only a request.
 */

export const AUTONOMY_LEVELS = ['watch', 'suggest', 'act-on-key', 'act-within-rules'] as const
export type Autonomy = typeof AUTONOMY_LEVELS[number]
/**
 * What a zoo that never set it means (backend/src/lib/zoo.ts reads the same default): `watch`. The person
 * opts into `suggest` and above; a level above `suggest` also waits for their yes at a window (pair/gate.ts).
 */
export const DEFAULT_AUTONOMY: Autonomy = 'watch'

export function isAutonomy(value: unknown): value is Autonomy {
  return typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value)
}

const YES = /^(yes|y|allow|approve|accept|proceed|continue|ok|okay|run|confirm)\b/i
const NO = /^(no|n|deny|reject|decline|cancel|don'?t|do not|skip|abort|stop)\b/i

/** An option as a person reads it: "1. Yes, and don't ask again" → "Yes, and don't ask again". */
export function bareOption(option: string): string {
  return option.replace(/^\s*(\d+[.)]|[>›❯*-])\s*/, '').trim()
}

export function isApproveOption(option: string): boolean {
  return YES.test(bareOption(option))
}

export function isDeclineOption(option: string): boolean {
  return NO.test(bareOption(option))
}

const PERSISTENT = /don['’]?t ask again|do not ask again|\balways\b|allow all|for (the rest of )?(this|the) session|during this session|\bremember\b|every time|from now on|auto-?accept|shift\+tab|\(p\)\s*$/i

/** An option that answers for more than this one prompt: "don't ask again", "allow all … this session". */
export function isPersistentOption(option: string): boolean {
  return PERSISTENT.test(option)
}

/** A yes that is only ever this once: the only kind of yes the daemon may key. */
export function isOneTimeYes(option: string): boolean {
  return isApproveOption(option) && !isPersistentOption(option)
}

const norm = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()

/** The dialog's own option `choice` names (exactly, or without its number), or null. */
export function matchOption(options: readonly string[], choice: string): string | null {
  const want = norm(choice)
  if (!want) return null
  return options.find((option) => norm(option) === want)
    ?? options.find((option) => norm(bareOption(option)) === want)
    ?? null
}

export type FloorRefusal = 'NOT_OFFERED' | 'DENY_CLASS' | 'PERSISTENT' | 'NOT_ALLOW_CLASS'

/** What the floor reads of a question: the owning machine's sensor sets all of it (pair/sensor.ts). */
export interface FloorQuestion {
  options: readonly string[]
  deny: boolean
  /** A permission prompt a `[y]` may approve (pair/classify.ts). */
  allow?: boolean
  /** A permission prompt at all, not a question the agent asks (AskUserQuestion) or a plan to approve. */
  permission?: boolean
  multi?: boolean
}

/**
 * Whether `choice` may be keyed into this question by anything but the person's hands in the pane — a
 * key on a daemon's line, the pair, a rule, another machine — whoever asked and whatever harness it is
 * (one the pair started too). Answers the option to key (the dialog's own spelling), or why not:
 *   - only the dialog's own options, and never one that answers for more than this once;
 *   - only a PERMISSION prompt: never a question the agent asks, never a plan to approve;
 *   - its decline, always; its one-time yes only when the prompt is allow-class (and never deny-class).
 */
export function answerFloor(question: FloorQuestion, choice: string):
  { ok: true; option: string } | { ok: false; error: FloorRefusal; detail: string } {
  const option = matchOption(question.options, choice)
  if (!option) return { ok: false, error: 'NOT_OFFERED', detail: 'That is not one of the question\'s own options.' }
  // Whoever asks — a key, the pair, a rule — the daemon answers only this once.
  if (isPersistentOption(option)) return { ok: false, error: 'PERSISTENT', detail: 'That option answers for more than this once: only you can choose it.' }
  if (question.permission !== true) {
    return { ok: false, error: 'NOT_ALLOW_CLASS', detail: 'Only a permission prompt is answered for you: open the harness to answer this one.' }
  }
  if (isDeclineOption(option)) return { ok: true, option }
  if (question.deny) {
    return { ok: false, error: 'DENY_CLASS', detail: 'This prompt pushes, deletes, deploys, publishes, drops or merges: only you can approve it.' }
  }
  if (question.allow !== true || question.multi === true || !isOneTimeYes(option)) {
    return { ok: false, error: 'NOT_ALLOW_CLASS', detail: 'Only a one-time yes to a read, test, build, formatter or in-project edit is keyed for you: open the harness.' }
  }
  return { ok: true, option }
}

/** Why a harness can never be driven by the daemon (typed into, answered, stopped, paused), or null. */
export type Untouchable = 'terminal' | 'pair'

export function untouchableDetail(why: Untouchable): string {
  return why === 'terminal' ? 'A terminal is a shell, not an agent: the daemon never types into it.'
    : 'That is the daemon\'s own harness: it never drives itself.'
}
