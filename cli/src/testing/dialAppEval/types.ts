// The dial eval's contract: the catalog, the drivers, the runner, the grader and the report all speak these types
// (docs/plans/2026-11-21-dial-app-eval-design.md).
import { observedAgentId } from '../../cable/hosts/observed.js'

export type App = 'claude' | 'chatgpt'
export type Dimension = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8'
export type Platform = 'darwin' | 'win32' | 'linux'
/** `a`: replay in process; `b`: scripted end to end on the real daemon, fake apps. */
export type Tier = 'a' | 'b'
export type SessionKey = string
export type Label = string

export const DIMENSIONS: readonly Dimension[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']

/** Each dimension's weight in an app's score: voice send counts most, since a wrong send is the worst failure. */
export const WEIGHTS: Readonly<Record<Dimension, number>> = {
  D1: 15, D2: 15, D3: 15, D4: 10, D5: 25, D6: 5, D7: 10, D8: 5,
}

/** [full, half], inclusive: at or under the first scores 1, at or under the second 0.5, else 0. */
export const THRESHOLDS: {
  follow: [1000, 3000]; open: [1000, 3000]; working: [1000, 3000]; needsYou: [1000, 3000]
  done: [2500, 5000]; ringChange: [2000, 5000]; loopP99Ms: [50, 200]; cpuPercent: [10, 25]
} = {
  follow: [1000, 3000],
  open: [1000, 3000],
  working: [1000, 3000],
  needsYou: [1000, 3000],
  // The 1.5 s answer grace is by design, so done gets more room.
  done: [2500, 5000],
  ringChange: [2000, 5000],
  loopP99Ms: [50, 200],
  cpuPercent: [10, 25],
}

export interface SessionDef {
  key: SessionKey; app: App
  /** Claude Code's cliSessionId, or the Codex thread id: a fixed made-up UUID. */
  id: string
  /** Claude only: `local_<uuid>`, its store file and its link's session. */
  localId?: string
  /** The app's title (Claude) / Codex's thread name (ChatGPT): starts with "Eval ". */
  title: string
  /** Under /work/eval-. */
  cwd: string
  /** Last active this long before the step that writes it. */
  ageMs: number
  /** ChatGPT: its sidebar project. */
  project?: string
  /** The fake app starts it when its link runs. */
  resumable?: true
  /** A Codex CLI session in a terminal, not the ChatGPT app's (X10). */
  cli?: true
  /** Never written or started: only probes name it. */
  ghost?: true
}

export const STEP_KINDS = ['claude.write', 'codex.write', 'hook', 'front', 'thread', 'attach', 'tap', 'swipe',
  'voice', 'quit', 'relaunch', 'unplug', 'replug', 'wait'] as const
export type StepKind = (typeof STEP_KINDS)[number]
// One member per kind, so StepOf<K> narrows.
export type Step = { label?: Label } & (
  | { kind: 'claude.write'; sessions: SessionKey[]; archived?: true }
  | { kind: 'codex.write'; sessions: SessionKey[]; projects?: string[]; names?: Record<SessionKey, string>;
      archived?: SessionKey[]; ages?: Record<SessionKey, number>; walBusy?: true }
  | { kind: 'hook'; session: SessionKey; event: 'start' | 'turn-start' | 'needs-input' | 'turn-stop' | 'end';
      asks?: 'permission' | 'question'; lastAnswer?: string }
  | { kind: 'front'; app: App | 'other' }
  | { kind: 'thread'; title: string }
  | { kind: 'attach'; session: SessionKey }
  | { kind: 'tap'; session: SessionKey }
  | { kind: 'swipe'; session: SessionKey }
  | { kind: 'voice'; transcript: string; target: SessionKey }
  | { kind: 'quit'; app: App }
  | { kind: 'relaunch'; app: App }
  | { kind: 'unplug' }
  | { kind: 'replug' }
  /**
   * With `until`, the wait ends once it holds and `ms` is only its limit: one that reaches it is a failing result.
   * Without, `ms` is the person's own timing.
   */
  | { kind: 'wait'; ms: number; until?: Until }
)
/** What a wait ends on: what the dial has received from the scenario's start, as a ring check reads it. */
export type Until = { kind: 'ring'; page: App; expect: SessionKey[] }
export type StepOf<K extends StepKind> = Extract<Step, { kind: K }>

export const CHECK_KINDS = ['ring', 'focus', 'still', 'open', 'state', 'voice', 'recap', 'cost'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]
export type Check = { id: string; dim: Dimension; after?: Label; at?: Label } & (
  | { kind: 'ring'; page: App; expect: SessionKey[]; timed?: true }
  | { kind: 'focus'; session: SessionKey; noBounce?: true }
  | { kind: 'still'; ms: number }
  | { kind: 'open'; session: SessionKey; link: boolean }
  | { kind: 'state'; session: SessionKey; state: 'working' | 'needs-you' | 'done' | 'idle' }
  | { kind: 'voice'; session: SessionKey; text: string }
  | { kind: 'recap'; session: SessionKey; text: string }
  | { kind: 'cost' }
)

export interface Scenario {
  id: string; app: App; title: string; dims: Dimension[]; platforms: Platform[]; tiers: Tier[]; heldOut: boolean
  sessions: SessionDef[]
  /** front defaults to `app`. */
  world?: { front?: App | 'other'; chatgptInstalled?: false; linkFails?: App[] }
  steps: Step[]; checks: Check[]
  /** Checks that name a ghost session, so they must fail: they prove a check can fail with its evidence. Never scored. */
  probes: Check[]
  /** Tier B: on a daemon of its own. */
  fresh?: true
}

/** Every delivery path, with its target: the Claude mod's inbox, the core's turns.send, the Codex queue, typed words. */
export interface Delivery { at: number; path: 'mod' | 'turns' | 'codex' | 'typed'; target: SessionKey | null; text: string }
/** What a driver observed. `at`: ms since the scenario's start (virtual in tier A, wall in tier B). */
export interface Seen {
  frames: Array<{ at: number; message: Record<string, unknown> }>
  faces: Array<{ at: number; page: string; tiles: string[]; active: string | null }>
  /** ok: the command succeeded. */
  commands: Array<{ at: number; argv: string[]; ok: boolean }>
  deliveries: Delivery[]
  steps: Array<{ at: number; index: number; kind: StepKind; label?: Label }>
  cost?: { cpuPercent: number; loopP99Ms: number; leftovers: number }
}
export interface CheckResult {
  tier: Tier; platform: Platform; scenario: string
  /** `<id>.<part>`, or `<id>` for a D7 check. */
  check: string
  app: App; dim: Dimension; heldOut: boolean
  /** 0..1. */
  score: number
  /** Latency or cost threshold: reported, never asserted in tier B, since it depends on the runner. */
  timed: boolean
  ms?: number | null
  /** What was observed, one line each; empty when nothing was. */
  evidence: string[]
}
/** A voice prompt delivered to a session other than the step's target: it fails the whole run. */
export interface WrongSend { tier: Tier; platform: Platform; scenario: string; target: SessionKey; got: SessionKey | null;
  path: Delivery['path']; at: number }
/** A scenario × platform the injected platform cannot drive: left out of the scores, neither pass nor fail. */
export interface CoverageGap { tier: Tier; platform: Platform; scenario: string; app: App; heldOut: boolean; reason: string }
export interface RunResults { schema: 1; results: CheckResult[]; wrongSends: WrongSend[]; gaps: CoverageGap[] }
/**
 * checks: keyed by resultKey. apps: each subset's app scores, keyed `a` (tier A, every platform at once, as it runs them
 * all by injection) or `b/<platform>`, so a run is compared only with the subsets it drove.
 */
export interface Baseline { schema: 1; checks: Record<string, number>; apps: Record<string, Record<App, number | null>> }
export interface AppScores {
  score: number | null; dims: Record<Dimension, number | null>
  /** That app's tier × platform × scenario runs left out for a gap. */
  leftOut: number
}
export interface Group { app: App; dim: Dimension; scenario: string; pointsLost: number; checks: string[] }
export interface Report {
  schema: 1
  apps: Record<App, AppScores>; heldOut: Record<App, AppScores>
  /** byPlatform's key: `<tier>/<platform>`. */
  byTier: Record<Tier, Record<App, AppScores>>; byPlatform: Record<string, Record<App, AppScores>>
  gate: { passed: boolean; wrongSends: WrongSend[] }
  /** groups ranked, most points lost first. */
  failing: Array<CheckResult & { pointsLost: number }>; groups: Group[]
  /** The main set's: a held-out gap counts only in its table's left out. */
  gaps: CoverageGap[]
  /** Each tier the eval command did not run, and why. */
  skipped?: Array<{ tier: Tier; reason: string }>
  /**
   * apps: keyed by subset, as the baseline's, for each subset this run drove. checks: the main set's; the held-out ones
   * that changed are only counted, so the report shows nothing of them to fix by.
   */
  delta: { apps: Record<string, Record<App, { before: number | null; after: number | null }>>;
           checks: Array<{ key: string; before: number | null; after: number | null }>; heldOutChanged: number }
}
export interface Verdict { ok: boolean; message: string }
export interface EvalDriver {
  readonly tier: Tier
  /** Time 0: devices up, dial welcomed, page and front set. */
  start(scenario: Scenario, platform: Platform): Promise<void>
  step(step: Exclude<Step, { kind: 'wait' }>): Promise<void>
  /** Let the world run up to ms, or until `until` holds. */
  settle(ms: number, until?: () => boolean): Promise<void>
  now(): number
  /** Still read after stop(). */
  seen(): Seen
  gaps(): string[]
  stop(): Promise<void>
}

/** The agent id the daemon's observed sources give this session: the ChatGPT app's threads are Codex's. */
export function agentIdOf(session: Pick<SessionDef, 'app' | 'id'>): string {
  return observedAgentId(session.app === 'claude' ? 'claude' : 'codex', session.id)
}

/** A result's key in the baseline: tier/platform/scenario/check. */
export function resultKey(r: Pick<CheckResult, 'tier' | 'platform' | 'scenario' | 'check'>): string {
  return `${r.tier}/${r.platform}/${r.scenario}/${r.check}`
}
