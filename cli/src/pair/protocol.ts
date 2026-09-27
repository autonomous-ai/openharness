/**
 * The pair brain's shapes (daemons/BRAIN.md), shared by the sensor that runs on every harnessd, the
 * machine-to-machine `pair_*` RPCs, and the brain on the computer you are at.
 *
 * Nothing here is a model or a transport. Two rules live in this file because every layer needs them
 * and they must never drift apart:
 *   - which permission prompts are DENY-CLASS (push, force, rm -rf, deploy, publish, drop, merge): they
 *     never get a `[y]` key and are never recommended or approved automatically;
 *   - which frames are local-only (`daemon_*`, loopback through sendLocal) and which are machine to
 *     machine (`pair_*`, sealed — see lib/e2ee/applicationFrames.ts).
 */

/** What the journal records. `question`/`answered` pair up by requestId. `act` is something the daemon
 *  did to a harness (pair/owner.ts): who asked is `by`, what it did is `action`. `learned` is a lesson the
 *  person approved, credited to the daemon that found it (`daemon`; pair/learn, daemons/LEARNING.md).
 *  `relayed` is a key this machine's brain sent on to another machine (`target`) — that machine journals
 *  the `act`; this one keeps which window (`origin`) it came from. */
export type PairKind = 'start' | 'done' | 'fail' | 'question' | 'answered' | 'recap' | 'act' | 'learned' | 'relayed'

/**
 * Who made the daemon act: a key a person pressed here, the pair harness's own tool call, a pair.jsonc
 * rule, or `remote` — another machine's sealed request. The owning machine decides it from how the request
 * reached it; a `by` a request carries is never believed.
 */
export type PairActor = 'key' | 'pair' | 'rule' | 'remote'
export type PairAction = 'answer' | 'send' | 'stop' | 'start' | 'pause' | 'resume'

export interface PairJournalEntry {
  /** The journal's lifetime: a new file (or one that could not be read) is a new epoch. */
  epoch: string
  /** Monotonic within an epoch. A reader's cursor is (epoch, seq). */
  seq: number
  at: number
  kind: PairKind
  agentId: string
  name: string
  engine: string
  requestId?: string
  /** The question, the recap, or why a turn failed. Untrusted text from a pane or a model. */
  text?: string
  options?: string[]
  /** The question matches a deny-class prompt (see isDenyClass). Decided here, on the owning machine. */
  deny?: boolean
  /** On an `act`: who asked for it, and what was done. */
  by?: PairActor
  action?: PairAction
  /** On `learned`: the roster id of the daemon that found the lesson. */
  daemon?: string
  /** On a `remote` act or a `relayed` key: the connection (and paired label) the request came from. */
  origin?: string
  /** On `relayed`: the machine the key was sent to. */
  target?: string
}

export interface PairQuestion {
  requestId: string
  text: string
  options: string[]
  multi: boolean
  /** Never approved by anything but the person (pair/classify.ts), read over the whole dialog. */
  deny: boolean
  /** A permission prompt a `[y]` may approve: a read, test, build, formatter or in-project edit. */
  allow: boolean
  /** A permission prompt (the engine asks to run something), not a question the agent asks. */
  permission: boolean
  since: number
  /**
   * The WHOLE dialog as painted — the exact command, or the edit's preview — bounded to DIALOG_MAX. What a
   * proposal or a line with a [y] shows in full before a key may approve it. Absent from older daemons.
   */
  dialog?: string
}

/** The most of a dialog kept and shown: past this, it is cut and marked, and nothing proposes answering it. */
export const DIALOG_MAX = 16_000

/** One harness as the sensor sees it. Everything a `daemon_state` needs, nothing a pane has to be read for. */
export interface PairHarness {
  agentId: string
  name: string
  engine: string
  working: boolean
  question: PairQuestion | null
  /** Why the last turn failed, until the next one starts. */
  failing: string | null
  lastDoneAt: number | null
  recap: string | null
}

export interface PairSnapshot {
  machineId: string
  epoch: string
  seq: number
  /** Bumped on every change, journaled or not — orders a snapshot against the pushes around it. */
  rev: number
  harnesses: PairHarness[]
}

/**
 * One change, pushed to watchers (locally to the brain, remotely as `pair_event`).
 *
 * `baseline` marks a change that is not news: a turn re-read from disk, a question that was already
 * open before this daemon started. The state moves; nothing is journaled and nobody reacts.
 */
export interface PairEvent {
  machineId: string
  rev: number
  harness: PairHarness | null
  agentId: string
  entry?: PairJournalEntry
  baseline?: boolean
  removed?: boolean
}

/** A page of journal. `reset` = the cursor's epoch is gone (start again from these); `truncated` = the
 *  ring dropped entries the cursor had not read yet. */
export interface PairJournalPage {
  epoch: string
  seq: number
  entries: PairJournalEntry[]
  reset?: boolean
  truncated?: boolean
}

/** What backendSocket asks of the sensor for the `pair_*` RPCs and the local `pair` request. */
export interface PairService {
  /** Pairing is on (the account's zoo has a paired daemon). Off, every `pair_*` answers PAIR_OFF. */
  enabled(): boolean
  /** Start pushing events to `connId`; answers the snapshot to begin from. `push` false = gone. */
  watch(connId: string, push: (event: PairEvent) => boolean): PairSnapshot
  unwatch(connId: string): void
  journal(payload: Record<string, unknown>): PairJournalPage
  read(payload: Record<string, unknown>): Record<string, unknown>
  /** The local-only `pair` request (the control interface grows from here, BRAIN.md P4). */
  local(payload: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** A daemon id as the roster writes one (daemons/tools/generate.mjs checks the same shape). */
export function isPairDaemonId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,15}$/.test(value)
}

// ── deny class ──────────────────────────────────────────────────────────────────────────────────────

/** Which prompts are never approved, read over the whole dialog (pair/classify.ts). */
export { isDenyClass } from './classify.js'

// ── local frames (loopback only) ────────────────────────────────────────────────────────────────────

export const DAEMON_OUT_TYPES = new Set(['daemon_state', 'daemon_say', 'daemon_unsay', 'daemon_brief', 'daemon_act_result', 'daemon_talk_result', 'daemon_confirm_result'])
/** Taken only over the daemon's Unix socket, and all but presence only from a window (localWsServer.ts). */
export const DAEMON_IN_TYPES = new Set(['daemon_act', 'daemon_presence', 'daemon_talk', 'daemon_shown', 'daemon_confirm'])

/**
 * The face a line wants. `auto` reports something it already did (a rule, or the pair driving a harness
 * it started) — drawn like `done`; `say` is the pair harness talking (its `say` tool) — drawn like `idle`;
 * `ask` is a proposal waiting for your key (autonomy `suggest`/`act-on-key`) — drawn like `need`.
 */
export type DaemonMood = 'need' | 'done' | 'fail' | 'back' | 'auto' | 'say' | 'ask'

export interface DaemonAction {
  /**
   * The key a client binds: `y` a ONE-TIME yes (only on an allow-class prompt, pair/classify.ts), `n` the
   * dialog's decline, `g` go to the pane (the client opens the harness; nothing is answered). On a lesson
   * proposal (pair/learn/propose.ts): `y` teach, `n` skip, `s` show its text.
   */
  key: 'y' | 'n' | 's' | 'g'
  label: string
  /** The option label the answer keys in. */
  choice: string
}

/** The harness a line is about, named the way the person names it. */
export interface DaemonHarness { machineId: string; machine: string; agentId: string | null; name: string }

export interface DaemonSay {
  id: string
  about: { machineId: string; agentId: string; requestId?: string }
  mood: DaemonMood
  line: string
  actions: DaemonAction[]
  ttlMs: number
  /**
   * Who is speaking. `pair`: the pair harness — its `say` tool, or a write it proposed. A client draws a
   * `pair` line distinctly (it is a model's words or request, not the daemon's own facts). Absent: the daemon.
   */
  from?: 'pair' | 'daemon'
  /**
   * What a key on this line would do, EXACTLY and in full: the whole command or diff, the whole prompt, the
   * folder and first prompt of a start. A client shows it — all of it — before it acknowledges the line as
   * displayed (`daemon_shown`); `line` is only its one-line summary.
   */
  detail?: string
  /** The harness a proposal is about, by name and machine. */
  harness?: DaemonHarness
  /** A setting waiting for the person's yes at a window (pair/gate.ts): answered with `daemon_confirm`. */
  confirm?: { kind: 'autonomy' | 'rules'; nonce: string }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────

/** Printable 7-bit ASCII, one line, bounded — what a status line can draw and a model may not exceed. */
export function statusText(value: string, max: number): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...` : flat
}

export function str(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
